# Columnes per carpeta — proposta per a #36

Estat: **aprovada per l'usuari el 2026-10-05**, abans de la implementació, amb el
text literal «Aprobar vista general y excepciones por carpeta». Vegeu l'ADR 0009.

## Comportament proposat

1. «Columnes» permet mostrar, ordenar i ajustar amplades mitjançant controls de
   teclat i de ratolí. L'assumpte continua visible; les caselles de selecció queden
   fora d'aquesta configuració. Restablir no canvia mai els missatges ni la selecció.
2. Una visualització general s'hereta a totes les carpetes. «Només aquesta carpeta»
   desa una còpia independent; «Fes servir la visualització general» elimina
   aquesta excepció. Canviar la visualització general no sobreescriu les carpetes
   personalitzades.
3. El primer lliurament admet remitent, assumpte, data i compte. Només les tres
   primeres ordenen: fan servir els ordres complets existents del nucli
   (ADR 0003), sense ordenar únicament la pàgina carregada. La columna Compte és informativa.
   Destinataris, mida i altres columnes esperen una semàntica fiable de
   conversa; no s'inventen valors ni capacitats.
4. Es manté el tauler actual. Quan les amplades triades no hi caben, la taula
   té un desplaçament horitzontal propi, amb controls accessibles; no eixampla
   tota l'aplicació. Restablir recupera la distribució compacta inicial.

## Contracte d'emmagatzematge proposat

Una preferència nova `mailbox_views` a través d'`app.prefsGet/Set` i la taula
de configuració existents; sense cap base de dades, servei ni sincronització
remota nous. Objecte amb versió:

```json
{
  "version": 1,
  "defaultColumns": [
    { "id": "sender", "visible": true, "width": 120 },
    { "id": "subject", "visible": true, "width": "auto" },
    { "id": "date", "visible": true, "width": 80 },
    { "id": "account", "visible": false, "width": 120 }
  ],
  "folders": [
    { "accountId": "existing-account-id", "folderId": "existing-folder-id", "columns": [] }
  ]
}
```

L'exemple de carpeta mostra la forma; una llista buida no és vàlida i s'ignora.
L'ordre de l'array és l'ordre visual. L'assumpte admet `auto`; les amplades
numèriques es limiten a 64–640 píxels CSS. Els identificadors són estables, no
traduccions. Una carpeta s'identifica pel parell exacte compte/carpeta; la safata
d'entrada unificada fa servir els seus rols actuals. Carpetes diferents no
comparteixen mai una excepció per accident.

Si la preferència no existeix, es conserva la visualització actual. Es validen les
versions, els camps, les columnes duplicades o desconegudes i els límits abans de
fer-los servir. Una versió futura no se sobreescriu automàticament: la
configuració es desactiva amb una explicació fins que l'usuari la restableixi
expressament o actualitzi l'aplicació. No es reescriuen preferències durant la
hidratació. L'ordre del correu existent continua separat de la disposició visual;
aquest primer lliurament no introdueix cap ordre per carpeta.

## Lliuraments i proves proposats

1. Validació, persistència i herència amb proves de versions no vàlides, claus amb
   caràcters especials, carpetes homònimes, reinici i absència d'escriptures
   durant la hidratació.
2. Configuració accessible, taula real i restabliment; proves en clar i en fosc,
   tauler estret, zoom, teclat, selecció i paginació existents.

L'aprovació d'aquesta proposta permet implementar aquests dos lliuraments dins de
l'arquitectura actual; no autoritza cap publicació, canvis de proveïdors ni noves
capacitats d'ordenació. #36 continuarà oberta fins que n'aporti totes les proves.
