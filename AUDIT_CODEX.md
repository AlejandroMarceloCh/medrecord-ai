# MedRecord AI — Auditoría para revisión de oportunidades

**Fecha:** 2026-06-07  
**Preparado por:** Alejandro + Claude  
**Para:** revisión con Codex (oportunidades de negocio + presentación web)

---

## 1. Qué es el producto

Herramienta para médicos y enfermeros en clínicas privadas del Perú. El médico graba la consulta con el celular mientras habla con el paciente. El backend transcribe el audio con Whisper (ASR local), un LLM extrae los datos clínicos estructurados, y la web muestra el formulario pre-llenado para que el médico solo revise y confirme. No escribe desde cero.

**Arquitectura de dos superficies:**
- **Móvil** (`/mobile`): login → nombre/DNI del paciente → grabar → subir. Nada más.
- **Web** (`/web`): bandeja de grabaciones en tiempo real → abre visor → transcripción + campos clínicos editables.

**Stack técnico:**
- Backend: Node.js + Express + WebSockets + multer
- ASR: Whisper.cpp `large-v3` con VAD silero + prompt médico (local, cero latencia de red)
- LLM: Ollama local `qwen2.5:7b` (testing) / Claude API (producción planeada)
- Frontend: React (JSX precompilado con esbuild), sin framework externo
- PWA instalable en Android/iOS

---

## 2. Validación del problema (entrevistas reales)

Tres entrevistas realizadas (2 médicos + 1 enfermera de tópico privado):

**Quotes clave:**
> *"Más es lo que te demoras en escribir que lo que te demoras examinando al paciente o conversando con él. Más pierdes tiempo en esto."* — Médico (Audio 2)

> *"En una consulta de 20 minutos, más te la pasas escribiendo que entrevistando al paciente."* — Médico (Audio 5)

> *"Yo mismo he pensado que me haría bien el tener una herramienta de dictado."* — Médico (Audio 5; vio una neuróloga usar una en EE.UU.)

> *"Sería fantástico, de verdad."* — Enfermera, reacción espontánea al escuchar el producto (Audio 1)

**Números validados:**
- Tópico/consultorio: 12–25 pacientes/día
- Emergencia: 20–30 pacientes por turno de 12h
- Hospitalización: 10–14 pacientes asignados → 1 nota de evolución diaria por cada uno
- Tiempo de transcripción a Excel/Drive: 3–4 min/paciente en formato simplificado

**Segmentos de mercado:**
| Segmento | Sistema actual | Oportunidad |
|---|---|---|
| Clínicas privadas | Físico + pasan a Excel/Drive | ✅ Gap exacto — target MVP |
| EsSalud | Sistema digital propio (ya transcribe en pantalla) | ❌ No atacar |
| MINSA | Todo escrito, sin computadoras | ❌ No atacar en MVP |

---

## 3. Estado actual del MVP (lo que funciona hoy)

### Funcionando end-to-end:
- Móvil: login, registro nombre/DNI, grabación real (MediaRecorder), upload multipart
- Backend: recibe audio, transcribe con Whisper, extrae campos con LLM (Ollama)
- WebSocket push: `recording:received → :processing → :transcribed → :filling → :filled`
- Web: bandeja de grabaciones en tiempo real, abre visor automáticamente al transcribir
- Visor: transcripción + reproductor de audio + campos editables pre-llenados por LLM
- LLM extrae: filiación, anamnesis, examen físico, impresión diagnóstica, plan
- Merge inteligente: si el médico edita un campo manualmente, el LLM no lo sobreescribe
- PWA: instalable en Android, iOS (con túnel HTTPS)
- Health endpoint: `/health` reporta estado de Whisper + LLM

### Campos que extrae el LLM hoy:
- **Filiación:** nombre, edad, documento, fecha
- **Anamnesis:** motivo de consulta, enfermedad actual, antecedentes
- **Examen físico:** signos vitales, hallazgos
- **Impresión diagnóstica:** diagnóstico, CIE-10
- **Plan:** tratamiento, indicaciones

### Lo que NO está implementado aún:
- Persistencia (grabaciones viven en memoria RAM; se pierden al reiniciar el servidor)
- Auth real (login hardcodeado con usuarios demo)
- Export PDF / Excel
- Historial de pacientes
- SOAP notes (notas de evolución para hospitalizados)
- Configuración de clínica (defaults: religión, grupo sanguíneo, distrito)
- Diccionario médico configurable
- HTTPS / producción en servidor real

---

