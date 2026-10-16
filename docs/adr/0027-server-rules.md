# ADR-0027: Regles al servidor

- Estat: acceptada; presa per delegació i revisada pel propietari
  el 2026-10-12. Cobreix la porta de #94
  (adaptadors i permisos nous per proveïdor).
- Data: 2026-10-12.
- Abast: primer lliurament de #94.

## Inventari per proveïdor

| Proveïdor | Regles al servidor | Resposta automàtica i reenviament | Estat |
|---|---|---|---|
| IMAP amb ManageSieve (RFC 5804; Dovecot Pigeonhole, Fastmail, Stalwart…) | Script Sieve | `vacation` i `redirect` de Sieve | **Regles: implementat.** Resposta automàtica i reenviament: no |
| Gmail | Filtres de l'API de Gmail (`settings.filters`) | `settings.sendAs`, `vacation`, reenviament verificat | Bloquejat: permís `gmail.settings.basic` i registre OAuth propi |
| Exchange EWS | `GetInboxRules` / `UpdateInboxRules` | OOF ja existeix (#48); el reenviament és una regla | Bloquejat: calen enregistraments reals, que no s'inventen |
| Microsoft Graph | `messageRules` | `mailboxSettings.automaticRepliesSetting` | Bloquejat: permís `MailboxSettings.ReadWrite` i consentiment |
| Fitxer local, RSS | No s'aplica | No s'aplica | — |

## Decisió

- **Les mateixes regles, en un altre lloc:**
  - les regles d'Oreneta es tradueixen a un script Sieve anomenat `oreneta`;
  - una regla només va al servidor si Sieve diu exactament el mateix, o
    alguna cosa més estreta en casos d'espais, mai alguna cosa més àmplia;
  - si alguna part no es pot dir, la regla sencera es queda aquí, amb
    el motiu a la vista;
  - exemples que es queden: «és» o «comença per» en una adreça, que aquí
    compara també el nom; un text que barreja nom i adreça; una
    etiqueta no enllaçada a una paraula clau; una extensió que el servidor
    no ofereix.
- **Què s'escriu i què no:**
  - només s'escriu l'script `oreneta`;
  - si la còpia del servidor ha canviat des de l'última escriptura, es mostra i
    no es reemplaça sense permís;
  - mai no es desactiva cap altre script actiu; si n'hi ha un, el d'Oreneta queda
    desat però apagat, i es diu;
  - el servidor comprova l'script (`CHECKSCRIPT`) abans de desar-lo.
- **Sense aplicar dues vegades:**
  - amb l'script actiu, el motor local se salta aquestes regles en aquest compte
    (`server_rules`);
  - en treure-les del servidor tornen a funcionar aquí;
  - un script desat però inactiu no treu res d'aquí.
- **Seguretat:**
  - ManageSieve només amb STARTTLS i la contrasenya del compte;
  - un servidor sense TLS es rebutja;
  - els comptes OAuth no fan servir ManageSieve.
- **Sense reenviaments ni respostes automàtiques al servidor:** cap prova
  ni acció no activa un reenviament a un tercer.

## Pendent

- Resposta automàtica amb `vacation` de Sieve.
- Adaptadors per a Gmail, EWS i Graph, quan hi hagi permisos i evidència
  real.
- Prova contra Dovecot Pigeonhole real (N5).
