# ADR-0023: Categorías de bandeja transparentes

- Estado: aceptada por delegación («Tomo yo la recomendada»); pendiente de
  revisión del propietario al final del plan. Cubre la puerta de arquitectura
  de #91 (clasificador y modelo de datos nuevos).
- Fecha: 2026-10-11.
- Alcance: primera entrega de #91.

## Contexto

#91 pide pestañas de categorías configurables, con corrección manual y
asignación por reglas, y con el motivo visible. Todo el correo debe seguir
accesible y lo no clasificado no puede desaparecer. Las asignaciones deben
sobrevivir a la sincronización y al reinicio, sin confundirse con las
etiquetas remotas (ADR-0002) ni con la agrupación de prioridad.

## Decisión

- **Sin modelo estadístico:**
  - las categorías las define la persona: nombre, color y, si quiere,
    condiciones;
  - las condiciones usan los mismos campos y comparaciones que las reglas
    (remitente, destinatarios, asunto);
  - una categoría sin condiciones solo se llena a mano.
- **Orden de decisión, con su motivo:**
  1. la persona puso esta conversación aquí;
  2. la persona puso aquí el correo de este remitente;
  3. la primera categoría, en el orden de la persona, cuyas condiciones se
     cumplen (se guarda qué condiciones se cumplieron);
  4. si nada coincide, la conversación queda en **Otros**.
- **Siempre visible:**
  - las pestañas son **Todo**, cada categoría y **Otros**;
  - Todo y Otros no se pueden quitar;
  - cada pestaña muestra su recuento, y una línea dice que los recuentos son
    del correo guardado en este equipo.
- **Por conversación:**
  - en cada carpeta, el mensaje más reciente de la conversación decide, y
    todos sus mensajes allí toman el mismo veredicto;
  - así la lista y los recuentos coinciden.
- **Persistencia:**
  - `messages.category` guarda el veredicto: NULL mientras no se ha juzgado,
    vacío para Otros;
  - las correcciones viven en `category_threads` (clave de conversación) y
    `category_senders` (dirección), separadas de los mensajes;
  - un mensaje que se vuelve a descargar se juzga otra vez y vuelve al mismo
    sitio;
  - las definiciones están en `inbox_categories` y son de la persona, no de
    una cuenta;
  - al borrar una cuenta se borran sus correcciones (ADR-0011).
- **Separación:**
  - el filtro tiene su propia faceta, `category:<id>` (`category:none` es
    Otros);
  - nunca se sincroniza con un servidor;
  - no se mezcla con `thread_labels` ni con `priority`.
- **Dónde:**
  - las pestañas aparecen en la bandeja de entrada de cada cuenta y en la
    unificada;
  - fuera de ellas, o mientras se busca, la faceta se quita para que nada
    filtre sin estar a la vista.
- **Límites:** hasta 12 categorías y 20 condiciones cada una. Una condición
  vacía o un nombre repetido se rechazan antes de guardar.

## Pendiente

- Usar cabeceras como `List-Id` o `List-Unsubscribe` en las condiciones: hoy
  no se guardan.
- Categorías como paso de Acciones rápidas (ADR-0022).
- El recuento de lo que el servidor tiene y aún no se ha descargado.
