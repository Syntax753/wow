# One-time GCP setup for GitHub Actions -> Cloud Run deployment
# Run this in PowerShell: .\scripts\gcp-setup.ps1
#
# Prerequisites:
#   1. GCP project "world-of-worlds-491214" exists
#   2. You have Owner/Editor role on the project
#   3. gcloud CLI installed and authenticated (gcloud auth login)

$ErrorActionPreference = "Continue"

# Add gcloud to PATH
$env:Path += ";$env:LOCALAPPDATA\Google\Cloud SDK\google-cloud-sdk\bin"

$PROJECT_ID = "world-of-worlds-491214"
$REGION = "us-central1"
$REPO_NAME = "wow-repo"
$SERVICE_ACCOUNT_NAME = "github-deploy"
$GITHUB_REPO = "syntax753/wow"

Write-Host "==> Setting project" -ForegroundColor Cyan
gcloud config set project $PROJECT_ID

Write-Host "==> Enabling required APIs (all free tier)" -ForegroundColor Cyan
gcloud services enable `
  run.googleapis.com `
  artifactregistry.googleapis.com `
  iam.googleapis.com `
  iamcredentials.googleapis.com `
  cloudresourcemanager.googleapis.com

Write-Host "==> Creating Artifact Registry repository" -ForegroundColor Cyan
gcloud artifacts repositories create $REPO_NAME `
  --repository-format=docker `
  --location=$REGION `
  --description="WoW game container images" 2>$null
if ($LASTEXITCODE -ne 0) { Write-Host "Repository already exists" }

Write-Host "==> Creating service account for GitHub Actions" -ForegroundColor Cyan
gcloud iam service-accounts create $SERVICE_ACCOUNT_NAME `
  --display-name="GitHub Actions Deploy" 2>$null
if ($LASTEXITCODE -ne 0) { Write-Host "Service account already exists" }

$SA_EMAIL = "${SERVICE_ACCOUNT_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

Write-Host "==> Granting roles to service account" -ForegroundColor Cyan
foreach ($ROLE in @("roles/run.admin", "roles/artifactregistry.writer", "roles/iam.serviceAccountUser")) {
  gcloud projects add-iam-policy-binding $PROJECT_ID `
    --member="serviceAccount:${SA_EMAIL}" `
    --role=$ROLE `
    --condition=None `
    --quiet
}

Write-Host "==> Creating Workload Identity Pool" -ForegroundColor Cyan
gcloud iam workload-identity-pools create "github-pool" `
  --project=$PROJECT_ID `
  --location="global" `
  --display-name="GitHub Actions Pool" 2>$null
if ($LASTEXITCODE -ne 0) { Write-Host "Pool already exists" }

Write-Host "==> Creating Workload Identity Provider" -ForegroundColor Cyan
gcloud iam workload-identity-pools providers create-oidc "github-provider" `
  --project=$PROJECT_ID `
  --location="global" `
  --workload-identity-pool="github-pool" `
  --display-name="GitHub Provider" `
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" `
  --issuer-uri="https://token.actions.githubusercontent.com" 2>$null
if ($LASTEXITCODE -ne 0) { Write-Host "Provider already exists" }

Write-Host "==> Binding service account to Workload Identity" -ForegroundColor Cyan
$PROJECT_NUMBER = gcloud projects describe $PROJECT_ID --format="value(projectNumber)"

gcloud iam service-accounts add-iam-policy-binding $SA_EMAIL `
  --project=$PROJECT_ID `
  --role="roles/iam.workloadIdentityUser" `
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github-pool/attribute.repository/${GITHUB_REPO}"

Write-Host ""
Write-Host "============================================" -ForegroundColor Green
Write-Host "  SETUP COMPLETE" -ForegroundColor Green
Write-Host "============================================" -ForegroundColor Green
Write-Host ""
Write-Host "Add these as GitHub repo secrets (Settings > Secrets > Actions):" -ForegroundColor Yellow
Write-Host ""
Write-Host "  WIF_PROVIDER:" -ForegroundColor White
Write-Host "  projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github-pool/providers/github-provider"
Write-Host ""
Write-Host "  WIF_SERVICE_ACCOUNT:" -ForegroundColor White
Write-Host "  ${SA_EMAIL}"
Write-Host ""
Write-Host "============================================" -ForegroundColor Green
