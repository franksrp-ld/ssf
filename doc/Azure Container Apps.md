# Deploying the Lookout → Okta SSF Transmitter on Azure Container Apps
**Secret Manager–Aware Deployment Model**

This guide walks customers and sales engineers through deploying the SSF Transmitter to **Azure Container Apps**, using **Azure Key Vault** for all sensitive data, and wiring it into Lookout Mobile Risk + Okta Identity Threat Protection.

---

## 0. Overview

The SSF Transmitter continuously polls Lookout Mobile Risk, converts device posture changes into SSF-compliant Security Event Tokens (SET), signs them with RS256, and sends them to Okta.

```text
Lookout Mobile Risk API
        │
        ▼
SSF Transmitter (Azure Container Apps)
        • Poll Lookout device posture
        • Normalize risk levels (low/medium/high)
        • Generate + sign SET (RS256)
        • Deliver real-time device-risk-change to Okta
        ▼
Okta Identity Threat Protection
        ▼
Adaptive Authentication:
        • Block access
        • Logout + revoke tokens
        • Step-up MFA
        • Normal access
```

Target flow:

1. Build + push the SSF container image.
2. Create **secrets** in Secret Manager.
3. Deploy to **Azure Container Apps** (first with a placeholder `SSF_ISSUER`).
4. Update the service with the real public URL as `SSF_ISSUER`.
5. Wire Okta SSF to the Cloud Run endpoint.
6. Validate end-to-end using a real Lookout risk change.

---

## 1. Prerequisites

You’ll need:

- An Azure subscription.
- `Azure` CLI installed and up to date.
- An Azure Container Apps extension:
```bash
az extension add --name containerapp
```
- An Azure Key Vault enabled
- A Docker or another container builder
- Git installed 
- A Lookout tenant + App Key with access to Mobile Risk API (MRA).
- An Okta Identity Engine org with Identity Threat Protection.
- Node.js (for key generation scripts, if used).
- A local clone of this repo

---

## 2. Authenticate to Azure

Log in to Azure and configure credentials:

```bash
az login
```

Set your subscription:

```bash
az account set --subscription "<YOUR_SUBSCRIPTION_ID>"
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

## 5. Create Azure Resources

Set baseline variables:

```bash
RESOURCE_GROUP="ssf-rg"
LOCATION="eastus"
CONTAINERAPPS_ENV="ssf-env"
ACR_NAME="ssfacr$RANDOM"
KEYVAULT_NAME="ssfkv$RANDOM"
```

### Create resource group

```bash
az acr create \
  --resource-group $RESOURCE_GROUP \
  --name $ACR_NAME \
  --sku Basic
```

### Create Key Vault

```bash
az keyvault create \
  --name $KEYVAULT_NAME \
  --resource-group $RESOURCE_GROUP \
  --location $LOCATION
```

---

## 6. Store Secrets in Azure Key Vault (Secure)

We’ll store:

- LOOKOUT_APP_KEY – Lookout API app key (string value).
- (Optional) SSF_PRIVATE_KEY_PEM – contents of private.pem.

### Store Lookout App Key:

```bash
az keyvault secret set \
  --vault-name $KEYVAULT_NAME \
  --name LOOKOUT-APP-KEY \
  --value "<YOUR_LOOKOUT_APP_KEY>"
```

### Store SSF private key:

```bash
az keyvault secret set \
  --vault-name $KEYVAULT_NAME \
  --name SSF-PRIVATE-PEM \
  --file src/private.pem
```

### (Optional) Store Okta Org URL

```bash
az keyvault secret set \
  --vault-name $KEYVAULT_NAME \
  --name OKTA-ORG \
  --value "https://YOUR_OKTA_TENANT.okta.com"
```

---

## 7. Allow Container Apps to Read Key Vault Secrets

```bash
az keyvault set-policy \
  --name $KEYVAULT_NAME \
  --resource-group $RESOURCE_GROUP \
  --spn "$(az ad sp list --display-name "Microsoft.ContainerService" --query "[0].appId" -o tsv)" \
  --secret-permissions get list
```

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

## 8. Build & Push Container to ACR

### Login to ACR:

```bash
az acr login --name $ACR_NAME
```

### Build and push:

```bash
IMAGE="$ACR_NAME.azurecr.io/ssf-transmitter:latest"

az acr build \
  --registry $ACR_NAME \
  --image ssf-transmitter:latest .
```

--- 

## 9. Create Azure Container Apps Environment

```bash
az containerapp env create \
  --name $CONTAINERAPPS_ENV \
  --resource-group $RESOURCE_GROUP \
  --location $LOCATION
```

---

## 10. First Deploy (Placeholder SSF_ISSUER)

We’ll deploy once with a placeholder SSF_ISSUER and wire secrets.

```bash
az containerapp create \
  --name ssf-transmitter \
  --resource-group $RESOURCE_GROUP \
  --environment $CONTAINERAPPS_ENV \
  --image $IMAGE \
  --target-port 8080 \
  --ingress external \
  --env-vars \
      SSF_ISSUER="https://placeholder" \
      LOOKOUT_SINCE_MINUTES="5" \
      LOOKOUT_POLL_INTERVAL_SECONDS="60" \
  --secrets \
      LOOKOUT_APP_KEY=keyvault://$KEYVAULT_NAME/LOOKOUT-APP-KEY \
      SSF_PRIVATE_KEY_PEM=keyvault://$KEYVAULT_NAME/SSF-PRIVATE-PEM
```

### Retrieve the service URL:

```bash
APP_URL=$(az containerapp show \
  --resource-group $RESOURCE_GROUP \
  --name ssf-transmitter \
  --query properties.configuration.ingress.fqdn \
  -o tsv)

echo $APP_URL
```

That URL will become your **SSF_ISSUER**.

--- 

## 11. Update Service With REAL SSF_ISSUER

```bash
az containerapp update \
  --name ssf-transmitter \
  --resource-group $RESOURCE_GROUP \
  --env-vars SSF_ISSUER="https://$APP_URL"
```

--- 

## 12. Validate Deployment

### Health Check

```bash
curl https://$APP_URL/healthz
```

Expected:

```text
HTTP/2 200
ok
```

### SSF Discovery

```bash
curl https://$APP_URL/.well-known/ssf-configuration | jq
```

Verify:
- issuer == SSF_ISSUER (Cloud Run URL).
- jwks_uri points at ${SSF_ISSUER}/jwks.json.

### JWKS

```bash
curl https://$APP_URL/jwks.json | jq
```

Check:
- keys[0].kid equals your lookout-ssf-key-1 (or chosen KID).
- alg is RS256.

### Logs

```bash
az containerapp logs show \
  --name ssf-transmitter \
  --resource-group $RESOURCE_GROUP \
  --follow
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

- Move to custom domain
- Enforce TLS 1.2+
- Lock down inbound traffic
- Regex validation on Okta Org URL
- Regular key rotation
- Protect Key Vault with RBAC + firewall
- Auto-scale Container Apps for load arrival
- Enable Log Analytics Workspace
