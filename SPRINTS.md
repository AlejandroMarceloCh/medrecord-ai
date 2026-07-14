# Bitácora de sprints

Memoria del proyecto. Se escribe al **cerrar** cada sprint, en append: los bloques
anteriores no se reescriben nunca. Está pensado para que un agente que llega sin contexto
pueda leerlo entero y saber en qué estado está el sistema, qué se probó y qué quedó
debiendo.

El plan vive en `PLAN_SPRINTS.md`. Los hallazgos que lo originaron, en `AUDIT_2026-07-12.md`.

**Sprints 1-14: cerrados antes de esta bitácora.** Ver `ROADMAP.md` para sus goals
(recuperación móvil, diccionario, evidencia, export, auth, autollenado, cifrado, seguridad
clínica, multiusuario, los P0 de la auditoría de sabuesos, integridad, UX de firma,
robustez, cumplimiento legal).

---

## Invariantes vivas

La lista que el Agente A verifica al cerrar **cada** sprint. Crece; nunca se poda.

1. Sin sesión válida, ningún cliente recibe PII por ningún canal (HTTP ni WS).
2. Un médico no-admin solo ve sus propias grabaciones; admin ve todo.
3. No se puede firmar una historia sin confirmar cada campo poblado por la IA.
4. Una historia firmada (`reviewed`) es inmutable: retry/reextract/PUT → 409.
5. Los sidecars y el audio están cifrados en reposo; ningún `console.*` imprime PII.
6. Un PUT con versión vieja → 409 (optimistic lock).
7. Sin consentimiento registrado, la grabación no se procesa.
8. La firma es recomputable y `/verify` la valida.
9. El backup incluye la master key y restaura en una máquina limpia.
10. Un sidecar corrupto va a cuarentena; las buenas cargan igual.
11. El diccionario médico se aplica en la transcripción visible, los campos y el PDF.
12. Las `_fuentes` del LLM se validan verbatim con `indexOf` antes de mostrarse.
13. El login tiene throttle (429 tras N fallos).
14. El audio vencido por retención se borra de forma segura.
15. **[S16]** Una `.master.key` existente nunca se regenera, sea cual sea su estado.
16. **[S16]** Sin usuarios, sin token y sin `MEDRECORD_OPEN=1`, el server no arranca.
17. **[S16]** Si NINGÚN sidecar descifra, el server aborta en vez de mandarlos a cuarentena.
18. **[S16]** Actualizar el código nunca borra audio ya guardado.
19. **[S17]** Nunca corre más de un Whisper a la vez, venga de donde venga el trabajo.
20. **[S17]** Un trabajo en vuelo nunca escribe sobre una historia firmada o borrada.
21. **[S17]** Una transcripción que no cabe en el contexto nunca produce campos vacíos en silencio.
22. **[S17]** No se puede firmar una historia vacía (sin transcripción y sin ningún campo).
23. **[S17]** El cliente no influye en el timeout de Whisper: la duración la mide el servidor.
24. **[S18]** El móvil no carga ningún recurso de un CDN y abre sin conexión.
25. **[S18]** La pantalla de grabación nunca muestra "grabando" si el micrófono está muerto.
26. **[S18]** Una consulta nunca se encola dos veces (carrera Detener / caída del micrófono).
27. **[S18]** El audio recuperado conserva su formato real (mp4 en iPhone, no webm forzado).
28. **[S18]** `npm test` descubre `test/sprint*.mjs` solo: ningún test puede quedar fuera por olvido.

---

## Sprint 16 — Cerrojo · CERRADO 2026-07-12

**Goal:** Ningún cliente sin credencial válida recibe PII por ningún canal, y ninguna clave
maestra existente se regenera jamás.

**Veredicto: CUMPLIDO.**

### Qué cambió

- `server.js` — fail-closed de arranque. Sin usuarios, sin `MEDRECORD_TOKEN` y sin
  `MEDRECORD_OPEN=1`, el server hace `exit(1)` con instrucciones. Antes arrancaba abierto:
  el `npm start` + `cloudflared` que documentaba el propio `DEPLOY.md` dejaba **todas las
  historias legibles, editables, firmables y borrables por cualquiera con la URL del túnel**.
