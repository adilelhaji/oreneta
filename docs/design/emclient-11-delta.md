# eM Client 11: diferències separades de la referència (#117)

La referència estable del llibre (ledger) continua fixada en **10.4.5674.0**.
El validador ho exigeix. La versió 11 se segueix a part.

- **Beta:** 11.0.282.0 (2026-09-03) i, després, 11.0.865.0, observada a
  l'auditoria de la cartera de feina pendent (backlog).
- **Estable:** el 2026-10-12, una font secundària (alternativeto.net) diu que
  eM Client 11 va sortir com a estable l'octubre del 2026. No està confirmat a
  www.emclient.com.
- **Decisió del propietari (2026-10-12):** la referència continua sent la 10.4
  fins que www.emclient.com confirmi la 11 estable. Aleshores es tornarà a
  decidir; mentrestant, aquesta taula només informa.

| Novetat de la 11 | Estat a l'Oreneta |
|---|---|
| Microsoft Graph en lloc d'EWS | Graph implementat (#141, #142, #143); EWS continua disponible |
| Xat Matrix | No; el xat va començar per XMPP (ADR-0036). Matrix seria un adaptador nou |
| eM Sync (sincronització de la configuració) | No |
| Assistent amb IA, cerca i regles en llenguatge natural | Assistent amb consentiment i revisió (ADR-0032); sense cerca ni regles en llenguatge natural |
| MCP | No |
| Paleta d'ordres | Existeix (`CommandPalette`); el seu abast davant de la 11 està per comprovar |
| Fixar converses | No |

Cap fila no és un bloqueig de la paritat estable amb la 10.4. Si la 11 passa a
ser la referència, cada fila «No» necessita la seva pròpia incidència acotada i
la seva revisió d'arquitectura. Cada fila porta la seva versió i la seva data
d'origen.
