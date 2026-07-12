# Plan de sprints — camino al piloto

Deriva de `AUDIT_2026-07-12.md`. Cubre los 11 P0 y los P1 que dañan la confianza del médico.
Los sprints 1-14 ya están cerrados; este plan arranca en el **Sprint 16** (el 15 del ROADMAP viejo
—SQLite, paginación, FHIR— queda **cancelado por prematuro**, salvo el timeout dinámico de Whisper,
que se rescata al Sprint 17 porque en realidad era un P0 enterrado).

---

## Las tres reglas innegociables

### Regla 1 — El sprint cierra por Goal, no por calendario

Cada sprint tiene **un solo Goal**, escrito como una afirmación verificable sobre el comportamiento
del sistema, no como una lista de tareas. Las tareas son el medio; el Goal es el contrato.

Un sprint está cerrado cuando, y solo cuando:

1. Su test propio (`test/sprintN_*.mjs`) pasa **N/N**, es autónomo (levanta su propio server) y
   **ataca el Goal**, no las tareas.
2. La **suite completa** (`npm test`) pasa verde. Cero excepciones, cero "eso ya estaba roto".
3. El **Protocolo Anticagadas** (Regla 2) no devuelve ningún P0 sin resolver.
4. El bloque del sprint está escrito en `SPRINTS.md` (Regla 3).

Si el Goal no se cumple, el sprint **no se cierra y no se avanza**. Se recorta el alcance de las
tareas o se parte el sprint en dos, pero nunca se declara cerrado un Goal a medias. Un sprint
declarado cerrado con el Goal incompleto envenena todos los sprints siguientes, porque los que vienen
después asumen esa invariante.

### Regla 2 — Protocolo Anticagadas (QA con agentes Sonnet)

Al final de cada sprint, **antes** de escribir el changelog, se lanzan **tres agentes Sonnet en
paralelo**. Son adversariales por diseño: su trabajo no es aprobar, es encontrar lo que rompimos.
Los tres leen el mismo diff pero con lentes distintos, porque un solo revisor con un solo criterio
encuentra siempre el mismo tipo de bug.

Se lanzan con el tool `Agent`, `subagent_type: "general-purpose"`, `model: "sonnet"`, los tres en un
solo mensaje para que corran concurrentes.

#### Agente A — Regresión de invariantes

El más importante. No mira el código nuevo: verifica que **los goals de los 14 sprints anteriores
sigan siendo ciertos**. Es lo que atrapa "arreglé la cola y de paso rompí el aislamiento entre
médicos".

```
Eres auditor de regresión. Acabamos de cerrar el Sprint <N> de MedRecord AI
(<goal en una línea>). Tu trabajo NO es revisar el código nuevo: es verificar que
NINGUNA invariante de los sprints anteriores se haya roto.

Lee ROADMAP.md y SPRINTS.md para la lista completa de goals ya cerrados, y
`git diff <sha-inicio-sprint>..HEAD` para ver qué cambió.

Para CADA una de estas invariantes, verifica en el CÓDIGO ACTUAL (no en el test —
el test puede haberse tocado) que sigue siendo cierta, y di en qué archivo:línea lo
confirmaste:

1. Sin sesión válida, ningún cliente recibe PII por ningún canal (HTTP ni WS).
2. Un médico no-admin solo ve sus propias grabaciones; admin ve todo.
3. No se puede firmar una historia sin confirmar cada campo poblado por la IA.
4. Una historia firmada (reviewed) es inmutable: retry/reextract/PUT → 409.
5. Los sidecars y el audio están cifrados en reposo; ningún console.* imprime PII.
6. Un PUT con version vieja → 409 (optimistic lock).
7. Sin consentimiento registrado, la grabación no se procesa.
8. La firma es recomputable y /verify la valida.
9. El backup incluye la master key y restaura en una máquina limpia.
10. Un sidecar corrupto va a cuarentena; las buenas cargan igual.
11. El diccionario médico se aplica en la transcripción visible, los campos y el PDF.
12. Las _fuentes del LLM se validan verbatim con indexOf antes de mostrarse.
13. El login tiene throttle (429 tras N fallos).
14. El audio vencido por retención se borra de forma segura.

Por cada invariante ROTA: archivo:línea, qué la rompió (cita el commit/hunk del diff),
escenario concreto de fallo, y severidad. Si una invariante ya no aplica porque este
sprint la cambió A PROPÓSITO, dilo explícitamente y verifica que el cambio esté
documentado en el goal del sprint.

Corre `npm test` y reporta el resultado real. NO edites nada.
```

