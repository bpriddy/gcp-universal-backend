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
is the source of truth — never commit `terraform.tfstate*` files. The
`.gitignore` in this directory already covers them as defense-in-depth.

### Who reads this bucket

**Only the `terraform` CLI**, when an operator runs `plan` or `apply` from
their laptop. Nothing else touches it:

- **Cloud Build does not read this bucket.** It builds container images
  from each repo's `main` branch and pushes new revisions to Cloud Run.
  It deploys *app code*, not *infra config*.
- **Cloud Run does not read this bucket.** The deployed app has no
  knowledge of Terraform state.
- **The app at runtime does not read this bucket.**

App-code changes land via push-to-`main` → Cloud Build → Cloud Run revision.
Infra changes land via `terraform apply` from a laptop → GCS state update +
GCP API calls. Two pipelines, no shared touchpoint. (When scheduled drift
detection is wired up, that will be the first system other than a human
operator that reads this bucket — and it will use a dedicated service
account with the minimum role for its job.)

### Bucket configuration

| Setting | Value | Purpose |
|---------|-------|---------|
| Location | `us-central1` | Same region as the rest of the platform |
| Uniform bucket-level access (UBLA) | **on** | All access decisions at the bucket level — no per-object ACLs to surprise you |
| Object versioning | **on** | Every state write keeps the prior generation; recovery from a bad apply is point-in-time |
| Soft delete | **on (7 days)** | Even after a delete + version-purge, objects are recoverable for 7 days |
| Public access prevention | `inherited` (effectively **enforced** at this project) | UBLA + project default mean public exposure is not possible without an explicit `allUsers`/`allAuthenticatedUsers` IAM binding (which would be a deliberate, visible action) |

### Access control

UBLA means there are exactly four roles that can grant access to state:

| Role | Capabilities | When you grant it |
|------|--------------|-------------------|
| `roles/storage.objectViewer` | Read objects (state + lock files) | Operators or service accounts that only need `terraform plan` |
| `roles/storage.objectAdmin` | Read + write objects | Operators or service accounts that run `terraform apply` (writes new state, takes the lock) |
| `roles/storage.admin` | Full bucket control: delete, reconfigure, modify IAM | Whoever maintains the bucket itself — usually one or two trusted humans |
| Project-level `roles/owner` / `roles/editor` | Inherits everything above | Avoid for state access; too broad |

**Today's effective access:** `bpriddy@anomaly.com` only, via project-owner
inheritance. No explicit bucket-level bindings have been added.

**Adding a second human operator** (e.g., for break-glass coverage): grant
`roles/storage.objectAdmin` *on this bucket only*, not at the project level:

```bash
gcloud storage buckets add-iam-policy-binding gs://os-test-491819-tfstate \
  --member="user:newoperator@example.com" \
  --role="roles/storage.objectAdmin"
```

**Adding a service account for CI** (drift detection, automated `plan`):
same shape, but use `roles/storage.objectViewer` if the SA only needs to
read state:

```bash
gcloud storage buckets add-iam-policy-binding gs://os-test-491819-tfstate \
  --member="serviceAccount:sa-tf-driftcheck@os-test-491819.iam.gserviceaccount.com" \
  --role="roles/storage.objectViewer"
```

Both forms keep the blast radius scoped to this single bucket.

### Bucket bring-up (out-of-band)

The bucket itself is **not managed by this Terraform tree** — a bucket
can't store its own state (chicken/egg). It was created once with:

```bash
gcloud storage buckets create gs://os-test-491819-tfstate \
  --project=os-test-491819 \
  --location=us-central1 \
  --uniform-bucket-level-access
gcloud storage buckets update gs://os-test-491819-tfstate --versioning
```

### State locking

Locking is built into the GCS backend. If an `apply` is killed mid-run, the
lock can linger at `gs://os-test-491819-tfstate/gub-platform/default.tflock`.
Clear with `terraform force-unlock <LOCK_ID>` — and **only** when you're
sure no other operator is mid-apply.

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
