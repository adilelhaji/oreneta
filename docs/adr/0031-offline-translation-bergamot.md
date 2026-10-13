# ADR-0031: Traducción sin conexión con Bergamot

- Estado: aceptada; tomada por delegación y revisada por el propietario
  el 2026-10-12. Dentro de ADR-0001; sin
  telemetría nueva ni servicio nuevo de pago.
- Fecha: 2026-10-12.
- Alcance: #106.

## Decisión

- **Motor:**
  - Bergamot (`@browsermt/bergamot-translator` 0.4.9, MPL-2.0), el que ya
    elegía ADR-0001;
  - su worker y su WebAssembly (5 MB) van con la aplicación, en
    `/bergamot/`, y se cargan la primera vez que se traduce;
  - la política de seguridad ya permite WebAssembly (ADR-0030); el worker se
    sirve desde la propia aplicación.
- **Modelos:**
  - los de Mozilla (MPL-2.0), publicados para Bergamot 0.3.3 en
    `storage.googleapis.com/bergamot-models-sandbox`;
  - la aplicación no los pide a ese bucket, que Mozilla llama «sandbox» y
    puede retirar: los pide a una copia sin cambios en el release
    `translation-models-0.3.3` de este repositorio (revisión del
    propietario, 2026-10-12). La copia la hace a mano el workflow
    *Publish translation models* con `scripts/translation-models/mirror.py`,
    que comprueba cada archivo contra el registro antes de subirlo. Un
    release solo tiene una lista plana, y algunos nombres se repiten entre
    pares, así que cada archivo se publica como `<par>-<nombre>`. El release
    nunca se marca como el último, para que el actualizador no lo vea;
  - el registro con el nombre, el tamaño y el SHA-256 de cada archivo va
    con la aplicación (`meron-core/src/translation/registry.json`): no se
    descarga ninguna lista, y no se puede pedir nada que no esté en ella;
  - solo los modelos que Firefox publicó como de calidad de producción:
    inglés con búlgaro, checo, alemán, español, estonio, francés, italiano,
    polaco y portugués en los dos sentidos, y noruego (bokmål) a inglés;
  - entre dos idiomas que no son inglés se traduce pasando por inglés, con
    dos modelos;
  - no hay modelo de catalán ni de otros idiomas: se dice «no hay modelo».
- **Descarga:**
  - solo cuando la persona la pide, después de ver qué idiomas, cuánto
    ocupa y desde dónde;
  - la hace el núcleo, con el proxy de la aplicación, a una carpeta
    provisional; cada archivo se comprueba (tamaño y SHA-256) y solo
    entonces la carpeta pasa a su sitio;
  - un archivo más largo de lo publicado se corta en cuanto se pasa;
  - cancelar, un corte de red o cerrar la aplicación no dejan nada que
    parezca instalado; al arrancar se borra lo que quedó a medias;
  - los modelos ocupan como máximo 1 GiB en total (todos juntos son unos
    425 MB); si el disco se llena, se dice y no se guarda nada;
  - los modelos son de la instalación, no de un perfil.
- **Uso:**
  - el puente Go sirve los modelos instalados en `/models/`, nunca una
    carpeta a medio descargar;
  - la aplicación vuelve a comprobar el SHA-256 de cada archivo antes de
    cargarlo;
  - traducir no usa la red.
- **Leer:**
  - «Traducir…» en el menú de un mensaje pregunta de qué idioma a cuál, con
    una suposición (palabras frecuentes de cada idioma) que se puede
    cambiar;
  - la traducción se muestra en lugar del texto, marcada como traducción
    automática hecha en este equipo, con «Ver original»; el mensaje no
    cambia;
  - el HTML traducido se muestra en el mismo marco aislado que el original.
- **Escribir:**
  - «Traducir este mensaje» muestra la traducción para revisarla sin tocar
    el borrador;
  - después, «Añadir debajo» conserva lo escrito, y «Usar en lugar de lo
    escrito» lo sustituye con opción de deshacer.
- **Límites:** más de 100 000 caracteres no se traducen de una vez; parar
  termina el worker y la traducción a medias.

## Alternativas

- Descargar del bucket de Mozilla (la decisión inicial): sin nada que
  mantener, pero depende de un bucket de pruebas que puede desaparecer.

- Servicios en línea (DeepL, Google): el texto sale del equipo.
- Modelos más nuevos de Mozilla (`moz-fx-translations-data`): más idiomas,
  pero hechos para el Bergamot de Firefox, no para el paquete publicado, y
  sin un registro estable de hashes.
- Remote Settings de Firefox: un servicio de Mozilla pensado para Firefox;
  añadiría una dependencia de red que no hace falta.

## Pendiente

- Detectar el idioma con un modelo (CLD) en lugar de palabras frecuentes.
- Dejar que la persona cambie el límite de espacio.
- Traducir dentro de la vista previa del lector sin abrir el mensaje.