#### Agente B — Sabueso del diff

Lee **solo lo que cambió**, con ojo de code review adversarial. Busca bugs introducidos, no ausencias.

```
Eres revisor adversarial de código. Lee `git diff <sha-inicio-sprint>..HEAD` completo
en ~/Desktop/PROYECTOS_2026/MedRecord y busca DEFECTOS INTRODUCIDOS por este cambio.

Contexto: producto clínico, datos de salud sensibles (Ley 29733 Perú), Node/Express,
Map en RAM + sidecars JSON cifrados AES-256-GCM, sin BD.

Busca específicamente:
- Races entre el pipeline async (transcribe→fill) y los handlers HTTP.
- Errores tragados (catch vacío, catch que loguea y sigue) que devuelvan 200 con el
  estado real fallido.
- Estado en RAM que diverge del disco.
- Caminos donde un fallo parcial deja el registro en un estado imposible.
- Cambios que asumen un orden de ejecución no garantizado.
- Cualquier lugar donde el código nuevo introduce PII en logs, errores o respuestas.
- Manejo de errores que le muestra al médico "algo salió mal" sin salida.

Por cada hallazgo: archivo:línea, escenario concreto (inputs/estado → resultado
incorrecto), severidad P0/P1/P2, fix. Verifica leyendo el código real; si no puedes
confirmarlo, márcalo PLAUSIBLE en vez de afirmarlo. NO edites nada.
```

#### Agente C — Verificador del Goal

El único que mira el sprint por su propio mérito. Su pregunta es una sola: **¿el Goal es cierto en el
producto real, o solo en el test que escribimos para él?** Este agente existe porque es trivial
escribir un test que pasa sin que la feature funcione.

```
Eres verificador de goals. El Sprint <N> de MedRecord AI declara este Goal:

  "<goal textual>"

Y su test es `test/sprint<N>_*.mjs`.

Tu trabajo: determinar si el Goal es cierto EN EL PRODUCTO, no en el test.

1. Lee el test y di qué está probando REALMENTE. Busca específicamente: ¿el test
   inyecta estado fixture y verifica el fixture? ¿Mockea la parte que importa?
   ¿Prueba el camino feliz y evita el que falla?
2. Lee el código de producción que implementa el Goal. Enumera los caminos de
   ejecución que el test NO toca.
3. Por cada camino no cubierto, di si el Goal seguiría siendo cierto ahí. Si no,
   ese es un agujero.
4. Ejercita el Goal a mano si puedes (levanta el server, curl, revisa el sidecar).
   Reporta lo que observaste, no lo que el código sugiere.

Veredicto final: GOAL CUMPLIDO / GOAL CUMPLIDO SOLO EN EL TEST / GOAL NO CUMPLIDO,
con la evidencia. Sé escéptico: tu sesgo por defecto es que el goal NO se cumple
hasta que lo demuestres. NO edites nada.
```

#### Reglas de cierre del protocolo

- **Un P0 de cualquiera de los tres bloquea el cierre del sprint.** Se arregla y se vuelve a correr
  ese agente.
- **Un P1 se arregla o se registra como deuda explícita** en el changelog, con dueño y sprint destino.
  Nunca se ignora en silencio.
- **Los tres reportes se resumen en el bloque del changelog**, no se archivan aparte. Si un agente no
  encontró nada, eso también se escribe (es información).
- **El veredicto "GOAL CUMPLIDO SOLO EN EL TEST" cuenta como P0.** Es exactamente el fallo que tiene
  hoy el proyecto: 69 tests verdes sobre un pipeline que nunca se ejerció.

### Regla 3 — Guardado de progreso: `SPRINTS.md`

Un solo archivo, `SPRINTS.md`, en la raíz. Es la **memoria del proyecto**: está diseñado para que un
agente que llega sin contexto (después de un `/compact`, o en una sesión nueva dentro de tres
semanas) pueda leerlo entero y saber exactamente en qué estado está el sistema, qué se probó y qué
quedó debiendo.

Se escribe **al cerrar cada sprint**, en append, nunca reescribiendo bloques anteriores. Formato fijo:

