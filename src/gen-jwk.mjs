#!/usr/bin/env node
// gen-jwk.mjs
//
// Generate jwks.json from an RSA public key (public.pem) for SSF.
//
// Usage:
//   cd ssf/src
//   node gen-jwk.mjs                 # uses ./public.pem -> ./jwks.json
//   node gen-jwk.mjs ./public.pem    # custom public key path
//   node gen-jwk.mjs ./public.pem ./jwks.json my-custom-kid
//
// Notes:
// - Make sure you already generated an RSA keypair, for example:
//     openssl genrsa -out private.pem 2048
//     openssl rsa -in private.pem -pubout -out public.pem
// - Keep private.pem OUT of Git and out of jwks.json.

import { readFileSync, writeFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { importSPKI, exportJWK } from "jose";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// CLI args: [node, gen-jwk.mjs, publicPath?, jwksPath?, kid?]
const PUBLIC_PEM_PATH =
  process.argv[2] || join(__dirname, "public.pem");
const JWKS_OUT_PATH =
  process.argv[3] || join(__dirname, "jwks.json");
const KID =
  process.argv[4] || process.env.SSF_JWK_KID || "lookout-ssf-key-1";

async function main() {
  if (!existsSync(PUBLIC_PEM_PATH)) {
    console.error(
      `❌ public.pem not found.\n` +
        `Looked for: ${PUBLIC_PEM_PATH}\n\n` +
        `Make sure you:\n` +
        `  1) Are running this from the correct directory (e.g. ssf/src)\n` +
        `  2) Have generated a public key, for example:\n` +
        `       openssl genrsa -out private.pem 2048\n` +
        `       openssl rsa -in private.pem -pubout -out public.pem\n`
    );
    process.exit(1);
  }

  console.log(`🔑 Reading public key from: ${PUBLIC_PEM_PATH}`);
  const spki = readFileSync(PUBLIC_PEM_PATH, "utf8");

  let key;
  try {
    key = await importSPKI(spki, "RS256");
  } catch (err) {
    console.error("❌ Failed to parse public.pem as SPKI (RSA) key:");
    console.error(err);
    process.exit(1);
  }

  const jwk = await exportJWK(key);

  // Enrich JWK with SSF-relevant metadata
  jwk.use = "sig";
  jwk.alg = "RS256";
  jwk.kid = KID;

  const jwks = { keys: [jwk] };

  writeFileSync(JWKS_OUT_PATH, JSON.stringify(jwks, null, 2));
  console.log("✅ Wrote JWKS to:", JWKS_OUT_PATH);
  console.log("   kid:", jwk.kid);
  console.log("   kty:", jwk.kty, "alg:", jwk.alg, "use:", jwk.use);
}

main().catch((err) => {
  console.error("❌ Unexpected error in gen-jwk.mjs:", err);
  process.exit(1);
});
