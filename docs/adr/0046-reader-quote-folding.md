# ADR-0046: Plegar el text citat i ajustar els missatges amples al lector

- Estat: acceptada per delegació («Tomo yo la recomendada»); pendent de
  revisió del propietari al final del pla.
- Data: 2026-10-13.
- Abast: fila S01-07 del registre d'acceptació
  (`docs/emclient-parity-acceptance.json`), #35. eM Client 10.4 plega al
  lector el text citat de les respostes i pot ajustar a l'amplada de
  la finestra un missatge maquetat més ample que ella. Oreneta ja contenia
  l'HTML d'amplada fixa (amb una barra horitzontal pròpia) i tenia la
  mida del text del missatge (80–400 %); faltaven les dues coses.

## Decisió

- **Què es plega (text citat), activat per defecte:**
  - Gmail: el `div.gmail_quote` (o `gmail_quote_container`) més extern
    que contingui un `blockquote`, amb la seva línia «On … wrote:»;
  - Outlook al web / Outlook nou: des de `#appendonsend` i l'`<hr>`
    que precedeix `#divRplyFwdMsg` fins al final del seu contenidor;
  - Outlook d'escriptori: el bloc amb vora superior la primera línia del qual
    és «From:» i que diu quan es va enviar («Sent:»/«Date:»/«Enviado:»…), o
    una línia «-----Original Message-----», fins al final del seu
    contenidor;
  - Apple Mail i Thunderbird: `blockquote type="cite"`, amb la línia
    d'atribució (`.moz-cite-prefix` o «… wrote:») que el precedeix;
  - un `blockquote` sense `type=cite` només si una línia d'atribució el
    precedeix;
  - text pla: el bloc final de línies que comencen per «>», amb la seva
    atribució (també partida en dues línies); una sola línia «>» sense
    atribució no és suficient. També el bloc de capçalera d'Outlook
    («______», «From:», «Sent:») i «-----Original Message-----».
  - Les citacions imbricades queden dins d'un sol plec: el més extern.
- **Què no es plega mai:**
  - un reenviament: «Forwarded message», «Begin forwarded message», «Mensaje
    reenviado»… o un assumpte «FW:/Fwd:/RV:/TR:/WG:/ENC:» a la capçalera; el
    que s'ha reenviat és el contingut;
  - una citació que no és al final (resposta intercalada): si després hi ha
    alguna cosa per llegir, a més d'una signatura, es deixa oberta, perquè
    ocultar-la amagaria a què es respon;
  - el que només sembla una citació (un `blockquote` amb una taula, una cita
    literària) sense marca de client ni atribució;
  - un missatge que es quedaria buit: si plegar no deixés res visible
    (una resposta que és només la citació, el primer missatge d'un fil que
    només porta la citació), no es plega res; si l'única cosa visible fos la
    signatura, es plega la citació i la signatura queda a la vista.
- **Signatures, desactivat per defecte:** es pleguen només les marcades com
  a tals pel programa del remitent (`.gmail_signature` amb el seu prefix
  «-- », `#Signature`, `.moz-signature`, `div[data-signature]`) i, en
  text pla, el bloc després de «-- » de com a màxim 12 línies abans del
  final o de la citació. eM Client plega les citacions; plegar signatures és
  una opció a part i conservadora.
- **Com es plega:**
  - a l'HTML, el tram s'embolcalla en `<details>`/`<summary>` tancat
    («Mostrar el text citat» / «Amagar el text citat»). Obre i tanca el
    mateix navegador, sense cap script dins del marc: la CSP del marc
    (`script-src 'none'`) no canvia, el marc no envia res a l'aplicació i no
    s'afegeix cap càrrega remota (l'estil va en línia en un `<style>`);
  - en text pla, un botó de l'aplicació amb `aria-expanded`;
  - és només presentació: el cos desat, la citació de la resposta i la
    impressió surten del missatge, no del marc;
  - la cerca al fil obre el plec que conté una coincidència i
    no compta com a coincidència l'etiqueta del botó.
