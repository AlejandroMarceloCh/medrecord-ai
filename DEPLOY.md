# Despliegue de MedRecord AI

## La realidad sobre Vercel (léelo antes de intentar)

MedRecord depende de **dos procesos pesados que viven en tu máquina**:

- **Whisper.cpp** — un binario que se ejecuta (`spawn`) y lee un modelo de ~3 GB.
- **Ollama** — un daemon aparte que sirve el LLM `qwen2.5:7b`.

Además el backend usa un **WebSocket persistente** y guarda archivos en **disco**.

**Vercel es serverless**: funciones efímeras (segundos de vida, sin proceso largo), **sin
WebSocket persistente, sin sistema de archivos durable, sin GPU/binarios**, y obviamente
no corre Whisper.cpp ni Ollama. → **El backend de MedRecord NO puede correr en Vercel.**

El **frontend** (`/web` y `/mobile`) sí es estático y podría servirse desde Vercel, pero
las llamadas `/api/...` y el WebSocket necesitan un backend en algún lado.

---

## Opciones

### Opción 1 — Local + túnel https  ⭐ recomendada para la demo con tu hermano
Todo corre en tu Mac. Lo expones con un túnel https (necesario para que el micrófono del
celular funcione). Privado (nada sale de tu máquina), gratis, 5 minutos.

```bash
npm install
npm start                                   # o npm run dev
# en otra terminal:
cloudflared tunnel --url http://localhost:3000     # o: ngrok http 3000
```
Te da una URL `https://algo.trycloudflare.com`. En el celular abre `…/mobile`, en la
laptop `…/web`. Listo.

### Opción 2 — Frontend en Vercel + backend tuyo (Mac por túnel, o EC2)
Subes solo el frontend estático a Vercel y lo apuntas a tu backend.
**Requiere un cambio menor de código**: hoy el frontend llama a `/api/...` y al WS del
mismo host; habría que parametrizar una `API_BASE` (variable) hacia la URL del backend.
Más piezas, sin ganancia real para un usuario único. No lo dejé hecho porque implica
decidir dónde vive el backend.

### Opción 3 — Re-plataforma cloud-nativa (NO recomendada ahora)
Para que TODO corra en la nube habría que cambiar:
- Whisper.cpp → Whisper API / Deepgram / AssemblyAI
- Ollama local → Claude API / OpenAI
- Disco → Postgres / Vercel Blob / S3
- WebSocket → polling o un servicio (Ably/Pusher)

⚠️ **Esto rompe el diferenciador del producto**: el audio y la transcripción de pacientes
**saldrían a la nube** de terceros. Para data médica eso es sensible (consentimiento,
ubicación de datos). **Es una decisión tuya/de producto, no un detalle técnico.**

---

## Recomendación

Para presentárselo a tu hermano: **Opción 1**. Sube el **código** a GitHub (versionado y
compartible), pero **corre la demo local con el túnel** — no despliegues el backend a Vercel.

## Subir el código a GitHub (cuando quieras, no lo hice yo)

```bash
cd ~/Desktop/PROYECTOS_2026/MedRecord
git init && git add -A && git commit -m "MedRecord AI: rediseño UX + pipeline real"
gh repo create medrecord-ai --private --source=. --remote=origin --push
```
`node_modules/`, `dist/`, `data/` y `.env` ya están en `.gitignore`.
