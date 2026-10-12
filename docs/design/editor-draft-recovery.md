# Recuperación de borradores del editor (#170)

Conecta el editor completo al almacén local de #169
([contrato del almacén](local-draft-storage.md)). Código:
`frontend/src/states/localDraftSync.ts`, enganchado en `states/compose.ts`, con
el estado visible en `components/composer/LocalDraftStatus.tsx`.

## Problema

Las pestañas del editor se copiaban a localStorage solo como texto: los
adjuntos se quitaban porque sus bytes no caben en la cuota. Tras un reinicio, el
borrador volvía sin ningún fichero adjunto y sin aviso de que faltaban.

## Contrato

- **Qué se guarda.** Cada pestaña de redacción se guarda entera en el almacén
  local: cuenta, remitente, destinatarios, asunto, ambos cuerpos, opciones de
  protección y cada adjunto con sus bytes y su tamaño exacto. El identificador
  local es el de la pestaña. La copia de texto en localStorage sigue igual,
  como respaldo cuando el almacén no se puede leer.
- **Cuándo.** Tras una pausa de 600 ms sin cambios, y en seguida al cerrar la
  aplicación (`beforeunload` y `pagehide`). Las escrituras de un mismo borrador
  van en fila, nunca a la vez. Un cambio que no altera el documento no se
  escribe.
- **Revisión.** Cada escritura indica la revisión que el almacén confirmó la
  última vez. Si el almacén tiene otra más reciente, o el borrador se descartó
  en otro sitio, no se sobrescribe nada. El autoguardado se detiene y el
  compositor lo dice. Ante una copia más reciente, «Conservar esta versión»
  escribe lo que se ve, partiendo de la revisión vigente. Ante un descarte, el
  texto sigue en pantalla para enviarlo o copiarlo. El tombstone nunca se
  sobrescribe.
- **Cerrar la pestaña.** Enviar, descartar o cerrar conservando el borrador del
  servidor borran la copia local. El borrado espera a la escritura en curso y
  deja un tombstone. Así una escritura tardía no puede resucitar un borrador ya
  enviado o descartado. Si nada de la pestaña llegó a guardarse, no se borra
  nada. Reabrir un envío deshecho crea una pestaña con otro identificador.
- **Arranque.** Hasta que se leen los borradores guardados no se escribe
  ninguno, porque aún no se conoce la revisión de partida. La lectura se
  reintenta con espera creciente mientras el núcleo arranca. Luego:
  - un borrador guardado sustituye a la copia de texto de la misma pestaña y
    vuelve con sus adjuntos;
  - uno que solo está en el almacén se abre como pestaña;
  - una pestaña que solo tenía localStorage se escribe en el almacén, y esa es
    su migración;
  - una pestaña cerrada antes de terminar la lectura se borra entonces, sin
    reaparecer;
  - un borrador ilegible se informa como error y nunca se convierte en uno
    vacío.
  Las pestañas abiertas se leen después de la última espera, así que una
  pestaña abierta mientras tanto no se pierde.
- **Imágenes insertadas.** El cuerpo enriquecido apunta a ficheros
  `/media/<clave>` y sus bytes están también entre los adjuntos guardados. La
  limpieza de ficheros huérfanos al arrancar se hace ahora después de leer el
  almacén. Antes se hacía con solo las pestañas de localStorage, y habría
  borrado las imágenes de un borrador que solo estuviera en el almacén. Si el
  almacén no se puede leer, no se limpia nada.
- **Errores visibles.** «Guardando una copia en este equipo…» y «Copia guardada
  en este equipo» se muestran discretos. Un fallo de escritura, por ejemplo un
  límite superado o el disco lleno, se muestra con el motivo del núcleo, y el
  siguiente cambio vuelve a intentarlo.

## Pruebas

- `localDraftSync.test.ts` usa un almacén falso con las reglas de revisión y
  tombstone del núcleo. Cubre bytes exactos de base64, ninguna escritura antes
  de la lectura, documento completo con adjuntos y revisiones encadenadas,
  escritura omitida si nada cambia y pausa de escritura. También cubre el
  volcado al cerrar, el conflicto con «conservar esta versión», el descarte en
  otro sitio y el error con reintento. Prueba el borrado tras una escritura en
  curso sin resurrección, la escritura pendiente anulada al cerrar, la
  recuperación con adjuntos y la revisión de partida, y la migración desde
  localStorage. Comprueba la pestaña cerrada antes de la lectura, el borrador
  ilegible, el fallo de listado y la pestaña abierta durante la lectura.
- `LocalDraftStatus.test.tsx` usa el estado real de `compose$`. Comprueba que
  abrir, escribir y cerrar guarda y borra, que la limpieza de imágenes espera a
  la lectura del almacén y que el arranque sin núcleo se rinde sin escribir.
  También prueba el texto de cada estado y el botón «Conservar esta versión».
- El arranque de producción (Playwright) responde a `localDrafts.*` y sigue sin
  órdenes inesperadas.
- El almacén mismo, con concurrencia, límites, corrupción y rollback, está
  probado en Rust por #169.

## Límites que siguen abiertos

- **Respuesta rápida.** La caja de respuesta del hilo no usa todavía este
  almacén. Su texto sobrevive como antes, sin adjuntos tras reiniciar.
- **Medios perdidos.** Si el fichero `/media/<clave>` de una imagen insertada
  desaparece, por ejemplo al restaurar el perfil en otro equipo, el editor la
  muestra rota. Sus bytes siguen en los adjuntos guardados, pero el cuerpo no
  dice a cuál corresponde. Resolverlo exige guardar esa correspondencia al
  insertar la imagen.
- **Ventana de pérdida.** Un cierre brusco, como un fallo eléctrico o la muerte
  del proceso, puede perder hasta 600 ms de escritura en el almacén. La copia
  de texto de localStorage los cubre, pero sin los adjuntos añadidos en ese
  intervalo.
- **Flujo nativo.** «Escribir, cerrar la app y reabrir» en el binario Windows
  (N4) sigue sin ejecutarse aquí. El reinicio se simula en las pruebas.
