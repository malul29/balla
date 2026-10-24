#!/usr/bin/env bash
# Daily PostgreSQL backup. Run from the project folder (where docker-compose.yml lives).
# Cron example (every day 02:00):  0 2 * * * cd /opt/balla && ./deploy/backup.sh >> backups/backup.log 2>&1
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p backups
FILE="backups/balla-$(date +%F-%H%M).sql.gz"
docker compose exec -T db pg_dump -U balla --no-owner balla | gzip > "$FILE"
[ -s "$FILE" ] || { echo "Backup kosong, dibatalkan"; rm -f "$FILE"; exit 1; }
echo "$(date -Is) OK $FILE ($(du -h "$FILE" | cut -f1))"
# keep 30 days
find backups -name 'balla-*.sql.gz' -mtime +30 -delete
