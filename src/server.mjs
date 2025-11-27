// src/server.mjs
import http from "http";
import { URL } from "url";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { handleLookoutIntake } from "./lookout-intake.mjs";
import { startLookoutPolling } from "./lookout-poll.mjs";

// ESM-friendly __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = process.env.PORT || 8080;
const ISSUER = process.env.SSF_ISSUER;

// Validate required config at startup
if (!ISSUER) {
  throw new Error("Missing SSF_ISSUER environment variable");
}

// --- JWKS loader ---
let jwksCache = null;
function getJwks() {
  if (!jwksCache) {
    const raw = readFileSync(join(__dirname, "jwks.json"), "utf8");
    jwksCache = JSON.parse(raw);
  }
  return jwksCache;
}

// --- SSF discovery document ---
const wellKnown = {
  issuer: ISSUER,
  jwks_uri: `${ISSUER}/jwks.json`,
  delivery_methods_supported: ["push"],
  events_supported: {
    "https://schemas.okta.com/secevent/okta/event-type/device-risk-change": {},
    "https://schemas.okta.com/secevent/okta/event-type/user-risk-change": {},
  },
};

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, "http://localhost");
  const path = parsed.pathname;
  const method = req.method || "GET";

  console.log(`[HTTP] ${method} ${path}`);

  try {
    // Root – simple health/smoke
    if (path === "/" && (method === "GET" || method === "HEAD")) {
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end("ok");
    }

    // Health endpoint
    if (path === "/status" && (method === "GET" || method === "HEAD")) {
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end("ok");
    }

    // SSF discovery
    if (path === "/.well-known/ssf-configuration" && method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(wellKnown));
    }

    // JWKS
    if (path === "/jwks.json" && method === "GET") {
      const jwks = getJwks();
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(jwks));
    }

    // Lookout intake – internal entry point for polling/webhooks
    if (path === "/intake/lookout" && method === "POST") {
      return handleLookoutIntake(req, res);
    }

    // Fallback
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  } catch (err) {
    console.error("[HTTP] Unhandled error:", err);
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Internal server error");
  }
});

server.listen(PORT, () => {
  console.log(`Listening on port ${PORT}`);
  console.log(`[BOOT] SSF Issuer: ${ISSUER}`);
  startLookoutPolling();
});