- **Ajustar a l'amplada (desactivat per defecte):**
  - es mesura fins on arriba el contingut que no es pot encongir (taules,
    imatges, blocs; no el que ja es desplaça sol, com un bloc de
    codi) i es redueix amb el mateix `zoom` del cos que fa servir la mida del
    text, multiplicat per ella: `zoom = tamaño de texto × ajuste`, de manera
    que la mida triada continua comptant;
  - només encongeix, mai per sota del 40 % de la mida triada; si canvia
    l'amplada de la subfinestra es torna a mesurar des de la mida natural;
  - s'ajusta abans de la barra horitzontal de rescat: una taula ajustada
    no la necessita;
  - no afecta el text pla, que sempre s'ajusta sol;
  - per missatge des del seu menú («Ajustar a la finestra» / «Veure a la mida
    original»), durant la sessió; sense elecció, mana el paràmetre.
- **Paràmetres (Lectura):** «Plegar el text citat» (`reader_fold_quotes`,
  sí), «Plegar les signatures» (`reader_fold_signatures`, no) i «Ajustar els
  missatges amples a la finestra» (`reader_fit_width`, no), cadascun una fila
  de preferències, com la resta (`DB_KEY`).

## Alternatives descartades

- **Un script dins del marc per a plegar i desplegar:** obligaria a
  relaxar la CSP que bloqueja tot script del correu. `<details>` ho fa
  sense script.
- **Plegar al nucli, en preparar l'HTML:** el mateix HTML el fan servir la
  resposta i la impressió; plegar és qüestió de com es llegeix, i l'etiqueta
  depèn de l'idioma de la interfície.
- **Plegar tota citació, també intercalada o sense marca:** amaga
  respostes escrites entre línies i contingut citat expressament. És millor
  deixar obert el que és dubtós.
- **Ajustar amb `transform: scale`:** no canvia la caixa, de manera que el marc
  autoajustable mesuraria l'alçada sense escalar i deixaria un buit; `zoom`
  sí que la canvia i és el que ja fa servir la mida del text.
- **Ajustar sempre:** un butlletí pensat a 600 px es llegeix millor a la seva
  mida amb la barra horitzontal en una subfinestra estreta que reduït a la meitat;
  per això és una opció, desactivada per defecte.

## Proves

- `quoteFolding.test.ts`: corpus realista — resposta de Gmail (amb
  signatura), reenviament de Gmail, Outlook al web (resposta i reenviament),
  Outlook d'escriptori, Apple Mail (resposta i reenviament), Thunderbird (amb
  citacions imbricades i signatura), resposta intercalada de Thunderbird,
  contingut que només sembla citació (taula en `blockquote`, cita literària),
  missatge que és només citació o només signatura; text pla amb «>», atribució
  partida, citacions imbricades, signatura «-- », capçalera d'Outlook,
  «Original Message», reenviaments, una línia «>» solta i un «--» llarg que
  no és signatura.
- `ReaderFolds.test.tsx`: obrir i tancar el plec del text pla, signatura
  segons el paràmetre, sense plecs amb el paràmetre desactivat, plec obert
  per una cerca, `<details>` tancat sota la CSP del marc sense scripts,
  factor d'ajust (proporció, mínim, mai no creix), elecció per missatge
  davant del paràmetre, l'acció del menú només per a HTML i les tres files de
  Paràmetres.
- `startup.e2e.ts` (CSP de producció): el plec de l'HTML s'obre i es
  tanca al marc i el del text pla a l'aplicació; amb «Ajustar a la
  finestra», una taula fixa de 1200 px cap a la subfinestra sense barra
  horitzontal, amb el zoom del cos per sota d'1 i la taula intacta.

## Pendent

- Recordar entre sessions l'elecció d'ajust per missatge.
- Plegar el text citat a la previsualització mòbil.