## 4. Oportunidades en el giro del negocio

### 4.1 SOAP notes para hospitalizados — mercado más grande que el consultorio

El médico del Audio 5 lo describió así: *"Las notas de evolución me hacen ir incluso más tiempo que la historia clínica. Tengo 10–14 pacientes asignados y escribo una por cada uno, cada día."* Eso es 10–14 SOAP notes diarias × médico × turno.

**Implicancia:** en hospitalización el volumen de escritura es mayor que en consultorio. MedRecord debería cubrir ambos flujos (historia clínica de ingreso + nota de evolución diaria). Ya lo tiene diseñado en el prototipo pero no implementado.

### 4.2 Campos de filiación que "casi siempre son iguales"

El médico señaló: religión y grupo sanguíneo "generalmente siempre le ponemos lo mismo" (Católica / O+). El sistema debería ofrecer defaults por clínica que el médico pueda confirmar con un click. Elimina fricción sin requerir al LLM.

### 4.3 El flujo es en vivo, no post-consulta

La grabación ocurre MIENTRAS el médico habla con el paciente, no después. Esto cambia el UX: cuando el médico termina la consulta y mira la web, el procesamiento ya debería estar listo (o en curso). El diseño actual asume esto pero hay que comunicarlo bien al médico: "graba, termina la consulta, llega a la web y ya está listo para revisar".

### 4.4 Exportación como feature de retención

Las clínicas privadas hoy exportan a Excel/Drive manualmente (3–4 min/paciente). Si MedRecord genera ese Excel automáticamente, el valor es inmediato y medible. **Export PDF/Excel debería ser el feature de retención número 1**, no una mejora futura.

### 4.5 El primer cliente ya existe (primer contacto validado)

El médico del tópico es un early adopter potencial. La enfermera Valeria (del mismo tópico, aún no entrevistada) es otra. José tiene acceso directo. La clínica del tópico es el primer cliente a cerrar.

### 4.6 Modelo de precios no definido

No hay pricing definido. Para clínicas privadas peruana, modelos que funcionan:
- **Por sede:** precio fijo mensual por clínica/tópico (S/ 200–500/mes)
- **Por usuario/médico:** S/ 80–150/mes por profesional activo

Recomendación: empezar con precio por sede (más fácil de vender a administración) y migrar a por-médico cuando escale.

### 4.7 Competidores a considerar
- **Nuance DAX / Dragon Medical**: dominante en EE.UU., casi sin presencia en LATAM, caro
- **Suki AI**: EE.UU., no disponible en Perú
- **AWS Transcribe Medical**: API, requiere desarrollo propio por la clínica
- **Local ad hoc**: médicos que graban con WhatsApp y transcriben con herramientas sueltas

La ventana de oportunidad en Perú está abierta. No hay ningún producto equivalente en el mercado local.

---

## 5. Oportunidades en la presentación web

### 5.1 Lo que el prototipo tiene que el MVP no tiene (y debería priorizar)

El prototipo original (diseñado antes de programar) tenía estas pantallas que el MVP real aún no implementa:

**Alta prioridad (le importa al médico desde el día 1):**
- Dashboard con stats del día (por revisar, completados, notas pendientes)
- Lista de pacientes de hoy con filtros (todos / por revisar / completados / hospitalizados)
- Perfil de paciente con historial de consultas
- Vista SOAP (notas de evolución diarias para hospitalizados)
- Export Excel + PDF desde el visor

**Media prioridad (valor en semana 2):**
- Sistema de "confianza" en los campos extraídos (high/low/empty — el LLM sabe cuándo está seguro)
- Campos default de clínica (religión: Católica, grupo: O+, distrito)
- Diccionario de corrección médica configurable

**Baja prioridad (post-primera-clínica):**
- Multi-usuario / roles (Médico / Enfermero / Admin)
- Settings avanzados
- Hospitalizados con gestión de camas

### 5.2 El visor actual (bandeja + visor) necesita un estado "ya procesado"

Hoy el visor se abre cuando llega el WebSocket push. Pero si el médico abre `/web` 5 minutos después de que llegó la grabación, debería ver la lista de grabaciones pasadas y poder abrirlas. Eso funciona, pero la UX de "grabaciones antiguas" es la misma que "grabación recién llegada". Se necesita diferenciar visualmente: qué está listo vs qué está procesando vs qué ya fue revisado (confirmado).

### 5.3 Los campos del LLM deberían mostrar confianza visual