- `server.js` — `canSee(null)` devuelve `OPEN_MODE` en vez de `true`.
- `crypto.js:26` — una `.master.key` existente pero inválida (≠32 bytes, ilegible) lanza en
  vez de regenerarse. Antes, un archivo truncado por una copia a medias hacía que se
  generara una clave nueva **encima de la real**, volviendo toda la data cifrada
  irrecuperable, sin un solo aviso.
- `server.js:116` — si **ningún** sidecar descifra, aborta. Un sidecar suelto que no abre es
  corrupción; todos a la vez es la clave equivocada, y mandar la historia clínica completa a
  `.corrupt` por un restore mal hecho es tan destructivo como perder la clave.
- `auth.js:36` — `loadUsers()` distingue `ENOENT` (primer arranque) de "existe pero no
  descifra" (aborta). Antes ambos casos daban cero usuarios, y cero usuarios **desactivaba
  la autenticación en silencio**. Un archivo de 0 bytes se trata como "aún no hay usuarios",
  no como corrupción.
- `auth.js:114` — `bootstrapAdmin()` rechaza las contraseñas de ejemplo de la documentación.
- `server.js:150` — la retención de audio se **exige explícita**, sin default. Con aviso en
  cada arranque si no está configurada.
- `server.js` / `whisper.js` — `secureDelete` (sobrescribir antes de desenlazar) en el
  `DELETE` del médico —el camino por el que el paciente ejerce su derecho de supresión— y en
  los temporales en claro de `/tmp`: el audio descifrado y el `out.txt` de Whisper, que es la
  transcripción completa de la consulta en texto plano.
- `server.js:5` — handler de `uncaughtException` que distingue los abortos deliberados
  (`code: 'MEDRECORD_BOOT'`) de un bug real, para que el operador lea un mensaje y no un stack.
- `.env.example` — documentadas las 8 variables que faltaban, con las credenciales de admin
  **comentadas** a propósito.
- `DEPLOY.md` — el paso 1 ahora crea el admin, y avisa de que la URL del túnel gratuito
  cambia en cada arranque. `RESTORE.md` — troubleshooting del nuevo fail-closed.

### Tests

- `test/sprint16_cerrojo.mjs` → **8/8**.
- Suite completa → **77/77, 0 fallas**.
- 12 tests tuvieron que declarar `MEDRECORD_OPEN=1`: corrían en modo abierto por default, que
  es justo lo que este sprint elimina.

### QA (protocolo anticagadas)

- **Agente A (regresión):** 14/14 invariantes intactas. Descartó explícitamente los cuatro
  riesgos que le señalé: `secureDelete` sobre un archivo inexistente no lanza; el nuevo
  `throw` no rompe el restore documentado; la retención no afecta a ningún test; y el
  `require('./crypto')` de `whisper.js` no crea ciclo ni genera una clave de más.
- **Agente B (sabueso del diff):** 2 P1 + 2 P2, **todos reproducidos ejecutando código**, no
  leyéndolo. Los cuatro corregidos dentro del sprint:
  - P1: mi `.env.example` dejaba `MEDRECORD_ADMIN_PASS=cambia-esta-clave` **descomentada** →
    `cp .env.example .env && npm start` creaba un admin con una clave que está escrita en el
    repo. Reabría el mismo agujero que el sprint cierra.
  - P1: mi default de retención de 90 días **borró audio real preexistente en el primer
    arranque** tras el upgrade. Lo demostró con un sidecar de hace 200 días. Destruir datos de
    salud como efecto secundario de un `git pull` es inaceptable → la política pasó a ser
    explícita.
  - P2: `users.json` de 0 bytes disparaba el abort de "corrupción" → ahora es "aún no hay
    usuarios".
  - P2: los aborts salían como stack trace crudo → ahora salen como mensaje.
- **Agente C (verificador del goal):** **GOAL CUMPLIDO**, verificado a mano contra un server
  real, no contra el test. Se conectó al WebSocket sin cookie (`close 1008`, nunca entra al
  `Set` de clientes), con token de device (solo `{id, status}`, sin PII) y con la sesión de
  un médico que no es dueño del registro (no recibe nada) — cobertura que el test no tenía.
  Y encontró **la grieta que este sprint no había visto**: una clave de **exactamente 32
  bytes pero equivocada** pasaba la validación de longitud, el server arrancaba, y mandaba
  **toda la historia clínica a `.corrupt`** en silencio. Corregido (invariante 17) y con test
  propio. También llamó falso el caso 6 original del test (era un `grep` sobre el fuente, no
  una prueba de comportamiento): reescrito.

