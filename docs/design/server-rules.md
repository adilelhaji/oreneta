# Regles al servidor (#94, ADR-0027)

## Ús

**Configuració → Regles → Regles al servidor**:
1. Es tria el compte i es prem **Comprova el servidor**. Es veu:
   - quantes regles hi poden anar;
   - quines es queden aquí i per què;
   - l'script tal com es desaria;
   - si la còpia del servidor és la que va escriure Oreneta.
2. **Aplica al servidor** demana confirmació.
3. **Treu-les del servidor** torna les regles a aquest equip.

## Proves

| Nivell | Què cobreix |
|---|---|
| N1 `rules/sieve/tests.rs` | Una regla, un bloc, amb les marques abans d'arxivar; el que el servidor llegiria de manera més àmplia es queda sencer; etiqueta enllaçada com a paraula clau; extensions que falten; només les regles actives del compte; cometes segures; «no conté» |
| N2 `rules/managesieve/tests.rs` (servidor simulat) | Capacitats i contrasenya rebutjada; escriu, activa i llegeix el mateix; no substitueix una còpia canviada sense permís; no desactiva un altre script actiu; un script rebutjat no es desa; treure desactiva primer |
| N1 `rules/server.rs` | Només un script actiu treu regles del motor local, per compte |
| N2 `ServerRules.test.tsx` | Mostra el que hi va i el que es queda abans d'enviar res; no substitueix sense permís i després sí; explica per què un compte no pot |

La prova amb un Dovecot real queda per a la verificació final (N5).