```markdown
## Sprint 16 — Cerrojo · CERRADO 2026-07-14

**Goal:** Ningún cliente sin credencial recibe PII por ningún canal, y ninguna clave
maestra existente se regenera jamás.

**Veredicto:** CUMPLIDO.

**Qué cambió**
- `auth.js:30` — `loadUsers()` distingue ENOENT de fallo de descifrado; si el archivo
  existe y no descifra, el server no arranca.
- `server.js:216` — el modo abierto exige `MEDRECORD_OPEN=1`; en producción sin
  usuarios ni token, `exit(1)`.
- `crypto.js:24` — una `.master.key` de menos de 32 bytes lanza, ya no se sobrescribe.
- `.env.example` — documentadas las 8 variables que faltaban.

**Tests**
- `test/sprint16_cerrojo.mjs` → 6/6.
- Suite completa → 75/75.

**QA Sonnet**
- Agente A (regresión): 14/14 invariantes intactas. Confirmó la #2 en `server.js:410`.
- Agente B (sabueso): 1 P1 — el `exit(1)` no cierra el WS server, deja el puerto
  colgado 30s en el reinicio. Arreglado en el mismo sprint.
- Agente C (goal): CUMPLIDO. Verificó a mano con la master key truncada a 10 bytes
  (el server aborta) y con `MEDRECORD_OPEN` sin setear en prod (aborta).

**Deuda abierta**
- CSRF por Origin allowlist queda para el Sprint 19 (no bloquea el piloto en LAN).

**Invariante nueva que este sprint agrega al Agente A**
15. Con `.master.key` presente pero inválida, el server NO arranca (nunca regenera).
```

Tres detalles que hacen que esto funcione como memoria y no como decoración:

- **El bloque "Invariante nueva"** alimenta el prompt del Agente A del sprint siguiente. La lista de
  invariantes **crece**; nunca se poda. Es lo que impide que el sprint 20 rompa lo que ganó el 16.
- **La deuda abierta lleva sprint destino.** Deuda sin destino es deuda olvidada.
- **El veredicto del Agente C se transcribe literal**, incluido si fue "CUMPLIDO SOLO EN EL TEST".
  Mentirle al changelog es mentirle al vos del futuro.

**Durante el sprint** (no al cerrarlo) se usa `session.log` con el formato del protocolo global:
`[YYYY-MM-DD HH:MM] | TIPO | Hallazgo | Por qué importa`, tipos `PARAM BUG DATA ARCH BLOCKER`. Al
cerrar el sprint, lo que valga la pena de `session.log` se destila en el bloque de `SPRINTS.md` y el
log se vacía. `SPRINTS.md` es el histórico permanente; `session.log` es el borrador del sprint en curso.

---

# Los sprints

## Sprint 16 — Cerrojo

> **Goal:** Ningún cliente sin credencial válida recibe PII por ningún canal, y ninguna clave maestra
> existente se regenera jamás.

Va primero porque son los dos hallazgos catastróficos y cuestan horas, no días. Hoy el camino de
despliegue que el propio repo recomienda deja las historias abiertas a cualquiera con la URL, y un
`.master.key` truncado destruye toda la data de forma irreversible.

**Tareas**
- `auth.js` / `crypto.js`: separar `ENOENT` de fallo de descifrado. Si `users.json` existe y no
  descifra → no arrancar.
- `crypto.js:20-31`: si `.master.key` existe con menos de 32 bytes → lanzar. Generar **solo** con
  `ENOENT`. Exigir exactamente 32 bytes.
- `server.js:216`: el modo sin auth pasa a ser opt-in explícito (`MEDRECORD_OPEN=1`). En producción,
  sin usuarios y sin token → `exit(1)` con mensaje claro.
- Documentar en `.env.example` las 8 variables que faltan (`MEDRECORD_ADMIN_USER/PASS`,
  `MEDRECORD_TOKEN`, `MEDRECORD_KEY_FILE`, `SESSION_TTL_MS`, `MEDRECORD_AUDIO_RETENTION_DAYS`,
  `LOGIN_MAX_FAILS`, `MEDRECORD_OPEN`) y corregir el paso 1 de `DEPLOY.md`.
- Retención de audio: default sensato (90 días) en vez de `|| 0` (hoy la promesa está apagada).
- `DELETE`: usar `enc.secureDelete()` como ya hace la purga por retención.
- PHI en `/tmp`: `secureDelete` sobre `audio.wav` y `out.txt` de Whisper antes del `rmSync`.

