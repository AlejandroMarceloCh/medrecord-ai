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
   Si ves "Sidecar corrupto" o la lista sale vacía, la clave no corresponde a esos datos.

## Verificación rápida

Tras arrancar, entra a la web y confirma que las historias se leen (nombres, campos).
Si todo sale vacío o ilegible: la `.master.key` del backup no es la que cifró esos datos.
