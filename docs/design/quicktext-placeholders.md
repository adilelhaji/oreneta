# Texto guardado: búsqueda, marcadores y cursor (#88)

## Qué cambia

- **Búsqueda:** el menú de texto guardado tiene un buscador que exige todas
  las palabras, en el nombre, el asunto o el texto.
- **Marcadores al insertar:** se rellenan con el mensaje que se escribe:
  - `{{to.firstName}}`, `{{to.name}}` y `{{to.email}}` (el primer
    destinatario; «Apellido, Nombre» se lee bien);
  - `{{me.name}}`, `{{me.firstName}}` y `{{me.email}}` (el alias elegido, o
    la cuenta);
  - `{{subject}}` y `{{date}}`.
- **Nada se rellena a ciegas:** un marcador sin dato todavía (no hay
  destinatario) o desconocido queda escrito tal cual y se avisa.
- **Formato:** en HTML lo que entra se escapa.
- **Cursor:** `{{cursor}}` marca dónde sigue la escritura, en el editor rico
  y en el de texto plano. Las marcas de más se quitan.
- **Sin pérdidas silenciosas:** guardar ya no descarta en silencio las
  plantillas incompletas, sino que nombra las que no se guardaron.

## Firmas

- Ya eran por cuenta, con la firma global como respaldo. Cambiar de cuenta
  en De cambia la firma insertada sin pisar lo escrito (pruebas existentes en
  `Composer.test.tsx`).
- **Pendiente:**
  - firma por alias;
  - sincronizar firmas con Gmail y Exchange: necesita pruebas con un
    proveedor real y debe depender de lo que admita cada uno;
  - plantillas en la respuesta rápida.

## Pruebas

| Nivel | Qué cubre |
|---|---|
| N1 `placeholders.test.ts` | Relleno desde el borrador, primer destinatario, «Apellido, Nombre»; lo que falta y lo desconocido queda y se informa; escape en HTML; cursor |
| N2 `TemplateMenu.test.tsx` | Búsqueda por todas las palabras, sin coincidencias |
| N2 `Composer.test.tsx` | Fragmento insertado con marcadores rellenos, cursor retirado y aviso de lo que no se pudo rellenar |