**Test** `sprint16_cerrojo.mjs`: master key de 10 bytes → el server aborta y **la key sigue intacta**;
prod sin usuarios ni token → aborta; `users.json` corrupto → aborta; DELETE → el ciphertext ya no está
en el disco; los temporales de Whisper se sobrescriben.

**Invariante nueva:** con `.master.key` presente pero inválida, el server nunca la regenera.

---

## Sprint 17 — El pipeline aguanta un turno

> **Goal:** Cinco audios subidos en tres minutos se procesan todos, sin matarse entre sí, y un audio
> de 30 minutos llega completo al LLM o falla con un mensaje que el médico entiende.

**Tareas**
- Cola FIFO con concurrencia 1 para `processRecording` (~10 líneas: array + flag `busy`), reusando el
  patrón que `loadAll()` ya aplica al resume. Estado `queued` con posición visible en la web y en el
  móvil.
- `whisper.js:27`: timeout dinámico `max(5min, durationSec × K)`. `durationSec` ya llega del móvil.
- `llm.js:134`: medir el largo del transcript; subir `num_ctx` (qwen2.5 soporta 32k) o trocear por
  secciones. Si excede el límite, `rec.fieldsError` explícito en vez de campos vacíos silenciosos.
- Degradación de Whisper: en estado `error`, `clinical.jsx:287-295` deja de mostrar un muro y muestra
  **el formulario vacío + el reproductor de audio**. El médico llena a mano escuchando. (Para Ollama
  esto ya está bien resuelto; falta el gemelo.)
- Chip de salud en el header: poll a `/health` cada 60 s (hoy el endpoint existe y **nadie lo llama**).
- Benchmark honesto con un audio real de 20 minutos: cuántos minutos pasan entre el stop y el borrador
  listo. **Ese número es la promesa del producto y hoy no existe.** Va al changelog.

**Test** `sprint17_turno.mjs`: 5 uploads concurrentes → los 5 llegan a `done`, y en ningún momento hay
más de un proceso Whisper vivo; audio de 3 min con timeout base → no se mata; transcript de 12k tokens
→ o entra completo, o `fieldsError` explícito.

**Invariantes nuevas:** nunca corre más de un Whisper a la vez · un transcript que no cabe en el
contexto nunca produce campos vacíos silenciosos.

---

## Sprint 18 — El móvil no miente

> **Goal:** La pantalla de grabación refleja el estado real del micrófono, y la app abre y graba sin
> conexión a internet.

Es el sprint que decide el día 1 del piloto. Hoy el cronómetro es un `setInterval` y la onda es CSS:
si iOS le quita el micro por una llamada entrante, la pantalla sigue diciendo "Grabando 14:32".

**Tareas**
- `AnalyserNode` real sobre el stream: RMS por frame → altura de barras. Si el nivel promedio queda a
  cero N segundos → banner "No estamos captando sonido. Revisa el micrófono."
- `rec.onerror` + `stream.getAudioTracks()[0].onended` → parar y avisar "Se interrumpió la grabación".
- `rec.start(5000)` con `timeslice` + persistir chunks incrementales en IndexedDB. Hoy 20 minutos de
  consulta viven en RAM y es todo o nada si iOS mata la pestaña.
- Bundlear el móvil con esbuild como la web (hoy carga React **development** + Babel desde unpkg, y
  `build.mjs` solo lo **copia** a `dist/`, así que producción también depende del CDN). Fuentes locales.
- Service worker que cachee el app shell. La app promete cola offline y hoy no abre sin señal.
- Blob de 0 bytes → error visible, y **no** limpiar el formulario (hoy se descarta en silencio y la UI
  parece un éxito).
- Botón "Descartar" con dialog destructivo. Hoy el único control es Stop y el audio se sube sí o sí:
  si el paciente retira el consentimiento, no hay salida.
- `canRecord`: exigir solo el consentimiento. Nombre y DNI opcionales o capturables después (la web ya
  tolera "Sin identificar").
- Pausa / Reanudar.
- Login en el móvil (`POST /api/login` → cookie same-origin) para que `ownerId` salga correcto. Hoy el
  device token deja `ownerId: null` y un médico no-admin **nunca ve las grabaciones que él mismo hizo**.

