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
29. **[S19]** La firma cubre consentimiento, campos confirmados, salida de la IA y procedencia.
30. **[S19]** Las firmas del esquema viejo siguen validando: un cambio de esquema no invalida historias.
31. **[S19]** Una historia firmada NO se puede borrar (tiene valor legal).
32. **[S19]** La firma prueba la AUTORÍA del médico: ni el servidor puede suplantarlo.
33. **[S19]** Si el disco falla, el PUT no dice "firmado" — y un fallo de disco nunca tumba el servidor.
34. **[S19]** El audit log está encadenado: editar una entrada se detecta.
35. **[S19]** Un origen ajeno no puede escribir (CSRF), y el WS revalida la sesión en cada envío.
36. **[S20]** Ninguna cifra entra a la historia sin estar en el audio — en NINGÚN campo.
37. **[S20]** Los signos vitales los extrae un regex, no el LLM. Un dato ajeno (FC fetal, presión de la madre) no entra.
38. **[S20]** Un campo dudoso llega vacío, pero `fields_ia` conserva lo que la IA propuso: hay que confirmarlo igual.
39. **[S20]** El ámbar es la excepción, no la norma: una redacción distinta del mismo hecho no se marca dudosa.
40. **[S20]** `npm run build` regenera también los bundles de dev: la UI nunca se queda atrás en silencio.
41. **[S21]** Un listado vacío solo se muestra si la carga fue exitosa y devolvió cero.
42. **[S21]** El médico SIEMPRE puede llegar a firmar: no hay campos por confirmar sin botón.
43. **[S21]** Existe una salida destructiva: se puede descartar una consulta sin firmar.
44. **[S21]** Confirmar se ordena por riesgo: lo clínico va uno a uno, nunca en bloque.
45. **[S21]** Contraste ≥4.5:1 en todos los tokens de texto.
46. **[S22]** El server resucita solo tras caerse, sin que nadie toque nada.
47. **[S22]** El backup se verifica a sí mismo: restaura y descifra, o falla ruidosamente.
48. **[S22]** Borrar el principio del audit log se detecta (no solo editarlo).
49. **[S22]** El `.env` del desarrollador nunca se filtra a los tests ni abre producción.
50. **[S22]** Existe el número que decide si el negocio existe: minutos por consulta.

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

## Sprint 19 — La firma dice la verdad · CERRADO 2026-07-13

**Goal:** Una historia firmada no puede ser alterada por ningún camino, y su firma cubre todo
lo que hay que probar en una auditoría.

**Veredicto: CUMPLIDO** (tras cerrar el agujero que el Agente C encontró en el primer pase).

### Qué cambió

**La firma (v2).** La v1 sellaba solo el contenido. Quedaban fuera justo las tres cosas que
hay que probar en una disputa:
- `consent` — la base legal de todo el procesamiento. Sin ella en el sello, **cualquiera con
  acceso al sidecar podía poner `granted: true` y `/verify` seguía diciendo que la historia
  era íntegra.**
- `confirmed` — qué campos de IA atestó el médico. Es la prueba del human-in-the-loop.
- `fields_ia` — qué generó la máquina. Sin esto no se puede demostrar qué escribió el médico
  y qué escribió el modelo, que es **LA** pregunta de una disputa.

Más la **procedencia** (`whisper_model`, `llm_model`, `prompt_hash`, `app_version`): sin ella,
con firma inmutable, no hay forma de explicar por qué una consulta de marzo se ve distinta de
una de mayo. Las firmas v1 se siguen verificando con su esquema: **un cambio de esquema no
puede invalidar historias legítimas en masa.**

**No-repudio real (Ed25519).** El HMAC prueba que el contenido no cambió, pero la clave la
conoce el servidor: **un admin podía forjar la firma de cualquier médico**, mientras
`TERMS.md` promete exactamente lo contrario. Ahora cada médico tiene su par de claves; la
privada se cifra con una clave derivada de **su** contraseña y solo se descifra al iniciar
sesión. El servidor no puede firmar por él. El test 15 lo demuestra: con la clave maestra se
forja el HMAC, pero la suplantación queda a la vista en la autoría.

