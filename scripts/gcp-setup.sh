#!/bin/bash
# One-time GCP setup for GitHub Actions → Cloud Run deployment
# Run this locally after authenticating with: gcloud auth login
#
# Prerequisites:
#   1. GCP project "wow-now-491200" exists
#   2. You have Owner/Editor role on the project
#   3. GitHub repo is e.g. "youruser/wow" — update GITHUB_REPO below

set -euo pipefail

PROJECT_ID="world-of-worlds-491214"
REGION="us-central1"
REPO_NAME="wow-repo"
SERVICE_ACCOUNT_NAME="github-deploy"
GITHUB_REPO="syntax753/wow"  # <-- CHANGE THIS to your GitHub org/user and repo name

echo "==> Setting project"
gcloud config set project "$PROJECT_ID"

echo "==> Enabling required APIs (all free tier)"
gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  iam.googleapis.com \
  iamcredentials.googleapis.com \
  cloudresourcemanager.googleapis.com

echo "==> Creating Artifact Registry repository"
gcloud artifacts repositories create "$REPO_NAME" \
  --repository-format=docker \
  --location="$REGION" \
  --description="WoW game container images" \
  2>/dev/null || echo "Repository already exists"

echo "==> Creating service account for GitHub Actions"
gcloud iam service-accounts create "$SERVICE_ACCOUNT_NAME" \
  --display-name="GitHub Actions Deploy" \
  2>/dev/null || echo "Service account already exists"

SA_EMAIL="${SERVICE_ACCOUNT_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

echo "==> Granting roles to service account"
for ROLE in roles/run.admin roles/artifactregistry.writer roles/iam.serviceAccountUser; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${SA_EMAIL}" \
    --role="$ROLE" \
    --condition=None \
    --quiet
done

echo "==> Creating Workload Identity Pool"
gcloud iam workload-identity-pools create "github-pool" \
  --project="$PROJECT_ID" \
  --location="global" \
  --display-name="GitHub Actions Pool" \
  2>/dev/null || echo "Pool already exists"

echo "==> Creating Workload Identity Provider"
gcloud iam workload-identity-pools providers create-oidc "github-provider" \
  --project="$PROJECT_ID" \
  --location="global" \
  --workload-identity-pool="github-pool" \
  --display-name="GitHub Provider" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  2>/dev/null || echo "Provider already exists"

echo "==> Binding service account to Workload Identity"
gcloud iam service-accounts add-iam-policy-binding "$SA_EMAIL" \
  --project="$PROJECT_ID" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')/locations/global/workloadIdentityPools/github-pool/attribute.repository/${GITHUB_REPO}"

PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')

echo ""
echo "============================================"
echo "  SETUP COMPLETE"
echo "============================================"
echo ""
echo "Add these as GitHub repo secrets (Settings → Secrets → Actions):"
echo ""
echo "  WIF_PROVIDER:"
echo "  projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github-pool/providers/github-provider"
echo ""
echo "  WIF_SERVICE_ACCOUNT:"
echo "  ${SA_EMAIL}"
echo ""
echo "============================================"
