// lookout-auth.mjs
import fetch from "node-fetch";

const tokenCache = {
  token: null,
  expiresAt: 0,
};

export async function getLookoutToken() {
  const now = Date.now();

  if (tokenCache.token && tokenCache.expiresAt > now) {
    return tokenCache.token;
  }

  const url = process.env.LOOKOUT_TOKEN_URL || "https://api.lookout.com/oauth2/token";
  const rawAppKey = process.env.LOOKOUT_APP_KEY;

  const appKey = (rawAppKey || "").trim();

  if (!appKey) {
    throw new Error("Missing LOOKOUT_APP_KEY env var (empty after trim)");
  }

  // Optional: one-time debug log so you can confirm there are no weird chars
  if (process.env.DEBUG_LOOKOUT_KEY === "1") {
    console.log("[DEBUG] LOOKOUT_APP_KEY length:", appKey.length);
  }

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
    const text = await res.text();
    throw new Error(`Lookout token request failed: ${res.status} ${text}`);
  }

  const json = await res.json();

  tokenCache.token = json.access_token;
  tokenCache.expiresAt = now + (json.expires_in - 60) * 1000;

  return tokenCache.token;
}
