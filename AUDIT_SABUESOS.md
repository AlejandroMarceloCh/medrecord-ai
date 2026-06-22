<!-- Auditoria multi-agente Opus · 2026-06-21 · 34 candidatos -> 32 confirmados -> 24 valen para piloto -->

# Auditoría MedRecord AI — Síntesis de hallazgos (sprints 6-9)

## 1) Resumen ejecutivo

La suite verde (39/39) da una falsa sensación de cobertura: los caminos más peligrosos no están testeados, y ahí viven los problemas reales. Hay **dos P0 que rompen la promesa central del producto**: (a) el WebSocket no autentica y difunde PII completa (nombre, DNI, transcripción, diagnóstico) a cualquiera en la LAN, evadiendo todo el aislamiento por `ownerId` del lado HTTP; y (b) el backup nunca incluye la clave maestra, así que los respaldos cifrados son matemáticamente irrecuperables ante pérdida de disco. El resto son P1/P2 concentrados en integridad clínica (registros firmados destruibles por retry/reextract, fields firmados sin validar contra esquema) y confianza UX (sesión expirada/save fallido que pierden trabajo en silencio). Casi todos los fixes son chicos, stdlib, sin dependencias nuevas — alineados con la vara de cero overengineering. Lo demás (a11y, responsive, tuning de hilos, tamaño de botón) es floro de best-practices para un piloto de un consultorio y se difiere.

## 2) HACER (worthForPilot=true), ordenado por severidad

