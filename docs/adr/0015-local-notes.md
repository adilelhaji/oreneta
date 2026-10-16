# ADR-0015: Notes locals

- Estat: acceptada; presa per delegació i revisada pel propietari
  el 2026-10-12.
- Data: 2026-10-11.
- Abast: primer lliurament de #104.

## Context

#104 demana notes independents amb text enriquit, imatges, adjunts,
etiquetes i cerca, i després sincronització amb Exchange, Office 365,
IceWarp o CalDAV. Exigeix decidir abans la identitat i l'emmagatzematge.

## Alternatives

1. **Notes locals sense compte (escollida).** Es desen a la base xifrada de
   l'equip amb un identificador propi (`note:<uuid>`). Cap compte no en
   té la propietat, de manera que treure un compte no les afecta (ADR-0011).
2. **Notes dins d'un compte des del principi.** Obliga a escollir ja el
   model de cada proveïdor i deixa sense notes qui només té IMAP.
3. **Notes com a esborranys o missatges IMAP en una carpeta «Notes»**, com
   fa Apple Mail. Funciona en qualsevol servidor, però barreja notes amb
   correu, depèn de la xarxa per a desar i exposa les notes a qui llegeixi la
   bústia.

## Decisió

- El cos és HTML netejat en desar: es conserva el format de l'editor;
  es treu tot el que s'executa o crida la xarxa (scripts, gestors d'esdeveniments,
  `javascript:`, imatges remotes, `data:` fora de `<img>`). Les imatges
  van dins de la nota com a `data:image/…`. Al costat del cos se'n desa el
  text pla per a cercar.
- Límits: 8 MB per nota amb imatges, 5 MB per imatge afegida, 20
  etiquetes de fins a 40 caràcters. El que els supera es rebutja; no es
  retalla.
- Cada escriptura anomena la revisió de la qual parteix. Si la nota ha canviat en
  una altra finestra, no s'escriu res i es mostren les dues versions (política
  de l'ADR-0012). Si s'ha suprimit del tot, s'ofereix desar-la com a nota nova.
- Suprimir mou a la paperera; des d'allà es restaura o se suprimeix del tot. La
  paperera oblida les notes al cap de 30 dies.
- Sense fitxers adjunts ni sincronització en aquest lliurament. La interfície
  diu «Només en aquest equip».

## Conseqüències

- Els proveïdors s'afegeixen després com a fonts amb la seva pròpia identitat
  remota, igual que els contactes (ADR-0012): una nota local no es puja sola.
  Exchange necessita enregistraments reals abans d'implementar-se.
- Els fitxers adjunts necessiten emmagatzematge fora de la fila (la còpia
  de seguretat de l'ADR-0010 els haurà d'incloure); es decideixen amb la
  sincronització.
