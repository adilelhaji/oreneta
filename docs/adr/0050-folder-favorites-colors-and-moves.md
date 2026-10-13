# ADR-0050: Carpetas favoritas, colores y mover carpetas

- Estado: aceptada por delegación («Tomo yo la recomendada»); pendiente de
  revisión del propietario al final del plan.
- Fecha: 2026-10-13.
- Alcance: la fila SET-07 de la paridad con eM Client 10.4 (#87),
  «General → Carpetas». La navegación de carpetas por cuenta y crear una
  carpeta que entra en el árbol antes de la siguiente sincronización ya
  estaban; faltaban las favoritas, los colores y arrastrar carpetas.

## Decisión

- **Favoritas:**
  - cualquier carpeta de cualquier cuenta, el archivo local incluido, se
    marca o desmarca desde su menú contextual (clic derecho, Mayús+F10 o la
    tecla de menú);
  - una sección «Favoritas» arriba del todo en la navegación de correo las
    muestra en el orden que elija la persona, con sus no leídos y, si hay
    más de una cuenta en juego, el nombre de la cuenta;
  - el orden se cambia arrastrando, con Alt+↑/Alt+↓ (el foco se queda en
    la carpeta movida y un aviso `aria-live` dice su nueva posición) o con
    «Subir»/«Bajar» del menú;
  - se guardan solo aquí, como preferencia (`folder_favorites`), con la
    clave cuenta + ruta de la carpeta en su servidor; ningún servidor se
    entera.
- **Colores:**
  - una paleta fija de nueve colores con nombre (rojo, naranja, amarillo,
    verde, verde azulado, azul, morado, rosa, gris); el lector de pantalla
    dice el nombre, nunca un código;
  - cada color tiene un tono para el tema claro y otro para el oscuro, y
    todos guardan al menos 3:1 contra las superficies de la navegación
    (reposo, encima y actual), el mínimo de WCAG 1.4.11 para una marca
    que no es texto; una prueba lo comprueba;
  - se ve como un punto junto al nombre y tiñe el icono, en el árbol y en
    Favoritas; el estilo va en CSS por atributo (`data-folder-color`), sin
    estilos en línea, así que sirve con la CSP de producción;
  - preferencia local (`folder_colors`), con la misma clave que las
    favoritas.
- **Qué pasa cuando una carpeta cambia:**
  - mover una carpeta: el núcleo devuelve cada ruta que cambió (la carpeta
    y sus subcarpetas) y favoritas, colores, columnas de tableros y la
    vista abierta siguen a la ruta nueva;
  - borrar una carpeta: la subcarpeta entera que el núcleo informa se
    lleva sus favoritas y colores;
  - quitar una cuenta: se lleva las suyas;
  - una carpeta que desaparece por otro camino (borrada o renombrada en
    otro cliente) deja de estar en la lista de su cuenta: su favorita y su
    color se quitan con un aviso visible («N carpetas favoritas ya no
    existen y se han quitado»). Una lista vacía o con solo la Bandeja de
    entrada no cuenta, porque es lo que muestra una cuenta antes de su
    primera sincronización.
- **Mover carpetas:**
  - se arrastra una carpeta sobre otra de la misma cuenta, sobre una
    favorita de esa cuenta o sobre el título «Carpetas» (nivel superior);
  - la alternativa de teclado es «Mover carpeta a…» del menú, que abre un
    selector con solo los destinos posibles y «Nivel superior»;
  - siempre se confirma, con el nombre de la carpeta y el del destino;
  - nunca se mueven Bandeja de entrada, Enviados, Borradores, Papelera,
    Correo no deseado ni Archivo (ni una carpeta que tenga una de ellas
    dentro), ni una carpeta dentro de sí misma o de una subcarpeta suya,
    ni a otra cuenta, ni a donde ya está, ni encima de una carpeta con el
    mismo nombre. La interfaz no acepta esos destinos y dice por qué; el
    núcleo vuelve a comprobarlo todo sobre su propia lista;
  - mover es renombrar la ruta jerárquica: `Trabajo` sobre `Proyectos`
    pasa a `Proyectos/Trabajo` con el delimitador que anuncie el servidor
    (`.` en servidores tipo `INBOX.`). Un servidor sin delimitador no
    tiene jerarquía y se rechaza; el archivo local y POP3 usan `/`.
- **Núcleo (`folders.move`, `meron_core::folder_move`):**
  - planifica sobre la lista guardada: comprueba las reglas y calcula los
    nombres nuevos de la carpeta y de toda su subcarpeta;
  - IMAP: un `RENAME` (RFC 3501 6.3.5 mueve también las inferiores), tras
    sacar la sesión reutilizada del buzón con `EXAMINE INBOX`, como al
    borrar; nunca se repite, porque si se pierde la respuesta el resultado
    es incierto y la siguiente sincronización de carpetas dice la verdad;
  - archivo local y POP3: se renombran sus filas (`archive_messages`), que
    son su servidor;
  - después se concilia la caché en una transacción: carpetas (con su
    delimitador), mensajes, estado de sincronización e ids de Exchange
    pasan a la ruta nueva; los resultados de búsqueda guardados de las
    rutas viejas se tiran. Los UID se conservan: si el servidor cambió
    UIDVALIDITY con el renombrado, la siguiente sincronización lo ve y
    vuelve a traer la carpeta, como con cualquier otro cambio;
  - responde con la carpeta nueva, la lista de renombrados y las carpetas,
    para que el puente y la interfaz no tengan que adivinar.
- **Microsoft Graph y Exchange (EWS):** este núcleo todavía no gestiona
  carpetas en ninguno de los dos (tampoco crear ni borrar), así que mover
  queda desactivado con el motivo a la vista («Mover carpetas aún no está
  disponible en esta cuenta») y el núcleo lo rechaza igualmente; en Graph
  además lo para la guarda de solo lectura.
- **Puente:** `mail.folderMove` en Go valida la petición, llama a
  `folders.move` (30 s de margen, como borrar) y da forma a las carpetas.

## Alternativas descartadas

- **Guardar favoritas y colores en el servidor (anotaciones IMAP METADATA
  o categorías de Exchange):** pocos servidores lo admiten y cada uno a su
  manera; eM Client también lo guarda en local.
- **Elegir cualquier color (selector libre):** no se puede garantizar el
  contraste en los dos temas ni dar un nombre que lea el lector de
  pantalla.
- **Borrar la caché de la carpeta movida y volver a descargarla:** más
  sencillo, pero obliga a bajar otra vez todo el correo de la carpeta y
  sus subcarpetas por un cambio de nombre.
- **Mover con `CREATE` + `COPY` + `DELETE`:** no es atómico, duplica el
  correo si se corta a medias y pierde los UID; `RENAME` es la operación
  del protocolo para esto.
- **Implementar ya `MoveFolder` de EWS y `move` de Graph:** ninguno de los
  dos adaptadores gestiona carpetas todavía y sus ids de carpeta no son
  rutas; hacerlo bien es trabajo de su propia decisión.

## Pendiente (#87 sigue abierta)

- Mover carpetas en Exchange (EWS `MoveFolder`) y en Microsoft Graph
  cuando esos adaptadores gestionen carpetas.
- Soltar mensajes sobre una carpeta o una favorita de la navegación: hoy
  no existe arrastrar mensajes a la navegación (solo entre columnas del
  tablero y fuentes RSS); cuando exista, una favorita debe aceptarlo igual
  que su carpeta.
- Reglas de correo cuyo destino es una carpeta movida: siguen apuntando a
  la ruta vieja.
- Evidencia nativa en Windows y de proveedores reales (la fila exige
  `requiresNative`).
