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

  const url =
    process.env.LOOKOUT_TOKEN_URL || "https://api.lookout.com/oauth2/token";

  // 🔑 Read from env and strip any whitespace/newlines
  const rawAppKey = process.env.LOOKOUT_APP_KEY || "";
  const appKey = rawAppKey.replace(/\s+/g, ""); // removes \n, \r, spaces, tabs, etc.

  if (!appKey) {
    throw new Error("Missing LOOKOUT_APP_KEY env var (empty after trimming)");
  }

  // Optional: very safe debug to confirm shape (won't leak secret)
  if (rawAppKey.length !== appKey.length) {
    console.warn(
      "[LookoutAuth] LOOKOUT_APP_KEY contained whitespace; sanitized for header use."
    );
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
  tokenCache.expiresAt = now + (json.expires_in - 60) * 1000; // refresh 1 min early

  return tokenCache.token;
}
