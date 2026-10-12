# Copia completa del perfil (#171, #172; ADR-0010, ADR-0017)

## Uso

En **Ajustes → Copia de seguridad → Perfil completo** hay tres acciones:
- **Copiar…** pide una contraseña de al menos 8 caracteres, confirmada, y
  dónde guardar el archivo `.oreneta-profile`.
- **Comprobar…** abre un archivo en una carpeta privada, comprueba cada
  entrada y la base, y dice qué contiene y qué no. El perfil en uso no se
  toca.
- **Restaurar…** hace lo mismo y después pide confirmación:
  - El perfil en uso se aparta; no se borra.
  - El restaurado entra con todas las cuentas en pausa; se sincroniza al
    reanudar cada una, y sus contraseñas se piden de nuevo si el llavero no
    las tiene.
  - Los envíos programados quedan retenidos.
  - La ventana se recarga.

Mientras el perfil anterior sigue apartado, la misma sección ofrece **Volver**
(lo repone tal como estaba) o **Conservar** (lo borra).

## Cómo se activa

1. El núcleo deja preparada la restauración en `restore-staging/ready`:
   - la base, recifrada con la clave del equipo;
   - las cuentas en pausa, los envíos retenidos y ningún secreto;
   - las imágenes;
   - `READY.json`.
2. El puente detiene el núcleo y espera a que el proceso termine y su salida
   se haya leído, para que Windows libere los archivos.
3. Antes de mover nada, el puente escribe un diario con cada movimiento y si
   había algo en su sitio. Después aparta la base, su WAL/SHM y las carpetas
   de imágenes, y coloca las restauradas.
4. Arranca el núcleo y le pide la lista de cuentas. Si no abre la base, se
   deshace con el diario y se arranca sobre el perfil anterior.
5. Al arrancar la aplicación, un diario a medias se deshace antes de que el
   núcleo abra la base.

## Pruebas

| Nivel | Qué cubre |
|---|---|
| N1 Rust (`profile_archive/tests.rs`) | Ida y vuelta con contraseña sola; nada legible en el archivo; la caché fuera; contraseña errónea, corta o archivo ajeno; 40 bytes cambiados y 4 cortes detectados; rutas maliciosas (`..`, absolutas, unidades, barras invertidas, `//`, `.`) y nombres repetidos; versión o esquema futuros y manifiesto falso; un fallo conserva la copia anterior; preparación recifrada, cuentas en pausa, envíos retenidos, sin secretos, sin restos tras un fallo y sin clave en equipo sin llavero |
| N1 despachador (`main.rs`) | Exportar e inspeccionar sin tocar el perfil en uso; la clave de la base no sale del núcleo |
| N1 Go (`restore_test.go`, `sidecar_restart_test.go`) | Intercambio completo y perfil anterior apartado; conservar; volver exactamente; corte tras cada paso, y a mitad de un paso, deshecho al arrancar; fallo a mitad que repone el anterior; nada sin archivo comprobado; el núcleo se detiene y reinicia como proceso nuevo; tiempos largos para copiar y restaurar |
| N2 (`ProfileArchiveDialog.test.tsx`, `RestoreStatusRow.test.tsx`) | Contraseña mínima y confirmada; comprobación con contraseña errónea y lista de exclusiones; restaurar solo tras comprobar y confirmar; fallo que no recarga; volver y conservar |
| N4 pendiente | En Windows: núcleo y WebView2 abiertos durante el intercambio, disco lleno e interrupción reales |
