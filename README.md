# MedRecord AI

Documentación clínica asistida por IA, **100% local**. El médico graba la consulta
desde el celular; el servidor la transcribe con Whisper y un LLM extrae los campos de
la historia clínica. En la laptop, el médico **solo revisa y confirma** — no escribe
desde cero. El audio y la transcripción **nunca salen de la máquina**.

## Dos superficies

- **Móvil** (`/mobile`) — la grabadora. Nombre del paciente (+ DNI opcional) → grabar → subir. Nada más.
- **Web** (`/web`) — el cerebro. Lista de consultas en tiempo real → visor con transcripción + campos clínicos pre-llenados, editables, con guardar y exportar reales.

```
[Celular: nombre/DNI + graba]
        │  POST /api/recordings  (multipart)
        ▼
[Server] ── ffmpeg → wav 16k → whisper.cpp (large-v3 + VAD) ── Ollama (qwen2.5:7b) ──┐
        │  WS: received → processing → transcribed → filling → done                  │
        ▼                                                                            ▼
[Web: lista de consultas] ── abre ──> [Visor: transcripción + audio + campos] → Guardar / Exportar PDF
```

## Stack

- **Backend**: Node.js + Express + WebSocket. Sin base de datos: cada grabación se persiste como un JSON en disco junto al audio, y se reconstruye al arrancar.
- **ASR**: Whisper.cpp `large-v3` (VAD silero + prompt médico). Local.
- **LLM**: Ollama local `qwen2.5:7b` (gratis, sin API key, privado). Conmutarlo a Claude API es trivial (mismo `extractFields`).
- **Frontend**: React (JSX precompilado con esbuild en producción; Babel en el navegador en dev). Sin framework de build. PWA instalable.

## Requisitos

- Node ≥ 18
- **Whisper.cpp** compilado con `large-v3` + VAD (rutas configurables, ver `.env.example`).
- **Ollama** corriendo con `qwen2.5:7b`:
  ```
  brew install --cask ollama-app   # NO `brew install ollama` (esa fórmula no trae el runner)
  ollama pull qwen2.5:7b
  ```
- `ffmpeg` en el PATH.

## Correr

```bash
npm install
npm run dev        # http://localhost:3000  (sirve public/, Babel en el navegador)
# producción (JSX precompilado):
npm run build && npm start
```

- Web: http://localhost:3000/web
- Móvil: http://localhost:3000/mobile

> El micrófono del celular necesita **https**. En LAN por http no funciona. Para una
> prueba real desde el celular, expón la app con un túnel https (ver `DEPLOY.md`).

## API

| Método | Ruta | Qué hace |
|---|---|---|
| `POST` | `/api/recordings` | Sube audio (multipart) → dispara transcripción + autollenado |
| `GET` | `/api/recordings` | Lista todas las grabaciones |
| `GET` | `/api/recordings/:id` | Una grabación (lo usa el móvil para el polling de estado) |
| `GET` | `/api/recordings/:id/audio` | Stream del audio |
| `PUT` | `/api/recordings/:id/fields` | Guarda la revisión del médico (marca `reviewed`) |
| `POST` | `/api/recordings/:id/retry` | Reprocesa todo (re-transcribe el audio) |
| `POST` | `/api/recordings/:id/reextract` | Reintenta solo el autollenado (reusa la transcripción) |
| `DELETE` | `/api/recordings/:id` | Descarta grabación (metadatos + audio) |
| `GET` | `/health` | Estado de Whisper/LLM + dirección LAN |

WebSocket (mismo host): empuja `recording:received|processing|transcribed|filling|filled|updated|error|deleted` a la web. La web reconecta sola (backoff) y re-sincroniza al reconectar.

## Estados de una grabación

`received` → `processing` (Whisper) → `transcribed` → `filling` (LLM) → `done` (por revisar)
→ `reviewed` (el médico guardó). `error` en cualquier punto (con mensaje accionable + reintento).

## Estructura

```
server.js          Express + WS + subida (multer) + orquesta Whisper/LLM + persistencia JSON
whisper.js         ffmpeg + whisper-cli (módulo autocontenido)
llm.js             autollenado de campos con Ollama (esquema de 5 secciones)
build.mjs          precompila el JSX inline → dist/ (esbuild)
public/web.html    superficie web: lista de consultas + visor clínico + ajustes
public/mobile.html superficie móvil: grabadora (Wake Lock + feedback de procesamiento)
data/recordings/   audios + sidecar JSON por grabación (gitignored)
```

## Despliegue

Ver **`DEPLOY.md`**. Resumen: para la demo, corre local + túnel https (cloudflared).
Vercel **no** puede correr Whisper.cpp ni Ollama (es serverless); a lo sumo serviría el
frontend estático apuntando a un backend aparte.
