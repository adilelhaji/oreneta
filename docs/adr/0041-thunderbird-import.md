# ADR-0041: Importar des de Thunderbird

- Estat: acceptada; presa per delegació i revisada pel propietari
  el 2026-10-12.
- Data: 2026-10-12.
- Abast: importació des d'altres clients (paritat amb l'assistent
  d'importació d'eM Client); amplia ADR-0014.

## Decisió

- **Origen:** els perfils de Thunderbird es cerquen als llocs
  habituals:
  - `profiles.ini` a Windows (`%APPDATA%`), macOS, Linux, Flatpak i Snap;
  - també es pot triar a mà un perfil o una carpeta de correu.
- **Què es llegeix:**
  - cada carpeta de Thunderbird és un mbox sense extensió, amb el seu índex
    `.msf` al costat, i les seves subcarpetes són a `<nombre>.sbd/`;
  - es recorren `Mail/` (Carpetes locals i comptes POP) i `ImapMail/`
    (còpies de comptes IMAP);
  - no es prenen com a correu els filtres, l'estat POP, els índexs sense
    carpeta ni els fitxers buits.
- **Les còpies IMAP no es trien d'entrada:** aquest correu continua al seu
  servidor i la còpia pot ser incompleta. Es diu al quadre de diàleg.
- **Missatges suprimits:** Thunderbird deixa al fitxer els missatges
  suprimits fins que es compacta, marcats amb `X-Mozilla-Status` 0x0008. No
  s'importen i es compten a la previsualització; mai no es recupera un correu
  que la persona va suprimir.
- **Destinació:** l'arxiu local (ADR-0014), a
  `Thunderbird/<cuenta>/<carpetas>`. Se segueix la mateixa regla de desduplicació
  per Message-ID, de manera que importar dues vegades no afegeix res.
- **Previsualització obligatòria:** abans de desar res es diu, per carpeta,
  quants missatges són nous, quants ja hi són i quants estaven suprimits.
  Canviar la selecció demana una altra previsualització.
- **Seguretat:**
  - només es llegeixen les carpetes que l'escaneig ha trobat, pel seu
    identificador;
  - no es modifica res del perfil de Thunderbird;
  - un fitxer de més d'1 GB es rebutja amb la indicació de compactar-lo
    o dividir-lo, com a ADR-0014.

## Fora d'aquesta decisió

- **PST d'Outlook:** no hi ha cap lector en Rust madur i mantingut. Continua
  pendent, a l'espera de triar-ne un (o de convertir-lo fora
  d'Oreneta).
- **Llibretes d'adreces i calendaris de Thunderbird:** es poden
  exportar des de Thunderbird com a vCard o `.ics` i importar-los amb les
  funcions que ja existeixen.
