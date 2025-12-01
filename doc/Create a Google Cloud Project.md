# How to Create a Google Cloud Project with Billing Enabled

## Login to Google Cloud
Authenticate your user
```bash
gcloud auth login
```

## Create the New Project

Pick a unique project ID:
```bash
PROJECT_ID="lookout-ssf-XXX"
```
Create the project:
```bash
gcloud projects create $PROJECT_ID
```

You can confirm:
```bash
gcloud projects list | grep $PROJECT_ID
```
	
## Enable Billing (CLI)
First get your billing account ID:
```bash
gcloud billing accounts list
```

Export it:
```bash
BILLING_ACCOUNT_ID="XXXXXX-XXXXXX-XXXXXX"
```

Attach billing:
```bash
gcloud billing projects link $PROJECT_ID \
--billing-account=$BILLING_ACCOUNT_ID
```

Validate:
```bash
gcloud billing projects describe $PROJECT_ID
```

Expected:
```text
billingEnabled: true
```
 	
## Set the Project as Your Active Context
```bash
gcloud config set project $PROJECT_ID
```

Confirm:
```bash
gcloud config get-value project
```
 			
## Enable Required APIs 
Enable APIs:
```bash
gcloud services enable \
run.googleapis.com \
artifactregistry.googleapis.com \
cloudbuild.googleapis.com \
secretmanager.googleapis.com
```

