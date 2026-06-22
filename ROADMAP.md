# MedRecord — Roadmap a producción

Plan por sprints hacia un producto clínico legítimo en Perú. Cada sprint cierra con
un goal verificable y su test autónomo (`test/sprintN_*.mjs`, levanta su propio
server, `pass === total`). **Regla de cierre: no se avanza al siguiente sprint
hasta que su test pasa N/N y el CI queda verde.**

Sprints 1-5 ya cerrados (recuperación móvil, diccionario, evidencia/fuentes,
export PDF, auth simple + atomic writes + sin PII en /health).

Hitos:
- **Sprints 6-8** → piloto legítimo con 1 médico
- **Sprints 9-10** → producto vendible (multi-médico, legal)
- **Sprint 11** → escala / multi-consultorio

---

## Sprint 6 — Fix funcional + red de seguridad

**Tareas**
- Fix mismatch de keys LLM↔frontend (normalize en `llm.js`: desempaquetar
  `signos_vitales`/`enfermedad_actual` al schema plano)
- Backup automático diario de `data/recordings/` (script + retención 7 días)
- `git init` + primer commit + `.gitignore` (excluir `data/`, `node_modules`, `dist`)
- CI mínimo (GitHub Actions) que corre `npm test` en cada push

**Goal:** una grabación con signos vitales en el audio llena los campos
`presion_arterial`/`frecuencia_cardiaca` (hoy quedan vacíos), y existe un backup
recuperable.

**Test** `sprint6_autofill_backup.mjs`: transcripción fixture con signos vitales →
los 4 campos vitales se pueblan; corre el backup → el `.tar.gz` existe y al
descomprimir reproduce los JSON.

---

## Sprint 7 — Cifrado en reposo + PII fuera de logs (P0.2, P0.3)

**Tareas**
- Master key en archivo con permisos `0600` (env var apunta a la ruta)
- Cifrar audio y JSON con AES-256-GCM al escribir; descifrar al leer (transparente
  para los endpoints)
- Redactar PII de todos los `console.*` (solo `id.slice(0,8)`, nunca `rec` completo)

**Goal:** acceso al disco no revela nombre, DNI, transcripción ni audio. Los logs
no contienen PII.

**Test** `sprint7_encryption.mjs`: grabación con "Ana García / 12345678" → el
archivo crudo no contiene esos valores en claro; el endpoint los devuelve
descifrados; stdout/stderr del server no contienen PII.

---

## Sprint 8 — Seguridad clínica: human-in-the-loop real (P1.5)

**Tareas**
- Disclaimer visible permanente en el visor
- Estado por campo: `generado_por_ia` vs `confirmado_por_medico`; firma confirma todo
- Resaltar campos sin confirmar antes de permitir firmar
- Trazabilidad: guardar `fields_ia` original junto al `fields` editado (diff)

**Goal:** no se puede firmar sin que cada campo de IA haya sido confirmado, y queda
registro de qué cambió el médico respecto a la IA.

**Test** `sprint8_clinical_safety.mjs`: firmar sin confirmar → rechazado; confirmar
y editar → firma OK → el registro guarda `fields_ia` y `fields` distinguibles.

---

## Sprint 9 — Auth multi-usuario + concurrencia (P0.1, P1.1) ✅

**Decisión:** SQLite se mueve al Sprint 11 (escala). Los goals de este sprint
(aislamiento, audit, optimistic lock, sesiones) se resuelven sobre el store cifrado
actual sin agregar una dependencia nativa. Cero overengineering para un piloto.

**Tareas**
- `auth.js`: usuarios cifrados (scrypt stdlib), sesiones en memoria, cookie HttpOnly
  (+Secure en prod), audit log JSONL sin PII. `/api/login` `/api/logout` `/api/whoami`
  `/api/users` (admin). Admin inicial por env `MEDRECORD_ADMIN_USER/PASS`.
