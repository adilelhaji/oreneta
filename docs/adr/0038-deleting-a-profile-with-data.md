# ADR-0038: Borrar un perfil con datos

- Estado: aceptada por delegación («Tomo yo la recomendada»); pendiente de
  revisión del propietario al final del plan.
- Fecha: 2026-10-12.
- Alcance: #99, sobre ADR-0016.

## Problema

Las contraseñas y claves de un perfil están en el llavero del sistema, con
nombres que solo conoce su propia base. Borrar sus carpetas desde otro
perfil dejaría esas entradas en el llavero para siempre. Por eso, hasta
ahora, solo se podía borrar un perfil que nunca se había abierto.

## Decisión

- **Cerrojo de perfil abierto:** cada proceso tiene un cerrojo del sistema
  sobre `.oreneta-running.lock` en la carpeta de su perfil mientras se
  ejecuta (`flock` o `LockFileEx`). Borrar un perfil toma ese cerrojo
  primero, así que un perfil abierto en otra ventana no se borra («ciérrala
  primero»).
- **Confirmación:** para borrar un perfil con datos hay que escribir su
  nombre exacto. El texto dice qué se borra de este equipo y que el correo
  y los datos de los servidores no se tocan.
- **Llavero:** el núcleo se ejecuta una vez dentro de ese perfil
  (`--purge-profile`, con su `MERON_PROFILE` y su base). Lee la base y
  borra cada entrada que nombra:
  - las cuentas;
  - las libretas;
  - los calendarios CalDAV;
  - el chat y la nube;
  - las claves OpenPGP y las identidades S/MIME;
  - la contraseña de las copias programadas;
  - los registros de Graph.

  La clave de la base se borra la última. Nunca actúa sobre el perfil
  principal. Una prueba cuenta los lugares del núcleo que guardan un
  secreto y falla si aparece uno nuevo sin añadirlo a esta lista.
- **Orden:**
  1. purgar;
  2. quitar el perfil de la lista, para que ya no pueda abrirse;
  3. soltar el cerrojo (Windows no borra un archivo abierto);
  4. borrar las carpetas.
- **Si la purga falla** (la base no se puede leer, el llavero no responde):
  no se borra nada y se pregunta. «Borrar igualmente» deja esas entradas
  en el llavero, y se dice.

## Alternativas descartadas

- **Enumerar el llavero por prefijo:** no todas las plataformas lo
  permiten.
- **Pedir que se abra el perfil y se quiten sus cuentas a mano:** era lo
  anterior. Es lento, y un perfil que no se puede abrir (base dañada) no se
  podía borrar nunca.
