# Lookout → Okta SSF Transmitter

A lightweight, cloud-deployable service that converts **Lookout Mobile Risk** signals into **Okta Shared Signals Framework (SSF)** real-time events.

This enables adaptive security controls in Okta Identity Threat Protection, including:

- 🚫 **High Risk → Logout + Block Access**
- ⚠️ **Medium Risk → MFA Step-Up**
- 🟢 **Low Risk → Normal Access**
- ❓ **Unknown Risk → MFA Step-Up**

The service polls Lookout’s Mobile Risk API, normalizes risk, signs Security Event Tokens (SET), and delivers them to Okta.

---

## 📐 Architecture Overview

```text
Lookout Mobile Risk API
        │
        ▼
SSF Transmitter (this service)
    • Polls Lookout devices
    • Normalizes risk levels (low / medium / high)
    • Signs SET (RS256) using private key
    • Sends to Okta Security Events API
        │
        ▼
Okta Identity Threat Protection
    • Entity Risk Policies
    • Authentication Policies
    • App Sign-In Policies
        │
        ▼
User Access Decisions
    • Block access
    • Logout + revoke tokens
    • MFA step-up
    • Normal access
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
│   ├─ jwks.json
│   └─ private.pem   (DO NOT COMMIT)
│
├─ Dockerfile
├─ package.json
├─ package-lock.json
├─ .gitignore
└─ README.md
```

---

## ⚙️ Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SSF_ISSUER` | Yes | Public HTTPS URL of your deployed service |
| `OKTA_ORG` | Yes | Your Okta domain (e.g. https://yourorg.okta.com) (no trailing slash) |
| `LOOKOUT_APP_KEY` | Yes | Lookout App Key used for OAuth |
| `LOOKOUT_BASE_URL` | No | Defaults to `https://api.lookout.com` |
| `LOOKOUT_TOKEN_URL` | No | Defaults to `https://api.lookout.com/oauth2/token` |
| `LOOKOUT_SINCE_MINUTES` | No | Poll window (default: 5 minutes) |
| `LOOKOUT_POLL_INTERVAL_SECONDS` | No | Poll interval (default: 60 seconds) |
| `LOOKOUT_ENTERPRISE_GUID` | Optional | Filter Lookout events to specific tenant |
| `PORT` | No | Defaults to `8080` |

---

## ⚙️ How the Service Works

### **1. Poll Lookout**
Calls: `GET /mra/api/v2/devices?limit=200&updated_since=`

### **2. Normalize Risk**
| Lookout | SSF Risk |
|---------|----------|
| `THREATS_HIGH`, `THREATS_CRITICAL` | `high` |
| `THREATS_MEDIUM` | `medium` |
| `THREATS_LOW`, `SECURE` | `low` |

### **3. Build SET event**
Event type: `device-risk-change`

### **4. Sign with RS256 (JOSE)**  
Uses `private.pem` — **never commit** this file.

### **5. POST to Okta SET API**
```
POST /security/api/v1/security-events
Content-Type: application/secevent+jwt
```

---

## 🐳 Running Locally

### 1. Install
```bash
npm install
```
### 2. Start service
```bash
SSF_ISSUER=http://localhost:8080 \
OKTA_ORG=https://yourorg.okta.com \
LOOKOUT_APP_KEY=xxxx \
npm start
```

---

## 🔌 API Endpoints

### Health Check
```
GET /healthz
```
### SSF Discovery 
```
GET /.well-known/ssf-configuration
```
### JWKS
```
GET /jwks.json
```
### Lookout Event Intake
```
POST /intake/lookout
Content-Type: application/json
```
Example body:
```json
{
  "user": { "email": "user@example.com" },
  "risk": {
    "current_level": "high",
    "previous_level": "low",
    "reason": "Lookout detected high threat"
  },
  "event_timestamp": "2025-01-01T12:00:00Z"
}
```

---

## 🐳 Docker

### Build
```sh
docker build -t ssf .
```
### Run
```sh
docker run -p 8080:8080 \
  -e SSF_ISSUER=https://your-public-url \
  -e OKTA_ORG=https://your-okta-org \
  -e LOOKOUT_APP_KEY=xxxx \
  ssf
```

---

## 🌥️ Deployment Options

### 1. Google Cloud Run
```bash
gcloud builds submit --tag gcr.io/<PROJECT>/ssf
gcloud run deploy ssf \
  --image gcr.io/<PROJECT>/ssf \
  --region us-central1 \
  --allow-unauthenticated \
  --set-env-vars SSF_ISSUER=https://<cloud-run-url> \
  --set-env-vars OKTA_ORG=https://<okta-org> \
  --set-env-vars LOOKOUT_APP_KEY=<key>
```

### 2. AWS App Runner
```bash
aws apprunner create-service \
  --service-name ssf \
  --source-configuration ImageRepository={
      ImageIdentifier="ACCOUNT.dkr.ecr.us-east-1.amazonaws.com/ssf:latest",
      ImageRepositoryType="ECR",
      ImageConfiguration={Port="8080"}
  } \
  --environment-variables Key=SSF_ISSUER,Value=https://<url> \
                           Key=OKTA_ORG,Value=https://yourorg.okta.com \
                           Key=LOOKOUT_APP_KEY,Value=xxxx
```

 ### 3. Azure Container Apps
```bash
az containerapp create \
  --name ssf \
  --resource-group my-rg \
  --image registry.azurecr.io/ssf:latest \
  --environment-variables \
       SSF_ISSUER=https://<url> \
       OKTA_ORG=https://yourorg.okta.com \
       LOOKOUT_APP_KEY=xxxx
```


---

## 🧪 Validation Checklist

✔ Verify SSF discovery:

`curl https://your-ssf-url/.well-known/ssf-configuration`
- Watch logs for SET delivery confirmation
- Trigger a Mobile Risk change in Lookout
- Check Okta → System Log for device_risk_change events
- Test Okta policies
   - High-risk → blocked
   - Medium-risk → MFA
   - Low → normal access

---

## 🔐 Security Notes

- ❗ Never commit **private.pem**
- Always run SSF over HTTPS
- Use **secret managers**, **KMS**, or **workload identity**
- Avoid static API tokens where possible