- Aislamiento: `ownerId` por grabación; el médico ve solo las suyas, admin ve todo.
- Audit log: login/create/edit/sign/delete con userId + recId (sin PII).
- Optimistic locking: `version` por registro; PUT con versión vieja → 409.
- Web: `LoginGate` + pantalla de login + cerrar sesión en Ajustes.

**Goal:** dos médicos en paralelo no se pisan datos ni se ven entre sí; toda acción
queda auditada; robar el token de uno no expone a los demás.

**Test** `sprint9_multiuser.mjs`: 7/7 — sin sesión 401, aislamiento A↔B, admin ve
todo, acceso cruzado 404, segundo PUT con versión vieja 409, audit con userId correcto.

---

# Hardening post-auditoría (sabuesos Opus, 2026-06)

19 hallazgos confirmados que valen para el piloto (ver `AUDIT_SABUESOS.md`).
Regla de cierre de CADA sprint: test de regresión propio + **toda la suite verde**
(`npm test`), no solo el test del sprint.

## Sprint 10 — Cerrar los P0 (la PII no sale, backups recuperables)

**Tareas**
- WS-PII (P0): autenticar el upgrade del WebSocket (cookie → sesión; close 1008 si
  no hay identidad) y emitir broadcast dirigido por `canSee`, o empujar solo
  `{id,status}` por el canal. Hoy difunde PII completa a cualquiera en la LAN.
- BACKUP-KEY (P0): incluir `.master.key` en el backup (o destino aparte) + README de
  restore + nota en DEPLOY.md. Hoy el backup cifrado es irrecuperable.
- DEVICE-READ (P1): el token Bearer de subida (móvil) = solo escritura; no debe leer
  historias ajenas (ajustar `canSee` y los GET).

**Goal:** ningún cliente sin sesión recibe PII por ningún canal (HTTP ni WS); un
backup restaurado en una máquina limpia es legible; el token de subida no lee nada.

**Test** `sprint10_p0.mjs`: cliente WS sin sesión no recibe PII; WS de A no recibe la
de B; device token → GET 404/403; backup + restore en dir limpio descifra. + suite.

## Sprint 11 — Integridad clínica (registro firmado inmutable y canónico)

**Tareas**
- RETRY-SIGNED (P2): `retry` y `reextract` sobre un registro `reviewed` → 409; avanzar
  `version`. Hoy destruyen una historia ya firmada.
- FIELDS-SCHEMA (P2): normalizar `fields` contra el esquema antes de guardar (descartar
  claves basura). Hoy `r.fields = fields` guarda cualquier objeto.
- PRINT-ATTEST (P2): el documento impreso declara asistencia por IA y atestación de
  firma (`reviewedAt`) cuando está `reviewed`.

**Goal:** una historia firmada no se puede destruir ni ensuciar con claves fuera de
esquema; el PDF declara IA + firma.

**Test** `sprint11_integridad.mjs`: retry/reextract sobre firmado → 409; PUT con claves
basura → se descartan; el registro firmado conserva esquema canónico. + suite.

## Sprint 12 — Confianza UX en el flujo de firma

**Tareas**
- SESSION-401 (P1): `apiFetch` detecta 401 → vuelve a login con copy "Tu sesión
  expiró". Hoy es 401 silencioso con bucle "Reintentar".
- SAVE-LOSS (P1): bloquear/avisar navegación (J/K/Siguiente) si hay cambios sin guardar
  o `save==='error'`; mostrar el fallo como toast.
- REEXTRACT-HANG (P2): el catch maneja `!r.ok` y apaga el spinner (hoy se cuelga).
- LOAD-ERROR (P3): estado `loadError` → no mostrar "Todo al día" falso si la 1ª carga
  falló.

**Goal:** el médico nunca pierde trabajo en silencio ni ve estados falsos; una sesión
caída lo regresa a login con mensaje claro.

**Test** `sprint12_ux.mjs`: contrato 401 de `apiFetch` (señal de re-login); ruta de
error de reextract; estado de error de carga. + suite.

## Sprint 13 — Robustez operativa + costo del pipeline