**Test** `sprint18_movil.mjs` (Playwright con `--use-fake-device-for-media-stream`): matar el track a
mitad → la UI sale del estado grabando y muestra el error; `dist/mobile.html` no referencia ningún
host externo; con la red cortada tras el primer load, la app abre y encola; blob vacío → error visible.

**Invariantes nuevas:** el móvil no carga ningún recurso de un CDN · la UI de grabación nunca muestra
"grabando" si el track está muerto.

---

## Sprint 19 — La firma dice la verdad

> **Goal:** Una historia firmada no puede ser alterada por ningún camino, y su firma cubre todo lo que
> hay que probar en una auditoría.

**Tareas**
- Guarda de **salida** del pipeline: capturar `r.gen` al lanzar el trabajo y revalidar al aterrizar
  (`if (recordings.get(id) !== r || r.reviewed || r.gen !== gen) return`). Hoy `/reextract` responde
  `{ok:true}` antes de llamar al LLM y, si el médico firma mientras corre, **la salida cruda de la IA
  pisa los campos firmados**. El Sprint 11 cerró la guarda de entrada; esta es la de salida.
- `persist()` propaga el error. Hoy se traga los fallos de escritura y el `PUT` responde `200` con la
  firma que solo existe en RAM: al reiniciar, la firma desaparece.
- Firma **v2**: el payload incluye `consent`, `confirmed` y `fields_ia`. Hoy quedan fuera del sello
  justo los tres campos que prueban la base legal y la traza humano-vs-máquina. `/verify` recomputa
  según `signature.v` (v1 para las ya firmadas).
- `version` avanza en retry, reextract y en el final de `processRecording`. Hoy solo `PUT /fields` la
  incrementa, así que el optimistic lock no protege nada.
- **Procedencia del modelo en cada sidecar**: `{whisper_model, llm_model, prompt_hash, app_version}`.
  Una hora de trabajo, y sin esto no vas a poder explicar por qué una historia de marzo se ve distinta
  de una de mayo — con firma inmutable, eso es un problema legal. **Tiene que estar antes de la
  primera historia del piloto.**
- Audit log: cubrir lecturas de historias y audio, `retry`, `reextract`, `logout` y las denegaciones.
  Encadenar cada entrada con el hash de la anterior. `readAudit()` hoy es código muerto.

**Test** `sprint19_firma.mjs`: firmar durante un reextract en vuelo → el registro firmado no cambia y
la firma sigue válida; `persist` con el disco lleno → el PUT devuelve 500, no 200; alterar `consent`
en el sidecar → `/verify` devuelve inválido; cada sidecar nuevo trae `whisper_model` y `prompt_hash`.

**Invariantes nuevas:** ningún trabajo async escribe sobre un registro firmado · la firma cubre
consent + confirmed + fields_ia · todo sidecar registra qué modelo y qué prompt lo produjeron.

---

## Sprint 20 — Confianza por campo

> **Goal:** Ningún número clínico llega a la historia sin estar literalmente en la transcripción, y el
> médico ve de un vistazo qué campos son dudosos.

El sprint de mayor retorno clínico. Sale del cruce con el material del curso (Tractable, la Selection
Policy de U4, el caso Google Translate).

**Tareas**
- **Validación numérica determinista** post-LLM en el server: para presión arterial, frecuencia
  cardiaca, temperatura, saturación y dosis del plan, comprobar que los dígitos aparecen **literalmente**
  en el transcript. Si no aparecen → vaciar el campo y marcarlo `sin_evidencia`. Hoy el campo se
  muestra igual aunque `buildSources()` haya descartado su cita, y la única señal es un punto teal de
  5 px.
- Extraer cifras y dosis con **regex + normalización** ("ciento veinte sobre ochenta" → `120/80`) en
  vez de dejárselas al LLM. El LLM se reserva para lo narrativo (motivo, enfermedad actual, plan).
- **Confianza por desacuerdo**: correr la extracción 2 veces con prompts distintos (uno "extrae X",
  otro "¿se menciona X? cita la frase textual"). Coinciden → verde. Divergen → **ámbar / UNSURE**. La
  confianza no sale de los logprobs de un 7B, que están mal calibrados: sale del ensemble.
- Los campos ámbar aparecen **vacíos**, con la sugerencia al costado y un botón "Aceptar". No
  pre-rellenados. La firma sigue bloqueada hasta tocarlos.
