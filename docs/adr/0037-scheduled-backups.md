# ADR-0037: Copias programadas del perfil

- Estado: aceptada; tomada por delegación y revisada por el propietario
  el 2026-10-12.
- Fecha: 2026-10-12.
- Alcance: #173, sobre ADR-0010 y ADR-0017.

## Decisión

- **Quién programa:** el núcleo, mientras la aplicación está abierta.
  Oreneta no instala una tarea en el sistema. Una copia que tocaba con la
  aplicación cerrada se hace una sola vez, poco después de abrirla (no al
  arrancar, para no frenarlo).
- **Apagada por omisión.** Encenderla pide:
  - una carpeta que exista y que no esté dentro del perfil ni lo contenga;
  - una contraseña de al menos 8 caracteres, confirmada.

  La contraseña se guarda en el llavero del sistema y nunca vuelve a la
  interfaz. Si el llavero no la conserva, la copia programada falla con
  «falta la contraseña» y se avisa; no se hace sin ella.
- **Qué cuenta como copia:** la copia completa de #171, escrita junto al
  destino y renombrada al terminar. Después se abre entera en una carpeta
  privada, como hace «Comprobar». Solo una copia que pasa esa comprobación
  cuenta. Si no la pasa, se borra (es suya) y se informa.
- **Retención:**
  - se conservan N copias comprobadas (de 1 a 30, 7 por omisión);
  - opcionalmente, un límite de espacio;
  - la copia comprobada más reciente no se borra nunca, aunque supere el
    límite por sí sola o fallen las copias siguientes.
- **Qué puede borrar:** solo archivos que escribió y comprobó, con su
  prefijo `oreneta-scheduled-` y con el mismo tamaño que tenían al
  escribirlos. Un archivo cambiado se olvida, no se borra. Nada más de la
  carpeta se toca.
- **Concurrencia:** una copia manual y una programada nunca se escriben a
  la vez; la segunda se rechaza con un mensaje, o espera a la siguiente
  comprobación si es la programada.
- **Fallos:**
  - un fallo (disco lleno, carpeta ausente, contraseña ausente) deja las
    copias anteriores como estaban;
  - se reintenta una hora después, no en bucle;
  - se avisa aunque Ajustes esté cerrado.
- **Restaurar:** un perfil restaurado llega con las copias programadas
  apagadas. Su contraseña no está en el archivo, y su carpeta puede ser de
  otro equipo.

## Alternativas descartadas

- **Tarea del sistema (Programador de tareas, launchd, systemd):** haría
  copias con la aplicación cerrada, pero exige instalar algo fuera de la
  aplicación, en cada plataforma. Queda para cuando haya instalador
  firmado.
- **Copiar a la nube:** fuera de alcance de #173, sin gasto ni servicio.
- **Guardar la contraseña en la base:** la copia del perfil la llevaría
  dentro.
