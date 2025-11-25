# Lookout → Okta SSF Transmitter

A lightweight, cloud-deployable service that converts **Lookout Mobile Risk** signals into **Okta Shared Signals Framework (SSF)** Security Event Tokens (SETs).

This enables risk-aware enforcement in Okta Identity Threat Protection:

- 🚫 **High Risk → Logout + Block / Restrict**
- ⚠️ **Medium Risk → MFA Step-Up**
- 🟢 **Low Risk → Normal Access**
- ❓ **Unknown Risk → Step-Up (configurable)**

The service:

1. Polls Lookout’s **Mobile Risk API v2**.
2. Normalizes device risk (`THREATS_*` → `low/medium/high`).
3. Builds **device-risk-change** SSF events.
4. Signs them with an **RS256 private key**.
5. Delivers them to **Okta’s Security Events API**.

---

## 📐 High-Level Architecture

```text
Lookout Mobile Risk API (mra/api/v2/devices)
         │
         ▼
Lookout → Okta SSF Transmitter (this service)
    • Polls Lookout devices on a schedule
    • Normalizes Lookout risk → low / medium / high
    • Builds SSF device-risk-change SETs
    • Signs with RS256 private key
    • POSTs SETs to Okta Security Events API
         │
         ▼
Okta Identity Threat Protection
    • Entity Risk Policies
    • Authentication Policies
    • App Sign-In Policies
         │
         ▼
User Experience
    • Block / restrict access
    • Logout + revoke sessions
    • Enforce MFA step-up
    • Allow normal access
```

---

## 📁 Repository Structure

```text
ssf/
├─ src/
│   ├─ server.mjs
│   ├─ lookout-auth.mjs
│   ├─ lookout-poll.mjs
│   ├─ lookout-intake.mjs
│   ├─ jwks.json          # public JWKs (matches private key)
│   └─ private.pem        # SSF signing key (DO NOT COMMIT)
│
├─ Dockerfile
├─ package.json
├─ package-lock.json
├─ .gitignore
└─ README.md
```

> 🔒 **Security**:
> -src/private.pem must never be committed to Git. Treat it as a deployment-only artifact (or move it entirely into your cloud secret store).

---

## 🔑 SSF Signing Key & JWKS

The transmitter signs SSF events using RS256 and publishes the corresponding public key via /jwks.json.

1. Generate the keypair (local)

From the repo root:

```bash
mkdir -p src
openssl genrsa -out src/private.pem 2048
```

2. Create jwks.json

You can either:

- Use the provided Node helper script (if present in the repo), e.g.:

```bash
node gen-jwk.mjs
```

*or*

- Use a JOSE tool / script to convert private.pem → JWK, then write src/jwks.json with a structure like:

```json
{
  "keys": [
    {
      "kty": "RSA",
      "n": "<base64url-modulus>",
      "e": "AQAB",
      "alg": "RS256",
      "use": "sig",
      "kid": "lookout-ssf-key-1"
    }
  ]
}
```

Make sure:

- kid in jwks.json matches the KID constant in lookout-intake.mjs.
- The private key in private.pem and the public key in jwks.json are generated from the same keypair.

---

## 🌍 Supported Deployment Targets

This repo is designed to deploy to:
- Google Cloud Run
- AWS App Runner
- Azure Container Apps

Each platform has a dedicated runbook:
- docs/gcp-cloud-run.md
- docs/aws-app-runner.md
- docs/azure-container-apps.md

---

## 🔌 Core Environment Variables

| Variable | Required | Description |
| --- | --- | --- |
| SSF_ISSUER | Yes | Public HTTPS base URL of this service (Cloud Run / App Runner / ACA URL). |
| OKTA_ORG | Yes | Okta Org URL (e.g. https://yourorg.okta.com), **no trailing slash**. |
| LOOKOUT_APP_KEY | Yes | Lookout App Key used for OAuth token requests. |
| LOOKOUT_BASE_URL | No | Defaults to https://api.lookout.com. |
| LOOKOUT_TOKEN_URL | No | Defaults to https://api.lookout.com/oauth2/token. |
| LOOKOUT_SINCE_MINUTES | No | Poll window; default 5 minutes. |
| LOOKOUT_POLL_INTERVAL_SECONDS | No | Poll interval; default 60 seconds. |
| LOOKOUT_ENTERPRISE_GUID | Optional | Restrict polling to a single Lookout tenant (optional). |
| PORT | No | App listening port; default 8080. |

> In cloud deployments, sensitive values like LOOKOUT_APP_KEY and private.pem should be sourced from:
> - GCP: Secret Manager
> - AWS: Secrets Manager / SSM Parameter Store
> - Azure: Key Vault

Each provider guide walks through a secret-aware pattern.

---

## 🔗 Next Steps

Pick your platform:

- Deploy to Google Cloud Run￼
- Deploy to AWS App Runner￼
- Deploy to Azure Container Apps￼
