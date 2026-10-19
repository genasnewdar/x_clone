#!/usr/bin/env bash
# Deploys Agent X to Cloud Run + Cloud SQL in the JASE project.
# Run from the repo root in Cloud Shell or a laptop with gcloud:
#
#   GCP_PROJECT_ID=jase-123456 deploy/cloudrun/deploy.sh setup    # once: APIs, DB, secrets, IAM
#   GCP_PROJECT_ID=jase-123456 deploy/cloudrun/deploy.sh deploy   # every release: build + deploy
#
# Each step is idempotent. Read them; docs/DEPLOY_CLOUDRUN.md explains why each exists.
set -euo pipefail

: "${GCP_PROJECT_ID:?set GCP_PROJECT_ID (gcloud projects list)}"
REGION="${REGION:-asia-east2}"
SERVICE="${SERVICE:-agentx}"
SQL_INSTANCE="${SQL_INSTANCE:-agentx-pg}"
SQL_TIER="${SQL_TIER:-db-f1-micro}"
REPO="${REPO:-agentx}"
RUN_SA_NAME="agentx-run"
RUN_SA="${RUN_SA_NAME}@${GCP_PROJECT_ID}.iam.gserviceaccount.com"
IMAGE="${REGION}-docker.pkg.dev/${GCP_PROJECT_ID}/${REPO}/agentx"
CONNECTION="${GCP_PROJECT_ID}:${REGION}:${SQL_INSTANCE}"
# Cost / DoS cap: Cloud Run never runs more than this many containers.
MAX_INSTANCES="${MAX_INSTANCES:-4}"
# Connections per instance. MAX_INSTANCES * DB_POOL_SIZE must stay below the
# Cloud SQL connection limit (~25 on db-f1-micro).
DB_POOL_SIZE="${DB_POOL_SIZE:-5}"

gcloud config set project "$GCP_PROJECT_ID" >/dev/null

secret_exists() { gcloud secrets describe "$1" >/dev/null 2>&1; }

setup() {
  gcloud services enable run.googleapis.com sqladmin.googleapis.com secretmanager.googleapis.com \
    artifactregistry.googleapis.com cloudbuild.googleapis.com

  # Container registry for our images.
  gcloud artifacts repositories describe "$REPO" --location="$REGION" >/dev/null 2>&1 || \
    gcloud artifacts repositories create "$REPO" --repository-format=docker --location="$REGION"

  # Cloud SQL Postgres. Public IP, but with NO authorized networks: nothing
  # can connect directly. Cloud Run reaches it through the Cloud SQL connector,
  # which authenticates with IAM (roles/cloudsql.client) and encrypts traffic.
  if ! gcloud sql instances describe "$SQL_INSTANCE" >/dev/null 2>&1; then
    gcloud sql instances create "$SQL_INSTANCE" \
      --database-version=POSTGRES_16 --edition=enterprise --tier="$SQL_TIER" \
      --region="$REGION" --storage-size=10GB --storage-auto-increase \
      --backup-start-time=18:00 --retained-backups-count=7 \
      --ssl-mode=ENCRYPTED_ONLY \
      --database-flags=log_min_duration_statement=1000
  fi
  gcloud sql databases describe agentx --instance="$SQL_INSTANCE" >/dev/null 2>&1 || \
    gcloud sql databases create agentx --instance="$SQL_INSTANCE"

  # App database user with a random password, stored only in Secret Manager.
  if ! secret_exists agentx-database-url; then
    local pw
    pw="$(openssl rand -hex 24)"
    gcloud sql users create agentx_app --instance="$SQL_INSTANCE" --password="$pw"
    # Host is ignored: DATABASE_SOCKET_DIR points the app at the connector's unix socket.
    printf 'postgres://agentx_app:%s@localhost/agentx' "$pw" | \
      gcloud secrets create agentx-database-url --data-file=- --replication-policy=automatic
  fi
  if ! secret_exists agentx-admin-token; then
    openssl rand -base64 36 | tr -d '\n' | \
      gcloud secrets create agentx-admin-token --data-file=- --replication-policy=automatic
    echo "Admin token stored in Secret Manager (agentx-admin-token). Read it with:"
    echo "  gcloud secrets versions access latest --secret=agentx-admin-token"
  fi

  # The service's own identity, with only what it needs:
  #  - connect to Cloud SQL
  #  - read exactly these two secrets
  gcloud iam service-accounts describe "$RUN_SA" >/dev/null 2>&1 || \
    gcloud iam service-accounts create "$RUN_SA_NAME" --display-name="Agent X Cloud Run"
  gcloud projects add-iam-policy-binding "$GCP_PROJECT_ID" \
    --member="serviceAccount:${RUN_SA}" --role=roles/cloudsql.client --condition=None >/dev/null
  for s in agentx-database-url agentx-admin-token; do
    gcloud secrets add-iam-policy-binding "$s" \
      --member="serviceAccount:${RUN_SA}" --role=roles/secretmanager.secretAccessor >/dev/null
  done
  echo "Setup complete."
  cat <<'NOTE'

ONE MANUAL HARDENING STEP (see docs/DEPLOY_CLOUDRUN.md, "Database privileges"):
users created with `gcloud sql users create` are members of cloudsqlsuperuser.
Open Cloud SQL Studio in the console, log in as "postgres", and run:

  ALTER DATABASE agentx OWNER TO agentx_app;
  REVOKE cloudsqlsuperuser FROM agentx_app;
  ALTER ROLE agentx_app NOCREATEDB NOCREATEROLE;

NOTE
}

deploy() {
  local tag
  tag="$(git rev-parse --short HEAD)$(git diff --quiet || echo -dirty)"
  gcloud builds submit --tag "${IMAGE}:${tag}" .

  gcloud run deploy "$SERVICE" \
    --image="${IMAGE}:${tag}" \
    --region="$REGION" \
    --service-account="$RUN_SA" \
    --allow-unauthenticated \
    --ingress=all \
    --port=8080 \
    --cpu=1 --memory=512Mi \
    --concurrency=80 \
    --min-instances=0 --max-instances="$MAX_INSTANCES" \
    --timeout=30s \
    --add-cloudsql-instances="$CONNECTION" \
    --set-secrets="DATABASE_URL=agentx-database-url:latest,ADMIN_TOKEN=agentx-admin-token:latest" \
    --set-env-vars="DATABASE_SOCKET_DIR=/cloudsql/${CONNECTION},TRUST_PROXY_HOPS=1,DB_POOL_SIZE=${DB_POOL_SIZE},POW_DIFFICULTY=${POW_DIFFICULTY:-20}"

  gcloud run services describe "$SERVICE" --region="$REGION" --format='value(status.url)'
}

case "${1:-}" in
  setup) setup ;;
  deploy) deploy ;;
  *) echo "usage: $0 setup|deploy" >&2; exit 2 ;;
esac
