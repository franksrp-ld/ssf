# Deploying the Lookout → Okta SSF Transmitter on Google Cloud Run
**Secret Manager–Aware Deployment Model**

This guide walks customers and sales engineers through deploying the SSF Transmitter to **Google Cloud Run**, using **Secret Manager** for all sensitive data, and wiring it into Lookout Mobile Risk + Okta Identity Threat Protection.

---

## 0. Overview

The SSF Transmitter continuously polls Lookout Mobile Risk, converts device posture changes into SSF-compliant Security Event Tokens (SET), signs them with RS256, and sends them to Okta.

```text
Lookout Mobile Risk API
        │
        ▼
SSF Transmitter (AWS App Runner)
        • Poll Lookout risk
        • Normalize risk levels
        • Sign SET → RS256
        • Publish to Okta SSF device-risk-change
        ▼
Okta Identity Threat Protection
        ▼
Adaptive Access Policies (MFA, block, logout, etc.)
```

Target flow:

1. Build + push the SSF container image.
2. Create **secrets** in Secret Manager.
3. Deploy to **Cloud Run** (first with a placeholder `SSF_ISSUER`).
4. Update the service with the real public URL as `SSF_ISSUER`.
5. Wire Okta SSF to the Cloud Run endpoint.
6. Validate end-to-end using a real Lookout risk change.

---

## 1. Prerequisites

You’ll need:

- A GCP project (e.g. `lookoutdemo-ssf`) with billing enabled.
- `gcloud` CLI installed and up to date.
- Git installed 
- A Lookout tenant + App Key with access to Mobile Risk API (MRA).
- An Okta Identity Engine org with Identity Threat Protection.
- Node.js (for key generation scripts, if used).
- A local clone of this repo

---

## 2. Login to Google Cloud
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

## 3. Enable Required Cloud APIs
```bash
gcloud services enable \
  run.googleapis.com \
  secretmanager.googleapis.com \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com
```

---  

## 4. Clone the Repository
```bash
git clone https://github.com/franksrp-ld/ssf.git
cd ssf
```

### Ensure the structure:
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

### Generate private key (2048-bit RSA)
```bash
openssl genpkey -algorithm RSA \
  -pkeyopt rsa_keygen_bits:2048 \
  -out src/private.pem
```

### Generate matching public key
```bash
openssl rsa -in src/private.pem -pubout -out src/public.pem
```

### Install dependencies from repo root: (if not already done)
```bash
cd ~/ssf
npm install
```

### Generate jwks.json from the public key

Run the generator from the repo root:
```bash
cd ~/ssf
node src/gen-jwk.mjs
```
Expected output will look something like:
```bash
Reading public key from: /Users/you/ssf/src/public.pem
Wrote JWKS to: /Users/you/ssf/src/jwks.json
kid: lookout-ssf-key-1
```

### Verify src/ now contains:
```text
src/private.pem
src/jwks.json
```

And a quick peek at the JWKS:
```bash
cat src/jwks.json
```

You should see a JSON blob like:
```json
{
  "keys": [
    {
      "kty": "RSA",
      "n": "....",
      "e": "AQAB",
      "use": "sig",
      "alg": "RS256",
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
- SSF_SIGNING_KEY – contents of private.pem.

### Upload SSF Signing Key (private.pem)
```bash
gcloud secrets create SSF_SIGNING_KEY --data-file=src/private.pem
```

### Upload Lookout App Key

Replace LOOKOUT_APP_KEY with the real value:
```bash
printf "%s" "LOOKOUT_APP_KEY" | \
  gcloud secrets create LOOKOUT_APP_KEY --data-file=-
```

---

## ❗ STOP NOW AND VERIFY SECRETS

Run:
```bash
gcloud secrets list
```

Expected:

| SECRET NAME | PURPOSE |
| --- | --- |
| SSF_SIGNING_KEY | RS256 private.pem |
| LOOKOUT_APP_KEY | Lookout API key |

If this list is missing anything → STOP and fix.

---

### Create a Dedicated Cloud Run Service Account

Create a dedicated SA for the SSF transmitter.
```bash
PROJECT_ID=$(gcloud config get-value project)

gcloud iam service-accounts create ssf-transmitter-sa \
  --display-name="SSF Transmitter Service Account"
```

Just to confirm:
```bash
gcloud iam service-accounts list \
  --filter="email:ssf-transmitter-sa"
```

The service account email will be:
```text
ssf-transmitter-sa@${PROJECT_ID}.iam.gserviceaccount.com
```

### Grant Secret Accessor Role to the Service Account
```bash
SA_EMAIL="ssf-transmitter-sa@${PROJECT_ID}.iam.gserviceaccount.com"

gcloud secrets add-iam-policy-binding LOOKOUT_APP_KEY \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/secretmanager.secretAccessor"

