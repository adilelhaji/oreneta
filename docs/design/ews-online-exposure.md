# Exposició a la retirada d'EWS a Exchange Online (#46)

Estudi amb data 2026-10-10. No afirma continuïtat: indica quins comptes i quines
funcions estan exposats, què cobreix ja Graph i quina decisió queda.

## Calendari de Microsoft

Comprovat el 2026-10-10 al blog de l'equip d'Exchange i a l'avís MC1227454:

- **Des de l'octubre del 2026.** Comença la desactivació per fases a Exchange
  Online. Des del 10 d'octubre, al núvol mundial, un inquilí (tenant) amb
  `EWSEnabled = True` necessita una llista `EWSAllowedAppIDs`; sense llista,
  EWS queda bloquejat. Microsoft emplena la llista amb uns 60 dies d'ús als
  inquilins que no l'han configurada.
- **1 d'abril de 2027.** Retirada completa, sense excepcions.
- **Exchange Server local no se'n veu afectat.**

Fonts:
- [Exchange Online EWS, Your Time is Almost Up](https://techcommunity.microsoft.com/blog/exchange/exchange-online-ews-your-time-is-almost-up/4492361)
- [Introducing EWSAllowedAppIDs](https://techcommunity.microsoft.com/blog/exchange/introducing-ewsallowedappids-preparing-for-the-final-phase-of-ews-retirement/4529471)
- [EWS Deprecation Is Here](https://techcommunity.microsoft.com/blog/exchange/ews-deprecation-is-here-%E2%80%93-what-this-means-to-you/4561431)
- [MC1227454](https://mc.merill.net/message/MC1227454)

Abans de decidir, convé tornar a comprovar les dates al Centre de missatges de
l'inquilí.

## Constatació: EWS a l'Oreneta ja era només local

El client EWS de l'Oreneta (`exchange.rs`) només s'autentica amb Basic, és a
dir, usuari i contrasenya. Exchange Online va desactivar Basic per a EWS
l'octubre del 2022. Per tant:

- **Exchange Online.** Un compte EWS de l'Oreneta que hi apuntés no es podia
  connectar abans d'aquesta retirada, i la retirada no ho canvia.
- **Exchange local.** Els comptes contra un servidor local, que és l'ús real,
  no estan afectats.
- **Exposició.** No és que «els comptes EWS deixen de funcionar». És que un
  usuari de Microsoft 365 no ha tingut mai per EWS el que només EWS ofereix a
  l'Oreneta: calendari, contactes d'Exchange, respostes automàtiques del
  servidor, directori i bústies compartides.

## Com identificar els comptes exposats

- `account.list` marca amb `ews_exchange_online: true` tot compte EWS el punt
  final del qual és Exchange Online: `outlook.office365.com`,
  `outlook.office.com` o els núvols nacionals `.us`, `.de` i
  `partner.outlook.cn` (`exchange::is_exchange_online`).
- La Configuració d'aquell compte mostra l'avís amb la sortida: treure'l i
  afegir la bústia com a Microsoft Graph. L'ADR-0004 no permet convertir-lo
  sobre la marxa.
- L'inventari dels comptes reals del pilot el fa el responsable amb aquesta
  marca. Aquest estudi no hi té accés.

## Matriu de capacitats

| Funció | EWS local (Oreneta) | Exchange Online per EWS | Graph a l'Oreneta avui | Permís de Graph | Estat |
|---|---|---|---|---|---|
| Llegir correu, carpetes, sincronitzar | Sí | No (Basic) | Sí (#128) | `Mail.Read` | Cobert |
| Llegit, marca, moure, copiar, suprimir | Sí, excepte l'estrella | No | Sí (#141) | `Mail.ReadWrite` | Cobert |
| Adjunts i en línia | Sí | No | Sí, fins a 64 MiB (#142) | `Mail.Read` | Cobert amb límit |
| Enviar | Sí | No | Sí, fins a 4 MB (#143) | `Mail.Send` | Cobert amb límit |
| Esborranys al servidor | No | No | No | `Mail.ReadWrite` | Buit (S) |
| Enviament de més de 4 MB (sessió de càrrega) | — | — | No | `Mail.ReadWrite` | Buit (M) |
| Enviament programat | Sí, local | No | No | — | Buit (S) |
| Calendari i respostes a invitacions | Sí | No | No | `Calendars.ReadWrite` | Buit (L) |
| Lliure/ocupat | Sí (resolució de noms) | No | No | `Calendars.Read.Shared` | Buit (M) |
| Contactes d'Exchange | Sí | No | No | `Contacts.ReadWrite` | Buit (M) |
| Directori (GAL) | Sí | No | No | `People.Read` / `User.ReadBasic.All` | Buit (S) |
| Respostes automàtiques del servidor | Sí | No | No | `MailboxSettings.ReadWrite` | Buit (S) |
| Bústies compartides | Sí (accés complet) | No | No | `Mail.Read.Shared`, `Mail.Send.Shared` | Buit (M) i #48 |
| Regles del servidor | No | No | No | `MailboxSettings.ReadWrite` | Fora d'abast (#94) |
| Núvols nacionals | — | — | No | — | Fora d'abast (ADR-0004) |

Notes:
- «Sí» vol dir implementat i amb proves en aquest repositori. No vol dir
  certificat amb un proveïdor (#98).
- Els límits de Graph i la paginació, el `Retry-After`, els testimonis
  (tokens) revocats i la sincronització delta són a
  [graph-adapter.md](../graph-adapter.md), [graph-message-actions.md](graph-message-actions.md),
  [graph-attachments.md](graph-attachments.md) i [graph-sending.md](graph-sending.md).

## Decisió que queda (responsable)

- **Termini.** Abans de l'1 d'abril de 2027 per al correu de Microsoft 365, que
  ja és cobert per Graph. Per al calendari i els contactes el termini el fixa
  el pilot, no Microsoft: amb Exchange Online no han funcionat mai a l'Oreneta.
- **Parts proposades.** En ordre, amb una estimació orientativa en dies de
  feina d'una persona, proves incloses:
  1. Calendari de Graph: lectura, creació, resposta i recurrència. 10–20 dies.
  2. Respostes automàtiques del servidor per Graph. 2–4 dies.
  3. Directori i lliure/ocupat. 3–6 dies.
  4. Contactes d'Exchange per Graph. 5–8 dies.
  5. Esborranys al servidor i sessions de càrrega per a enviaments grans. 5–8
     dies.
  6. Bústies compartides amb `.Shared`, juntament amb #48. 6–10 dies.
- **Interval total.** Entre 31 i 56 dies de feina, més la certificació amb un
  inquilí real (#98), que necessita un compte de prova autoritzat.
- **Consentiment.** Cada part demana el seu permís de manera incremental, com ja
  fan els canvis i l'enviament. No es demana cap permís de cop.
- **El que ha de decidir el responsable:**
  - qui n'és responsable;
  - quines parts entren abans del pilot;
  - si s'accepta fer servir `.Shared`, que amplia l'ADR-0004.

## Validació

- `exchange::tests::exchange_online_endpoints_are_told_apart_from_on_premises_servers`
  distingeix els punts finals en línia i locals, inclosos casos enganyosos.
- Els comptes marcats es veuen a la Configuració amb l'avís.
- No hi ha evidència contra un inquilí real. Aquest estudi no la substitueix.
