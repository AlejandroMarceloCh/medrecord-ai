# Restaurar un backup de MedRecord

Los backups (`scripts/backup.sh`) son `.tar.gz` que contienen:
- `recordings/` — audio y sidecars JSON, **cifrados** (AES-256-GCM).
- `.master.key` — la clave maestra. **Sin ella los datos cifrados no se pueden leer.**

Por eso el `.tar.gz` es tan sensible como los datos: guárdalo en un destino seguro
(USB cifrado / NAS), de preferencia fuera del disco de la máquina.

## Pasos para restaurar

1. Detén el servidor.
2. Respalda lo actual por las dudas:
   ```
   mv data/recordings data/recordings.bak 2>/dev/null || true
   mv data/.master.key data/.master.key.bak 2>/dev/null || true
   ```
3. Extrae el backup dentro de `data/`:
   ```
   tar -xzf backup-AAAAMMDD-HHMMSS.tar.gz -C data/
   ```
   Esto deja `data/recordings/` y `data/.master.key` en su lugar.
4. Si usabas `MEDRECORD_KEY_FILE` en una ruta distinta a `data/.master.key`, mueve la
   clave a esa ruta:
   ```
   mv data/.master.key /tu/ruta/configurada/.master.key
   ```
5. Arranca el servidor. En el log debe decir "Restauradas N grabaciones desde disco".

## Si la clave no corresponde a los datos

El servidor **no arranca**, a propósito. Verás uno de estos mensajes:

- *"Ninguno de los N sidecars se pudo descifrar. La clave maestra no corresponde a estos
  datos"* → restauraste los datos con la clave equivocada. Las historias **no se tocaron**:
  vuelve a extraer el backup completo, con su `.master.key`.
- *"Clave maestra inválida: N bytes, se esperaban 32"* → el archivo de la clave se copió a
  medias. Vuelve a extraerlo del `.tar.gz`.
- *"No se pudo descifrar users.json"* → mezclaste la clave de un backup con los datos de otro.

Ninguno de estos casos regenera la clave ni pone las historias en cuarentena. Antes el
servidor arrancaba igual y renombraba todo a `.corrupt` en silencio, que es la forma más
rápida de perder una historia clínica creyendo que la restauraste.

## Verificación rápida

Tras arrancar, entra a la web y confirma que las historias se leen (nombres, campos).
