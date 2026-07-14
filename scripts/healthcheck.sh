#!/usr/bin/env bash
# ¿El sistema está vivo? Avisa si no, ANTES de que se entere el médico con el paciente delante.
#
# Comprueba las tres piezas: el servidor, Whisper y Ollama. Un servidor vivo con Ollama caído
# transcribe pero no llena campos — el médico lo nota historia por historia.
#
# La alerta va por notificación de macOS. Para el piloto real, apúntala a un canal que el
# usuario mire de verdad (Telegram, correo): una notificación en una Mac que nadie mira no
# alerta a nadie.
set -uo pipefail

PUERTO="${PORT:-3000}"
URL="http://localhost:${PUERTO}/health"
ESTADO="/tmp/medrecord-health-estado"

avisar() {
  local msg="$1"
  echo "$(date '+%F %T') ALERTA: $msg"
  osascript -e "display notification \"${msg}\" with title \"MedRecord\" sound name \"Basso\"" 2>/dev/null || true
}

RESP="$(curl -s -m 8 "$URL" 2>/dev/null || true)"

if [ -z "$RESP" ]; then
  # Solo avisamos al CAMBIAR de estado: una alerta cada 5 minutos durante un fin de semana
  # entrena a ignorarlas.
  if [ "$(cat "$ESTADO" 2>/dev/null || echo ok)" != "caido" ]; then
    avisar "El servidor no responde. Las consultas grabadas quedan en cola en el celular."
    echo caido > "$ESTADO"
  fi
  exit 1
fi

WHISPER="$(echo "$RESP" | sed -n 's/.*"whisper":\([a-z]*\).*/\1/p')"
LLM="$(echo "$RESP" | sed -n 's/.*"llm":\([a-z]*\).*/\1/p')"

PROBLEMAS=""
[ "$WHISPER" != "true" ] && PROBLEMAS="Whisper caído (no se transcribe nada)"
[ "$LLM" != "true" ] && PROBLEMAS="${PROBLEMAS:+$PROBLEMAS · }Ollama caído (se transcribe, pero los campos hay que escribirlos a mano)"

if [ -n "$PROBLEMAS" ]; then
  if [ "$(cat "$ESTADO" 2>/dev/null || echo ok)" != "degradado" ]; then
    avisar "$PROBLEMAS"
    echo degradado > "$ESTADO"
  fi
  exit 1
fi

# Todo bien: si veníamos de una caída, avisamos la recuperación.
if [ "$(cat "$ESTADO" 2>/dev/null || echo ok)" != "ok" ]; then
  avisar "El sistema volvió a la normalidad."
fi
echo ok > "$ESTADO"
echo "$(date '+%F %T') ok"
