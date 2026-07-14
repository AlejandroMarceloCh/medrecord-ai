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

# Aviso: el backup al lado de los datos que protege no protege de nada. Un disco que muere
# se lleva las dos cosas, y el tar lleva la clave maestra dentro.
if [ "$DEST" = "$DATA_PARENT/backups" ]; then
  echo "  AVISO: estás respaldando al MISMO disco que los datos ($DEST)."
  echo "  Define BACKUP_DIR hacia un USB cifrado o un NAS."
fi

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

# ── Verificación ─────────────────────────────────────────────────────────────
# Un backup que nunca se probó no es un backup: es un archivo con esperanza dentro.
# Esto lo restaura en un directorio temporal y comprueba que descifra de verdad.
VERIF="$(mktemp -d)"
trap 'rm -rf "$VERIF"' EXIT

tar -xzf "$OUT" -C "$VERIF" 2>/dev/null

KEY_RESTAURADA="$VERIF/$(basename "$KEY_FILE")"
REC_RESTAURADAS="$VERIF/$REC_NAME"

if [ ! -f "$KEY_RESTAURADA" ]; then
  echo "  FALLO: el backup NO contiene la clave maestra. Sin ella es irrecuperable."
  exit 1
fi

SIDECAR="$(find "$REC_RESTAURADAS" -name '*.json' ! -name 'users.json' | head -1 || true)"
if [ -n "$SIDECAR" ]; then
  if MEDRECORD_KEY_FILE="$KEY_RESTAURADA" node -e '
    const enc = require(process.argv[1] + "/crypto.js");
    const json = enc.readEncrypted(process.argv[2]).toString("utf8");
    const rec = JSON.parse(json);
    if (!rec.id) throw new Error("el sidecar restaurado no tiene id");
  ' "$ROOT" "$SIDECAR" 2>/dev/null; then
    echo "  Verificado: el backup restaura y descifra correctamente."
  else
    echo "  FALLO: el backup NO se puede descifrar con la clave que contiene."
    exit 1
  fi
fi

shasum -a 256 "$OUT" | tee "$OUT.sha256"
