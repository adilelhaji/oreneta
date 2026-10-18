# ADR-0032: Context, proveïdor i consentiment de l'assistent

- Estat: acceptada; presa per delegació i revisada pel propietari
  el 2026-10-12. Sense servei nou de pagament:
  el proveïdor el tria i el configura la persona.
- Data: 2026-10-12.
- Abast: #51 i la part estable de #52.

## Decisió

- **Activació:**
  - l'assistent està desactivat per defecte (`assistant_enabled`);
  - desactivat, no apareix a les converses ni al composer;
  - activat, cada petició continua necessitant revisió i confirmació, que
    el nucli exigeix: sense la casella marcada i un testimoni (token) igual al de la
    previsualització, no s'envia res.
- **Proveïdor:**
  - format de chat completions (OpenAI), el que entenen Ollama,
    llama.cpp i LM Studio en local i els proveïdors remots;
  - en mode local, només una adreça d'aquest equip (loopback);
  - en mode remot, només HTTPS;
  - la clau es demana a cada petició i no es desa.
- **Context:**
  - en una conversa, només els missatges i fitxers adjunts que la persona marca:
    id del missatge, compte, remitent, assumpte, text i nom, tipus i
    mida dels adjunts;
  - no s'envien destinataris, dates ni altres comptes o converses;
  - en reescriure, només el text de l'esborrany.
  - Una prova falla si apareix un camp nou en el que s'envia.
- **El que es revisa és el que surt:**
  - la previsualització del nucli retorna el cos exacte de la petició;
  - el testimoni és el seu resum (hash) juntament amb el proveïdor, i en executar es refà i es
    compara;
  - el quadre de diàleg mostra la destinació i el cos exacte.
- **El correu són dades, no ordres:**
  - va dins de `<mail>…</mail>` com a JSON, de manera que no pot tancar la
    tanca;
  - les instruccions del sistema diuen que no s'obeeix res de dins i
    que no es pot actuar sobre la bústia;
  - de la resposta només es llegeixen `text`, `sources` i `tasks`, i les fonts i
    tasques fora del context revisat es descarten;
  - res de la resposta no envia, suprimeix, mou o canvia regles: un esborrany s'obre
    per a editar-lo, una tasca es crea en prémer i una reescriptura es fa servir
    en prémer, amb desfer.
- **Cancel·lar:** respon a l'instant, encara que la petició estigui en curs, i
  la resposta tardana es descarta.
- **Registre:**
  - no es desa res;
  - un error del proveïdor s'informa només amb el seu estat, perquè el seu cos
    pot citar el correu i els errors es registren.
- **Escriptura (#52):**
  - a més de resum, resposta i tasques suggerides, es pot reescriure
    l'esborrany: corregir, més formal, més amable, més curt o més llarg;
  - la instrucció és una d'aquestes, mai text lliure.

## Alternatives

- Format propi (el que hi havia): no l'entenia cap servidor real.
- Activació per compte: més fina, però la confirmació per petició ja és
  explícita; es pot afegir si el propietari ho demana.

## Pendent (per al propietari)

- La política de privadesa pública (`docs/privacy.html`) ha de dir que,
  si s'activa l'assistent en mode remot, el text revisat s'envia al
  proveïdor triat, i que les baixades de models de traducció només
  es fan a petició. Afecta la secció de Google (Limited Use): un
  enviament a un tercer triat per la persona necessita revisió abans de la
  verificació de Google. Text proposat al registre de disseny.
- Separar a #117 l'extracció d'esdeveniments i les funcions d'agent de la
  versió 11.
