// src/lookout-poll.mjs
import fetch from "node-fetch";
import { getLookoutToken } from "./lookout-auth.mjs";

const BASE_URL =
  process.env.LOOKOUT_BASE_URL || "https://api.lookout.com";
const SINCE_MINUTES =
  parseInt(process.env.LOOKOUT_SINCE_MINUTES || "5", 10);
const POLL_INTERVAL_SECONDS =
  parseInt(process.env.LOOKOUT_POLL_INTERVAL_SECONDS || "60", 10);
const LOOKOUT_APP_KEY = process.env.LOOKOUT_APP_KEY;

// Optional: pin to one tenant explicitly
const LOOKOUT_ENTERPRISE_GUID = process.env.LOOKOUT_ENTERPRISE_GUID || null;


// In Cloud Run, localhost:PORT will hit the same container.
const PORT = process.env.PORT || 8080;
const SSF_INTAKE_URL =
  process.env.SSF_INTAKE_URL ||
  `http://localhost:${PORT}/intake/lookout`;

// ------------------------
// Polling heartbeat state
// ------------------------
let lastPollAt = null;          // Date ISO string of last attempt
let lastPollResult = null;      // "ok" | "error" | "disabled"
let lastPollError = null;       // short error message (string) or null
let totalPolls = 0;             // how many times we attempted to poll
let totalErrors = 0;            // how many poll attempts failed

function recordPollSuccess() {
  lastPollAt = new Date().toISOString();
  lastPollResult = "ok";
  lastPollError = null;
  totalPolls += 1;
}

function recordPollError(err) {
  lastPollAt = new Date().toISOString();
  lastPollResult = "error";
  lastPollError = String(err).substring(0, 500);
  totalPolls += 1;
  totalErrors += 1;
}

// Exposed diagnostics for HTTP layer
export function getPollingStatus() {
  return {
    enabled: Boolean(LOOKOUT_APP_KEY),
    lastPollAt,                // ISO timestamp or null
    lastPollResult,            // "ok" | "error" | "disabled" | null
    lastPollError,             // string or null
    totalPolls,
    totalErrors,
    sinceMinutes: SINCE_MINUTES,
    pollIntervalSeconds: POLL_INTERVAL_SECONDS,
    lookoutBaseUrl: BASE_URL,
    enterpriseGuid: LOOKOUT_ENTERPRISE_GUID || undefined,
  };
}






// Helper: how far back to look
function isoSince(minutes) {
  const d = new Date(Date.now() - minutes * 60 * 1000);
  return d.toISOString();
}

// Helper: collapse Lookout security_status into Okta-ish risk levels
function mapSecurityStatusToRiskLevel(securityStatus) {
  if (!securityStatus) return null;

  const s = String(securityStatus).toUpperCase();

  if (s === "THREATS_CRITICAL" || s === "THREATS_HIGH") return "high";
  if (s === "THREATS_MEDIUM") return "medium";

  // SECURE / THREATS_LOW → treat as low
  return "low";
}

