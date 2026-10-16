# Reunions en línia (#109)

Registre de la implementació de l'ADR-0034.

## Peces

- **Nucli:**
  - `calendar/meeting.rs`: reconeixement, qui pot crear-ne i la clau de
    petició;
  - `google.rs`: lectura de `conferenceData`, creació en crear o editar,
    eliminació amb `null` i estat llest, en preparació o fallit;
  - `route.rs` i `main.rs` rebutgen la creació fora de Google.
- **Aplicació:**
  - casella a l'editor només on se'n pot crear;
  - indicació d'enganxar l'enllaç en els altres casos;
  - «Treu-la» per a un Meet;
  - «Uneix-te a …» a l'esdeveniment;
  - avís si Google no ha creat la reunió.

## Proves

- **Nucli:**
  - enllaços reconeguts i rebutjats, inclosos dominis falsos;
  - només Meet a Google;
  - la mateixa clau per al mateix esdeveniment;
  - creació amb la petició i la versió correctes;
  - sense petició, res sobre reunions;
  - la fallada i la preparació s'informen;
  - editar no la toca, demanar-la dues vegades no la duplica, treure-la envia
    `null` i qualsevol altre tipus es rebutja;
  - un complement a Google s'anomena per la seva adreça;
  - la reunió es desa i es reconeix l'enllaç de les notes.
- **Aplicació:**
  - casella i enviament de `meet`;
  - sense casella en un calendari local;
  - «Treu-la» envia `none`;
  - «Uneix-te a Zoom» obre l'adreça.
- **Trobat en provar-ho:** el camp anava dins d'un `<label>` i el botó
  prenia el nom del camp. Ara és un grup amb el seu propi nom.
