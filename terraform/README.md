# Terraform — GUB platform infrastructure

Manages GCP infrastructure for the GCP Universal Backend platform. Currently
covers Cloud Scheduler jobs and the Cloud IAP IAM binding for `gub-admin`.
Designed to expand to cover all platform resources over time.

## Day-to-day

```bash
cd terraform
terraform init                                          # first time per clone
terraform plan  -var-file=environments/dev.tfvars
terraform apply -var-file=environments/dev.tfvars
```

## State backend

State lives in GCS at `gs://os-test-491819-tfstate/gub-platform/`. The bucket
has **versioning enabled** (recovery from bad applies) and **uniform
bucket-level access** on (no per-object ACLs). The bucket is the source of
truth — never commit `terraform.tfstate*` files. The `.gitignore` in this
directory already covers them as defense-in-depth.

Operators who run `apply` need `roles/storage.objectAdmin` on the bucket.
Read-only `plan` can be done with `roles/storage.objectViewer`.

The bucket itself is **out-of-band** — it isn't managed by this Terraform
tree. That's deliberate: a bucket can't store its own state. It was created
once with:

```bash
gcloud storage buckets create gs://os-test-491819-tfstate \
  --project=os-test-491819 \
  --location=us-central1 \
  --uniform-bucket-level-access
gcloud storage buckets update gs://os-test-491819-tfstate --versioning
```

State locking is built in. If an `apply` is killed mid-run, the lock can
linger in `gs://os-test-491819-tfstate/gub-platform/default.tflock`.
Clear with `terraform force-unlock <LOCK_ID>` — and only when you're sure
no other operator is mid-apply.

## Provider versions

Provider versions are **pinned via `.terraform.lock.hcl`** (committed to
the repo). `terraform init` consults the lock file rather than re-resolving
fresh each time, so every operator and CI run uses the same provider
version.

To upgrade a provider:

```bash
terraform init -upgrade   # re-resolves within the version constraints in main.tf
```

Review the resulting lock-file diff in the same PR as any constraint
changes in `main.tf`. The lock file is multi-platform (`darwin_arm64`,
`darwin_amd64`, `linux_amd64`) so any operator can `init` without a
hash-mismatch error. To add a platform:

```bash
terraform providers lock \
  -platform=linux_amd64 \
  -platform=darwin_arm64 \
  -platform=darwin_amd64
```

## File map

| File | Purpose |
|------|---------|
| `main.tf` | Provider config + GCS state backend |
| `variables.tf` | Input variable declarations |
| `apis.tf` | `google_project_service` enables (Cloud Scheduler) |
| `scheduler.tf` | Sync + cleanup Cloud Scheduler jobs |
| `gub_admin_iap.tf` | Authoritative IAP IAM binding for the gub-admin app |
| `outputs.tf` | Job names + URIs |
| `environments/dev.tfvars` | Dev-environment values |
