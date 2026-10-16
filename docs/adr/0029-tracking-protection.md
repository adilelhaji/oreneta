# ADR-0029: Protecció contra rastrejadors amb EasyPrivacy

- Estat: acceptada; presa per delegació i revisada pel propietari
  el 2026-10-12. Dins de l'ADR-0001; sense
  telemetria nova.
- Data: 2026-10-12.
- Abast: #107.

## Decisió

- **Llista:**
  - una còpia fixa d'EasyPrivacy, `easylist/easylist@4b79596e`, va amb
    l'aplicació, amb la seva procedència, el seu resum (hash) i la seva llicència (GPL-3.0+ o
    CC BY-SA 3.0+);
  - només se'n baixa una de nova quan la persona ho demana, i únicament
    des de `easylist.to`;
  - abans de fer-la servir es comprova el títol, la mida i el nombre de
    regles, s'escriu al costat de l'anterior i se li canvia el nom; si alguna cosa falla,
    continua la llista que hi havia;
  - es pot tornar a la inclosa.
- **On actua:**
  - al nucli, en preparar l'HTML per a llegir-lo, dins del sanejament
    (ammonia), que ja lliura els valors descodificats; així una adreça
    escrita amb entitats es reconeix com qualsevol altra;
  - es comproven `src`, `background`, `poster`, `srcset` i `style`, i
    `url()` i `@import` als blocs `<style>`, també amb escapaments CSS;
  - una imatge bloquejada no carrega res; un fons o un full bloquejats es
    treuen;
  - els enllaços no es toquen: seguir-ne un és decisió de qui llegeix.
- **Quines regles:**
  - només les de xarxa que es poden aplicar a un correu;
  - s'ometen les cosmètiques, les expressions regulars, les que reescriuen
    peticions i les limitades a un lloc web, que no existeix en un correu;
  - ometre només pot deixar de bloquejar alguna cosa, mai bloquejar més del que
    diu la llista;
  - es respecten les excepcions (`@@`) i `important`.
- **Visible:**
  - el missatge diu quants rastrejadors s'han bloquejat i, si es demana, quins
    i amb quina regla.
- **Excepció per missatge:**
  - «Carregar-los en aquest missatge» pregunta abans i es desa per compte i
    Message-ID;
  - no canvia la política d'imatges remotes del compte, que el CSP continua
    imposant;
  - un missatge sense Message-ID no pot tenir excepció.
- **Confirmacions de lectura:** l'aplicació no n'envia cap.
- **Sense xarxa a les proves:** les proves mai no contacten amb cap rastrejador
  ni amb easylist.to.

## Pendent

- Treure els paràmetres de seguiment dels enllaços (`removeparam`), amb
  avís.
- Mesurar i, si cal, accelerar la comprovació de missatges amb centenars
  d'imatges (uns 0,4 ms per adreça en compilació optimitzada).
