#!/usr/bin/env bash
# Restore a backup INTO an empty database. Usage: ./deploy/restore.sh backups/housing-YYYY-MM-DD-HHMM.sql.gz
set -euo pipefail
cd "$(dirname "$0")/.."
[ $# -eq 1 ] && [ -f "$1" ] || { echo "Pemakaian: $0 <file-backup.sql.gz>"; exit 1; }
read -r -p "Ini MENIMPA seluruh data saat ini dengan isi $1. Ketik 'ya' untuk lanjut: " ok
[ "$ok" = "ya" ] || { echo "Dibatalkan"; exit 1; }
docker compose stop app
docker compose exec -T db psql -U housing -d postgres -c "DROP DATABASE IF EXISTS housing WITH (FORCE)" -c "CREATE DATABASE housing OWNER housing"
gunzip -c "$1" | docker compose exec -T db psql -U housing -d housing -v ON_ERROR_STOP=1 -q
docker compose start app
echo "Selesai."
