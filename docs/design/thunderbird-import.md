# Importar desde Thunderbird (ADR-0041)

## Uso

En **Ajustes → Copia de seguridad → Importar correo → Desde Thunderbird…**:
1. Se elige uno de los perfiles encontrados, u otra carpeta.
2. Se marcan las carpetas que se quieren importar. Las copias de cuentas
   IMAP empiezan sin marcar.
3. **Comprobar** dice cuántos mensajes son nuevos, cuántos ya están en el
   archivo y cuántos estaban borrados en Thunderbird.
4. **Importar** los guarda en el archivo local, bajo `Thunderbird/`.

## Núcleo

- `meron-core/src/thunderbird/`: perfiles, escaneo, mensajes borrados y
  carpeta de destino.
- Órdenes: `thunderbird.profiles`, `thunderbird.scan`,
  `thunderbird.preview` y `thunderbird.import`.
- El puente añade `thunderbird.pickFolder`.

## Pruebas

| Nivel | Qué cubre |
|---|---|
| N1 (`thunderbird/tests.rs`) | Un perfil con la estructura de Thunderbird: carpetas y subcarpetas `.sbd`, nombres con puntos, sin filtros, sin estado POP, sin índices sueltos ni carpetas vacías; copia IMAP marcada; carpeta elegida a mano; mensajes borrados fuera y contados; `profiles.ini` relativo y absoluto, perfil inexistente fuera; carpeta de destino con niveles y sin `/` dentro de un nombre |
| N1 despachador (`main.rs`) | Escanear, vista previa sin guardar nada, importar en `Thunderbird/<cuenta>/<carpetas>`, dos veces sin duplicados, el borrado no entra, un identificador que el escaneo no dio se rechaza |
| N2 (`ThunderbirdImportDialog.test.tsx`) | Perfil listado; copias IMAP sin marcar; vista previa antes de importar; se importan exactamente las elegidas; cambiar la selección pide otra comprobación |
| N4 pendiente | Con un perfil real de Thunderbird en Windows |
