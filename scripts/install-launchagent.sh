#!/usr/bin/env bash
# Instala MedRecord como servicio de macOS: arranca solo al encender, y vuelve solo si se cae.
#
# Sin esto, una actualización de macOS de madrugada deja el servidor muerto y el médico llega
# a la clínica con una app que no responde. `caffeinate` impide además que la Mac se duerma
# y corte el turno a mitad.
set -euo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="pe.medrecord.server"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
NODE="$(command -v node)"

if [ -z "$NODE" ]; then echo "  No encuentro node en el PATH."; exit 1; fi

# macOS bloquea por TCC el acceso de los procesos de launchd a Desktop, Documents y Downloads.
# Un LaunchAgent que apunte ahí ARRANCA Y MUERE con EPERM, en silencio: `launchctl list` marca
# LastExitStatus=256 y el servidor simplemente no está. El médico llega a una app muerta y
# nadie sabe por qué.
#
# Es un fallo real, verificado: instalar el servicio desde ~/Desktop no levanta nada.
case "$RAIZ" in
  "$HOME"/Desktop/*|"$HOME"/Documents/*|"$HOME"/Downloads/*)
    echo "  El proyecto está en una carpeta protegida por macOS (TCC):"
    echo "    $RAIZ"
    echo ""
    echo "  Un servicio de launchd NO puede leer ahí: arrancaría y moriría con EPERM, en"
    echo "  silencio, y el médico llegaría a una app muerta sin saber por qué."
    echo ""
    echo "  Mueve el proyecto fuera de Desktop/Documents/Downloads. Por ejemplo:"
    echo "    mv \"$RAIZ\" ~/MedRecord && cd ~/MedRecord && bash scripts/install-launchagent.sh"
    echo ""
    echo "  (La alternativa —dar 'Acceso total al disco' a node— funciona, pero le concede"
    echo "   ese permiso a CUALQUIER script de Node que corras. No lo recomiendo.)"
    exit 1
    ;;
esac

# El admin y la retención tienen que estar definidos: el server se niega a arrancar sin ellos.
if [ ! -f "$RAIZ/.env" ]; then
  echo "  Falta $RAIZ/.env — cópialo de .env.example y pon tus credenciales."
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents" "$RAIZ/logs"

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>

  <!-- caffeinate -i: la Mac no se duerme mientras el server viva. Un consultorio con la
       laptop dormida es un consultorio sin transcripciones. -->
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/caffeinate</string>
    <string>-i</string>
    <string>${NODE}</string>
    <string>${RAIZ}/server.js</string>
  </array>

  <key>WorkingDirectory</key><string>${RAIZ}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key><string>production</string>
    <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>

  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>          <!-- si se cae, vuelve -->
  <key>ThrottleInterval</key><integer>10</integer>

  <key>StandardOutPath</key><string>${RAIZ}/logs/server.log</string>
  <key>StandardErrorPath</key><string>${RAIZ}/logs/server.err</string>
</dict>
</plist>
PLIST_EOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load  "$PLIST"

echo "  MedRecord instalado como servicio (${LABEL})."
echo "  Arranca solo al encender la Mac y vuelve solo si se cae."
echo ""
echo "    Estado : launchctl list | grep medrecord"
echo "    Logs   : tail -f ${RAIZ}/logs/server.log"
echo "    Parar  : launchctl unload ${PLIST}"
