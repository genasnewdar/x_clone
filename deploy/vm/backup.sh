#!/usr/bin/env bash
# Logical backup of the database (in addition to disk snapshots).
# Cron example (daily 03:30): 30 3 * * * /opt/agentx/deploy/vm/backup.sh
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p backups
chmod 700 backups
docker compose exec -T db pg_dump -U postgres -Fc agentx > "backups/agentx-$(date +%F).dump"
find backups -name 'agentx-*.dump' -mtime +14 -delete
