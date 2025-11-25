# Deploying the Lookout → Okta SSF Transmitter on Google Cloud Run (Secret-Aware Model)

This runbook walks a customer / sales engineer through deploying the SSF transmitter to **Google Cloud Run**, using:

- **Google Secret Manager** for:
  - `LOOKOUT_APP_KEY`
  - (optional) `SSF_PRIVATE_KEY_PEM`
- **Artifact Registry** for container images
- **Okta Identity Threat Protection** for risk policies

---

## 1. Overview

Target flow:

1. Build + push the SSF container image.
2. Create **secrets** in Secret Manager.
3. Deploy to **Cloud Run** (first with a placeholder `SSF_ISSUER`).
4. Update the service with the real public URL as `SSF_ISSUER`.
5. Wire Okta SSF to the Cloud Run endpoint.
6. Validate end-to-end using a real Lookout risk change.

---

## 2. Prerequisites

You’ll need:

- A GCP project (e.g. `lookoutdemo-ssf`) with billing enabled.
- A Lookout tenant + App Key with access to `/mra/api/v2/devices`.
- An Okta Identity Engine org with Identity Threat Protection.
- `gcloud` CLI installed and up to date.
- Node.js (for key generation scripts, if used).

---

## 3. Login to Google Cloud

```bash
# Authenticate your user
gcloud auth login

# (Optional, but recommended) Application default credentials
gcloud auth application-default login

# Select your project and region
gcloud config set project <PROJECT_ID>
gcloud config set run/region us-central1
```

---

## 4. Clone the Repository

```bash
git clone https://github.com/franksrp-ld/ssf.git
cd ssf
```

Ensure the structure:

```bash
ssf/
  Dockerfile
  package.json
  package-lock.json
  src/
    server.mjs
    lookout-auth.mjs
    lookout-poll.mjs
    lookout-intake.mjs
    jwks.json
    private.pem   # local only; not committed
```

---

## 5. Create the SSF Signing Key (private.pem + jwks.json)

> [!TIP]
> For PoC, you can generate the key locally and bake it into the image.
> For production, consider storing it in Secret Manager and updating code to load from an env var.

### 5.1 Generate private.pem

```bash
mkdir -p src

openssl genrsa -out src/private.pem 2048
```

### 5.2 Generate jwks.json

If your repo has a helper script:

```bash
node gen-jwk.mjs
```

Otherwise, generate a JWK (via JOSE or another tool) and create src/jwks.json:

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

> [!IMPORTANT]
> Ensure kid matches the constant in src/lookout-intake.mjs.

--- 

## 6. Store Secrets in Google Secret Manager (Secure)

We’ll store:

- LOOKOUT_APP_KEY – Lookout API app key (string value).
- (Optional) SSF_PRIVATE_KEY_PEM – contents of private.pem.

### 6.1 Enable Secret Manager API

```bash
gcloud services enable secretmanager.googleapis.com
```

### 6.2 Create LOOKOUT_APP_KEY Secret

```bash
gcloud secrets create LOOKOUT_APP_KEY \
  --replication-policy="automatic"

# Add the current value
echo -n "<YOUR_LOOKOUT_APP_KEY>" | \
  gcloud secrets versions add LOOKOUT_APP_KEY --data-file=-
```

### 6.3 (Optional) Store Private Key as Secret

```bash
gcloud secrets create SSF_PRIVATE_KEY_PEM \
  --replication-policy="automatic"

gcloud secrets versions add SSF_PRIVATE_KEY_PEM \
  --data-file=src/private.pem
```

> [!NOTE]
> The current code reads from ./private.pem. 
> - For a fully secret-aware model, either:
> 	- Mount SSF_PRIVATE_KEY_PEM as a file at src/private.pem, or
> 	- Update lookout-intake.mjs to read from an env var instead of the file path.

---

## 7. Enable Required Cloud APIs

```bash
gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com
```

--- 

## 8. Environment Variables for Cloud Run

Core variables:
- SSF_ISSUER – the public HTTPS URL of the Cloud Run service (we’ll set it after first deploy).
- OKTA_ORG – your Okta org URL (no trailing slash).
- LOOKOUT_APP_KEY – sourced from Secret Manager.
- Optional: LOOKOUT_SINCE_MINUTES, LOOKOUT_POLL_INTERVAL_SECONDS, LOOKOUT_ENTERPRISE_GUID.

---

## 9. Build & Push Container Image (Artifact Registry)

```bash
PROJECT_ID=$(gcloud config get-value project)
REGION=us-central1
IMAGE_NAME=ssf-transmitter
REPO_ID=ssf-repo
IMAGE_URI="$REGION-docker.pkg.dev/$PROJECT_ID/$REPO_ID/$IMAGE_NAME:latest"
```

### 9.1 Create Artifact Repository (one-time)

