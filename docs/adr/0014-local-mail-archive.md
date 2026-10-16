# ADR-0014: Arxiu local de correu i importació EML/MBOX

- Estat: acceptada; presa per delegació i revisada pel propietari
  el 2026-10-12.
- Data: 2026-10-11.
- Abast: primer lliurament de #112 (importació i arxius de dades locals).
- Aprovació: el responsable va delegar el 2026-10-11 les decisions pendents
  en l'opció més prudent, que revisarà al final (pla de finalització,
  «Mode d'execució acordat»).

## Decisió

- Un **arxiu local** és un compte més (`local-archive`, `auth_type`
  `local_archive`) el «servidor» del qual és la base de dades del perfil. No té
  contrasenya, no sincronitza, no envia ni respon automàticament, i mai no
  fa servir la xarxa.
- Per a la resta del nucli és una variant més de la sessió de correu
  (`backend::Session::Local`), al costat d'IMAP, EWS i Graph. Així, llistes,
  fils, cerca, marques, moure, copiar i suprimir funcionen amb el mateix
  codi que en els altres comptes.
- **Emmagatzematge.** Cada missatge es desa dues vegades a la base de dades
  xifrada del perfil:
  - analitzat, a les mateixes taules que el correu sincronitzat (capçaleres,
    cos, adjunts);
  - en els seus bytes originals (`archive_messages`), per a rellegir-lo, exportar-lo
    o copiar-lo a un servidor tal com va arribar.

  Entra a la còpia completa del perfil (ADR-0010).
- **Importació** de `.eml` (un missatge) i `.mbox` (diversos, amb `>From`
  desfet), en dos passos: previsualització i confirmació.
  - Els fitxers es llegeixen al nucli a partir dels seus camins i mai no es
    modifiquen.
  - Es rebutgen els fitxers de més d'1 GB i els missatges de més de 100 MB.
  - S'omet el que no és correu, i el que ja és a la carpeta (mateix
    Message-ID) no s'afegeix dues vegades.
  - El que s'importa queda com a llegit.
- **Suprimir** mou el missatge a la paperera de l'arxiu; suprimir a la
  paperera l'elimina.
- **Copiar o moure entre l'arxiu i un compte** fa servir el flux de còpia
  existent: els bytes originals van i venen.

## Alternatives descartades

- **Carpetes al disc (Maildir).** Haurien quedat fora del xifratge de la
  base de dades i de la còpia completa, i requerien un segon model de
  lectura.
- **Importar dins d'un compte IMAP.** Hauria pujat correu antic a un
  servidor sense que s'hagués demanat.
- **PST (Outlook).** És un format propietari que no té cap biblioteca
  madura en Rust. Queda com a fila pendent de #112, sense comptar per a la
  paritat.

## Pendent (#112)

- Exportar a EML o MBOX.
- Importació per parts de fitxers de més d'1 GB, i represa.
- Paràmetres i perfils de Thunderbird i Postbox.
- PST.
