# Deploying the Lookout → Okta SSF Transmitter on AWS App Runner
**Secret Manager–Aware Deployment Model**

This guide walks customers and sales engineers through deploying the SSF Transmitter to **AWS App Runner**, using **AWS Secrets Manager** for all sensitive data, and wiring it into Lookout Mobile Risk + Okta Identity Threat Protection.

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

- An AWS account with admin or sufficient IAM privileges.
- `AWS` CLI installed and up to date.
- An ECR (Elastic Container Registry) enabled
- A Docker or another container builder
- Git installed 
- A Lookout tenant + App Key with access to Mobile Risk API (MRA).
- An Okta Identity Engine org with Identity Threat Protection.
- Node.js (for key generation scripts, if used).
- A local clone of this repo

---

## 2. Authenticate to AWS

Log in to AWS and configure credentials:

```bash
aws configure
```

Log in to ECR:

```bash
aws ecr get-login-password --region us-east-1 \
  | docker login --username AWS --password-stdin <ACCOUNT_ID>.dkr.ecr.us-east-1.amazonaws.com
```

---

## 3. Clone the Repository

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

## 4. Create the SSF Signing Key (private.pem + jwks.json)

> [!TIP]
> For PoC, you can generate the key locally and bake it into the image.
> For production, consider storing it in Secret Manager and updating code to load from an env var.

### Generate private.pem

```bash
openssl genpkey -algorithm RSA -out private.pem -pkeyopt rsa_keygen_bits:2048
```

### Generate jwks.json

```bash
node gen-jwk.mjs
```

### Verify src/ now contains:

```text
src/private.pem
src/jwks.json
```

> [!IMPORTANT]
> Ensure kid matches the constant in src/lookout-intake.mjs.

--- 

## 5. Store Secrets in AWS Secrets Manager (Secure)

We’ll store:

- LOOKOUT_APP_KEY – Lookout API app key (string value).
- (Optional) SSF_PRIVATE_KEY_PEM – contents of private.pem.

### Create secret for Lookout App Key:

```bash
aws secretsmanager create-secret \
  --name LOOKOUT_APP_KEY \
  --secret-string "<YOUR_LOOKOUT_APP_KEY>"m
```

### Create secret for SSF private key:

```bash
aws secretsmanager create-secret \
  --name SSF_PRIVATE_KEY_PEM \
  --secret-string file://src/private.pem
```

### (Optional) Store Okta Org URL in Secrets Manager

```bash
aws secretsmanager create-secret \
  --name OKTA_ORG \
  --secret-string "https://<your-okta-tenant>.okta.com"
```

---

## 6. Required AWS Services

Make sure the following are enabled:
- Elastic Container Registry (ECR)
- App Runner
- CloudWatch Logs
- Secrets Manager
- IAM

---

## 7. Where Environment Variables Are Stored (Important)

Cloud Run uses two sources for environment variables:

| Type | Where It Lives | What We Use It For |
| --- | --- | --- |
| Sensitive values | Secrets Manager | Private key, Lookout App Key |
| Non-sensitive values | App Runner Environment Variables | SSF_ISSUER, polling settings |
| Injected secrets | App Runner → Runtime Environment | Automatically rotated |

### Our mapping:

| Purpose | Storage |
| --- | --- |
| LOOKOUT_APP_KEY | Secret Manager |
| SSF_PRIVATE_KEY_PEM | Secret Manager |
| OKTA_ORG | Secret Manager (optional) |
| SSF_ISSUER | App Runner environment variables |
| LOOKOUT_* configs | App Runner env vars |

--- 

## 8. Build & Push Container Image to ECR

### Create an ECR repo:

```bash
aws ecr create-repository \
  --repository-name ssf-transmitter \
  --region us-east-1
```

### Build the container:

```bash
docker build -t ssf-transmitter .
```

### Tag it for ECR:

```bash
docker tag ssf-transmitter:latest \
  <ACCOUNT_ID>.dkr.ecr.us-east-1.amazonaws.com/ssf-transmitter:latest
```

