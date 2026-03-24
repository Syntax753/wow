$env:Path += ";$env:LOCALAPPDATA\Google\Cloud SDK\google-cloud-sdk\bin"
Write-Host "==> Listing WIF pools"
gcloud iam workload-identity-pools list --location=global --project=world-of-worlds-491214
Write-Host "==> Listing WIF providers"
gcloud iam workload-identity-pools providers list --workload-identity-pool=github-pool --location=global --project=world-of-worlds-491214
Write-Host "==> Project number"
gcloud projects describe world-of-worlds-491214 --format="value(projectNumber)"
