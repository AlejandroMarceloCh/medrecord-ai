# Términos de uso — MedRecord

MedRecord es una herramienta de **asistencia** a la documentación clínica. No es un
dispositivo médico certificado ni emite diagnósticos.

## Responsabilidad

- La transcripción y el autollenado de campos los genera software (Whisper + un LLM
  local) y **pueden contener errores u omisiones**.
- El **profesional de salud** que revisa y firma cada consulta es el único responsable
  de la veracidad y exactitud del contenido de la historia clínica (NTS 139-MINSA/2018;
  Código de Ética del CMP, arts. 141-142).
- Al firmar, el contenido se sella con una firma de integridad y queda como fuente de
  verdad. El proveedor del software no se hace responsable del contenido clínico.

## Datos del paciente

- El audio y los datos del paciente son **datos sensibles** (Ley 29733, art. 2.5) y
  requieren **consentimiento previo por escrito** del paciente (art. 13.6). MedRecord
  exige registrar ese consentimiento antes de procesar cada grabación.
- Todo se procesa y almacena **localmente**, cifrado en reposo. El audio no se envía a
  servicios en la nube.
- El audio puede borrarse de forma segura al vencer el período de retención configurado;
  la nota clínica firmada se conserva.

## Cumplimiento

Para uso en producción en Perú, el responsable del tratamiento debe además: registrar el
banco de datos ante la Autoridad Nacional de Protección de Datos Personales, designar un
DPO, realizar la evaluación de impacto (EIPD) y firmar las notas con firma digital
RENIECE. Estos pasos son responsabilidad del titular de la operación, no del software.
