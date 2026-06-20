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

## Sprint 10 — Cumplimiento legal Perú

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

## Sprint 11 — Escala + interoperabilidad + observabilidad

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