- El visor ordena los campos por **confianza ascendente**, no por el orden de la historia clínica.
  Lo dudoso arriba.
- Click en un campo → salta al **segundo del audio** donde se dijo (Whisper ya da timestamps). Es la
  explicabilidad real y la defensa ante una auditoría: *"¿de dónde salió que es alérgico a X?"* →
  *"minuto 4:12, escúchelo"*.
- **CIE-10: apagarlo.** Hoy lo inventa un 7B sin catálogo. O lookup contra tabla local, o nada.

**Test** `sprint20_confianza.mjs`: transcript que dice "ciento cuarenta sobre noventa" y LLM que emite
`120/80` → el campo queda vacío y marcado `sin_evidencia`; dos extracciones que divergen → el campo
sale ámbar y vacío; firmar con un ámbar sin tocar → 409.

**Invariantes nuevas:** ningún número clínico se muestra sin respaldo literal en el transcript · los
campos de baja confianza nunca llegan pre-rellenados.

---

## Sprint 21 — Revisar una historia toma menos de 60 segundos

> **Goal:** El médico revisa y firma una consulta sin levantarse de la silla, con el paciente todavía
> vistiéndose.

El deck de MVP lo dice sin rodeos: si ahorra 4 minutos por consulta pero se queda 30 al final del día
revisando el backlog, **el impacto es cero**. La revisión tiene que caber dentro de la consulta.

**Tareas**
- `loadError` llega al `ListingView`. Hoy un servidor caído se ve como *"Sin consultas en esta
  sección"* y el médico cierra la laptop creyendo que terminó.
- Tabla densa real para "Por revisar" (hoy es un grid de cards de 280px: ~6 pacientes por pantalla, vs
  25 en tabla). Era la decisión tomada y nunca llegó al código.
- Evidencia con `onFocus`, no solo `onMouseEnter`. Hoy el médico que tabula entre campos **nunca ve
  la evidencia**, que es justo la feature que justifica confiar en la IA.
- Contraste: `--faint` de `#A8A29E` (2.33:1) a `#78716C` (4.6:1). Etiqueta todos los campos clínicos y
  el DNI, a 10.5 px.
- Cards del listing navegables por teclado. Botones con estado loading (hoy `handleRetry` tiene un
  `catch {}` vacío: el clic es un no-op absoluto y el médico clickea cinco veces).
- Cablear `onDelete` (hoy es prop muerta y `handleDelete` es código inalcanzable).
- `Esc` pasa por `confirmLeave()` como todos los demás caminos de salida.
- Toast de error con causa y con acción ("Reintentar"). Distinguir el 409 del optimistic lock de un
  fallo de red: hoy ambos dicen "No se pudo guardar".
- Terminología: un glosario y aplicarlo. "Historial" y "Revisadas" son hoy el mismo destino con dos
  nombres.
- Portar el sistema de diseño al móvil: acento teal `#0D9488` (hoy es **índigo** `oklch(0.52 0.20 277)`),
  crema, Bricolage + JetBrains. Y los dos manifests, que siguen en `#4f46e5`.
- `prefers-reduced-motion` en móvil. Touch targets de 44 pt (el botón "Reintentar" de una subida
  fallida mide 34 y es la acción de recuperación de una consulta que se puede perder).

**Test** `sprint21_revision.mjs`: servidor caído → el listing muestra error, no vacío; `Tab` entre
campos resalta la evidencia; contraste calculado ≥ 4.5:1 en los tokens de texto.

**Invariante nueva:** un listado vacío solo se muestra si la carga fue exitosa y devolvió cero.

---

## Sprint 22 — Operación y arranque del piloto

> **Goal:** El sistema sobrevive un reinicio de la Mac sin intervención humana, y tenemos el baseline
> medido **antes** de que el médico use la app por primera vez.

**Tareas**
- LaunchAgent con `KeepAlive=true` + `caffeinate -dimsu`. Hoy no hay ninguno: si macOS se actualiza de
  madrugada, el server no vuelve.
- Túnel estable. `cloudflared` **ni siquiera está instalado**, y el túnel gratuito cambia de URL en
  cada arranque (el médico reinstalaría el PWA todos los días y perdería el `localStorage`).
  Recomendación: **Tailscale** — MagicDNS, HTTPS de tailnet, el micrófono funciona y no expones nada a
  internet público.
