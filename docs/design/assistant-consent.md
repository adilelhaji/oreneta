# Assistent: context i consentiment (#51, #52)

Registre de la implementació de l'ADR-0032.

## Defectes trobats i corregits

- **Format incompatible:** la sol·licitud feia servir un format propi contra
  `/v1/chat/completions`, de manera que no funcionava amb Ollama ni amb cap
  proveïdor real. Ara fa servir chat completions i llegeix
  `choices[0].message.content`.
- **Errors al registre:** el cos d'un error del proveïdor, que pot citar el
  correu, acabava al registre de l'aplicació.
- **Cancel·lar:** només es comprovava abans i després de la sol·licitud; amb un
  proveïdor lent calia esperar fins a 60 s.
- **Revisió incompleta:** el que es mostrava no incloïa la sol·licitud real
  (adjunts, instruccions). Ara es mostra el cos exacte, lligat al testimoni
  (token).
- **Sense activació:** el botó apareixia sempre. Ara està desactivat per
  defecte.

## Proves

- **Nucli:**
  - només surten els camps revisats (llista exacta de claus);
  - una injecció no tanca el bloc delimitat;
  - es permeten instruccions de reescriptura;
  - un proveïdor fals en aquest equip rep exactament el cos revisat i la clau;
  - un error 500 s'informa sense el seu cos;
  - cancel·lar respon en menys de 2 s amb el proveïdor tardant 5 s.
- **Aplicació:**
  - desactivat per defecte;
  - JSON en un bloc de codi, i les «accions» de la resposta s'ignoren;
  - el diàleg de revisió d'una conversa comença amb només el missatge més
    recent marcat (la data més alta; amb dates iguals o desconegudes, l'últim
    de la llista) i cap detall d'adjunt; la resta l'afegeix la persona, i la
    previsualització canvia amb cada casella (#196,
    `AssistantReviewDialog.test.tsx`);
  - un esborrany no compta com el més recent, tret que la conversa només
    tingui esborranys: aleshores comença marcat l'esborrany més recent, perquè
    el diàleg només mostra la llista de missatges quan hi ha una
    previsualització i, sense res marcat, no se'n podria afegir cap; l'avís de
    privadesa ho diu; un enviament pendent (enviant, enviat o fallit) sí que
    compta, perquè és un missatge de la persona i no un esborrany;
  - la selecció torna a aquest valor només quan arriba un missatge més recent:
    una sincronització, un canvi de marca o pàgines antigues conserven el que
    hi ha marcat, i la mateixa sol·licitud no es torna a previsualitzar ni
    s'esborra el resultat mostrat;
  - el diàleg de reescriptura mostra la destinació i el cos exacte, exigeix
    tornar a confirmar si la sol·licitud canvia, no canvia res fins a «Fes-lo
    servir» i, en aturar-lo, cancel·la i descarta la resposta tardana.
- **e2e:** sense activar, no s'ofereix; activat, apareix al redactor.

## Text proposat per a `docs/privacy.html` (decideix el propietari)

> **Optional assistant.** Off unless you turn it on. When you ask it to
> summarise, draft or rewrite, Oreneta shows the exact text it would send
> and where, and sends it only after you confirm: to a model on your own
> computer, or to the HTTPS provider you configured. Nothing is kept.
>
> **Translation models.** Downloaded from Mozilla's model storage only when
> you ask for a language; translating happens on your computer.
