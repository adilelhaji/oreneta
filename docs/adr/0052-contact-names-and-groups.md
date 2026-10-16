# ADR-0052: Nombres y grupos de contactos

- Estado: aceptada por delegación («Tomo yo la recomendada»); pendiente de
  revisión del propietario al final del plan.
- Fecha: 2026-10-13.
- Alcance: la fila SET-19 de la paridad con eM Client 10.4 (#41),
  «Contactos → General». La libreta local, la edición en CardDAV que nunca
  pisa un cambio remoto ni pierde campos (ADR-0012), la importación y
  exportación de vCard y los enlaces de duplicados ya estaban resueltos y
  probados; faltaban cómo se muestran y ordenan los nombres, y los grupos.

## Decisión

- **Partes del nombre:**
  - una persona guarda, además de su nombre entero (`FN`), el nombre de pila
    y el apellido cuando la libreta los tiene separados: el `N` de una
    vCard (apellido;nombre;…), `givenName`/`familyName` de Google, o los dos
    campos nuevos «Nombre» y «Apellidos» del editor. Columnas `given` y
    `family` en `people` (esquema 60);
  - un nombre que solo existe entero **nunca se parte** adivinando: «María
    José García López» o «Kim Min-jun» se muestran tal cual, con cualquier
    preferencia;
  - al guardar en CardDAV, cambiar las partes reescribe solo el apellido y
    el nombre de `N` y conserva segundos nombres, prefijos y sufijos; una
    tarjeta sin `N` lo recibe. Cambiar solo el nombre entero hace lo de
    antes (`N:;nombre;;;`), porque las partes viejas ya no lo describen;
  - un editor que no envía partes (una ventana antigua, el móvil) las deja
    como estaban en vez de borrarlas; un contacto escrito solo con sus dos
    partes recibe un nombre entero formado con ellas.
- **Preferencias** (dos filas de `settings`, texto plano para que el móvil
  las lea con `app.prefsGet`):
  - `contact_name_display`: `auto`, `first_last` («Ada Lovelace»),
    `last_comma_first` («Lovelace, Ada») o `last_first` («Lovelace Ada»;
    para chino, japonés y coreano sin espacio: «王芳»);
  - `contact_name_sort`: `auto`, `first` o `last`. Ordena por la parte
    elegida y, sin ella, por el nombre entero; con `Intl.Collator` del
    idioma de la interfaz;
  - `auto` sigue al idioma de la interfaz: apellido primero y orden por
    apellido en chino, japonés, coreano, húngaro y vietnamita (orden de
    CLDR); nombre primero y orden por nombre en el resto. La opción lo dice
    con un ejemplo («Como el idioma (Ada Lovelace)»);
  - se aplican a la lista y la ficha de contactos, a las sugerencias de
    destinatarios que vienen de la libreta, y a la lista de correo **solo
    cuando el mensaje no trae nombre**: entonces se muestra el de la libreta
    (`people.names`, una pregunta agrupada por pantalla). Un nombre escrito
    en una cabecera nunca se reescribe; tampoco el de una dirección vista
    solo en correo;
  - en Ajustes, grupo «Contactos» (sección `contactsGeneral`, también en la
    búsqueda de ajustes).
- **Grupos:**
  - un grupo pertenece a un libro, como una persona (`contact_groups` y
    `contact_group_members`, esquema 60), y guarda a sus miembros por id de
    persona. En un libro sincronizado ese id sale del UID del miembro en el
    mismo libro, así que una sincronización que reescribe a las personas no
    deja al grupo sin ellas. Un miembro sin tarjeta aquí no se lista, pero
    sigue en el grupo;
  - **local:** crear, renombrar, borrar y poner o quitar miembros, con la
    versión con que se leyó (ADR-0012): una versión distinta no guarda nada
    y lo dice. Un grupo local puede tener a cualquiera de cualquier libro: es
    una lista de la persona y nadie más la lee. Borrar un grupo no borra a
    nadie; borrar a una persona la saca de sus grupos;
  - **CardDAV:** se leen los dos modelos que se usan: vCard 4
    (`KIND:group` y `MEMBER:urn:uuid:<uid>`) y el de Apple para 3.0
    (`X-ADDRESSBOOKSERVER-KIND:group` y `X-ADDRESSBOOKSERVER-MEMBER`). Una
    tarjeta de grupo ya no aparece como persona;
  - un cambio se escribe como el resto de tarjetas (ADR-0012): se lee la del
    servidor, se compara su ETag con la versión leída y se escribe con
    `If-Match`; un 412 o una ETag distinta no escribe nada y devuelve la
    copia del servidor. El cambio parte de esa copia y toca solo el nombre y
    los miembros añadidos o quitados (diferencia con lo leído): un miembro
    `mailto:`, un UID que no está en este libro, campos desconocidos y el
    orden de las líneas vuelven tal cual;
  - un miembro nuevo se escribe en la propiedad que ya usa la tarjeta; un
    grupo nuevo, como los grupos que ya tiene el libro, y si no tiene
    ninguno, en vCard 4 si sus tarjetas son 4.0 y al estilo de Apple si son
    3.0 (lo calcula cada sincronización: `contact_sources.group_style`);
  - un grupo en un servidor solo puede contener personas de ese mismo libro;
    pedir otra cosa es un error que no envía nada;
  - **Google:** las etiquetas se leen, sin poder cambiarlas: el permiso
    `contacts.readonly` que ya pide la cuenta basta para
    `contactGroups.list` y para `memberships` de cada persona. Solo las del
    usuario (`USER_CONTACT_GROUP`); «Mis contactos», «Destacados» y demás de
    sistema no son grupos que alguien eligiera. Si las etiquetas no se
    pueden leer, las personas se sincronizan igual y se conservan los
    grupos que había;
  - **Exchange:** sin grupos por ahora (ver «Pendiente»).
- **Vista de contactos:** un selector «Mostrar grupo» filtra la lista (con
  el número de miembros), y desde él se crea, renombra, borra y se escribe a
  todo el grupo. La ficha de una persona muestra sus grupos y deja añadirla
  a un grupo de su libro o a uno local, o quitarla, cuando el grupo se puede
  escribir.
- **Redactor:** escribir parte del nombre de un grupo lo sugiere encima de
  las personas, con cuántas direcciones tiene («grupo, 3 personas»), y solo
  al elegirlo se convierte en la primera dirección de cada miembro (cada una
  una vez, con su nombre en el orden elegido); quien no tiene dirección no
  cuenta. Los grupos se leen la primera vez que se escribe en un campo.
- **Móvil:** la lista de contactos lee `contact_name_display` y
  `contact_name_sort` al abrirse y los aplica a la lista, la ficha y la
  confirmación de borrado. `auto` muestra el nombre entero y deja el orden
  del núcleo, porque el código común no tiene orden de nombres por idioma.
  Los grupos no están en el móvil todavía.
- **Bajas:** al quitar una cuenta se van sus grupos y sus miembros
  (`REMOVED_WITH_ACCOUNT`); al quitar un libro, sus grupos.

## Alternativas descartadas

- **Partir el nombre entero por el último espacio:** es lo que hacen otros
  clientes y falla con apellidos compuestos, nombres de una sola palabra y
  el orden de Asia oriental. Mejor mostrar el nombre como está.
- **Reescribir con el nombre de la libreta todos los remitentes de la lista
  de correo:** cambiaría lo que el remitente dijo de sí mismo y ocultaría
  suplantaciones; solo se rellena lo que el mensaje dejó vacío.
- **Guardar en un grupo CardDAV la lista completa de miembros y escribirla
  entera:** perdería los miembros que aquí no se ven (otro libro, `mailto:`)
  y el trabajo de otro cliente entre lectura y escritura; por eso se envía
  la diferencia sobre la copia del servidor.
- **Escribir siempre vCard 4:** muchos servidores y clientes de 3.0 (macOS,
  iOS, Nextcloud) solo entienden los grupos de Apple; se sigue lo que el
  libro ya usa.
- **Categorías (`CATEGORIES`) como grupos:** es otro modelo, que no
  comparten Apple ni RFC 6350 para grupos, y mezclaría etiquetas libres con
  listas; se conservan intactas.
- **Pedir el permiso de escritura de Google para editar etiquetas:** obliga
  a todas las cuentas a volver a dar permiso; queda para cuando se pida.

## Pendiente (#41 sigue abierta)

- Editar etiquetas de Google y grupos de Exchange (listas de distribución
  personales). Las listas de Exchange ya se leen y escriben (ADR-0058).
- Grupos en el móvil y en la importación y exportación de vCard.
- Más campos del contacto (direcciones postales, cumpleaños) en el editor.
- Evidencia con proveedores reales (iCloud, Nextcloud, Google); la prueba de
  integración usa Radicale 3.5.4.
