# How to Create a Google Cloud Project with Billing Enabled

## Create the New Project
		Pick a unique project ID:
    ```text
    PROJECT_ID="lookout-ssf-XXX"
    ```
    
		Create the project:
			gcloud projects create $PROJECT_ID
		You can confirm:
			gcloud projects list | grep $PROJECT_ID
	
	Enable Billing (CLI)
		First get your billing account ID:
			gcloud billing accounts list
		Export it:
			BILLING_ACCOUNT_ID="XXXXXX-XXXXXX-XXXXXX"
		Attach billing:
			gcloud billing projects link $PROJECT_ID \
 			 --billing-account=$BILLING_ACCOUNT_ID
 		Validate:
 			gcloud billing projects describe $PROJECT_ID
 		Expected:
 			billingEnabled: true
 	
 	Set the Project as Your Active Context
 		gcloud config set project $PROJECT_ID
 		Confirm:
 			gcloud config get-value project
 			
 	Enable Required APIs 
 		Enable APIs:
 			gcloud services enable \
  				run.googleapis.com \
 			 	artifactregistry.googleapis.com \
  				cloudbuild.googleapis.com \
  				secretmanager.googleapis.com

