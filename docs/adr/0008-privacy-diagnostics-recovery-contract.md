# ADR-0008: Diagnòstic local, còpia de seguretat de la configuració i actualitzacions per etapes

- Estat: acceptada
- Data: 2026-09-10
- Abast: incidència #54 / capacitats C22 i C29
- Aprovació: l'usuari va triar les opcions 1-A, 2-A i 3-A el 2026-09-10
- Esmena: el 2026-10-05, l'[ADR-0010](0010-full-profile-local-recovery.md)
  substitueix només el límit de només configuració de la decisió 2. L'exportació
  de configuració existent continua disponible; les decisions 1 i 3 no canvien.

## Decisió

1. **El diagnòstic és només local.** Oreneta manté registres locals limitats al
   fitxer canònic `oreneta.log`, emmascara
   les adreces de correu electrònic i els valors semblants a credencials abans de mostrar-los o exportar-los, i mai no
   envia telemetria per defecte. L'exportació és explícita i l'usuari la pot revisar.
2. **Límit original de només configuració (ampliat per l'ADR-0010).** El format de còpia de seguretat existent inclou
   comptes, paràmetres i canals, omet el correu de la memòria cau i només inclou secrets
   quan l'usuari proporciona una frase de pas. La importació ha d'informar de les fallades en lloc
   d'afirmar en silenci que s'ha recuperat tot.
3. **Les actualitzacions continuen sent per etapes i confirmades per l'usuari.** Es mantenen el manifest de versions
   existent, el límit de mida de la càrrega, la verificació SHA-256 i la instal·lació per etapes.
   La instal·lació automàtica, la telemetria remota i un servei d'actualitzacions nou queden
   fora d'abast.

## Conseqüències

- L'abast de privadesa continua sent local i auditable, sense cap servei ni dependència nous.
- Una restauració de la configuració és més petita i més segura, però no restaura el correu
  de la memòria cau ni les sessions del proveïdor.
- La verificació del resum (hash) protegeix la integritat; la política d'autenticitat/signatura i
  l'evidència de reversió nativa continuen sent treball de seguiment separat.

## Límit de la validació

Les proves sintètiques poden demostrar l'emmascarament, la gestió dels secrets de la còpia de seguretat i el comportament
del resum o de les etapes de les actualitzacions. No poden certificar la interoperabilitat amb els proveïdors, la recuperació
nativa a Windows ni el lliurament d'actualitzacions en producció.