**Una historia firmada ya no se puede borrar.** Lo encontró el Agente C y es el hueco que
hacía falso el goal: `DELETE` la destruía con borrado seguro, irrecuperable. Y borrar es
**peor** que alterar — una alteración la detecta `/verify`, un borrado no deja nada que
verificar. Un borrador sin firmar sí se puede borrar (el paciente retira el consentimiento).

**El disco manda.** `persist()` se tragaba los errores: con el disco lleno, el `PUT` respondía
200 con la firma, la UI decía "firmado", y al reiniciar la firma y las ediciones desaparecían.
Ahora devuelve 500 y revierte la RAM.

**Deuda de seguridad de los sprints 16-17, cerrada:**
- **CSRF**: `SameSite=Strict` es **ciego al puerto**, así que cualquier otro servidor en tu
  `localhost` (tienes un UTEC Gym en :8000) contaba como *same-site* y podía firmar historias
  con la cookie del médico. Ahora se valida el `Origin` completo.
- **El WebSocket** congelaba la identidad en el handshake: un socket abierto seguía recibiendo
  nombres, DNIs y transcripciones **aunque el médico hubiera cerrado sesión**. Ahora se
  revalida en cada envío. Más `Origin`, `maxPayload` y cap de conexiones.
- **Timing attack**: si el usuario no existía, no se corría scrypt → respuesta instantánea →
  se podía enumerar quién trabaja en la clínica. Hash señuelo.
- **HKDF**: la misma clave cifraba y firmaba. Subclaves separadas por dominio (solo para las
  firmas nuevas: cambiársela a las viejas las invalidaría todas).
- **Audit log encadenado** con hashes + `GET /api/audit`. `readAudit()` existía desde el
  Sprint 9 y **nadie podía llamarlo**: un log que no se puede leer no es evidencia, es un
  archivo. Ahora cubre lecturas de historia y de audio (el fisgoneo es *el* incidente clásico
  en clínicas), logout, reextract y denegaciones.

### Tests

- `test/sprint19_firma.mjs` → **15/15**.
- Suite completa → **124/124, 0 fallas**, tres corridas seguidas limpias.

### QA (protocolo anticagadas)

- **Agente A (regresión):** 28/28 invariantes intactas — **y encontró un crítico que yo
  introduje**. Al hacer que `persist()` lance, dejé dos llamadores sin capturar; uno es la
  purga horaria de audio. O sea que **un fallo de disco transitorio tumbaría el servidor
  entero** —matando el turno del médico y el trabajo en vuelo— que es exactamente lo contrario
  de lo que este sprint viene a arreglar. Cerrado con `persistSoft`.
- **Agente B (sabueso):** sin P0. Un P1 real: sin `trust proxy`, el CSRF **bloqueaba el login
  detrás del túnel** que el propio `DEPLOY.md` recomienda. El deploy del piloto habría dejado
  de funcionar sin que nadie entendiera por qué. Verificado con los tres escenarios (túnel OK,
  ataque 403, móvil sin `Origin` OK).
- **Agente C (verificador):** primer veredicto **"CUMPLIDO SOLO EN EL TEST"** — que bloquea el
  cierre. Probó los 8 caminos de alteración uno por uno y encontró que **`DELETE` no
  comprobaba `reviewed`**. También verificó lo que más miedo daba: que la firma **sobrevive a
  un reinicio** (el payload se construye con orden de claves explícito, así que
  `JSON.stringify` es determinista). Y fue honesto sobre lo que faltaba: el HMAC no daba
  no-repudio. Ambas cosas cerradas.

### Deuda abierta

- **El HMAC del audit log usa la clave maestra**: quien la tenga puede reescribir la cadena
  entera de forma consistente. La cadena detecta ediciones puntuales, no un reescrito total.
  Un sellado de tiempo externo lo cerraría. → Post-piloto.
