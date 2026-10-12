# Copias programadas (#173; ADR-0037)

## Uso

En **Ajustes → Copia de seguridad → Copias programadas**:
- activar, elegir carpeta, cada día o cada semana, cuántas conservar y un
  límite de espacio opcional;
- la contraseña, confirmada, se guarda en el llavero del sistema;
- **Copiar ahora** hace una copia en el momento;
- se muestran la última copia buena, el último fallo (con «las copias
  anteriores se conservan»), la próxima y la lista de las que se conservan,
  marcando las que ya no están en la carpeta.

Un fallo de una copia programada se avisa aunque Ajustes esté cerrado.

## Núcleo

`meron-core/src/backup_schedule/`, RPC `backupSchedule.status`,
`backupSchedule.save`, `backupSchedule.runNow`, evento `backup.scheduled`.
Comprueba cada 5 minutos, empezando 2 minutos después de abrir. Esquema 55.
El puente da `backupSchedule.pickFolder` y pasa `MERON_APP_VERSION`.

## Pruebas

| Nivel | Qué cubre |
|---|---|
| N1 Rust (`backup_schedule/tests.rs`) | Apagada por omisión; una copia perdida se hace una vez y un fallo se reintenta a la hora; ajustes y carpeta (dentro del perfil, que lo contiene, inexistente, relativa); retención por número y por espacio sin borrar nunca la comprobada más reciente; copia real escrita, comprobada y legible; disco lleno que conserva todo; copia nueva corrupta que se borra y deja la buena con «conservar 1»; solo se borran archivos propios sin cambios (ni notas, ni copias manuales, ni un archivo sustituido); manual y programada nunca a la vez; parada a mitad (sin comprobar o `.part`) que se limpia al arrancar sin tocar `.part` ajenos; dos copias en el mismo segundo; perfil restaurado con las copias apagadas |
| N1 despachador (`main.rs`) | Sin contraseña no se enciende; la contraseña no vuelve; copiar ahora deja una copia comprobada; manual y programada se excluyen |
| N2 (`BackupScheduleGroup.test.tsx`) | Apagada por omisión; no se guarda sin carpeta ni contraseña confirmada; un cambio posterior no reenvía la contraseña; fallo visible con «se conservan»; copia ausente marcada; evento recibido con Ajustes abierto |
| N4 pendiente | En Windows: copia con la aplicación en uso, disco lleno real, carpeta en unidad extraíble desconectada |