| id | dimensión | sev | archivo:línea | problema (1 línea) | fix (1 línea) | esf |
|----|-----------|-----|---------------|--------------------|---------------|-----|
| WS-PII | seguridad | **P0** | server.js:460-474, 238, 251 | WS sin auth difunde PII completa de todos los pacientes a cualquier cliente de la LAN | Autenticar el upgrade (cookie→getSessionUser, close 1008 si no hay identidad) + broadcast dirigido por `canSee`; o empujar solo `{id,status}` | M |
| BACKUP-KEY | integridad-datos | **P0** | scripts/backup.sh:24 + crypto.js:17 | El backup empaqueta solo `recordings/`, nunca `.master.key` → respaldo cifrado irrecuperable | Incluir la clave en el tar (o respaldarla aparte) + README de restore; documentar en DEPLOY.md | S |
| SESSION-401 | ux-frontend | **P1** | helpers.js:112-118, app.jsx:231-234, clinical.jsx:205-221 | Sesión expirada (o reinicio del server) → 401 silencioso; firmar entra en bucle "Reintentar" sin guardar | En `apiFetch` detectar 401→evento que devuelva a login; distinguir 401 con copy "Tu sesión expiró" | M |
| SAVE-LOSS | ux-frontend / seg-clínica | **P1** | clinical.jsx:205-228, 337-348 | Si save/firma falla, J/K o Siguiente cambia de paciente y se pierden campos editados sin aviso | Bloquear/avisar navegación cuando `save==='error'` o dirty; mostrar fallo como toast (componente ya existe) | M |
| DEVICE-READ | seguridad | **P1** | server.js:329, 140-144; mobile.html:201 | El token Bearer de subida concede lectura global de todas las grabaciones + audio descifrado | Tratar `device` como solo-escritura en `canSee` y en los GET de lectura | S |
| LLM-AVAIL | correctness | **P2** | llm.js:52-54 | `startsWith(base)` da falso positivo: health dice "LLM OK" pero el autollenado falla siempre | Match estricto: `m.name===MODEL` o `MODEL+':latest'`; quitar el `startsWith` laxo | S |
| FIELDS-SCHEMA | seguridad-clínica | **P2** | server.js:386 | `r.fields = fields` guarda cualquier objeto sin validar contra el esquema → claves basura firmadas | Normalizar `fields` con `llm.normalize`/esquema antes de guardar (~5 líneas) | S |
| RETRY-SIGNED | seguridad-clínica / correctness | **P2** | server.js:400-409, 412-429 | retry/reextract borran un registro YA firmado sin guarda ni avanzar `version` (irreversible) | `if (r.reviewed) return res.status(409)` en ambos endpoints + avanzar `r.version` | S |
| WRITE-FSYNC | integridad-datos | **P2** | crypto.js:53-58 | `writeFileSync`+`rename` sin fsync: corte de luz puede dejar sidecar/audio truncado | openSync→writeSync→fsyncSync→closeSync→rename antes del rename (~4 líneas) | S |
| CORRUPT-SILENT | integridad-datos | **P2** | server.js:85 | Sidecar corrupto se omite en silencio: historia desaparece, audio queda huérfano | Renombrar a `<id>.json.corrupt` + log al arranque "N grabaciones corruptas omitidas" | S |
| PRINT-ATTEST | seguridad-clínica | **P2** | clinical.jsx:121-149 (PrintDoc) | El documento que sale al expediente no avisa asistencia por IA ni atestación de firma | Pie fijo condicional a `reviewed`: leyenda IA + "revisado y firmado" + `reviewedAt` (1 línea JSX) | S |
| RESUME-STORM | integridad-datos | **P2** | server.js:88-99 | loadAll re-dispara TODAS las grabaciones pendientes en paralelo → tormenta Whisper/Ollama post-crash | Serializar con `await` en un `for` (o cap 1-2); el resto del código ya asume "una a la vez" | S |
| LOGIN-DOS | seguridad | **P2** | server.js:149-157 | Login sin throttle: cada intento quema ~34ms de CPU del único proceso (mini-DoS), no crackeo | Map en memoria `{fails,lockUntil}`, 429 tras N fallos, reset en login OK (~15 líneas) | S |
| AUDIO-CLEAR | correctness / seguridad | **P3** | server.js:349 + data/recordings/*.ogg | Dos audios `.ogg` de prueba en claro en disco (huérfanos, NO servidos) | `rm` los dos archivos; opcional `find data -name '*.ogg' -delete` en deploy (no migración) | S |
| REEXTRACT-HANG | ux-frontend | **P2** | clinical.jsx:230-233 | `doReextract` con `catch{}` vacío y sin chequeo `!r.ok`: spinner colgado para siempre | En catch: `setReextracting(false)`+feedback; manejar `!r.ok` (404/409) | S |
| AVAIL-GATE | costo-cómputo / robustez | **P3** | server.js:275 | Gate `available()` con timeout 2s: si Ollama está lento, pasa a 'done' sin fields y sin ruta de Reintentar en UI | Quitar el gate, ir directo a `extractFields` en el try/catch (como ya hace /reextract) | S |
| LOAD-ERROR | ux-frontend | **P3** | app.jsx:230-234, 350-355 | Si la 1ra carga de recordings falla, muestra "Todo al día" (falso positivo) | Estado `loadError`: si falló y vacío, mostrar error + Reintentar (la mayoría ya la atrapa LoginGate) | S |
| OLLAMA-KEEPALIVE | costo-cómputo | **P3** | llm.js:124 | Sin `keep_alive`: el 7B se descarga entre pacientes y recarga en frío cada autollenado | Añadir `keep_alive:'30m'` al body (no '-1', la Mac es dual-workflow) | S |
| WHISPER-TURBO | costo-cómputo | **P2** | whisper.js:15 | large-v3 (2.9GB) es la mayor palanca de latencia; turbo da ~3-4x | Probar `large-v3-turbo` como default tras benchmarkear 2-3 audios reales; mantener v3 vía env | S |

## 3) DIFERIR (worthForPilot=false)

| id | qué es / por qué se difiere |
|----|------------------------------|
| LLM-NESTED | `String(v)` sobre objeto da '[object Object]' en un campo — atrapado por el HITL obligatorio (el médico lo ve y corrige), no corrompe en silencio. P3. |
| BACKUP-TMP | tar podría incluir `.tmp` huérfanos — cosmético, el restore ignora `.tmp`; rename atómico evita el caso grave. P3. |
| SHUTDOWN-FLUSH | SIGTERM entre transcript y setStatus pierde el transcript en RAM — no hay pérdida (audio persiste, recalcula); solo 1 corrida extra de Whisper. P3. |
| WEB-RESPONSIVE | Consola sin media queries <900px — uso real a pantalla completa en monitor; el propio finder lo marca false. P3. |
| A11Y-LABELS | Inputs sin `htmlFor`/`aria-label` — sin usuarios de lector de pantalla en el piloto; impacto nulo. P3. |
| BTN-CONFIRM | Botón "Confirmar" ~16px — desktop puro (no aplica 44px táctil); editar el campo ya confirma. Fix trivial si se toca el archivo. P3. |
| LOCK-OPTIN | Optimistic lock opt-in si falta `version` — el único cliente que escribe siempre la manda; no hay vector real con 1 médico. P3. |
| THREADS-T | `-t 10` sobre-subscribe E-cores — micro-tuning no medido, Metal hace el grueso; hardcodear ataría al chip. P3. |
| TESTS-GAP | Falta cobertura de retry/reextract y WS — deuda de testing, no bug; **hacer junto con los fixes P0/P1**, no como ítem aparte. P3. |

## 4) Top 5 acciones recomendadas (en orden)

1. **WS-PII (P0)** — Es el agujero más grave: anula todo el aislamiento multiusuario y el cifrado por el canal WS, explotable sin login desde la LAN. Toca el corazón de la promesa ("la PII no sale"). Fix M sin deps.
2. **BACKUP-KEY (P0)** — "Tengo backups" indescifrables es peor que no tener backup ante pérdida total de historias clínicas. Fix S (una línea al tar + README). Arréglalo junto con un destino de backup fuera del disco de datos.
3. **RETRY-SIGNED + FIELDS-SCHEMA (P2, integridad clínica)** — Dos guardas baratas (`if (r.reviewed) 409` y `normalize(fields)`) que protegen la invariante central del producto: un registro firmado debe ser inmutable y canónico. ~10 líneas combinadas.
4. **SESSION-401 + SAVE-LOSS (P1, confianza UX)** — Ambos pegan en el flujo de firma donde el médico cree que guardó y no guardó. El reinicio del server (Map en RAM) hace que 401 sea frecuente en un piloto local, no un caso raro. Reusa el Toast existente; sin deps.
5. **DEVICE-READ (P1) + LLM-AVAIL (P2)** — Cierre rápido de dos fixes S: el token de subida no debe leer historias ajenas (`canSee` device=solo-escritura), y el health no debe mentir "LLM OK" cuando el autollenado falla siempre (match estricto de modelo).

**Nota honesta:** de los 5 P0/P1-equivalentes priorizados, solo los dos P0 son "parar todo". El resto son fixes baratos de alto retorno. Toda la sección DIFERIR es legítimamente floro para este piloto — no inflar. Al cerrar los P0/P1, añadir las regresiones de TESTS-GAP (retry sobre firmado → 409; segundo cliente WS no recibe PII ajena) reusando el patrón spawn+DATA_DIR de sprint8/9.