### Deuda abierta

- **CSRF / validación de `Origin`** en endpoints mutantes y en el handshake del WS.
  `SameSite=Strict` es ciego al puerto, así que cualquier otro servidor en `localhost` es
  *same-site*. → **Sprint 19.**
- **El WS congela la identidad en el handshake**: `logout` y la expiración de sesión no
  cortan el stream de PII de un socket ya abierto. → **Sprint 19.**
- **Timing attack / enumeración de usuarios** en `authenticate()` (si el usuario no existe,
  no corre scrypt) y lockout dirigido por username. → **Sprint 19.**
- **La misma clave sirve para AES-GCM y para el HMAC de firma**, y el HMAC no da no-repudio
  (el servidor conoce la clave). → **Sprint 19.**
- **`secureDelete` en SSD con wear leveling no garantiza borrado físico.** Es lo mejor que se
  puede hacer desde userspace; el cifrado en reposo es la defensa real. Documentado, sin acción.

### Invariantes nuevas para el Agente A

15. Una `.master.key` existente nunca se regenera, sea cual sea su estado.
16. Sin usuarios, sin token y sin `MEDRECORD_OPEN=1`, el server no arranca.
17. Si NINGÚN sidecar descifra, el server aborta en vez de mandarlos a cuarentena.
18. Actualizar el código nunca borra audio ya guardado.

## Sprint 17 — El pipeline aguanta un turno · CERRADO 2026-07-12

**Goal:** Cinco audios subidos en tres minutos se procesan todos, sin matarse entre sí, y un
audio de 30 minutos llega completo al LLM o falla con un mensaje que el médico entiende.

**Veredicto: CUMPLIDO** (el Agente C lo verificó con Playwright sobre el bundle de producción
y corriendo el pipeline real con Whisper large-v3 + Ollama, no contra el test).

### Qué cambió

- `server.js` — **cola FIFO con concurrencia 1**. Whisper carga 3 GB por proceso y corre con
  todos los cores; dos a la vez mandan la Mac de 16 GB a swap y se matan entre sí en cascada.
  `loadAll()` ya serializaba el resume con el comentario *"el resto del pipeline asume una a la
  vez"* — pero el camino en vivo no lo asumía. Ahora el POST, el resume y el `/retry` pasan
  todos por la misma cola. Estado `queued` + `queuePos` visible ("vas 3 de 5").
- `whisper.js` — **timeout proporcional a la duración**, y la duración **la mide el servidor**
  sobre el WAV que produce ffmpeg (PCM 16 kHz mono = 32.000 bytes/seg, sale de un `stat`). El
  cliente no influye: un `durationSec` inflado reservaría el único slot de la cola por horas.
- `llm.js` — **`num_ctx` dinámico**. El fijo de 8192 desbordaba con una consulta de 25-30 min, y
  Ollama trunca **descartando tokens del inicio**: se comía la filiación y el motivo de consulta,
  y `normalize()` rellenaba con `''`, indistinguible de "no se mencionó". Si de verdad no cabe,
  `TRANSCRIPT_TOO_LONG` con un mensaje que el médico entiende.
- `llm.js` — **las fuentes verbatim resucitaron** (ver abajo, lo encontró el benchmark).
- `src/web/clinical.jsx` — si Whisper falla, el médico **ya puede llenar la historia a mano**
  escuchando el audio: antes un muro de error reemplazaba todo el formulario y lo dejaba sin
  salida, justo el día malo. El `AiBanner` ahora muestra la **causa** del fallo del LLM.
- `src/web/app.jsx` — **chip de salud** con poll a `/health`. El endpoint existía desde el
  sprint 1 y la web nunca lo llamaba: si Ollama caía a mitad de turno, el médico se enteraba
  viendo fallar el autollenado doce veces seguidas.

### Benchmark real (el número que era la promesa del producto y no existía)

Consulta sintética de 2.66 min (diálogo clínico completo), pipeline real en la Mac:

| Etapa | Tiempo |
|---|---|
| Whisper large-v3 | 32.1 s → **0.20× tiempo real** |
| Ollama qwen2.5:7b | 38.2 s |
| **Total** | **70 s** |