El LLM sabe cuándo está seguro. Un campo `motivo_consulta` bien dicho en el audio tiene confianza alta. Un campo `antecedentes_familiares` que no se mencionó debería aparecer vacío y destacado. El prototipo original tenía un sistema `high/low/empty/confirmed` con color-coding. Esto reduce el tiempo de revisión del médico porque sabe dónde enfocarse.

### 5.4 El flujo móvil necesita feedback más claro post-upload

Cuando el médico graba y sube, la pantalla dice "grabado". Pero no hay confirmación de que el procesamiento está avanzando. Se debería mostrar el estado en tiempo real: "Transcribiendo... (10s)" → "Extrayendo campos..." → "Listo en la web". El médico termina la consulta con el paciente, mira el celular, y sabe que ya está listo para revisar.

### 5.5 La web debería tener un estado "vacío" explícito para el primer día

Si el médico abre `/web` antes de hacer cualquier grabación, ve una bandeja vacía. Falta un onboarding mínimo: "Graba una consulta desde tu celular en /mobile para ver los resultados aquí." Un hint con el URL de `/mobile` o un QR code haría el primer día menos confuso.

### 5.6 El diseño actual es funcional pero puede potenciarse

**Lo que funciona bien:**
- Tipografía (Hanken Grotesk) y tokens de diseño (oklch, radios, densidad) son sólidos
- Sistema de iconos limpio y consistente
- Cards con hover states sutiles
- Modo oscuro implementado en tokens (aunque no hay toggle en el MVP)

**Oportunidades:**
- El sidebar con dashboard está en el código del prototipo pero no en el MVP real — activarlo daría sensación de producto completo
- Los StatCards (Por revisar / Completados / Notas pendientes) dan contexto del día de un vistazo
- La lista de pacientes con tabla + filtros segmentados ya está diseñada y lista para conectar a datos reales

---

## 6. Deuda técnica bloqueante antes de mostrar a clientes

En orden de prioridad:

1. **Persistencia** (SQLite): hoy las grabaciones se pierden al reiniciar. Un médico pierde trabajo.
2. **Auth básica**: cualquier persona con la URL puede ver todas las grabaciones. JWT simple o session cookies.
3. **Export PDF/Excel**: es el feature de venta inmediata ("te ahorra 3-4 min por paciente").
4. **HTTPS en producción**: el micrófono del celular no funciona sobre HTTP. Necesita dominio + certbot o túnel.
5. **Limpiar código muerto en mobile.html**: hay funciones `MRecord`, `MProcessing`, `MNotif` del prototipo anterior que nunca se llaman (~200 líneas de peso muerto).

---

## 7. El README está desactualizado

El README dice: *"LLM autollenado: pendiente"*. Esto ya está implementado y funciona. Si alguien lo lee antes de ver el producto, subestima lo que existe. Actualizar.

---

## 8. Preguntas abiertas para Codex

1. ¿Qué features adicionales sugieres para el flujo de hospitalización (SOAP notes) dado el pain point descrito?
2. ¿Hay una forma más intuitiva de mostrar la "confianza" del LLM en los campos que mejore el tiempo de revisión del médico?
3. ¿Qué sistema de autenticación es suficiente para MVP en una clínica pequeña (sin ser overengineering)?
4. ¿Qué debería priorizarse para una demo efectiva con el médico del tópico?
5. ¿Hay formas de estructurar el pricing B2B para clínicas pequeñas en Perú que funcionen mejor que suscripción mensual?

---

## 9. Resumen ejecutivo (para pegar al inicio de la conversación con Codex)

MedRecord AI resuelve el problema validado de que los médicos peruanos pasan más tiempo escribiendo historia clínica que atendiendo al paciente. El producto graba la consulta, transcribe con Whisper (ASR local de alta calidad médica), extrae los campos clínicos con un LLM, y presenta el formulario pre-llenado para revisión. El médico solo confirma — no escribe.

**Estado técnico:** MVP funcional con Whisper + LLM + WebSocket push + PWA. Los campos se llenan solos en ~12s post-grabación. Falta persistencia, auth, export y HTTPS para mostrar a clientes reales.

**Validación:** 2 médicos + 1 enfermera entrevistados. El médico lo pidió él solo ("yo mismo he pensado que me haría bien una herramienta de dictado"). Reacción de la enfermera: "Sería fantástico, de verdad."

**Oportunidad inmediata:** clínicas privadas en Lima (EsSalud y MINSA no son el target). Primer cliente potencial: el tópico donde José hizo las entrevistas.