### Push to ECR:

```bash
docker push <ACCOUNT_ID>.dkr.ecr.us-east-1.amazonaws.com/ssf-transmitter:latest
```

--- 

## 9. First Deploy (Placeholder SSF_ISSUER)

We’ll deploy once with a placeholder SSF_ISSUER and wire secrets.

```bash
aws apprunner create-service \
  --service-name ssf-transmitter \
  --source-configuration "{
    \"ImageRepository\": {
      \"ImageIdentifier\": \"<ACCOUNT_ID>.dkr.ecr.us-east-1.amazonaws.com/ssf-transmitter:latest\",
      \"ImageRepositoryType\": \"ECR\",
      \"ImageConfiguration\": {
        \"Port\": \"8080\",
        \"RuntimeEnvironmentVariables\": [
          {\"Name\": \"SSF_ISSUER\", \"Value\": \"https://placeholder\"}
        ]
      }
    },
    \"AuthenticationConfiguration\": {
      \"AccessRoleArn\": \"arn:aws:iam::<ACCOUNT_ID>:role/AppRunnerECRAccessRole\"
    }
  }"
```

### Record the service URL:

```text
Service URL: https://ssf-transmitter-xyz123.us-east-1.awsapprunner.com
```

That URL will become your **SSF_ISSUER**.

--- 

## 10. Attach Secrets to the Service

### Get the Service ARN

```bash
aws apprunner list-services --query "ServiceSummaryList[*].ServiceArn"
```

### Bind secrets

```bash
aws apprunner associate-custom-domain \
  --service-arn <SERVICE_ARN> \
  --environment-variables "[
    {\"Name\": \"LOOKOUT_APP_KEY\", \"Value\": \"arn:aws:secretsmanager:us-east-1:<ACCOUNT_ID>:secret:LOOKOUT_APP_KEY\"},
    {\"Name\": \"SSF_PRIVATE_KEY_PEM\", \"Value\": \"arn:aws:secretsmanager:us-east-1:<ACCOUNT_ID>:secret:SSF_PRIVATE_KEY_PEM\"}
  ]"
```

---

## 11. Update Service With REAL SSF_ISSUER

```bash
aws apprunner update-service \
  --service-arn <SERVICE_ARN> \
  --source-configuration "{
    \"ImageRepository\": {
      \"ImageIdentifier\": \"<ACCOUNT_ID>.dkr.ecr.us-east-1.amazonaws.com/ssf-transmitter:latest\",
      \"ImageRepositoryType\": \"ECR\",
      \"ImageConfiguration\": {
        \"Port\": \"8080\",
        \"RuntimeEnvironmentVariables\": [
          {\"Name\": \"SSF_ISSUER\", \"Value\": \"https://ssf-transmitter-xyz123.us-east-1.awsapprunner.com\"}
        ]
      }
    }
  }"
```

--- 

## 12. Validate Deployment

### Health Check

```bash
curl https://<APP_RUNNER_URL>/healthz
```

Expected:

```text
HTTP/2 200
ok
```

### SSF Discovery

```bash
curl https://<APP_RUNNER_URL>/.well-known/ssf-configuration | jq
```

Verify:
- issuer == SSF_ISSUER (Cloud Run URL).
- jwks_uri points at ${SSF_ISSUER}/jwks.json.

### JWKS

```bash
curl https://<APP_RUNNER_URL>/jwks.json | jq
```

Check:
- keys[0].kid equals your lookout-ssf-key-1 (or chosen KID).
- alg is RS256.

### Logs

```bash
aws logs tail /aws/apprunner/ssf-transmitter --follow
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
	- **Issuer URL** → SSF_ISSUER (APP_RUNNER_URL)
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
3.	Check CloudWatch logs:
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

- Use HTTPS custom domain
- Restrict App Runner ingress
- Rotate SSF signing key regularly
- Use dedicated IAM roles
- Enable App Runner auto-scaling limits
