# Deploying the Lookout → Okta SSF Transmitter to Google Cloud Run

This guide walks through deploying the Lookout → Okta SSF Transmitter to Google Cloud Run, wiring it up to Lookout Mobile Risk and Okta Identity Threat Protection.

The flow:
	1.	Build a container image from your ssf repo
	2.	Push it to Artifact Registry or Container Registry
	3.	Deploy to Cloud Run
	4.	Configure environment variables
	5.	Validate health + SSF discovery
	6.	Point Okta SSF at the new URL

---

## 0. Prerequisites

You’ll need:
- A GCP project (e.g. lookoutdemo-ssf)
- Billing enabled for the project
- The gcloud CLI installed and logged in
- Node.js app already in GitHub at franksrp-ld/ssf (or local clone)
- A **private key** (private.pem) and matching **JWKS** (jwks.json) already in src/

> ⚠️ **Security note:**
> private.pem should **not be committed to GitHub**. Keep it only in your local working directory when building your image, or use Secret Manager in production.

---

## 1. Clone the Repo Locally

If you haven’t already:

```bash
git clone https://github.com/franksrp-ld/ssf.git
cd ssf
```

Ensure your tree looks like:

```text
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
    private.pem   (local only, not in GitHub)
```

---
    
## 2. Configure gcloud for Your Project

```bash
gcloud auth login
gcloud config set project <PROJECT_ID>
gcloud config set run/region us-central1   # or your preferred region
```

If this is the first Cloud Run deployment in the project, enable APIs:

```bash
gcloud services enable run.googleapis.com \
                       artifactregistry.googleapis.com \
                       cloudbuild.googleapis.com
```
   
---
                       
## 3. Build & Push the Container Image

We’ll use a simple Artifact Registry path:

```bash
PROJECT_ID=$(gcloud config get-value project)
REGION=us-central1
IMAGE_NAME=ssf-transmitter
IMAGE_URI="us-central1-docker.pkg.dev/$PROJECT_ID/ssf-repo/$IMAGE_NAME:latest"
```

### 3.1 Create an Artifact Registry Repo (once per project)

```bash
gcloud artifacts repositories create ssf-repo \
  --repository-format=docker \
  --location=$REGION \
  --description="SSF transmitter images"
```
  
### 3.2 Build & Push via Cloud Build

From the root of your ssf repo:

```bash
gcloud builds submit --tag "$IMAGE_URI"
```

Cloud Build will:
	- Build using your Dockerfile
	- Push the image to us-central1-docker.pkg.dev/$PROJECT_ID/ssf-repo/ssf-transmitter:latest
	
---
	
## 4. Environment Variables for Cloud Run

These are the minimum required env vars:
- SSF_ISSUER – Public HTTPS URL of your SSF service (Cloud Run URL)
- OKTA_ORG – Your Okta org URL, e.g. https://integrator-2974929.okta.com
- LOOKOUT_APP_KEY – Lookout App Key used to acquire OAuth tokens
	
Optional tuning knobs:
- LOOKOUT_SINCE_MINUTES – Polling lookback window (default 5)
- LOOKOUT_POLL_INTERVAL_SECONDS – Polling interval (default 60)
- LOOKOUT_ENTERPRISE_GUID – To scope to a single Lookout tenant

You won’t know the final SSF_ISSUER (the Cloud Run URL) until after the first deploy, so we use a two-pass deployment:
1.	First deploy with a placeholder SSF_ISSUER
2.	Capture the Cloud Run URL
3.	Update the service with the real SSF_ISSUER
	
---
	
## 5. First Deploy to Cloud Run (Placeholder Issuer)

```bash
SERVICE_NAME=ssf-transmitter

gcloud run deploy "$SERVICE_NAME" \
  --image "$IMAGE_URI" \
  --platform managed \
  --allow-unauthenticated \
  --set-env-vars SSF_ISSUER=https://placeholder \
  --set-env-vars OKTA_ORG=https://integrator-2974929.okta.com \
  --set-env-vars LOOKOUT_APP_KEY=<YOUR_LOOKOUT_APP_KEY>
```

