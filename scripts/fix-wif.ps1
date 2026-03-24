$env:Path += ";$env:LOCALAPPDATA\Google\Cloud SDK\google-cloud-sdk\bin"

Write-Host "==> Creating Workload Identity Provider"
gcloud iam workload-identity-pools providers create-oidc "github-provider" `
  --project="world-of-worlds-491214" `
  --location="global" `
  --workload-identity-pool="github-pool" `
  --display-name="GitHub Provider" `
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" `
  --attribute-condition="assertion.repository=='syntax753/wow'" `
  --issuer-uri="https://token.actions.githubusercontent.com"

Write-Host "==> Verifying provider"
gcloud iam workload-identity-pools providers list --workload-identity-pool=github-pool --location=global --project=world-of-worlds-491214
