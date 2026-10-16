# ADR-0023: Categories de safata transparents

- Estat: acceptada; presa per delegació i revisada pel propietari
  el 2026-10-12. Cobreix la porta d'arquitectura
  de #91 (classificador i model de dades nous).
- Data: 2026-10-11.
- Abast: primer lliurament de #91.

## Context

#91 demana pestanyes de categories configurables, amb correcció manual i
assignació per regles, i amb el motiu visible. Tot el correu ha de continuar
accessible i el que no estigui classificat no pot desaparèixer. Les assignacions han de
sobreviure a la sincronització i al reinici, sense confondre's amb les
etiquetes remotes (ADR-0002) ni amb l'agrupació de prioritat.

## Decisió

- **Sense model estadístic:**
  - les categories les defineix la persona: nom, color i, si vol,
    condicions;
  - les condicions fan servir els mateixos camps i comparacions que les regles
    (remitent, destinataris, assumpte);
  - una categoria sense condicions només s'omple a mà.
- **Ordre de decisió, amb el seu motiu:**
  1. la persona ha posat aquesta conversa aquí;
  2. la persona ha posat aquí el correu d'aquest remitent;
  3. la primera categoria, en l'ordre de la persona, les condicions de la qual es
     compleixen (es desa quines condicions s'han complert);
  4. si no hi coincideix res, la conversa queda a **Altres**.
- **Sempre visible:**
  - les pestanyes són **Tot**, cada categoria i **Altres**;
  - Tot i Altres no es poden treure;
  - cada pestanya mostra el seu recompte, i una línia diu que els recomptes són
    del correu desat en aquest equip.
- **Per conversa:**
  - a cada carpeta, el missatge més recent de la conversa decideix, i
    tots els seus missatges d'allà prenen el mateix veredicte;
  - així, la llista i els recomptes coincideixen.
- **Persistència:**
  - `messages.category` desa el veredicte: NULL mentre no s'ha jutjat,
    buit per a Altres;
  - les correccions viuen a `category_threads` (clau de conversa) i
    `category_senders` (adreça), separades dels missatges;
  - un missatge que es torna a baixar es jutja una altra vegada i torna al mateix
    lloc;
  - les definicions són a `inbox_categories` i són de la persona, no d'un
    compte;
  - en suprimir un compte se suprimeixen les seves correccions (ADR-0011).
- **Separació:**
  - el filtre té la seva pròpia faceta, `category:<id>` (`category:none` és
    Altres);
  - mai no se sincronitza amb un servidor;
  - no es barreja amb `thread_labels` ni amb `priority`.
- **On:**
  - les pestanyes apareixen a la safata d'entrada de cada compte i a la
    unificada;
  - fora d'aquestes, o mentre es cerca, la faceta es treu perquè res no
    filtri sense estar a la vista.
- **Límits:** fins a 12 categories i 20 condicions cadascuna. Una condició
  buida o un nom repetit es rebutgen abans de desar.

## Pendent

- Fer servir capçaleres com `List-Id` o `List-Unsubscribe` a les condicions: avui
  no es desen.
- Categories com a pas d'Accions ràpides (ADR-0022).
- El recompte del que el servidor té i encara no s'ha baixat.