- **La firma Ed25519 no es RENIECE**: es no-repudio técnico, no una firma digital legalmente
  vinculante en Perú. `TERMS.md` ya lo dice. → Depende de un tercero.
- **El audit log no rota**: `verifyAudit` es O(n) (127 ms con 100k entradas, medido). → S22.
- La deuda del S17 y S18 sigue: consulta real de 20-30 min de punta a punta, y el móvil en un
  iPhone real. → Antes del piloto.

### Invariantes nuevas para el Agente A

29. La firma cubre consentimiento, campos confirmados, salida de la IA y procedencia.
30. Las firmas del esquema viejo siguen validando: un cambio de esquema no invalida historias.
31. Una historia firmada NO se puede borrar (tiene valor legal).
32. La firma prueba la AUTORÍA del médico: ni el servidor puede suplantarlo.
33. Si el disco falla, el PUT no dice "firmado" — y un fallo de disco nunca tumba el servidor.
34. El audit log está encadenado: editar una entrada se detecta.
35. Un origen ajeno no puede escribir (CSRF), y el WS revalida la sesión en cada envío.

## Sprint 20 — Confianza por campo · CERRADO 2026-07-13

**Goal:** Ningún número clínico llega a la historia sin estar literalmente en la transcripción,
y el médico ve de un vistazo qué campos son dudosos.

**Veredicto: CUMPLIDO** (tras cerrar los dos P0 que hicieron que el primer veredicto fuera
GOAL NO CUMPLIDO).

### Qué cambió