Campos llenos 15/22, y extrajo bien lo que importa: PA `150/95`, FC `88`, diagnóstico
(*"cefalea tensional, hipertensión arterial no diagnosticada"*), tratamiento con dosis
(*"naproxeno 500 mg cada 12 horas por 5 días"*).

**Extrapolado a una consulta de 20 minutos: ~4.7 minutos hasta el borrador.** Nadie ha corrido
todavía los 20 minutos completos de punta a punta — es una extrapolación lineal sobre el ratio
de Whisper, honesta pero no medida.

### El bug que solo el benchmark podía encontrar

Con la transcripción real, `buildSources()` devolvió **0 fuentes**. Cero. La evidencia vinculada
—la feature que justifica que el médico confíe en la IA— estaba **muerta sobre audio real**, y
ningún test lo veía porque todos usan transcripciones de una sola línea.

Causa: whisper.cpp separa los segmentos con saltos de línea, el LLM cita las frases sin ellos, y
el `indexOf` literal fallaba en cualquier cita que cruzara un salto. La invariante 12 ("las
fuentes se validan verbatim") **seguía siendo cierta y era vacua**: no mostrábamos fuentes falsas
porque no mostrábamos ninguna.

Arreglado colapsando los espacios en blanco con un mapa de vuelta a los offsets originales. No
relaja la garantía —la cita sigue teniendo que existir en el audio—, solo deja de exigir que
coincidan los saltos de línea. Sobre el mismo audio: **de 0 a 6 fuentes**, y la cita inventada
se sigue descartando.

### Tests

- `test/sprint17_turno.mjs` → **11/11**. El caso 1 no mira el resultado: sustituye whisper-cli
  por un script que registra START/END y **verifica que sus ventanas de ejecución nunca se
  solapen** (5 arranques, máximo 1 simultáneo). Sin eso, un test que solo mirara el estado final
  pasaría igual aunque corrieran los 5 en paralelo.
- Suite completa → **88/88, 0 fallas**.

### QA (protocolo anticagadas)

Los tres agentes encontraron **2 P0, 1 P1 y 1 P2 reales**, todos reproducidos ejecutando código.
Todos corregidos dentro del sprint, y los dos agentes que hallaron P0 se relanzaron para
verificar los fixes.

- **Agente B (sabueso):** los dos P0 eran míos y los introdujo este mismo sprint.
  - **P0:** al habilitar el footer en estado `error` para que el médico pudiera llenar a mano,
    abrí la puerta a **firmar una historia completamente vacía**. El gate de human-in-the-loop
    solo corre `if (r.fields_ia)`, y cuando Whisper falla no hay IA — así que el gate entero se
    saltaba. Lo firmó en vivo con un solo PUT: historia sellada con HMAC, sin una palabra dentro.
  - **P0:** la cola alargó de milisegundos a **minutos** la ventana en que un job en vuelo puede
    aterrizar sobre una historia ya firmada, dejando el HMAC inválido sobre contenido que el
    médico nunca vio. Lo reprodujo: `/verify` devolvía `valid:false` sobre una firma legítima, y
    el registro reaparecía en "Por revisar". Fix: `jobVigente()`, que revalida después de cada
    `await`. (Estaba planificado para el Sprint 19; la cola lo volvió urgente.)
  - **P1:** el `durationSec` del cliente podía inflar el timeout y trabar el único slot 3 horas.
  - En la **re-verificación** encontró que mi primer fix era **incompleto** (`medida || durationSec`
    seguía cayendo al cliente si el WAV salía corrupto). Cerrado quitando el fallback entero.
- **Agente C (verificador):** primer veredicto **"GOAL CUMPLIDO SOLO EN EL TEST"** — que según las
  reglas cuenta como P0 y bloquea el cierre. Dos grietas: (a) con `durationSec=0` el timeout caía
  al tope fijo de 20 min, *el bug que el sprint decía arreglar*; y (b) **el mensaje de
  `TRANSCRIPT_TOO_LONG` nunca llegaba a la pantalla** — lo construí con cuidado en el backend y el
  `AiBanner` lo tiraba a la basura, mostrando el mismo genérico que para cualquier otro fallo.
  Tras los fixes: **GOAL CUMPLIDO**, verificado con Playwright leyendo el DOM del bundle de
  producción.
- **Agente A (regresión):** 18/18 invariantes intactas. Señaló el mismo riesgo de la carrera de
  firma que el sabueso, por otro camino.

### Deuda abierta

- **Nadie ha corrido una consulta real de 20-30 minutos de punta a punta.** El número del
  benchmark es una extrapolación. → Antes del piloto.
- **Los tests usan puertos fijos**: dos suites solapadas colisionan (`TIME_WAIT`). Va a morder en
  CI. → **Sprint 22.**
- **Ningún test ejercita Whisper real**: los fakes siempre tienen éxito en 700 ms. No se cubren el
  timeout con `SIGKILL`, el exit code ≠ 0, ni el `.txt` ausente. → **Sprint 22.**
- **Firmar solo con transcripción y sin campos** queda bloqueado por el gate nuevo. Creo que es lo
  correcto (una historia clínica sin campos estructurados no es una historia), pero es una
  decisión de producto que conviene confirmar con el médico del piloto.
- La deuda del Sprint 16 (CSRF, WS que congela la identidad, timing attack en login, HMAC sin
  no-repudio) sigue abierta. → **Sprint 19.**

### Invariantes nuevas para el Agente A

19. Nunca corre más de un Whisper a la vez, venga de donde venga el trabajo.
20. Un trabajo en vuelo nunca escribe sobre una historia firmada o borrada.
21. Una transcripción que no cabe en el contexto nunca produce campos vacíos en silencio.
22. No se puede firmar una historia vacía (sin transcripción y sin ningún campo).
23. El cliente no influye en el timeout de Whisper: la duración la mide el servidor.

## Sprint 18 — El móvil no miente · CERRADO 2026-07-13

**Goal:** La pantalla de grabación refleja el estado real del micrófono, y la app abre y
graba sin conexión a internet.

**Veredicto: CUMPLIDO** (el Agente C lo verificó grabando offline de verdad, matando la
pestaña a mitad de consulta, y silenciando el micrófono con un `GainNode` en cero).

### Qué cambió

El móvil era un HTML de 609 líneas que transpilaba JSX en el navegador. Ahora son módulos
compilados con esbuild (`src/mobile/`), igual que la web.

- **La onda sale del micrófono.** `level.js` mide RMS real con un `AnalyserNode`. Antes era
  un `@keyframes` de CSS y el cronómetro un `setInterval`: **ninguno de los dos tocaba el
  micrófono**. Si iOS le quitaba el micro a la app —una llamada entrante basta—, la pantalla
  seguía diciendo "Grabando 14:32" con la onda bailando, y el médico terminaba la consulta
  convencido de que había grabado. Una onda que miente es peor que no tener onda.
- **`rec.onerror` + `track.onended`**: si el micrófono muere, la app sale del estado grabando,
  avisa por qué, y **conserva lo grabado hasta el corte**.
- **Aviso de silencio**: 6 segundos sin voz → "No estamos captando sonido. Revisa el micrófono."
- **`timeslice` de 5 s + chunks a IndexedDB al vuelo.** Antes 20 minutos de consulta vivían en
  RAM y era todo o nada si iOS mataba la pestaña. Ahora lo peor que se pierde son segundos, y
  al reabrir la app ofrece recuperar lo grabado.
- **Sin CDN.** Cargaba React *development* y Babel standalone (~3 MB) desde unpkg, y
  `build.mjs` solo **copiaba** el HTML a `dist/`, así que producción también dependía del CDN.
  Sin internet, la app **no existía**: pantalla en blanco, con el paciente enfrente — mientras
  el propio cartel prometía *"tus grabaciones se suben solas al volver"*. Ahora hay bundle
  local, fuentes del sistema y un service worker que precachea el shell.
- **Descartar** (con diálogo destructivo que dice qué se borra), **pausa/reanudar**, blob vacío
  con error visible en vez de un falso éxito silencioso, y **el nombre pasa a ser opcional**:
  solo el consentimiento es obligatorio. El flujo real es "entra el paciente → grabo", no
  "tipeo el nombre completo con el paciente esperando".
- **Login en el móvil**: sin sesión, el audio subía con el token de device y quedaba con
  `ownerId: null` — un médico no-admin **nunca veía las grabaciones que él mismo acababa de
  hacer**. Hoy funcionaba por accidente porque el único usuario era el admin.

### Tests

- `test/sprint18_movil.mjs` → **10/10**, en Chromium real con micrófono falso.
- Suite completa → **109/109, 0 fallas, 17 suites**.

### QA (protocolo anticagadas)

- **Agente A (regresión):** 23/23 invariantes intactas. Verificó que el service worker excluye
  `/api` (la PII no va al Cache Storage) y que el "bypass" de `whoami` sin red no permite leer
  nada: el servidor sigue exigiendo identidad.
- **Agente B (sabueso):** 2 P0 + 1 P1 + 1 P2, todos corregidos.
  - **P0:** al recuperar un borrador huérfano, el `mimeType` estaba **hardcodeado a webm**.
    Safari en iPhone graba **mp4**: subíamos bytes mp4 con extensión `.webm`, Whisper recibía
    un contenedor renombrado y la transcripción salía basura — **justo en el caso que esa
    feature existe para salvar**. Ahora cada trozo guarda su formato real.
  - **P0:** carrera entre "Detener" y la caída del micrófono (el paciente cuelga una llamada
    justo cuando el médico termina): las dos rutas ensamblaban el mismo audio y lo encolaban
    **dos veces** → dos consultas duplicadas, ambas transcritas por separado. Guard idempotente.
  - **P1:** los trozos huérfanos se acumulaban en IndexedDB para siempre — audio de paciente
    creciendo sin límite en el teléfono. Ahora se barren al abrir.
  - **P2:** la duración del borrador recuperado se sobreestimaba (`chunks × 5s`); ahora sale de
    los timestamps reales.
- **Agente C (verificador):** **GOAL CUMPLIDO** en comportamiento real — grabó offline y vio la
  cola drenar al reconectar; silenció el micrófono con un `GainNode` y el aviso apareció; mató
  la pestaña a mitad de consulta y recuperó 72 KB de audio válido. **Y encontró la regresión más
  peligrosa del sprint**: al pasar el móvil a módulos, `window.MRQueue` dejó de existir y
  `sprint1_mobile_recovery` —el arnés que garantiza *"una grabación nunca se pierde"*— pasó a
  **1/9 sin que nadie lo notara, porque nunca corría en `npm test`**.

### La lección del sprint

Al arreglar ese arnés apareció algo peor: **llevaba roto desde el Sprint 14**. Sus fixtures
inyectaban grabaciones sin `consent`, y el Sprint 14 hizo el consentimiento obligatorio. El
test que garantizaba la promesa central del móvil estuvo mintiendo durante semanas, y no se
notó por una sola razón: **no corría**.

Arreglado de raíz, no en el síntoma:
- `sprint1` y `sprint2` son **autónomos** (levantan su propio server y siembran sus datos).
- `npm test` ahora **descubre `test/sprint*.mjs` solo**: un test nuevo no puede quedar fuera
  por olvido, que es exactamente como pasó esto.
- El caso 8 de `sprint1` leía un `.ogg` de `data/recordings` — o sea **usaba grabaciones reales
  de pacientes como fixture**. Ahora genera audio sintético con ffmpeg.
- Los tests ya no usan puertos fijos (`_port.mjs`): dos suites seguidas colisionaban en
  `TIME_WAIT` y una fallaba sin motivo. Un test que falla por su propia infraestructura enseña
  a ignorar el rojo.
- El CI instala Chromium y ffmpeg.

### Deuda abierta

- **El caso 6 de `sprint18`** (blob vacío) sigue siendo un regex sobre el fuente, no
  comportamiento. El Agente C lo señaló; se puede probar de verdad mockeando `MediaRecorder`.
- **Nadie ha probado el móvil en un iPhone real.** Todo el mp4/Safari es razonamiento sobre la
  API, no observación. → Antes del piloto.
- La deuda del S16 y S17 sigue abierta (CSRF, WS que congela identidad, timing attack, HMAC sin
  no-repudio, consulta real de 20-30 min de punta a punta). → **Sprint 19 y 22.**

### Invariantes nuevas para el Agente A

24. El móvil no carga ningún recurso de un CDN y abre sin conexión.
25. La pantalla de grabación nunca muestra "grabando" si el micrófono está muerto.
26. Una consulta nunca se encola dos veces (carrera Detener / caída del micrófono).
27. El audio recuperado conserva su formato real (mp4 en iPhone, no webm forzado).
28. `npm test` descubre `test/sprint*.mjs` solo: ningún test puede quedar fuera por olvido.
