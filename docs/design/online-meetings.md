# Reuniones en línea (#109)

Registro de la implementación de ADR-0034.

## Piezas

- **Núcleo:**
  - `calendar/meeting.rs`: reconocimiento, quién puede crear y la clave de
    petición;
  - `google.rs`: lectura de `conferenceData`, creación al crear o editar,
    eliminación con `null` y estado listo, en preparación o fallido;
  - `route.rs` y `main.rs` rechazan la creación fuera de Google.
- **Aplicación:**
  - casilla en el editor solo donde se puede crear;
  - pista de pegar el enlace en los demás casos;
  - «Quitarla» para un Meet;
  - «Unirse a …» en el evento;
  - aviso si Google no creó la reunión.

## Pruebas

- **Núcleo:**
  - enlaces reconocidos y rechazados, incluidos dominios falsos;
  - solo Meet en Google;
  - la misma clave para el mismo evento;
  - creación con la petición y versión correctas;
  - sin petición, nada sobre reuniones;
  - fallo y preparación se informan;
  - editar no la toca, pedirla dos veces no la duplica, quitarla envía
    `null` y otro tipo se rechaza;
  - un complemento en Google se nombra por su dirección;
  - la reunión se guarda y se reconoce el enlace de las notas.
- **Aplicación:**
  - casilla y envío de `meet`;
  - sin casilla en un calendario local;
  - «Quitarla» envía `none`;
  - «Unirse a Zoom» abre la dirección.
- **Encontrado al probar:** el campo iba dentro de un `<label>` y el botón
  tomaba el nombre del campo. Ahora es un grupo con su propio nombre.
