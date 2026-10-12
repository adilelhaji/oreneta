# eM Client 11: delta separado de la referencia (#117)

La referencia estable del ledger sigue fijada en **10.4.5674.0**. El
validador lo exige. La versión 11 se sigue aparte.

- **Beta:** 11.0.282.0 (2026-09-03), y después 11.0.865.0, observada en la
  auditoría de backlog.
- **Estable:** el 2026-10-12, una fuente secundaria (alternativeto.net)
  dice que eM Client 11 salió como estable en octubre de 2026. No está
  confirmado en www.emclient.com.
- **Decisión del propietario (2026-10-12):** la referencia sigue siendo la
  10.4 hasta que www.emclient.com confirme la 11 estable. Entonces se
  vuelve a decidir; mientras tanto, esta tabla solo informa.

| Novedad de 11 | Estado en Oreneta |
|---|---|
| Microsoft Graph en lugar de EWS | Graph implementado (#141, #142, #143); EWS sigue disponible |
| Chat Matrix | No; el chat empezó por XMPP (ADR-0036). Matrix sería un adaptador nuevo |
| eM Sync (sincronización de ajustes) | No |
| Asistente con IA, búsqueda y reglas en lenguaje natural | Asistente con consentimiento y revisión (ADR-0032); sin búsqueda ni reglas en lenguaje natural |
| MCP | No |
| Paleta de comandos | Existe (`CommandPalette`); su alcance frente a la 11 está por comprobar |
| Fijar conversaciones | No |

Ninguna fila es un bloqueo de la paridad estable con la 10.4. Si la 11 pasa
a ser la referencia, cada fila «No» necesita su propia incidencia acotada y
su revisión de arquitectura. Cada fila lleva su versión y su fecha de
origen.
