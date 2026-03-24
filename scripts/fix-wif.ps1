$env:Path += ";$env:LOCALAPPDATA\Google\Cloud SDK\google-cloud-sdk\bin"

Write-Host "==> Undeleting provider"
gcloud iam workload-identity-pools providers undelete "github-provider" `
  --project="world-of-worlds-491214" `
  --location="global" `
  --workload-identity-pool="github-pool"

Write-Host "==> Updating attribute condition with correct case"
gcloud iam workload-identity-pools providers update-oidc "github-provider" `
  --project="world-of-worlds-491214" `
  --location="global" `
  --workload-identity-pool="github-pool" `
  --attribute-condition="assertion.repository=='Syntax753/wow'"

Write-Host "==> Verifying"
gcloud iam workload-identity-pools providers describe "github-provider" `
  --workload-identity-pool=github-pool --location=global --project=world-of-worlds-491214
