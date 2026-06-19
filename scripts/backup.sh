#!/usr/bin/env bash
# Backup diario de las grabaciones (audio + sidecar JSON). Retención: 7 días.
# Uso:  bash scripts/backup.sh            → backup a data/backups/
#       BACKUP_DIR=/ruta bash scripts/backup.sh
#
# Programar diario (crontab -e):  0 2 * * *  cd /ruta/MedRecord && bash scripts/backup.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/data/recordings"
DEST="${BACKUP_DIR:-$ROOT/data/backups}"
KEEP_DAYS="${KEEP_DAYS:-7}"

mkdir -p "$DEST"

if [ ! -d "$SRC" ] || [ -z "$(ls -A "$SRC" 2>/dev/null || true)" ]; then
  echo "Nada que respaldar en $SRC"
  exit 0
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$DEST/backup-$STAMP.tar.gz"
# -C para guardar rutas relativas (recordings/...), no la ruta absoluta de la máquina.
tar -czf "$OUT" -C "$ROOT/data" recordings
echo "Backup creado: $OUT"

# Retención: borra backups con más de KEEP_DAYS días.
find "$DEST" -name 'backup-*.tar.gz' -type f -mtime +"$KEEP_DAYS" -delete 2>/dev/null || true
echo "Retención aplicada: se conservan los últimos $KEEP_DAYS días"
