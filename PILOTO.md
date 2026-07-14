# El piloto

Este documento se escribe **antes** de instalar nada. Si los umbrales se fijan después, se
racionalizan: siempre hay una razón para que el número que salió sea "suficientemente bueno".

El material del curso lo dice sin rodeos: *"no se limite a obtener un asentimiento de cabeza
de una demostración del producto"*. **Que el médico diga "está bacán" no es aprendizaje
validado.** Lo que sigue es lo que hay que medir para saber si esto sirve.

---

## Antes de instalar: la semana de baseline

**Una semana con cronómetro, sin la app.** El médico anota, por consulta:

| Dato | Cómo |
|---|---|
| Minutos de documentación | Desde que el paciente sale hasta que la historia queda escrita |
| Consultas del día | Cuenta simple |
| Cuántas quedaron sin escribir al terminar el turno | El backlog que se lleva a la casa |

Sin este número, el piloto **no puede probar nada**. Es la única forma de decir "ahorra X
minutos" en vez de "al médico le gustó".

---

## El único número de titular

> **Minutos de documentación por consulta.**

Todo lo demás es diagnóstico. Este es el que se le muestra a la clínica.

Y la advertencia que importa: **ahorrar 5 minutos por consulta no vale nada si el médico no
redirige ese margen.** Hay que decidir cuál de las dos cosas se vende:

- **(a) Atiende 2-3 pacientes más por turno.** El ROI es aritmética: `2 consultas × tarifa ×
  20 días`. La licencia se paga con uno o dos días de uso. Este es el número de la primera
  slide del pitch.
- **(b) Se va a su casa a la hora.** Retención del médico, que en una clínica privada es *el*
  activo escaso. Menos cuantificable, más emocional, y a veces vende mejor.

---

## Qué mide el sistema solo

`GET /api/metrics` (admin). Nadie tiene que anotar nada:

| Métrica | Qué significa |
|---|---|
| `revision.mediana_segundos` | Cuánto tarda el médico desde que abre la consulta hasta que firma |
| `revision.pct_sin_leer` | **Firmadas en menos de 20 segundos.** Proxy de "firmó sin mirar" |
| `consultas.abandonadas` | **Grabó y nunca firmó.** El indicador más honesto de que la app no sirve |
| `autollenado.pct_editados` | Cuánto corrige el médico lo que propuso la IA |
| `consultas.con_error` | Transcripciones que fallaron |

### La métrica ética

**`pct_sin_leer` no es una métrica de producto, es una de seguridad.** Si sube, el sistema está
enseñando al médico a confiar sin verificar — y eso es exactamente el *automation bias* que
convierte una herramienta útil en un riesgo clínico. Si en cualquier momento supera el 30%,
hay que parar y rediseñar el flujo de confirmación, aunque el ahorro de tiempo sea excelente.

---

## Los dos checkpoints

De cada rombo sale una flecha a **Pausa**. No es una formalidad: es la decisión de matar el
proyecto si no está funcionando, tomada mientras todavía se puede.

### Checkpoint 1 — semana 2

> **¿El médico grabó ≥80% de sus consultas sin que se lo recordáramos?**

Si no, el problema no es el que creíamos. No es cuestión de mejorar la transcripción ni la UI:
la herramienta no encaja en su flujo real. **Pausa** y volver a las entrevistas.

### Checkpoint 2 — semana 8

Los tres a la vez. Si falla uno, **pausa antes** de construir escala, búsqueda o cualquier
cosa nueva:

1. **Ahorro ≥ 4 minutos por consulta** contra el baseline.
2. **≥ 60% de las historias firmadas sin edición mayor** (`pct_editados` < 40%).
3. **Cero alucinaciones detectadas** en una muestra auditada a mano de 20 consultas.

La tercera no se negocia. Una sola cifra inventada que el médico no detectó y firmó vale más
que cualquier ahorro de tiempo.

---

## El protocolo de dictado de cierre

**Cero código, y es la palanca más grande del piloto.**

Whisper **no diariza**: el transcript es un bloque plano, así que lo que el paciente *especula*
("creo que es dengue") o lo que dice un familiar puede terminar en el diagnóstico.

Con el paciente delante, el médico dicta 20 segundos estructurados al final de la consulta:

> *"Presión 120 sobre 80, frecuencia cardíaca 88, temperatura 36.8. Impresión diagnóstica:
> faringitis aguda. Plan: amoxicilina 500 miligramos cada 8 horas por 7 días."*

Eso convierte un problema de **comprensión de diálogo** —que Whisper no resuelve— en uno de
**transcripción de dictado**, que resuelve bien. Y encaja con lo que el sistema ya hace: los
signos vitales y las dosis los extrae un regex determinista, que es exactamente lo que un
dictado estructurado le sirve en bandeja.

---

## Lo que NO se construye durante el piloto

Que el médico lo pida. No adivinarlo:

- Entidad paciente / multi-consulta
- Receta estructurada
- Nota SOAP
- Búsqueda de historias
- SQLite, FHIR, escala

*"Las organizaciones no fracasan por falta de casos de uso; fracasan porque tienen demasiados."*

Si el médico pide búsqueda de historias, **hazla a mano por WhatsApp durante dos semanas antes
de escribir una línea de código.** Si no la pide, la feature no existe.
