#!/usr/bin/env bash
# Creates the Compute Engine VM and firewall rules for Agent X.
# Run from your laptop or Cloud Shell, after: gcloud auth login
#
#   GCP_PROJECT_ID=jase-123456 ./create-vm.sh
#
# Read every command before running it -- that is the point of this exercise.
set -euo pipefail

: "${GCP_PROJECT_ID:?set GCP_PROJECT_ID (gcloud projects list)}"
ZONE="${ZONE:-asia-east2-a}"          # Hong Kong; closest to Mongolia. Change freely.
VM_NAME="${VM_NAME:-agentx-vm}"
MACHINE="${MACHINE:-e2-small}"        # 2 vCPU (shared), 2 GB RAM

gcloud config set project "$GCP_PROJECT_ID"
gcloud services enable compute.googleapis.com iap.googleapis.com

# Static external IP so DNS / sslip.io keeps working across restarts.
gcloud compute addresses describe "${VM_NAME}-ip" --region="${ZONE%-*}" >/dev/null 2>&1 || \
  gcloud compute addresses create "${VM_NAME}-ip" --region="${ZONE%-*}"
IP=$(gcloud compute addresses describe "${VM_NAME}-ip" --region="${ZONE%-*}" --format='value(address)')

gcloud compute instances create "$VM_NAME" \
  --zone="$ZONE" \
  --machine-type="$MACHINE" \
  --image-family=debian-12 --image-project=debian-cloud \
  --boot-disk-size=20GB --boot-disk-type=pd-balanced \
  --address="$IP" \
  --no-service-account --no-scopes \
  --shielded-secure-boot --shielded-vtpm --shielded-integrity-monitoring \
  --metadata=enable-oslogin=TRUE,block-project-ssh-keys=TRUE \
  --tags=agentx-web

# Note --no-service-account: by default a VM runs as the Compute Engine default
# service account, which has Editor on the whole project. Anyone who gets code
# execution on the VM could then ask the metadata server (169.254.169.254) for
# a token and take over the project. This VM needs no Google APIs, so it gets
# no identity at all.

# Web traffic from anywhere, only to VMs tagged agentx-web.
gcloud compute firewall-rules describe agentx-allow-web >/dev/null 2>&1 || \
  gcloud compute firewall-rules create agentx-allow-web \
    --network=default --direction=INGRESS --action=ALLOW \
    --rules=tcp:80,tcp:443,udp:443 --source-ranges=0.0.0.0/0 --target-tags=agentx-web

# SSH only through Identity-Aware Proxy (Google's range), never from the open internet.
gcloud compute firewall-rules describe agentx-allow-iap-ssh >/dev/null 2>&1 || \
  gcloud compute firewall-rules create agentx-allow-iap-ssh \
    --network=default --direction=INGRESS --action=ALLOW \
    --rules=tcp:22 --source-ranges=35.235.240.0/20 --target-tags=agentx-web

# The default network ships with "default-allow-ssh" open to 0.0.0.0/0. Remove it.
if gcloud compute firewall-rules describe default-allow-ssh >/dev/null 2>&1; then
  echo "Deleting default-allow-ssh (SSH open to the whole internet)..."
  gcloud compute firewall-rules delete default-allow-ssh --quiet
fi
if gcloud compute firewall-rules describe default-allow-rdp >/dev/null 2>&1; then
  gcloud compute firewall-rules delete default-allow-rdp --quiet
fi

# Daily disk snapshots, kept 14 days.
gcloud compute resource-policies describe agentx-daily >/dev/null 2>&1 || \
  gcloud compute resource-policies create snapshot-schedule agentx-daily \
    --region="${ZONE%-*}" --daily-schedule --start-time=18:00 --max-retention-days=14
gcloud compute disks add-resource-policies "$VM_NAME" --zone="$ZONE" --resource-policies=agentx-daily

echo
echo "VM ready at $IP"
echo "Domain without buying one: ${IP//./-}.sslip.io"
echo "Next: gcloud compute ssh $VM_NAME --zone=$ZONE --tunnel-through-iap"
echo "Then follow docs/DEPLOY_VM.md from step 3."
