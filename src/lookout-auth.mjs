// src/lookout-auth.mjs
import fetch from "node-fetch";

const tokenCache = {
  token: null,
  expiresAt: 0,
};

export async function getLookoutToken() {
  const now = Date.now();

  // Reuse cached token if still valid
  if (tokenCache.token && tokenCache.expiresAt > now) {
    return tokenCache.token;
  }

  const url =
    process.env.LOOKOUT_TOKEN_URL || "https://api.lookout.com/oauth2/token";

  const rawAppKey = process.env.LOOKOUT_APP_KEY || "";

  // Hard fail if nothing is set
  if (!rawAppKey) {
    throw new Error("Missing LOOKOUT_APP_KEY env var");
  }

  // 🔑 Sanitize the key to avoid ERR_INVALID_CHAR in headers
  const appKey = rawAppKey.replace(/[\r\n]/g, "").trim();

  // Optional: basic sanity logging (no secret value exposed)
  if (rawAppKey !== appKey) {
    console.warn(
      "[LookoutAuth] LOOKOUT_APP_KEY contained whitespace/newlines; sanitized for header use"
    );
  }

  // You can also log length for debugging, without leaking the key:
  console.log(
    "[LookoutAuth] Using LOOKOUT_APP_KEY from env (length=%d chars)",
    appKey.length
  );

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${appKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error(
      "[LookoutAuth] Lookout token request failed:",
      res.status,
      text.substring(0, 300)
    );
    throw new Error(`Lookout token request failed: ${res.status}`);
  }

  const json = await res.json();

  tokenCache.token = json.access_token;
  tokenCache.expiresAt = now + (json.expires_in - 60) * 1000; // refresh 1 min early

  console.log("[LookoutAuth] Obtained Lookout access token (cached)");
  return tokenCache.token;
}