When this finishes, note the URL printed by gcloud, e.g.:

```text
Service [ssf-transmitter] revision [ssf-transmitter-00001-xxx] has been deployed and is serving 100 percent of traffic.
Service URL: https://ssf-transmitter-abc123-uc.a.run.app
```

---

## 6. Update Service With Real SSF_ISSUER

Now that you have the real URL, set SSF_ISSUER correctly:

```bash
CLOUD_RUN_URL="https://ssf-transmitter-abc123-uc.a.run.app"  # replace with yours

gcloud run services update "$SERVICE_NAME" \
  --set-env-vars SSF_ISSUER="$CLOUD_RUN_URL"
```
  
You can also tweak polling knobs at the same time, for example:

```bash
gcloud run services update "$SERVICE_NAME" \
  --set-env-vars SSF_ISSUER="$CLOUD_RUN_URL",\
OKTA_ORG="https://integrator-2974929.okta.com",\
LOOKOUT_APP_KEY="<YOUR_LOOKOUT_APP_KEY>",\
LOOKOUT_SINCE_MINUTES="5",\
LOOKOUT_POLL_INTERVAL_SECONDS="60"
```

---

## 7. Validate the Service

### 7.1 Health Check

```bash
curl -i "$CLOUD_RUN_URL/healthz"
```

Expected:

```text
HTTP/2 200
ok
```

### 7.2 SSF Discovery Document

```bash
curl -s "$CLOUD_RUN_URL/.well-known/ssf-configuration" | jq
```

You should see:
- issuer equal to your SSF_ISSUER
- jwks_uri pointing at /jwks.json
- events_supported including Okta device-risk-change

### 7.3 JWKS

```bash
curl -s "$CLOUD_RUN_URL/jwks.json" | jq
```

Confirm:
- keys[0].kid matches the KID used in your lookout-intake.mjs
- kty is RSA, alg is RS256

### 7.4 Logs

Verify polling + SET publishing:

```bash
gcloud run services logs read "$SERVICE_NAME" \
  --region us-central1 \
  --limit 100
```
  
Look for log lines:
- [LookoutPoll] Starting Lookout polling...
- [LookoutPoll] Received N devices from Lookout
- Okta SSF accepted SET: 202
- Or error details if something failed

---
	
## 8. Wire Okta To the New SSF Endpoint

In Okta Admin (high level):
1.	**Security → Signals Providers**
2.	Add / edit your Lookout SSF Provider
3.	Set:
	- **Issuer URL** = SSF_ISSUER (your Cloud Run URL)
	- **JWKS URL** = SSF_ISSUER/jwks.json
4.	Upload the **public key / or configure JWKS** as required
5.	Save & verify Okta can fetch the configuration

Then confirm:
- Entity Risk Policy is configured (High-risk logout, etc.)
- Authentication / App Sign-in policies consume risk

---

## 9. Functional Test
1.	On a Lookout-enrolled device, trigger a High or Medium risk state
2.	Wait for the poll interval (default 60s)
3.	Check Cloud Run logs for:
	- [LookoutPoll] Sent risk event to /intake/lookout
	- Okta SSF accepted SET: 202
4.	In **Okta System Log**, search for security.events.provider.receive_event and device_risk_change
5.	Attempt sign-in as that user and validate:
	- High risk → session termination / blocked
	- Medium risk → forced MFA
	- Low risk → normal experience

---

## 10. Hardening Notes (Production)

For a production-grade deployment:
- Move private.pem to **Secret Manager** or KMS-managed storage
- Use **Workload Identity** instead of long-lived credentials
- Lock down Cloud Run ingress (e.g., only Okta / Lookout / admin IPs) if required
- Put Cloud Run behind a **custom domain** + managed certificate if you want a pretty SSF issuer URL

---
	
# Secret Manager–Aware Deployment on Google Cloud Run

This variant keeps all sensitive material in **Google Secret Manager**:
- private.pem (SSF signing key)
- LOOKOUT_APP_KEY (Lookout API app key)

