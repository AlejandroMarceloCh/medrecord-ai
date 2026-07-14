#!/usr/bin/env bash
# Programa el backup diario y el healthcheck.
#
# `backup.sh` existía desde el Sprint 6 y NADA lo ejecutaba: el backup estaba escrito, probado,
# documentado… y nunca corría. Un backup que no se ejecuta no es un backup, es un archivo.
#
# El healthcheck existe porque hoy el sistema de monitoreo es el médico, y se entera cuando ya
# es tarde: con el paciente delante y la app sin responder.
set -euo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENTES="$HOME/Library/LaunchAgents"
mkdir -p "$AGENTES" "$RAIZ/logs"

# ── Backup diario, 22:00 ─────────────────────────────────────────────────────
# BACKUP_DIR debe apuntar FUERA del disco de datos (un USB cifrado, un NAS). El tar lleva la
# clave maestra dentro: un solo archivo compromete todo, y guardarlo al lado de los datos que
# protege no protege de nada.
: "${BACKUP_DIR:=$HOME/MedRecordBackups}"
mkdir -p "$BACKUP_DIR"

cat > "$AGENTES/pe.medrecord.backup.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>pe.medrecord.backup</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${RAIZ}/scripts/backup.sh</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>BACKUP_DIR</key><string>${BACKUP_DIR}</string></dict>
  <key>WorkingDirectory</key><string>${RAIZ}</string>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>22</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardOutPath</key><string>${RAIZ}/logs/backup.log</string>
  <key>StandardErrorPath</key><string>${RAIZ}/logs/backup.err</string>
</dict>
</plist>
EOF

# ── Healthcheck cada 5 minutos ───────────────────────────────────────────────
cat > "$AGENTES/pe.medrecord.health.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>pe.medrecord.health</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${RAIZ}/scripts/healthcheck.sh</string>
  </array>
  <key>WorkingDirectory</key><string>${RAIZ}</string>
  <key>StartInterval</key><integer>300</integer>
  <key>StandardOutPath</key><string>${RAIZ}/logs/health.log</string>
  <key>StandardErrorPath</key><string>${RAIZ}/logs/health.err</string>
</dict>
</plist>
EOF

for L in pe.medrecord.backup pe.medrecord.health; do
  launchctl unload "$AGENTES/$L.plist" 2>/dev/null || true
  launchctl load  "$AGENTES/$L.plist"
done

echo "  Backup diario   : 22:00 → $BACKUP_DIR"
echo "  Healthcheck     : cada 5 minutos"
echo ""
echo "  OJO: BACKUP_DIR debe estar FUERA del disco de datos (USB cifrado o NAS)."
echo "  El .tar.gz lleva la clave maestra dentro: guardarlo al lado de lo que protege"
echo "  no protege de nada."
