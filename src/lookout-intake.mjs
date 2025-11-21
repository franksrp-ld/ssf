// lookout-intake.mjs
import { readFile } from "fs/promises";
import { SignJWT, importPKCS8 } from "jose";
import crypto from "crypto";
import fetch from "node-fetch";

const ISSUER = process.env.SSF_ISSUER;
const OKTA_ORG = process.env.OKTA_ORG;

if (!ISSUER) throw new Error("Missing SSF_ISSUER");
if (!OKTA_ORG) throw new Error("Missing OKTA_ORG");

const ALG = "RS256";
const KID = "lookout-ssf-key-1";

let privateKeyPromise;

/**
 * Lazily load and parse the private key from private.pem using JOSE
 */
async function getPrivateKey() {
  if (!privateKeyPromise) {
    privateKeyPromise = (async () => {
      const pem = await readFile("./private.pem", "utf8");
      return importPKCS8(pem, ALG);
    })();
  }
  return privateKeyPromise;
}

/**
 * Normalize arbitrary Lookout risk strings -> low/medium/high
 */
function normalizeRiskLevel(raw) {
  const v = String(raw || "").toLowerCase();
  if (["critical", "severe", "high"].includes(v)) return "high";
  if (["medium", "moderate"].includes(v)) return "medium";
  return "low";
}

/**
 * POST a signed SET to Okta's /security-events endpoint
 */
async function sendSetToOkta(payload) {
  const key = await getPrivateKey();

  const jwt = await new SignJWT(payload)
    .setProtectedHeader({
      alg: ALG,
      typ: "secevent+jwt",
      kid: KID
    })
    .sign(key);

  const resp = await fetch(`${OKTA_ORG}/security/api/v1/security-events`, {
    method: "POST",
    headers: {
      "Content-Type": "application/secevent+jwt"
    },
    body: jwt
  });

  const text = await resp.text().catch(() => "");

  if (!resp.ok) {
    console.error("Okta SSF error:", resp.status, text);
    throw new Error(`Okta SSF ${resp.status}: ${text}`);
  }

  console.log("Okta SSF accepted SET:", resp.status);
}

/**
 * HTTP handler for POST /intake/lookout
 * Accepts a JSON payload in our internal "Lookout event" format and
 * transforms it into a device-risk-change SET for Okta.
 */
export async function handleLookoutIntake(req, res) {
  try {
    // Read raw request body
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const bodyStr = Buffer.concat(chunks).toString("utf8");

    let body;
    try {
      body = JSON.parse(bodyStr || "{}");
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(
        JSON.stringify({
          error: "invalid_json",
          detail: e.message
        })
      );
    }

    const userEmail = body?.user?.email;
    const lookoutCurrent = body?.risk?.current_level;
    const lookoutPrevious = body?.risk?.previous_level;
    const reason =
      body?.risk?.reason || "Lookout updated device/user risk";

    if (!userEmail || !lookoutCurrent) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(
        JSON.stringify({
          error: "missing_fields",
          detail: "user.email and risk.current_level are required"
        })
      );
    }

    const currentLevel = normalizeRiskLevel(lookoutCurrent);
    const previousLevel = normalizeRiskLevel(
      lookoutPrevious || "low"
    );

    const eventTsSeconds = body?.event_timestamp
      ? Math.floor(new Date(body.event_timestamp).getTime() / 1000)
      : Math.floor(Date.now() / 1000);

    const nowSeconds = Math.floor(Date.now() / 1000);

    // Build the SAME payload structure as your working test SET
    const payload = {
      iss: ISSUER,
      aud: OKTA_ORG,
      iat: nowSeconds,
      jti: crypto.randomUUID(),
      events: {
        "https://schemas.okta.com/secevent/okta/event-type/device-risk-change":
          {
            event_timestamp: eventTsSeconds,
            current_level: currentLevel,
            previous_level: previousLevel,
            initiating_entity: "system",
            reason_admin: {
              en: reason
            },
            subject: {
              user: {
                format: "email",
                email: userEmail
                // you can also add: id: "<oktaUserId>" later if you map it
              }
            }
          }
      }
    };

    console.log("Built SET payload from Lookout intake:", payload);

    // Send it to Okta
    await sendSetToOkta(payload);

    // Respond to Lookout (or your test caller)
    res.writeHead(202, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "accepted" }));
  } catch (err) {
    console.error("Error in /intake/lookout:", err);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: "internal_error",
        message: err.message
      })
    );
  }
}