gcloud secrets add-iam-policy-binding SSF_SIGNING_KEY \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/secretmanager.secretAccessor"
```

---

## 7. Where Environment Variables Are Stored (Important)

Cloud Run uses two sources for environment variables:

| Type | Where It Lives | What We Use It For |
| --- | --- | --- |
| Environment Vars | Stored in Cloud Run service definition | Non-sensitive values (URLs, toggles) |
| Secret Manager Env Vars | Stored as secret mounts or injected env-vars | Sensitive values (private key, Lookout App Key) |

### Our mapping:

| Purpose | Storage | Example |
| --- | --- | --- |
| LOOKOUT_APP_KEY | Secret Manager | Injected via --set-secrets |
| SSF_SIGNING_KEY | Secret Manager | Injected via --set-secrets |
| SSF_ISSUER | Cloud Run Env Var | the public HTTPS URL of the Cloud Run service (we’ll set it after first deploy) |
| OKTA_ORG | Cloud Run Env Var | your Okta org URL (no trailing slash) | 
| Polling configs | Cloud Run Env Vars | Non-sensitive | 

--- 

## 8. Build & Push Container Image

### Set Helper Variables
```bash
PROJECT_ID="<PROJECT_ID>"
REGION="us-central1"
REPO_NAME="ssf-repo"
IMAGE_NAME="ssf-transmitter"

IMAGE_URI="$REGION-docker.pkg.dev/${PROJECT_ID}/$REPO_NAME/${IMAGE_NAME}"
```

Check:
```bash
echo "${IMAGE_URI}"
```

Expected format:
```text
us-central1-docker.pkg.dev/<PROJECT_ID>/ssf-repo/ssf-transmitter
```

### Create the Artifact Registry Repository (one-time)
```bash
gcloud artifacts repositories create $REPO_NAME \
  --repository-format=docker \
  --location=$REGION \
  --description="Repository for SSF transmitter"
```

Verify:
```bash
gcloud artifacts repositories list --location $REGION
```

You should see:
```text
ssf-repo   DOCKER  us-central1
```

### Build & Push the Container Image (Cloud Build):

Run this from the root of your repository:
```
cd ~/ssf

gcloud builds submit --tag "${IMAGE_URI}"
```

What this does:
- Uploads your repo to Cloud Build
- Runs your Dockerfile
- Pushes the built image into Artifact Registry

Expected successful output:
```text
DONE
PUSH
latest: digest: sha256:xxxxxx size: 1234
```

### Verify the Image Exists
```bash
gcloud artifacts docker images list $IMAGE_URI
```

Or list the repo:
```bash
gcloud artifacts docker images list \
  $REGION-docker.pkg.dev/$PROJECT_ID/$REPO_NAME
```

You should see:
```text
IMAGE                          TAGS     DIGEST        ...
ssf-transmitter                latest   sha256:abc123
```

--- 

## 9. First Deploy (Placeholder SSF_ISSUER)

We’ll deploy once with a placeholder SSF_ISSUER and wire secrets.
```bash
SERVICE_NAME="ssf-transmitter"
IMAGE_NAME="ssf-transmitter"
IMAGE_URI="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO_NAME}/${IMAGE_NAME}"
SA_EMAIL="ssf-transmitter-sa@${PROJECT_ID}.iam.gserviceaccount.com"

gcloud run deploy "${SERVICE_NAME}" \
  --image "${IMAGE_URI}:latest" \
  --region "${REGION}" \
  --platform managed \
  --allow-unauthenticated \
  --service-account="${SA_EMAIL}" \
  --set-env-vars OKTA_ORG="<Your Okta Org URL>",SSF_ISSUER="https://placeholder" \
  --set-secrets LOOKOUT_APP_KEY=LOOKOUT_APP_KEY:latest \
  --set-secrets SSF_SIGNING_KEY=SSF_SIGNING_KEY:latest \
```

### Record the service URL:
```text
Service URL: https://ssf-transmitter-xxxxxx-uc.a.run.app
```

That URL will become your **SSF_ISSUER**.

--- 

## 10. Update Service With REAL SSF_ISSUER
```bash
gcloud run services update ssf-transmitter \
  --set-env-vars SSF_ISSUER="$SERVICE_URL"
```

--- 

## 11. Validate Deployment

### Health Check
```bash
curl -i "$SERVICE_URL/healthz"
```

Expected:
```text
HTTP/2 200
ok
```

### SSF Discovery
```bash
curl -s "$SERVICE_URL/.well-known/ssf-configuration" | jq
```

Verify:
- issuer == SSF_ISSUER (Cloud Run URL).
- jwks_uri points at ${SSF_ISSUER}/jwks.json.

### JWKS
```bash
curl -s "$SERVICE_URL/jwks.json" | jq
```

Check:
- keys[0].kid equals your lookout-ssf-key-1 (or chosen KID).
- alg is RS256.

### Logs
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

## 12. Configure Okta SSF

In the Okta Admin console:
1.	**Security → Signals Providers**
2.	Add or edit the **Lookout SSF** provider.
3.	Set:
	- **Issuer URL** → SSF_ISSUER
	- **JWKS URL** → SSF_ISSUER/jwks.json
4.	Save and verify Okta can reach the JWKS endpoint.

Then configure:
- **Entity Risk Policies** (e.g., High risk → sign out).
- **Authentication Policies** (e.g., Medium risk → MFA).
- **App Sign-In Policies** for high-value apps.

--- 

## 13. Functional Test
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

## 14. Production Hardening

For a production rollout:

- Mount private.pem from **Secret Manager** (or refactor app to read from env-var-based secrets).
- Restrict Cloud Run ingress if desired (e.g., only Okta IPs or via Cloud Armor).
- Front the service with a **custom domain** + managed certificate for a branded SSF issuer.
- Use **Workload Identity** instead of static credentials where applicable.
- Turn on **Cloud Logging / Monitoring** alerts for SSF or Lookout API failures.