async function pollLookoutOnce() {
  const sinceIso = isoSince(SINCE_MINUTES);

  let token;
  try {
    token = await getLookoutToken();
  } catch (err) {
    console.error("[LookoutPoll] Failed to get Lookout token:", err);
    recordPollError(err);
    return;
  }

  const params = new URLSearchParams();
  params.set("limit", "200"); // avoid the default 20-device cap
  params.set("updated_since", sinceIso);
  if (LOOKOUT_ENTERPRISE_GUID) {
    params.set("enterprise_guid", LOOKOUT_ENTERPRISE_GUID);
  }

  const url = `${BASE_URL}/mra/api/v2/devices?${params.toString()}`;

  console.log(
    `[LookoutPoll] Fetching devices updated since ${sinceIso} from ${url}`
  );

  let data;
  try {
    const resp = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.error(
        "[LookoutPoll] Lookout API error",
        resp.status,
        text.substring(0, 500)
      );
      recordPollError(
        `Lookout API ${resp.status}: ${text.substring(0, 200)}`
      );
      return;
    }

    data = await resp.json();
  } catch (err) {
    console.error("[LookoutPoll] Error calling Lookout API:", err);
    recordPollError(err);
    return;
  }

  const devices = Array.isArray(data.devices) ? data.devices : [];
  console.log(
    `[LookoutPoll] Received ${devices.length} devices from Lookout (count=${data.count ?? "?"})`
  );

  // If we got here without throwing, treat the poll as successful
  recordPollSuccess();

  for (const d of devices) {
    const email = d.email;
    const securityStatus = d.security_status; // NOTE: snake_case from the API
    const guid = d.guid;

    if (!email || !securityStatus) {
      console.log(
        "[LookoutPoll] Skipping device with missing email or security_status",
        {
          guid,
          email,
          security_status: securityStatus,
        }
      );
      continue;
    }

    const riskLevel = mapSecurityStatusToRiskLevel(securityStatus);

    // For now: only emit SSF events for medium/high risk
    if (!riskLevel || riskLevel === "low") {
      console.log("[LookoutPoll] Skipping low/secure device", {
        guid,
        email,
        security_status: securityStatus,
        mapped_risk: riskLevel,
      });
      continue;
    }

    // 🔑 NEW: track previous vs current to drive Okta transitions, incl. back to LOW
    const previousLevel = lastRiskByUser.get(email) || "low";

    // If nothing changed, don't spam Okta
    if (previousLevel === riskLevel) {
      console.log("[LookoutPoll] Risk unchanged; not sending SET", {
        guid,
        email,
        security_status: securityStatus,
        current_level: riskLevel,
      });
      continue;
    }

    lastRiskByUser.set(email, riskLevel);

    const eventTimestamp = d.updated_time || new Date().toISOString();

    const payload = {
      user: { email },
      risk: {
        current_level: riskLevel,      // high / medium / low
        previous_level: previousLevel, // what we last told Okta (or low)
        reason: `Lookout security_status=${securityStatus} for ${email}`,
      },
      event_timestamp: eventTimestamp,
    };

    try {
      const resp = await fetch(SSF_INTAKE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!resp.ok) {
        const text = await resp.text();
        console.error(
          "[LookoutPoll] Error POSTing to /intake/lookout",
          {
            status: resp.status,
            text: text.substring(0, 500),
            email,
            security_status: securityStatus,
            previous_level: previousLevel,
            current_level: riskLevel,
          }
        );
      } else {
        console.log("[LookoutPoll] Sent risk event to /intake/lookout", {
          email,
          security_status: securityStatus,
          previous_level: previousLevel,
          current_level: riskLevel,
        });
      }
    } catch (err) {
      console.error(
        "[LookoutPoll] Exception calling /intake/lookout",
        {
          error: String(err),
          email,
          security_status: securityStatus,
          previous_level: previousLevel,
          current_level: riskLevel,
        }
      );
    }
  }
}

export function startLookoutPolling() {
  if (!LOOKOUT_APP_KEY) {
    console.warn(
      "[LookoutPoll] LOOKOUT_APP_KEY not set; polling is disabled."
    );
    lastPollResult = "disabled";
    lastPollError = "LOOKOUT_APP_KEY env var not set";
    return;
  }

  console.log(
    `[LookoutPoll] Starting Lookout polling every ${POLL_INTERVAL_SECONDS}s (window=${SINCE_MINUTES}m)`
  );

  // run once at boot
  pollLookoutOnce().catch((err) =>
    console.error("[LookoutPoll] First poll error:", err)
  );

  // then on interval
  setInterval(() => {
    pollLookoutOnce().catch((err) =>
      console.error("[LookoutPoll] Poll error:", err)
    );
  }, POLL_INTERVAL_SECONDS * 1000);
}
