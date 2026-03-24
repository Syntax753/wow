$env:Path += ";$env:LOCALAPPDATA\Google\Cloud SDK\google-cloud-sdk\bin"

Write-Host "==> Checking Artifact Registry repo exists"
gcloud artifacts repositories list --location=us-central1 --project=world-of-worlds-491214

Write-Host "==> Checking SA roles"
gcloud projects get-iam-policy world-of-worlds-491214 --flatten="bindings[].members" --filter="bindings.members:github-deploy" --format="table(bindings.role)"
