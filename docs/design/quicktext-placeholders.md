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
