#!/usr/bin/env bash
# Backup diario de las grabaciones (audio + sidecar JSON) Y la clave maestra.
# Sin la clave, los datos cifrados son IRRECUPERABLES, así que el backup la incluye.
# OJO: por eso el .tar.gz es tan sensible como los datos: guárdalo en un destino
# seguro y de preferencia FUERA del disco de datos (USB cifrado, NAS, etc.).
# Retención: 7 días.
#
# Uso:  bash scripts/backup.sh
#       BACKUP_DIR=/Volumes/USB/medrecord bash scripts/backup.sh   ← recomendado (fuera del disco)
# Restore: ver RESTORE.md
# Programar diario (crontab -e):  0 2 * * *  cd /ruta/MedRecord && bash scripts/backup.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${MEDRECORD_DATA_DIR:-$ROOT/data/recordings}"
DATA_PARENT="$(dirname "$SRC")"
REC_NAME="$(basename "$SRC")"
DEST="${BACKUP_DIR:-$DATA_PARENT/backups}"
KEY_FILE="${MEDRECORD_KEY_FILE:-$ROOT/data/.master.key}"
KEEP_DAYS="${KEEP_DAYS:-7}"

mkdir -p "$DEST"

if [ ! -d "$SRC" ] || [ -z "$(ls -A "$SRC" 2>/dev/null || true)" ]; then
  echo "Nada que respaldar en $SRC"
  exit 0
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$DEST/backup-$STAMP.tar.gz"

# Incluye recordings/ + la clave maestra. Múltiples -C cambian de directorio entre
# entradas (soportado por bsdtar de macOS y GNU tar).
if [ -f "$KEY_FILE" ]; then
  tar -czf "$OUT" -C "$DATA_PARENT" "$REC_NAME" -C "$(dirname "$KEY_FILE")" "$(basename "$KEY_FILE")"
  echo "Backup creado (con clave maestra): $OUT"
  echo "  El backup contiene la clave: trátalo como dato sensible y guárdalo fuera del disco."
else
  tar -czf "$OUT" -C "$DATA_PARENT" "$REC_NAME"
  echo "Backup creado: $OUT"
  echo "  AVISO: no se encontró la clave maestra ($KEY_FILE). Si los datos están"
  echo "  cifrados, este backup será IRRECUPERABLE. Verifica MEDRECORD_KEY_FILE."
fi

# Retención: borra backups con más de KEEP_DAYS días.
find "$DEST" -name 'backup-*.tar.gz' -type f -mtime +"$KEEP_DAYS" -delete 2>/dev/null || true
echo "Retención aplicada: se conservan los últimos $KEEP_DAYS días"