Cloud Run loads them as environment variables at runtime; your container image stays clean.

---

## 1. Small Code Change: Read Private Key from Env Var

Today lookout-intake.mjs reads ./private.pem from disk.
We’ll change it to read from process.env.SSF_PRIVATE_KEY_PEM instead.

### 1.1. Update src/lookout-intake.mjs

Replace the top of the file with this:

```js
// lookout-intake.mjs
import { SignJWT, importPKCS8 } from "jose";
import crypto from "crypto";

const ISSUER   = process.env.SSF_ISSUER;
const OKTA_ORG = process.env.OKTA_ORG;

if (!ISSUER)   throw new Error("Missing SSF_ISSUER");
if (!OKTA_ORG) throw new Error("Missing OKTA_ORG");

const ALG = "RS256";
const KID = "lookout-ssf-key-1";

// NEW: private key comes from Secret Manager via env var
const PRIVATE_KEY_PEM = process.env.SSF_PRIVATE_KEY_PEM;
if (!PRIVATE_KEY_PEM) {
  throw new Error("Missing SSF_PRIVATE_KEY_PEM env var");
}

let privateKeyPromise;

/**
 * Lazily parse the private key from SSF_PRIVATE_KEY_PEM using JOSE
 */
async function getPrivateKey() {
  if (!privateKeyPromise) {
    privateKeyPromise = importPKCS8(PRIVATE_KEY_PEM, ALG);
  }
  return privateKeyPromise;
}
```
Keep the rest of the file (normalizeRiskLevel, sendSetToOkta, handleLookoutIntake) as-is.

### 1.2. Remove Local private.pem From the Image
- Delete src/private.pem from the repo (if it’s there)
- Ensure .gitignore contains:
	
```gitignore
# Keys
private.pem
*.key
*.pem
```

From now on the only source of the private key will be Secret Manager.

---

## 2. Create Secrets in Google Secret Manager

### 2.1. Enable Secret Manager API

```bash
PROJECT_ID=$(gcloud config get-value project)

gcloud services enable secretmanager.googleapis.com \
  --project "$PROJECT_ID"
```

### 2.2. Create the SSF Private Key Secret

Create a file private.pem locally (or reuse your existing one).
It should look like:

```text
-----BEGIN PRIVATE KEY-----
<base64 lines>
-----END PRIVATE KEY-----
```
Then:

```bash
gcloud secrets create ssf-private-key \
  --replication-policy="automatic" \
  --project "$PROJECT_ID"

gcloud secrets versions add ssf-private-key \
  --data-file=src/private.pem \
  --project "$PROJECT_ID"
```
> [!NOTE]
> You can also paste the PEM directly in the console UI instead of using --data-file.

### 2.3. Create the Lookout App Key Secret

```bash
gcloud secrets create lookout-app-key \
  --replication-policy="automatic" \
  --project "$PROJECT_ID"

echo -n "<YOUR_LOOKOUT_APP_KEY>" | \
gcloud secrets versions add lookout-app-key \
  --data-file=- \
  --project "$PROJECT_ID"
```
---

## 3. Grant Cloud Run Runtime Access to Secrets

Identify the Cloud Run service account. By default:

```bash
SA_EMAIL="$(gcloud iam service-accounts list \
  --filter='Compute Engine default service account' \
  --format='value(email)' \
  --project "$PROJECT_ID")"

echo "$SA_EMAIL"
```

Grant it Secret Manager Secret Accessor:

```bash
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:$SA_EMAIL" \
  --role="roles/secretmanager.secretAccessor"
```

---

## 4. Rebuild and Push the Image

From the repo root:

```bash
REGION=us-central1
IMAGE_NAME=ssf-transmitter
IMAGE_URI="us-central1-docker.pkg.dev/$PROJECT_ID/ssf-repo/$IMAGE_NAME:latest"

# If you haven't created the repo yet:
gcloud artifacts repositories create ssf-repo \
  --repository-format=docker \
  --location=$REGION \
  --description="SSF transmitter images" || true

gcloud builds submit --tag "$IMAGE_URI"
```

