# Text desat: cerca, marcadors i cursor (#88)

## Què canvia

- **Cerca:** el menú de text desat té un cercador que exigeix totes
  les paraules, al nom, a l'assumpte o al text.
- **Marcadors en inserir:** s'emplenen amb el missatge que s'escriu:
  - `{{to.firstName}}`, `{{to.name}}` i `{{to.email}}` (el primer
    destinatari; «Cognom, Nom» es llegeix bé);
  - `{{me.name}}`, `{{me.firstName}}` i `{{me.email}}` (l'àlies triat, o
    el compte);
  - `{{subject}}` i `{{date}}`.
- **No s'emplena res a cegues:** un marcador encara sense dada (no hi ha
  destinatari) o desconegut queda escrit tal qual i se n'avisa.
- **Format:** en HTML, el que s'hi insereix s'escapa.
- **Cursor:** `{{cursor}}` marca on continua l'escriptura, a l'editor de text
  enriquit i al de text pla. Les marques sobrants s'eliminen.
- **Sense pèrdues silencioses:** desar ja no descarta en silenci les
  plantilles incompletes, sinó que anomena les que no s'han desat.

## Signatures

- Ja eren per compte, amb la signatura global com a alternativa. Canviar de
  compte a De canvia la signatura inserida sense sobreescriure el que s'ha escrit
  (proves existents a `Composer.test.tsx`).
- **On va la signatura a les respostes i els reenviaments (#277, 2026-10-17):**
  - per a cada compte, a la targeta «Signatura» de la seva configuració, es
    tria a «A les respostes i els reenviaments»: «Amb el que escric» (per
    defecte), «Damunt de la citació» o «Sota la citació»; si la signatura és
    «Cap», l'opció no es mostra;
  - «Amb el que escric» és el comportament d'ADR-0047, que no canvia: la
    signatura va amb el text propi, és a dir, damunt de la citació en un
    reenviament o en una resposta escrita a sobre, i sota el text en una
    resposta escrita a sota;
  - «Damunt de la citació» la posa just abans de l'original citat (en una
    resposta escrita a sota, queda a dalt de tot i el text, sota la
    citació); «Sota la citació» la posa al final, després de l'original;
  - s'aplica a la resposta oberta a l'editor complet, que conserva tots els
    destinataris (respondre i respondre a tots són el mateix camí), i al
    reenviament en línia. Un reenviament com a adjunt no té citació al cos;
    la resposta ràpida no cita;
  - és una preferència local, la fila `signature_placement` de `settings`
    (id del compte → `above` o `below`; sense entrada, «Amb el que escric»);
    l'entrada del compte s'esborra quan es treu el compte. No se sincronitza
    amb el servidor ni amb l'aplicació mòbil; com la resta de files de
    `settings`, va a la còpia de seguretat i es restaura amb ella;
  - una tria desada continua valent si després el compte passa a «Cap»
    signatura (l'opció s'amaga però no s'esborra): decideix on aniria la
    signatura si l'esborrany canvia a un compte que en té;
  - si la persona ha editat la signatura a la resposta ràpida, la resposta
    s'obre amb aquell text com a seu i sense cap signatura nova, de manera que
    l'opció no hi intervé;
  - l'esborrany es queda amb la posició amb què es va obrir: si després es
    canvia de compte a De, la signatura nova substitueix l'anterior al mateix
    lloc;
  - proves: `replyForwardCompose.test.ts` (respondre, respondre a tots i
    reenviar, amb les dues posicions, en text pla, i en HTML per a la
    resposta i el reenviament; el canvi de compte, els missatges nous i les
    respostes sense l'original) i
    `SignatureSettingsCard.test.tsx` (l'opció per compte).
- **Pendent:**
  - signatura per àlies;
  - sincronitzar les signatures amb Gmail i Exchange: necessita proves amb un
    proveïdor real i ha de dependre del que admeti cadascun;
  - plantilles a la resposta ràpida.

## Proves

| Nivell | Què cobreix |
|---|---|
| N1 `placeholders.test.ts` | Emplenament a partir de l'esborrany, primer destinatari, «Cognom, Nom»; el que falta i el desconegut es queden i s'informa; escapament en HTML; cursor |
| N2 `TemplateMenu.test.tsx` | Cerca per totes les paraules, sense coincidències |
| N2 `Composer.test.tsx` | Fragment inserit amb els marcadors emplenats, cursor retirat i avís del que no s'ha pogut emplenar |
| N1 `replyForwardCompose.test.ts` | On va la signatura (#277) a la resposta, la resposta a tots i el reenviament; el canvi de compte; la lectura i el sanejament de `signature_placement` |
| N2 `SignatureSettingsCard.test.tsx` | L'opció per compte, amagada amb «Cap» signatura |