**Los números ya no pasan por el LLM.** Una presión arterial es un patrón, no lenguaje: un
regex la saca sin inventar nada, un 7B puede alucinarla. `clinical-values.js` extrae los
signos vitales de forma determinista, **incluso dictados en palabras** ("ciento cincuenta
sobre noventa y cinco" → 150/95), y **toda** cifra que el modelo ponga y que no esté en el
audio se vacía y se marca.

**Confianza por desacuerdo.** La confianza no sale del modelo —los logprobs de un 7B están mal
calibrados, su "estoy 90% seguro" no significa nada—: sale de preguntarle dos veces de formas
distintas y ver si se contradice. Es la Selection Policy del curso, adaptada a lo que se puede
pagar en la Mac de un consultorio.

**Los campos dudosos llegan VACÍOS**, con la sugerencia al lado y un botón para aceptarla.
Pre-rellenarlos invita a confirmar sin leer, y con 150 clics de "Confirmar" al día el médico
aprende a no mirar. Y lo dudoso va **arriba**, en un banner: revisar 12 historias no puede
significar bajar por un scroll de 22 campos buscando qué está mal.

**El CIE-10, apagado.** Lo inventaba un 7B sin catálogo, y ese código es lo que la clínica le
factura a la aseguradora. Un código plausible y falso es peor que vacío.

### El bug que solo el pipeline real podía mostrar (otra vez)

`buildSources` volvió a devolver **cero fuentes**: el modelo dejó de incluir `_fuentes` porque
la clave solo se pedía en prosa, no estaba en el esquema JSON. Que la evidencia —la feature que
justifica confiar en la IA— dependa de que un 7B se acuerde de incluir una clave es una
fragilidad de diseño. Ahora está en el esquema, **y** hay un respaldo determinista que busca la
frase por su cuenta.

Y aparecieron **citas verbatim pero irrelevantes**: para `filiacion.nombre` el modelo citaba
*"Buenos días doctor"*. Es verbatim, así que pasaba la validación, y el médico veía una
evidencia que no evidencia nada. Una cita decorativa es **peor** que ninguna: hace confiar en un
campo que nadie dijo. De 0 → 14 → **12 fuentes, todas pertinentes**.

### Tests

- `test/sprint20_confianza.mjs` → **15/15**.
- Suite completa → **139/139, 0 fallas**.

### QA (protocolo anticagadas)

**Los agentes A y C dictaminaron GOAL NO CUMPLIDO en el primer pase, y tenían razón en las dos
cosas.**

- **P0 (A y C, por caminos distintos):** yo vaciaba los campos dudosos **antes** de copiar
  `fields_ia`. Consecuencia: dejaban de contar como "poblados por la IA", así que el gate de
  human-in-the-loop no los exigía — **el médico podía firmar sin haber mirado justo los campos
  que el sistema marcó como sospechosos**. C lo reprodujo por HTTP: firmó una historia
  confirmando solo dos campos triviales. Y la firma sellaba un `fields_ia` que ya no probaba qué
  había propuesto la máquina, que es LA pregunta de una disputa. Fix: el snapshot se toma antes.
- **P0 (C):** *"ningún número"* era **falso**. Yo validaba seis campos. Una dosis inventada
  entraba tranquila por `plan.indicaciones` (*"paracetamol 1000 mg cada 8 horas"*), una fiebre
  por `sintomas`. Ahora se valida **todo** campo que salga del audio.
- **B (sabueso), cuatro hallazgos clínicos reales:**
  - *"frecuencia cardíaca **fetal** de 140"* entraba como la FC del paciente. **140 lpm es
    fisiológico en un feto y taquicardia franca en un adulto.**
  - *"temperatura **ambiente** 30 grados"* entraba como temperatura corporal (30 °C cae dentro
    del rango fisiológico, así que el rango no lo filtraba).
  - Con **dos presiones** en la consulta (*"la de la mamá era 180/100, la del paciente 120/80"*)
    tomaba la primera — la de otra persona. Whisper no diariza, así que ahora no pone ninguna.
  - `palabrasANumero` sumaba sin orden: *"cinco veinte"* daba 25 y *"dos ciento"* daba 102.
    Números plausibles, dentro del rango, y completamente inventados.
- **B, el hallazgo de diseño (el que más importa):** comparar por igualdad exacta marcaba dudoso
  *"cefalea tensional"* vs *"cefalea de tipo tensional"* — el mismo hecho dicho distinto. Eso
  convertía el ámbar en el estado normal, **entrenando al médico a ignorarlo**: exactamente el
  fallo que la señal existe para evitar. Ahora los campos narrativos se comparan por solapamiento
  de contenido. **Medido en consulta real: 1 dudoso de 22 campos. El ámbar es excepción.**
- **Un footgun operativo:** `public/app.js` (el bundle de dev) quedaba desactualizado, así que
  quien corriera `npm run dev` **no veía la UI nueva, sin un solo error**. Ahora `npm run build`
  regenera los dos.

### Benchmark real (Whisper + Ollama)

Consulta de 71 s: vitales por regex **150/95 · 88 · 36.8 · 98**, CIE-10 vacío, 12 fuentes
vinculadas, **1 campo dudoso**, 0 cifras sin evidencia. El LLM tarda el doble (dos pasadas), lo
que es el precio de la señal de confianza.

### Deuda abierta

- **Sinónimos**: *"dolor de cabeza"* y *"cefalea"* se marcan como desacuerdo (el Jaccard no ve
  sinónimos). Genera algún ámbar de más. Un diccionario clínico lo cerraría.
- **`dudosos`/`sugerencias` no están en el payload firmado**: se pueden editar tras firmar sin
  invalidar `/verify`. Pero el valor disputado **sí** está sellado en `fields_ia`, así que solo
  se podría manipular la etiqueta cosmética, no el dato. P3.
- **Sin diarización**: lo que el paciente **especula** ("creo que es dengue") puede terminar en
  el diagnóstico. El protocolo de dictado de cierre lo mitiga sin código. → S22.
- La deuda de S17-S19 sigue: consulta real de 20-30 min, móvil en un iPhone real, rotación del
  audit log.

### Invariantes nuevas para el Agente A

36. Ninguna cifra entra a la historia sin estar en el audio — en NINGÚN campo.
37. Los signos vitales los extrae un regex, no el LLM. Un dato ajeno (FC fetal, presión de la
    madre) no entra.
38. Un campo dudoso llega vacío, pero `fields_ia` conserva lo que la IA propuso: hay que
    confirmarlo igual.
39. El ámbar es la excepción, no la norma: una redacción distinta del mismo hecho no se marca
    dudosa.
40. `npm run build` regenera también los bundles de dev: la UI nunca se queda atrás en silencio.

## Sprint 21 — Revisar toma menos de 60 segundos · CERRADO 2026-07-13

**Goal:** El médico revisa y firma una consulta sin levantarse de la silla, con el paciente
todavía vistiéndose.

**Veredicto: CUMPLIDO** (tras cerrar los dos bugs que hicieron que el verificador dictara
"CUMPLIDO SOLO EN EL TEST", y uno de ellos dejaba el producto **inutilizable**).

### Qué cambió

- **Un servidor caído ya no se ve como "no hay consultas".** Antes el médico leía *"Sin
  consultas en esta sección"*, cerraba la laptop creyendo que había terminado el día, y dejaba
  las historias sin firmar. Un vacío solo es legítimo si la carga tuvo éxito.
- **Tabla densa en "Por revisar".** Era la decisión tomada y nunca llegó al código: con cards
  de 280 px caben ~6 pacientes por pantalla; con filas de 44 px, las 8 del día completo
  (medido). Con 12-30 consultas diarias, esa es la diferencia entre ver el día de un vistazo o
  descubrirlo bajando por un scroll.
- **La evidencia aparece con el teclado.** Solo se disparaba con `onMouseEnter`: el médico que
  tabula entre campos —lo natural al revisar 12 historias— **nunca la veía**. La feature que
  justifica confiar en la IA funcionaba únicamente si movías el mouse.
- **Contraste.** `--faint` estaba en **2.52:1** y etiqueta *cada* campo clínico y el DNI del
  paciente, a 10.5 px, en una pantalla de consultorio con reflejo. Ahora 4.80:1. `--ok` de
  3.30 a 5.02.
- **`Esc` ya no descarta ediciones en silencio.** Era el único camino de salida que no pasaba
  por la confirmación: el médico corregía el diagnóstico, apretaba Esc por reflejo, y perdía
  la corrección sin un aviso.
- **Los botones avisan cuando fallan.** `handleRetry` tenía un `catch {}` vacío: el clic era un
  **no-op absoluto** y el médico volvía a apretar cinco veces sin entender nada. Los toasts de
  error llevan la causa y un botón, y ya no se auto-descartan.
- **Un 409 ya no se confunde con un fallo de red.** Ambos decían "No se pudo guardar", y piden
  cosas distintas: uno recargar, el otro reintentar.
- **El móvil usa la paleta de la web.** Seguía en índigo/violeta sobre gris frío — dos productos
  distintos, y el violeta es literalmente el acento por defecto que hay que evitar. Los dos
  manifests también.

### Confirmar, ordenado por riesgo

El cuello de botella real del goal: confirmar **cada** campo de IA son ~13 clics por consulta ×
12 pacientes = **~150 clics al día**, y el médico aprende a clicar sin leer. Eso es el
*confirmation theater*, y es lo que mata al producto.

La salida **no** es un "Confirmar todo" (destriparía el human-in-the-loop), sino ordenar por
riesgo: lo administrativo **con evidencia verificada en el audio** se confirma en bloque; el
**diagnóstico, el plan y los signos vitales** siguen exigiendo una mirada cada uno.

**Medido con Playwright: de 13 clics a 6.** Un clic confirma los 8 administrativos, y los 4 de
riesgo clínico van uno a uno.

### Tests

- `test/sprint21_revision.mjs` → **12/12**, en Chromium real.
- Suite completa → **151/151, 0 fallas**.

### QA (protocolo anticagadas)

- **El test atrapó un `Btn is not defined`** en `listing.jsx` que dejaba **la app entera en
  pantalla blanca**. El mismo tipo de bug que ya llegó a producción una vez (ver `AUDIT_CODEX`).
  Sin el test, esto lo descubría el médico.
- **Agente C (verificador): "CUMPLIDO SOLO EN EL TEST"**, y encontró el bug que hacía el
  producto **inutilizable**: `filiacion.nombre` contaba como campo de IA por confirmar, pero se
  edita en el H1 del visor y **no tiene botón "Confirmar"**. El contador se quedaba en
  *"Confirma 1"* para siempre y **el médico no podía firmar nunca**. La causa raíz: el nombre y
  el DNI **no los genera la IA**, los inyecta el registro — nunca debieron contar.
  También: **no existía ningún botón para descartar una consulta**. `onDelete` llevaba siendo
  una prop muerta desde siempre. Si el paciente retiraba el consentimiento, o se grababa al
  paciente equivocado, el audio se quedaba en el servidor para siempre.
- **Agente A (regresión):** 40/40 invariantes intactas. Señaló que los toasts de error no tienen
  tope: con 12 consultas fallidas se acumulan 12. No bloquea, queda anotado.

### Deuda abierta

- **Los toasts de error no se agrupan ni tienen límite.** → S22.
- El goal habla de **60 segundos** y lo que se puede medir son los clics (6). El tiempo de
  lectura real solo lo dirá el piloto. → S22 lo instrumenta.
- La deuda de S17-S20 sigue: consulta real de 20-30 min, móvil en un iPhone real, sinónimos en
  el detector de dudosos, rotación del audit log.

### Invariantes nuevas para el Agente A

41. Un listado vacío solo se muestra si la carga fue exitosa y devolvió cero.
42. El médico SIEMPRE puede llegar a firmar: no hay campos por confirmar sin botón.
43. Existe una salida destructiva: se puede descartar una consulta sin firmar.
44. Confirmar se ordena por riesgo: lo clínico va uno a uno, nunca en bloque.
45. Contraste ≥4.5:1 en todos los tokens de texto.

## Sprint 22 — Operación y arranque del piloto · CERRADO 2026-07-13

**Goal:** El sistema sobrevive un reinicio de la Mac sin intervención humana, y tenemos el
baseline medido **antes** de que el médico use la app por primera vez.

**Veredicto: CUMPLIDO** (tras el hallazgo que hacía falso el primer brazo del goal).

### Qué cambió

- **El sistema vuelve solo.** LaunchAgent con `KeepAlive` + `caffeinate`: arranca al encender,
  resucita si se cae, y no deja dormir la Mac a mitad del turno.
- **El backup se ejecuta.** `backup.sh` existía desde el Sprint 6 y **nada lo corría**: estaba
  escrito, probado, documentado… y nunca se ejecutaba. Un backup que no corre no es un backup.
  Ahora va a las 22:00, **se verifica a sí mismo** (restaura en un temporal y comprueba que
  descifra), deja un checksum, y **avisa si lo estás guardando en el mismo disco que los datos**
  — el `.tar.gz` lleva la clave maestra dentro, así que guardarlo al lado de lo que protege no
  protege de nada.
- **Healthcheck cada 5 minutos**, que avisa **al cambiar de estado**, no cada 5 minutos: una
  alerta repetida durante un fin de semana entrena a ignorarlas.
- **Métricas del piloto** (`GET /api/metrics`): mediana de revisión, **% firmadas en menos de
  20 segundos** (proxy de "firmó sin leer"), **consultas abandonadas** (grabó y nunca firmó — el
  indicador más honesto de que la app no sirve), y cuánto edita el médico lo que propuso la IA.
- **Tailscale** en vez del túnel público: URL estable, HTTPS real, y **nada expuesto a internet**.
  El túnel gratuito cambia de URL en cada arranque; el médico reinstalaría el PWA todos los días.
- **`PILOTO.md`**: la semana de baseline con cronómetro, los dos checkpoints con **umbral
  numérico escrito por adelantado** (si se fijan después, se racionalizan), y el protocolo de
  dictado de cierre.

### El hallazgo que hacía falso el goal

El Agente C **instaló el LaunchAgent de verdad** en vez de leer el `.plist`. **No levanta el
servidor.**

macOS bloquea por TCC el acceso de los procesos de `launchd` a `Desktop`, `Documents` y
`Downloads`. El proyecto vive en `~/Desktop/PROYECTOS_2026/`. El servicio arranca y **muere con
`EPERM`, en silencio**: `launchctl list` marca `LastExitStatus=256` y el servidor simplemente
no está. El médico llegaría a una app muerta y nadie sabría por qué.

El test decía 9/9 porque comprobaba que el `.plist` **dijera** `KeepAlive`. Un `.plist`
perfectamente escrito que no levanta nada.

Ahora: el test **mata el proceso de verdad y comprueba que resucita**, y el instalador
**detecta la carpeta protegida y se niega a instalar**, explicando por qué.

### Y el que me rompió los tests

Mi cargador de `.env` lo leía **incondicionalmente**. Un `.env` de desarrollo inyecta sus
credenciales en cada test —que levanta su propio servidor aislado— y los rompe todos. Peor: un
`.env` con `MEDRECORD_OPEN=1` copiado a la Mac del consultorio **abriría el servidor sin
autenticación, en silencio**. Ahora los tests corren aislados y el modo abierto **está prohibido
en producción**.

### La cadena del audit log

Al hacer que `verifyAudit` arranque desde la primera fila (para sobrevivir a la rotación), abrí
un agujero: un atacante **recorta el principio del log** —justo donde está el rastro que quiere
borrar— y el resto de la cadena sigue cuadrando. Ahora la primera entrada tiene que apuntar a un
eslabón que **exista**: o el inicio, o el final de un log rotado.

### Tests

- `test/sprint22_operacion.mjs` → **11/11**.
- Suite completa → **162/162, 0 fallas**, tres corridas seguidas limpias.

### Qué falta todavía para un paciente real

Honesto, con lo que el QA dejó anotado:

1. **Mover el proyecto fuera de `~/Desktop`.** Sin eso el servicio no arranca. Es un `mv`.
2. **Nadie ha corrido una consulta real de 20-30 minutos** de punta a punta. El número del
   benchmark (~4.7 min hasta el borrador) es una extrapolación.
3. **Nadie ha probado el móvil en un iPhone real.** Todo el mp4/Safari es razonamiento sobre la
   API, no observación.
4. **La semana de baseline no se ha hecho.** Sin ella el piloto no puede probar nada.
5. **Un abogado peruano tiene que revisar** el consentimiento y la retención contra la Ley 29733
   antes de cobrar. Eso no lo cierra el código.

### Invariantes nuevas para el Agente A

46. El server resucita solo tras caerse, sin que nadie toque nada.
47. El backup se verifica a sí mismo: restaura y descifra, o falla ruidosamente.
48. Borrar el principio del audit log se detecta (no solo editarlo).
49. El `.env` del desarrollador nunca se filtra a los tests ni abre producción.
50. Existe el número que decide si el negocio existe: minutos por consulta.

---

# Los 7 sprints, cerrados

| Sprint | Goal | Estado |
|---|---|---|
| 16 · Cerrojo | Nadie sin credencial ve PII; ninguna clave se autodestruye | ✓ 8/8 |
| 17 · Turno | 5 audios no se matan; 30 min llegan completos al LLM | ✓ 11/11 |
| 18 · El móvil no miente | La UI refleja el micrófono real; abre sin internet | ✓ 10/10 |
| 19 · La firma dice la verdad | Lo firmado es inalterable, auditable y con autoría | ✓ 15/15 |
| 20 · Confianza por campo | Ningún número sin respaldo literal en el audio | ✓ 15/15 |
| 21 · Revisión en 60s | Revisar cabe dentro de la consulta (6 clics) | ✓ 12/12 |
| 22 · Operación | Sobrevive un reinicio; el baseline está definido | ✓ 11/11 |

**Suite: 162/162.** De 69 tests que pasaban sobre un pipeline nunca ejercido, a 162 que
ejercitan Whisper y Ollama reales, un Chromium con micrófono falso, y servidores que se matan
y resucitan.

**El siguiente paso no es código: es `PILOTO.md`.**
