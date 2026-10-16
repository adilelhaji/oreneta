# Impressió (#35, #213)

Fila del registre d'acceptació SET-05 (General → Impressió). Decisions: [ADR-0060](../adr/0060-print-options.md).

Codi: `frontend/src/lib/print.ts`, `lib/printDocument.ts`, `lib/printOptions.ts`,
`states/printing.ts`, `components/dialog/PrintGroup.tsx`.

## Què va al paper

- `lib/printDocument.ts` construeix una pàgina HTML autònoma; `lib/print.ts`
  la imprimeix des d'un iframe fora de la pantalla, aïllat sense scripts. La
  finestra de l'aplicació mateixa no s'imprimeix mai.
- `states/printing.ts` (`printFromReader`) és l'únic camí des del lector:
  - el menú de la conversa (⋯ → Imprimeix…) imprimeix segons les opcions recordades;
  - el menú contextual d'un missatge (Imprimeix el missatge…) imprimeix només
    aquell missatge, amb les opcions de capçalera i d'adjunts recordades.
- Abans que s'hagi carregat la conversa (o si la càrrega ha fallat) no
  s'imprimeix res: una notificació d'error diu que la conversa encara no s'ha
  carregat, en lloc d'una pàgina buida que passaria per una impressió.
- Un esborrany (carpeta d'esborranys) o una còpia local encara no enviada
  (finestra per desfer, enviament fallit pendent de reintent) porta una marca
  "Esborrany" / "No enviat" al paper sempre que s'imprimeix.

## Opcions (Configuració → General → Impressió)

Es desen com una sola fila `print_options` (`settings$.print`, `lib/printOptions.ts`);
cada camp torna al seu valor per defecte de manera independent quan es llegeix.

| Opció | Valors | Per defecte |
|---|---|---|
| Camps de capçalera | encapçalament d'assumpte, data, Per a, A/c, C/o | tots activats excepte C/o |
| Abast | conversa sencera, un missatge | conversa sencera |
| Ordre (només conversa) | primer el més antic, primer el més recent | primer el més antic |
| Llista d'adjunts | activada, desactivada | activada |

El remitent (nom i adreça) s'imprimeix sempre. Els valors per defecte reprodueixen
la impressió tal com era abans que existissin les opcions. "Un missatge" des del
menú de la conversa és el missatge carregat més recent que no és ni un esborrany
ni una còpia no enviada (el més recent, marcat, si no n'hi ha cap altre). Primer
el més recent és exactament l'invers de primer el més antic. C/o, un cop activat,
continua activat fins que es desactiva; la seva indicació ho diu.

## Garanties que es mantenen amb totes les opcions (#35)

- Les imatges remotes només es carreguen quan el compte les carrega; la pàgina
  porta la seva pròpia Content-Security-Policy (sense scripts, marcs ni
  formularis). S'eliminen els píxels de seguiment, els scripts i els gestors
  d'esdeveniments en línia.
- El que queda fora es diu a la part superior de la pàgina: missatges més antics
  que no s'han carregat (abast de conversa), o que només s'imprimeix un missatge
  d'una conversa més llarga (abast de missatge). Quan la conversa del missatge no
  està carregada, la pàgina diu que la resta, si n'hi ha, no s'imprimeix, sense
  afirmar que n'hi hagi més.

Proves: `printDocument.test.ts` (cada opció i les garanties en totes les
combinacions), `printOptions.test.ts`, `printing.test.ts`, `print.test.ts`,
`PrintGroup.test.tsx`, `MessageContextMenu.test.tsx`. Les proves d'impressió
nativa (Windows, N4) queden fora d'aquest abast i continuen al registre d'acceptació.