---

## 5. Deploy to Cloud Run With Secrets

We’ll:
- Inject SSF_PRIVATE_KEY_PEM from ssf-private-key
- Inject LOOKOUT_APP_KEY from lookout-app-key
- Set SSF_ISSUER and OKTA_ORG as normal env vars

### 5.1. First Deploy (with placeholder SSF_ISSUER)

```bash
SERVICE_NAME=ssf-transmitter

gcloud run deploy "$SERVICE_NAME" \
  --image "$IMAGE_URI" \
  --platform managed \
  --region "$REGION" \
  --allow-unauthenticated \
  --set-env-vars SSF_ISSUER=https://placeholder,OKTA_ORG=https://integrator-2974929.okta.com \
  --set-secrets SSF_PRIVATE_KEY_PEM=ssf-private-key:latest,LOOKOUT_APP_KEY=lookout-app-key:latest
```

This does two key things:
	- Sets **regular env vars**: SSF_ISSUER, OKTA_ORG
	- Sets **secret-backed env vars**:
		- SSF_PRIVATE_KEY_PEM ← secret ssf-private-key
		- LOOKOUT_APP_KEY ← secret lookout-app-key

> [!NOTE]
> No secrets are in the container image or command line arguments.

When deploy finishes, gcloud prints the service URL, e.g.:

```text
Service URL: https://ssf-transmitter-abc123-uc.a.run.app
```

---

## 6. Update SSF_ISSUER to the Real URL

```bash
CLOUD_RUN_URL="https://ssf-transmitter-abc123-uc.a.run.app"  # replace with yours

gcloud run services update "$SERVICE_NAME" \
  --region "$REGION" \
  --set-env-vars SSF_ISSUER="$CLOUD_RUN_URL",OKTA_ORG="https://integrator-2974929.okta.com"
```

Secrets are **unchanged**; they continue to flow from Secret Manager.

---

## 7. Validate the Secret-Backed Service

### 7.1. Health

```bash
curl -i "$CLOUD_RUN_URL/healthz"
```

Expect 200 ok.

### 7.2. SSF Discovery

```bash
curl -s "$CLOUD_RUN_URL/.well-known/ssf-configuration" | jq
```

Confirm:
- issuer == CLOUD_RUN_URL
- jwks_uri ends with /jwks.json

### 7.3. Logs

```bash
gcloud run services logs read "$SERVICE_NAME" \
  --region "$REGION" \
  --limit 100
```

You **should not** see errors like “Missing SSF_PRIVATE_KEY_PEM” or “Missing LOOKOUT_APP_KEY”.

You should see:
- [LookoutPoll] Starting Lookout polling...
- [LookoutPoll] Received N devices from Lookout
- Okta SSF accepted SET: 202
	
---

## 8. Okta & Lookout Wiring (Same As Before)

Once the service is healthy:
1.	Configure **Okta Signals Provider** with:
	- Issuer: CLOUD_RUN_URL
	- JWKS: CLOUD_RUN_URL/jwks.json
2.	Ensure **Entity Risk Policy**, **Authentication Policy**, and **App Sign-In Policy** are configured to consume device risk.
3.	Generate risk events in Lookout and verify they flow into Okta via System Log + your policies.

---

## 9. Operational Notes
- **Rotating the private key**
	- Add a new secret version for ssf-private-key
	- Optionally change KID and rotate jwks.json accordingly
	- Redeploy the service (or force new revision)
- **Rotating the Lookout App Key**
	- Add new version to lookout-app-key
	- Cloud Run automatically uses the latest version when the revision restarts (you can trigger by gcloud run services update with a no-op env var change)
- **Hard failures**
	- If secrets are missing or IAM is misconfigured, the app will throw on startup (Missing SSF_PRIVATE_KEY_PEM / Missing LOOKOUT_APP_KEY). Cloud Run revision will show as unhealthy, making it obvious during rollout.