```bash
gcloud artifacts repositories create "$REPO_ID" \
  --repository-format=docker \
  --location="$REGION" \
  --description="SSF transmitter images"
```

### 9.2 Build & Push

From the repo root:

```bash
gcloud builds submit --tag "$IMAGE_URI"
```

--- 

## 10. First Deploy (Placeholder SSF_ISSUER)

We’ll deploy once with a placeholder SSF_ISSUER and wire secrets.

```bash
SERVICE_NAME=ssf-transmitter

gcloud run deploy "$SERVICE_NAME" \
  --image "$IMAGE_URI" \
  --platform managed \
  --allow-unauthenticated \
  --set-env-vars OKTA_ORG="https://yourorg.okta.com" \
  --set-env-vars SSF_ISSUER="https://placeholder.example" \
  --set-secrets LOOKOUT_APP_KEY=LOOKOUT_APP_KEY:latest
```

> If you’ve updated the app to read the private key from an env var, also add:
> - --set-secrets SSF_PRIVATE_KEY_PEM=SSF_PRIVATE_KEY_PEM:latest

Capture the output:

```text
Service [ssf-transmitter] revision [...] has been deployed and is serving 100 percent of traffic.
Service URL: https://ssf-transmitter-xxxxxx-uc.a.run.app
```

That URL will become your **SSF_ISSUER**.

--- 

## 11. Update Service With REAL SSF_ISSUER

```bash
CLOUD_RUN_URL="https://ssf-transmitter-xxxxxx-uc.a.run.app"

gcloud run services update "$SERVICE_NAME" \
  --set-env-vars SSF_ISSUER="$CLOUD_RUN_URL"
```

You can combine everything in one update if needed:

```bash
gcloud run services update "$SERVICE_NAME" \
  --set-env-vars SSF_ISSUER="$CLOUD_RUN_URL",\
OKTA_ORG="https://yourorg.okta.com",\
LOOKOUT_SINCE_MINUTES="5",\
LOOKOUT_POLL_INTERVAL_SECONDS="60" \
  --set-secrets LOOKOUT_APP_KEY=LOOKOUT_APP_KEY:latest
```

--- 

## 12. Validate Deployment

### 12.1 Health Check

```bash
curl -i "$CLOUD_RUN_URL/healthz"
```

Expected:

```text
HTTP/2 200
ok
```

### 12.2 SSF Discovery

```bash
curl -s "$CLOUD_RUN_URL/.well-known/ssf-configuration" | jq
```

Verify:
- issuer == SSF_ISSUER (Cloud Run URL).
- jwks_uri points at ${SSF_ISSUER}/jwks.json.

### 12.3 JWKS

```bash
curl -s "$CLOUD_RUN_URL/jwks.json" | jq
```

Check:
- keys[0].kid equals your lookout-ssf-key-1 (or chosen KID).
- alg is RS256.

### 12.4 Logs

```bash
gcloud run services logs read "$SERVICE_NAME" \
  --region us-central1 \
  --limit 100
```

Look for:
- [LookoutPoll] Starting Lookout polling...
- [LookoutPoll] Received N devices from Lookout
- Okta SSF accepted SET: 202

--- 

## 13. Configure Okta SSF

In the Okta Admin console:
1.	**Security → Signals Providers**
2.	Add or edit the **Lookout SSF** provider.
3.	Set:
	- **Issuer URL** → SSF_ISSUER (Cloud Run URL)
	- **JWKS URL** → SSF_ISSUER/jwks.json
4.	Save and verify Okta can reach the JWKS endpoint.

Then configure:
- **Entity Risk Policies** (e.g., High risk → sign out).
- **Authentication Policies** (e.g., Medium risk → MFA).
- **App Sign-In Policies** for high-value apps.

--- 

## 14. Functional Test
1.	On a test device enrolled in Lookout, trigger a **Medium** or **High threat** (e.g., controlled malicious app / network).
2.	Wait for at least one poll interval (e.g., 60 seconds).
3.	Check Cloud Run logs:
	- [LookoutPoll] Sent risk event to /intake/lookout
	- Okta SSF accepted SET: 202
4.	In **Okta System Log**, filter for:
	- device-risk-change
5.	Attempt sign-in as that user:
	- High risk → session termination / blocked / restricted.
	- Medium risk → prompted for MFA.
	- Low risk → normal UX.
	
--- 

## 15. Production Hardening

For a production rollout:

- Mount private.pem from **Secret Manager** (or refactor app to read from env-var-based secrets).
- Restrict Cloud Run ingress if desired (e.g., only Okta IPs or via Cloud Armor).
- Front the service with a **custom domain** + managed certificate for a branded SSF issuer.
- Use **Workload Identity** instead of static credentials where applicable.
- Turn on **Cloud Logging / Monitoring** alerts for SSF or Lookout API failures.