- Backup programado (el script está bien; **no hay cron ni LaunchAgent que lo ejecute**) con `BACKUP_DIR`
  fuera del disco de datos, y un `--verify` que pruebe el restore.
- Healthcheck externo cada 5 minutos → alerta si `/health` no responde. Hoy el sistema de monitoreo es
  el médico, cuando ya es tarde.
- **Instrumentación del piloto**, y esto es lo que decide si el negocio existe:
  - **Baseline: una semana con cronómetro, sin la app.** Minutos de documentación por consulta.
  - Métricas en vivo: minutos por consulta, ediciones por campo, % firmadas sin editar, **consultas
    abandonadas** (grabó y nunca firmó — el indicador más honesto de que la app no sirve), **% firmadas
    en menos de 20 segundos** (proxy de "firmó sin leer").
  - **Los dos checkpoints, con umbral numérico escrito ANTES de arrancar** (si se fijan después, se
    racionalizan). CP1 (semana 2): ¿grabó ≥80% de sus consultas sin que se lo recordáramos? CP2
    (semana 8): ¿ahorro ≥ X min **y** ≥ Y% firmadas sin edición mayor **y** cero alucinaciones? De
    cada rombo sale una flecha a **Pausa**.
- Protocolo de **dictado de cierre** (cero código, la palanca más grande): el médico dicta 20 segundos
  estructurados al final de la consulta. Convierte un problema de comprensión de diálogo —que Whisper
  no resuelve, porque no diariza— en uno de transcripción de dictado, que sí resuelve bien.

**Test** `sprint22_operacion.mjs`: matar el proceso → vuelve solo en menos de 30 s; el backup programado
corre y su restore en un directorio limpio descifra; `/health` caído dispara la alerta.

**Invariante nueva:** el server se levanta solo tras un reinicio.

---

# Fuera de alcance (explícito)

No entran en este plan, y la razón importa tanto como la decisión:

- **SQLite.** Con 12 consultas/día × 20 días son ~240 al mes; el `Map` aguanta miles. Y si la búsqueda
  de historias entra al roadmap —y va a entrar—, **el destino es Postgres, no SQLite**: SQLite no tiene
  `tsvector` y su FTS5 stemmea en inglés, así que el médico buscaría "hipertensión" y no encontraría
  "hipertenso". Migrar sidecars → SQLite → Postgres es hacer el trabajo doloroso dos veces.
- **pgvector / búsqueda semántica.** El corpus es todo del mismo médico y la misma especialidad:
  semánticamente casi idéntico por construcción. Los embeddings quedarían todos cerca y el ranking
  sería ruido. Full-text con IDF discrimina mejor, porque premia lo raro (`amiodarona`) y castiga lo
  común (`paciente refiere`). Regla: no tocarlo hasta 50,000 historias o hasta que el médico pida
  "casos similares".
- **FHIR.** No hay con quién interoperar en un piloto de un médico.
- **Entidad paciente, multi-consulta, receta estructurada, nota SOAP.** Son lo primero que el médico va
  a pedir, y por eso mismo van **después** del piloto: que los pida él, no que se los adivinemos.
- **A/B testing.** Con N=1 es estadísticamente vacío. Pre/post con el médico como su propio control.

---

# Resumen

| Sprint | Goal | Cierra |
|---|---|---|
| 16 · Cerrojo | Nadie sin credencial ve PII; ninguna clave se autodestruye | 2 P0 catastróficos |
| 17 · Turno | 5 audios en paralelo no se matan; 30 min llegan completos al LLM | 3 P0 de pipeline |
| 18 · El móvil no miente | La UI refleja el micrófono real; abre sin internet | 3 P0 del día 1 |
| 19 · La firma dice la verdad | Lo firmado es inalterable y auditable | Integridad clínica |
| 20 · Confianza por campo | Ningún número sin respaldo literal en el audio | El P0 clínico |
| 21 · Revisión en 60s | Revisar cabe dentro de la consulta | La adopción |
| 22 · Operación | Sobrevive un reinicio; el baseline está medido | Arranca el piloto |

El orden no es negociable en los tres primeros: 16 porque los agujeros son catastróficos y baratos, 17
porque sin cola el resto no se puede probar en condiciones reales, 18 porque es lo que el médico ve el
primer minuto del primer día.
