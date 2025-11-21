# Lookout → Okta SSF Transmitter (Device Risk → Identity Risk)

This repository contains a lightweight Node.js service that:

- Pulls **device security status** from **Lookout Mobile Risk API v2**
- Normalizes that into **Okta SSF Security Event Tokens (SETs)**
- Pushes **device risk changes** to Okta as  
  `https://schemas.okta.com/secevent/okta/event-type/device-risk-change`
- Enables **Identity Threat Protection (ITP) / Entity Risk** to react with:
  - Step-up MFA for medium risk
  - Block / force logout for high risk
  - No friction for low / secure devices

Built as a container-ready microservice for easy deployment across:
- **Google Cloud Run**
- **AWS App Runner**
- **Azure Container Apps**

> ⚠️ This is a reference / PoC implementation. Hardening, monitoring, and production controls should be added before deploying in a live environment.

---

## High-Level Architecture

1. **Lookout Poller**
   - Uses a Lookout **application key** to request an **access token**
   - Calls `GET /mra/api/v2/devices` on a schedule
   - Filters devices by `security_status` and email presence

2. **Risk Mapping**
   - Translates Lookout `security_status` → Okta risk levels:
     - `THREATS_HIGH` → `current_level = "high"`
     - `THREATS_MEDIUM` → `current_level = "medium"`
     - `THREATS_LOW` / `SECURE` → ignored (no event)
   - Uses device owner email as the entity identity (`format = email`)

3. **SSF Transmitter**
   - Signs a **Security Event Token (SET)** with an **RS256** key
   - Presents a `.well-known/ssf-configuration` and `jwks.json`
   - Sends SETs to Okta `/security/api/v1/security-events`

4. **Okta ITP / Policy**
   - Okta consumes device risk changes as an external risk signal
   - Entity Risk Policy and Authentication Policies drive:
     - Step-up MFA
     - Session termination
     - Conditional access

---

## Prerequisites

### Lookout

- Access to the **Lookout Mobile Risk API v2**
- An **Application Key** for API auth
- Confirmed access to:

  - `https://api.lookout.com/oauth2/token`
  - `https://api.lookout.com/mra/api/v2/devices`

### Okta

- Okta Identity Engine (OIE) tenant
- **Identity Threat Protection** / **Entity Risk** enabled
- Ability to configure a **Security Events Provider** via **SSF**

### Local / Dev Environment

- Node.js **v18+** (Cloud Run uses newer runtimes; tested on 18/20/22+)
- `npm` or `pnpm` installed
- Git & Docker (for local container testing, optional)

---

## Project Layout

```text
src/
  server.mjs          # HTTP server, SSF discovery, JWKS, /intake/lookout
  lookout-auth.mjs    # Lookout OAuth2 token acquisition
  lookout-intake.mjs  # Convert internal risk events → SSF SET → POST to Okta
  lookout-poll.mjs    # Poll Lookout Mobile Risk API v2 for device status
  gen-jwk.mjs         # Utility to generate an RS256 JWK + jwks.json
  jwks.json           # Public JWKS served to Okta

Dockerfile            # Container build for Cloud Run / App Runner / ACA
package.json          # Node project metadata / dependencies
README.md             # This file