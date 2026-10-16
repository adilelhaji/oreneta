# ADR-0007: Resultats de l'assistent revisables i cancel·lació cooperativa

- Estat: acceptada
- Data: 2026-09-10
- Abast: incidència #52 / capacitat C24
- Aprovació: l'usuari va aprovar els fragments de resum/esborrany/tasca i la cancel·lació per identificador d'execució el 2026-09-10

## Decisió

La incidència #52 consumeix el límit del proveïdor de l'ADR-0006 en tres fragments acotats:

1. Els resultats de **resum** són text més referències opcionals a les fonts. Les fonts porten
   la identitat del compte i del missatge del context revisat; les fonts desconegudes
   es mostren com a text sense enllaç en lloc d'enllaços endevinats.
2. Els resultats d'**esborrany** són text que es col·loca en un esborrany nou i editable
   del redactor només després d'una acció explícita de l'usuari. Els destinataris i el fil
   es deriven del missatge seleccionat; l'enviament mai no forma part de l'operació
   de l'assistent.
3. Els resultats de **tasca** són suggeriments que es mostren a l'usuari. Desar un suggeriment
   crida el contracte existent de tasques locals vinculades només després de la confirmació. La
   regla existent d'una sola tasca oberta per fil no canvia; els suggeriments seleccionats
   duplicats per a un mateix fil es fusionen en una sola nota.

Els proveïdors retornen un sobre de resultat JSON quan és possible:

```json
{
  "text": "…",
  "sources": [{"account_id":"…","message_id":"…"}],
  "tasks": [{"account_id":"…","message_id":"…","title":"…","note":"…","due_at":null}]
}
```

La sortida del proveïdor que no és JSON es conserva com a text pla sense fonts ni
tasques deduïdes. La capa de l'assistent mai no desa el sobre.

Cada execució té un `execution_id` generat pel consumidor. Una petició de cancel·lació
marca aquella execució com a cancel·lada; el transport queda limitat pel seu temps
d'espera existent, i el resultat es rebutja tant abans de l'enviament com després que
el proveïdor respongui. Els resultats tardans no poden actualitzar la interfície. Això
és cancel·lació cooperativa al límit de l'assistent; els transports de proveïdor
interrompibles continuen sent treball futur.

## Conseqüències

- La procedència dels resums és explícita i limitada a l'abast del compte.
- La creació d'esborranys és una edició reversible de l'usuari, no una acció de correu externa.
- L'extracció de tasques no pot crear ni multiplicar tasques en silenci.
- Aquest ADR no selecciona adaptadors de resposta específics de cap proveïdor.

## Fora d'abast

- Cap enviament, supressió, trasllat, arxivament, canvi de regles ni creació de tasques automàtics.
- Cap indicació (prompt), resposta, credencial ni indexació de tota la bústia desades.
- Cap canvi a l'esquema de tasques existent ni a l'invariant d'una sola tasca oberta per fil.
