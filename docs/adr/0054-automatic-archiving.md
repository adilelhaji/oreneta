# ADR-0054: Archivado automático por antigüedad

- Estado: aceptada por delegación («Tomo yo la recomendada»); pendiente de
  revisión del propietario al final del plan.
- Fecha: 2026-10-13.
- Alcance: #112 (fila SET-13 del libro de paridad, «Correo → Archivado
  automático» de eM Client 10.4), sobre ADR-0014 (archivo local) y con la
  programación de ADR-0037.

## Decisión

- **Apagado por omisión, y por cuenta.** Cada cuenta con servidor (IMAP,
  Exchange por EWS, Microsoft Graph) tiene su política en
  `auto_archive_policies` (esquema 62). POP3 y el archivo local no la
  tienen: su correo ya está en este equipo.
- **Qué dice una política:**
  - antigüedad: N días (1–3650) o N meses (1–120); 6 meses por omisión;
  - carpetas de origen: la Bandeja de entrada por omisión; cada carpeta
    elegida puede tener su propia antigüedad;
  - destino: la carpeta Archivo de la cuenta en el servidor, o el archivo
    local; con el archivo local, opción de dejar también la copia del
    servidor;
  - excluidos por omisión: los mensajes marcados y los no leídos; dos
    casillas los incluyen.
- **Carpetas que nunca son origen:** Borradores, Bandeja de salida,
  Papelera, No deseado y la propia carpeta Archivo (o «Todos» de Gmail).
  Se reconocen por su papel (RFC 6154) y, si el servidor no lo dice, por su
  nombre. Se muestran en Ajustes desactivadas, con el motivo; el núcleo las
  rechaza aunque se le pidan.
- **Qué es «más antiguo que N»:** la fecha del mensaje (`Date:`) es
  anterior a la medianoche local del día que cae N días o N meses antes de
  hoy. Un mensaje de ese mismo día no entra. Los meses son de calendario
  (el 31 de marzo menos un mes es el 28 de febrero). Si ese día empieza en
  un cambio de hora sin medianoche, cuenta desde la primera hora que
  existe. Un mensaje sin fecha conocida no se archiva nunca.
- **Vista previa y confirmación:**
  - antes de encenderla, y cada vez que cambie algo que decida qué se mueve
    (antigüedad, carpetas, destino, opciones), se muestra cuántos mensajes
    de cada carpeta se moverían ahora, desde qué fecha y adónde;
  - la vista previa no mueve nada y devuelve una huella (SHA-256 de la
    cuenta y la política sin el «encendida»);
  - el núcleo solo acepta encenderla con esa huella; una política cambiada
    sin huella nueva queda sin confirmar y, por tanto, no corre;
  - apagarla y volver a encenderla sin cambios no pide otra vista previa.
- **Cuándo corre:** como las copias programadas (ADR-0037), mientras la
  aplicación está abierta: una comprobación cada 5 minutos, la primera unos
  2½ minutos después de abrir. Una vez al día; la primera, en la siguiente
  comprobación tras confirmar. Una ejecución que no puede empezar (sin
  conexión, sin carpeta Archivo) se reintenta una hora después, sin
  adelantar la diaria. Las cuentas en pausa no corren. «Ejecutar ahora»
  hace lo mismo a petición, con la política confirmada. Solo corre una
  ejecución a la vez.
- **Cómo se buscan los mensajes:**
  - IMAP: se pregunta al servidor (`UID SEARCH SENTBEFORE`, con dos días de
    margen) y se leen las cabeceras de lo encontrado; la fecha exacta, las
    marcas y el Message-ID deciden;
  - Graph y EWS no ofrecen esa búsqueda por esta vía: se usa lo
    sincronizado aquí, de modo que solo se archiva lo que la aplicación ya
    conoce de esa carpeta.
- **Al Archivo del servidor:** la misma acción que «Archivar»: `UID MOVE`
  (RFC 6851), o `COPY` + `\Deleted` + `EXPUNGE` si el servidor no tiene
  MOVE; en Graph y EWS, el movimiento propio de cada uno. Se mueve en
  tandas de 50; una tanda rechazada se anota mensaje a mensaje.
- **Al archivo local (ADR-0014): copiar → comprobar → borrar.**
  - se leen los bytes originales del servidor (`BODY.PEEK[]`, sin marcar
    nada como leído) y se guardan en `Archived/<dirección>/<carpeta>` del
    archivo local, con sus marcas de leído y marcado;
  - la copia se vuelve a leer y se compara byte a byte con la del
    servidor; si no coincide o no se puede leer, se borra la copia (es
    nuestra) y el mensaje se queda en el servidor;
  - solo con la copia comprobada se borra del servidor (`\Deleted` +
    `UID EXPUNGE`), en tandas;
  - solo es posible en cuentas IMAP: Graph y EWS no entregan aquí los bytes
    originales, y la opción aparece desactivada con el motivo.
- **Reanudable y sin duplicados:** cada paso queda en
  `auto_archive_items` (copiado, comprobado). Si la ejecución se corta:
  - entre copiar y comprobar, o entre comprobar y borrar, la siguiente
    vuelve a leer el original, reconoce la copia ya hecha (por el diario, o
    por Message-ID e igualdad de bytes) y no copia otra vez;
  - nunca se borra del servidor sin comparar, en esa misma ejecución, los
    bytes del servidor con una copia local; si el UID ahora nombra otro
    mensaje, los bytes no coinciden y no se borra nada;
  - en el peor caso queda el mensaje en los dos sitios, nunca en ninguno.
  Con «dejar también en el servidor», lo archivado se recuerda (UID y
  Message-ID) y no se vuelve a copiar cada día.
- **Registro de cada ejecución** (`auto_archive_runs`, las 30 últimas por
  cuenta): cuándo, si fue programada o a petición, destino, movidos,
  copiados con copia en el servidor, no movidos, desaparecidos antes de su
  turno y, para cada mensaje que no se movió, carpeta, asunto, paso (leer,
  copiar, comprobar, borrar, mover) y motivo (hasta 200). Se ve en Ajustes
  de la cuenta. Un fallo de una ejecución programada se avisa aunque
  Ajustes esté cerrado.
- **Al quitar la cuenta** se van con ella su política, su registro y su
  diario (ADR-0011). Lo ya copiado al archivo local se queda.
- **Restaurar un perfil** (ADR-0010) deja todas las políticas apagadas:
  una copia restaurada en otro equipo no empieza a mover correo sola.

## Alternativas descartadas

- **Elegir los mensajes con la caché local también en IMAP:** solo vería
  los mensajes recientes que la aplicación ha sincronizado y dejaría sin
  archivar justo los más antiguos.
- **Pedir confirmación antes de cada ejecución diaria:** la política
  confirmada ya dice qué se mueve; preguntar cada día enseña a aceptar sin
  leer. Cambiarla sí vuelve a preguntar.
- **Mover al archivo local con MOVE del servidor y copiar después:** si la
  copia fallara, el mensaje quedaría solo en una carpeta que no es la del
  destino elegido. Copiar y comprobar antes de borrar no pierde nada.
- **Archivar con la aplicación cerrada (tarea del sistema):** igual que en
  ADR-0037, exige instalar algo fuera de la aplicación en cada plataforma.
- **Contar la antigüedad por la fecha de llegada (INTERNALDATE):** cambia
  al copiar o migrar buzones; la fecha del mensaje es la que la persona ve
  en la lista.