**Tareas**
- WRITE-FSYNC (P2): `fsync` antes del `rename` en `crypto.writeEncrypted`.
- CORRUPT-SILENT (P2): sidecar corrupto → renombrar a `<id>.json.corrupt` + log al
  arranque "N grabaciones corruptas omitidas".
- RESUME-STORM (P2): serializar el re-disparo de `loadAll` (for await / cap 1-2).
- LOGIN-DOS (P2): throttle de login (Map fails/lockUntil → 429 tras N fallos).
- AVAIL-GATE (P3): quitar el gate `available()` y ir directo a `extractFields` en
  try/catch (como ya hace `/reextract`).
- LLM-AVAIL (P2): match estricto del modelo en `available()` (no `startsWith`).
- OLLAMA-KEEPALIVE (P3): `keep_alive:'30m'` en el body de Ollama.
- WHISPER-TURBO (P2): `large-v3-turbo` como default (env override a v3); requiere tu
  benchmark con 2-3 audios reales antes de fijarlo.
- AUDIO-CLEAR (P3): borrar los 2 `.ogg` en claro huérfanos de `data/recordings/`.

**Goal:** el sistema sobrevive cortes, corrupción y reinicios sin tormenta ni pérdida;
el login no es DoS-able; el pipeline LLM/Whisper es más barato/rápido sin dejar de ser
local.

**Test** `sprint13_robustez.mjs`: escritura con fsync; sidecar corrupto en cuarentena;
resume serializado; login throttle → 429; `available()` con match estricto. + suite.

---

## Sprint 14 — Cumplimiento legal Perú (antes Sprint 10) ✅

**Tareas**
- Firma digital de la nota (RENIECE; puente: firma criptográfica + hash sellado,
  documentado)
- Consentimiento del paciente por escrito (registro por grabación; sin él no se procesa)
- Retención de audio configurable + borrado seguro (overwrite)
- Términos de servicio embebidos (responsabilidad recae en el médico)

**Goal:** nada se procesa sin consentimiento; toda nota firmada tiene firma
verificable y sello temporal; el audio se borra de forma segura al vencer la retención.

**Test** `sprint10_compliance.mjs`: sin consentimiento → rechazada; con él →
procesa; firma → firma + hash recomputable; vencer retención → audio borrado e
irrecuperable.

---

## Sprint 15 — Escala + interoperabilidad + observabilidad (antes Sprint 11)

**Tareas**
- Migrar Map+JSON → SQLite (cifrado); índices por dueño/fecha (movido desde S9)
- Paginación en `/api/recordings` (limit/offset)
- Export FHIR R4 (`Composition`/`DocumentReference`, guía HL7.FHIR.PE)
- Logging estructurado (pino) + métricas (latencia, error rate, cola)
- Health checks reales (`/health/ready` prueba Whisper y Ollama de verdad)
- Timeout de Whisper dinámico según duración del audio

**Goal:** responde con 1000+ grabaciones sin degradarse, exporta FHIR válido, y se
puede diagnosticar en producción.

**Test** `sprint11_scale_interop.mjs`: 1000 grabaciones → `?limit=50` rápido y
paginado; export valida contra schema FHIR R4; sin Ollama → `/health/ready`
reporta `llm:false`.

---

## Referencia legal Perú (no negociable antes de cobrar)

- Audio de consulta = dato sensible de salud (Ley 29733 art. 2.5)
- Consentimiento escrito obligatorio (art. 13.6)
- Registrar banco de datos en SIPDP del MINJUS (gratis, automático)
- EIPD (evaluación de impacto, IA/alto riesgo) + DPO
- Firma digital del médico sobre la nota (Ley 30024 + RENIECE)
- Notificar brechas a la ANPD en 48h
- Reglamento vigente: DS 016-2024-JUS (deroga DS 003-2013). Validar con abogado.
- Multas hasta ~S/ 550,000 o 10% de ingresos brutos anuales.

Correr local evita el régimen de transferencias internacionales y baja la
superficie de brecha, pero no exime de lo anterior.
