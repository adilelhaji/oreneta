# Tasques completes: decisió pendent (#103)

Estat: **proposta**. #103 demana presentar aquesta decisió i aprovar-la en un
ADR abans d'escriure codi. El contracte actual (tasques locals enllaçades a una
conversa, una d'oberta per conversa) no canvia sense aquesta aprovació. La seva
validació és a [message-linked-tasks.md](message-linked-tasks.md).

## Què ofereixen els proveïdors

| Capacitat | Google Tasks | CalDAV (VTODO) | Exchange (EWS) | Graph (To Do) |
|---|---|---|---|---|
| Llistes | Sí | Una per col·lecció | Carpetes de tasques | Sí |
| Tasca solta | Sí | Sí | Sí | Sí |
| Data límit | Només data | Data i hora | Data i hora | Data i hora |
| Recordatori | No | `VALARM` | Sí | Sí |
| Prioritat | No | 1–9 | Baixa/normal/alta | Baixa/normal/alta |
| Repetició | No per API | `RRULE` | Patrons d'EWS | Patrons de Graph |
| Subtasques | Un nivell | `RELATED-TO` | No | Passos (llista de comprovació) |
| Delegació | No | No estàndard | Sí (assignar) | No |
| Versió per a conflictes | `etag` | ETag | `ChangeKey` | `@odata.etag` |

Les diferències són grans. Un model comú ha d'indicar quin camp es perd a cada
proveïdor, en lloc de prometre el que el proveïdor no desa.

## Decisions

1. **Model.** Proposta: una taula de tasques amb llista, títol, nota, data límit
   (data o hora), recordatori, prioritat (baixa/normal/alta), estat i un
   enllaç opcional a una conversa. Les tasques enllaçades actuals migren a una
   llista local «Seguiment del correu» sense perdre res. La regla d'una tasca
   oberta per conversa es manté per a les enllaçades.
2. **Primer lliurament només local.** Llistes i tasques soltes, sense repetició
   ni delegació. Inclou la cerca i l'aparició a l'agenda.
3. **Sincronització, per proveïdor i en aquest ordre:**
   1. CalDAV VTODO, que es pot provar contra Radicale a la CI;
   2. Google Tasks, amb un permís nou (`tasks`) que depèn dels registres OAuth
      de #144;
   3. Graph To Do, amb `Tasks.ReadWrite`;
   4. EWS, amb evidència d'un servidor real.

   Cada camp que un proveïdor no desa s'indica a la interfície en triar la
   llista.
4. **Conflictes.** Proposta: els mateixos que al calendari i als contactes.
   Escriure amb la versió llegida; si el servidor respon 412, no es desa res i
   es pregunta. Sense fusió silenciosa.
5. **Sense connexió.** Proposta: els canvis es desen en local i es marquen com a
   pendents. S'envien en tornar a connectar, d'un en un i amb versió, i un
   conflicte atura la cua d'aquella llista, no les altres. Això necessita la
   mateixa decisió que la cua sense connexió del calendari (#101), i convé
   prendre-les juntes.
6. **Repetició i delegació.** Proposta: fora dels primers lliuraments.
   Repetició només quan hi hagi un proveïdor que la sincronitzi; delegació
   només a Exchange.

## Proves exigides per #103

- N1: alta, edició, completar i reobrir.
- N1: migració des de les tasques enllaçades, d'anada i tornada, sense pèrdua.
- N1: aïllament entre comptes.
- N3: conflicte i interrupció contra Radicale.
- N2: fluxos de la vista.
- N5: amb cada proveïdor real abans d'anunciar-lo.
