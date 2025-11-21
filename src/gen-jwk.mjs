// gen-jwk.mjs
import { readFileSync, writeFileSync } from "fs";
import { importSPKI, exportJWK } from "jose";

async function main() {
  const spki = readFileSync("public.pem", "utf8");
  const key = await importSPKI(spki, "RS256");
  const jwk = await exportJWK(key);

  jwk.use = "sig";
  jwk.alg = "RS256";
  jwk.kid = "lookout-ssf-key-1";

  const jwks = { keys: [jwk] };

  writeFileSync("jwks.json", JSON.stringify(jwks, null, 2));
  console.log("Wrote jwks.json with kid:", jwk.kid);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});