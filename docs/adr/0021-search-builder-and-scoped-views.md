# ADR-0021: Constructor de cerques i cerques desades amb àmbit

- Estat: acceptada; presa per delegació i revisada pel propietari
  el 2026-10-12.
- Data: 2026-10-11.
- Abast: primer lliurament de #43.

## Context

El quadre de cerca ja entén operadors (`from:`, `to:`, `subject:`,
`is:`, `has:attachment`, `label:`, `after:`, `before:`). El nucli els llegeix
una sola vegada per a l'índex local, la cerca IMAP i la interfície. Les
cerques desades només desaven el text i s'aplicaven a la carpeta que
estigués oberta. #43 demana un constructor visual que conservi el
significat de cada operador, i vistes desades amb el seu origen.

## Decisió

- **Constructor:** edita els camps de la consulta tal com els llegeix el
  nucli (`search.parse`) i la torna a escriure amb el nucli
  (`search.compose`, l'invers de `parse`). Una prova d'anada i tornada amb
  un corpus fixa que `parse(compose(q)) == q`, de manera que un constructor i
  el quadre no poden entendre coses diferents. Diversos valors en un camp
  signifiquen «qualsevol d'ells», com al quadre.
- **Àmbit de les cerques desades:**
  - una cerca desada recorda el compte i la carpeta on es va desar,
    i obrir-la hi torna;
  - les desades abans continuen funcionant allà on s'obrin.
- **Vista viva:** una cerca desada és una consulta, no una còpia. La
  llista s'actualitza amb la sincronització i mai no mou missatges.

## Pendent

- Combinar etiquetes amb «totes» i «qualsevol»: la gramàtica només n'admet
  una per cerca, i #13 fixa el contracte del filtre ràpid.
- Dir quina part del servidor s'ha consultat davant del que hi ha a
  l'equip.
