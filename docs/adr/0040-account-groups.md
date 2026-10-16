# ADR-0040: Grups de comptes

- Estat: acceptada; presa per delegació i revisada pel propietari
  el 2026-10-12.
- Data: 2026-10-12.
- Abast: #99 (la part de grups de comptes; els perfils són l'ADR-0016).

## Decisió

- **Què és un grup:** un nom i els comptes que la persona tria. És una
  vista: no mou, copia ni desa correu, i un compte pot ser en
  diversos grups.
- **Com es veu:** a través de la safata unificada, limitada als comptes
  del grup. Els grups apareixen sota «Safata unificada» a la
  navegació de comptes i al menú contextual del botó unificat de la
  barra lateral.
- **Inclusió explícita:**
  - un grup mostra exactament els comptes que anomena, encara que algun estigui
    exclòs de la safata unificada general;
  - la safata unificada sense grup continua mostrant els comptes inclosos,
    com abans.
- **Vistes separades:** cada grup és una vista diferent de la llista, de manera
  que una llista carregada per a un grup no es mostra per a un altre.
- **En sortir de la vista unificada** se surt també del grup.
- **Desament:** a les preferències del perfil (`account_groups`). Viatja amb
  la còpia completa del perfil i no se sincronitza amb cap servidor.
- **Coherència:**
  - treure un compte el treu de tots els grups;
  - suprimir un grup no toca els seus comptes;
  - les dades malmeses es llegeixen com a «sense grups», sense trencar la vista.

## Alternatives descartades

- **Carpetes globals per grup al nucli:** la vista unificada ja es
  compon a l'aplicació compte per compte, de manera que n'hi ha prou de limitar quins
  comptes hi entren.
- **Un compte en un sol grup:** obliga a triar entre, per exemple,
  «Feina» i «Tot el de l'Ana». Una vista no necessita aquesta exclusió.
