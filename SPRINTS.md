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
