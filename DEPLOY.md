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

**Paso 1 — crea el admin. No es opcional.** Un túnel publica el puerto en internet: sin
usuario configurado, cualquiera con la URL leería todas las historias. Por eso el server
se niega a arrancar sin autenticación.

```bash
npm install

# Primer arranque: crea el admin (solo hace falta una vez; queda cifrado en disco).
MEDRECORD_ADMIN_USER=alejandro \
MEDRECORD_ADMIN_PASS='una-clave-larga-de-verdad' \
npm start

# Arranques siguientes: ya no necesitas las variables.
npm start
```

**Paso 2 — el túnel:**

```bash
cloudflared tunnel --url http://localhost:3000     # o: ngrok http 3000
```

Te da una URL `https://algo.trycloudflare.com`. En el celular abre `…/mobile`, en la
laptop `…/web`, y entras con el usuario del paso 1.

**Aviso sobre el túnel gratuito:** la URL **cambia en cada arranque**. Para uso diario eso
significa reinstalar el PWA y perder el `localStorage` todos los días. Sirve para una demo,
no para un piloto.

---

## Para el piloto: Tailscale  ⭐

Es la mejor opción para una clínica, y por una razón que no es técnica: **no expone el
servidor a internet.** El túnel público pone la historia clínica de tus pacientes detrás de
una URL que cualquiera podría descubrir; Tailscale la deja en una red privada donde solo
entran los dispositivos que autorices.

```bash
brew install --cask tailscale

# En la Mac del consultorio y en el celular del médico: iniciar sesión con la misma cuenta.
tailscale up
tailscale cert "$(tailscale status --json | jq -r .Self.DNSName)"   # HTTPS del tailnet
tailscale serve https / http://localhost:3000
```

Con eso:

- **URL estable** (`https://mac-consultorio.tu-tailnet.ts.net`): el PWA se instala una vez.
- **HTTPS de verdad**, así que el micrófono del celular funciona.
- **Nada expuesto a internet público.** Ni siquiera hay un puerto abierto.

## Instalar como servicio (obligatorio para el piloto)

Sin esto, una actualización de macOS de madrugada deja el servidor muerto y el médico llega a
una app que no responde.

```bash
cp .env.example .env      # y pon tus credenciales
bash scripts/install-launchagent.sh    # arranca al encender, vuelve si se cae, no deja dormir la Mac
BACKUP_DIR=/Volumes/USB_CIFRADO bash scripts/install-cron.sh   # backup 22:00 + healthcheck cada 5 min
```

**`BACKUP_DIR` tiene que estar FUERA del disco de datos.** El `.tar.gz` lleva la clave maestra
dentro: un backup al lado de lo que protege no protege de nada, y un disco que muere se lleva
las dos cosas.

**Respalda `data/.master.key` antes de exponer nada.** Sin ella, los datos cifrados son
irrecuperables; y si el archivo se daña, el server aborta en vez de regenerarla (ver
`RESTORE.md`).

---

## Antes de la primera consulta: lee `PILOTO.md`

Tiene la semana de baseline (sin la cual el piloto no prueba nada), las métricas que el sistema
mide solo, y los dos checkpoints con su umbral de **pausa** escrito por adelantado.

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
