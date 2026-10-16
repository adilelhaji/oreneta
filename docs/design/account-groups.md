# Grups de comptes (#99, ADR-0040)

## Ús

- **Configuració → Comptes → Grups de comptes:** crear, reanomenar i suprimir
  grups, i triar-ne els comptes. Es rebutja un nom buit o repetit.
- **Navegació:** cada grup apareix sota «Safata unificada». Quan es tria, se'n
  veuen els comptes junts, amb les mateixes carpetes unificades, cerca, filtres
  i accions. «Safata unificada» torna a tots els comptes inclosos.
- **Barra lateral estreta:** el menú contextual del botó unificat ofereix els
  grups.

## Implementació

`frontend/src/states/accountGroups.ts`:
- `inUnifiedScope` decideix quins comptes entren a la vista unificada, i
  `unifiedAccounts()` la fa servir;
- també es fa servir a «marca-ho tot com a llegit», a la sincronització i als
  recomptes;
- `threadListViewKey` inclou el grup, de manera que cada grup és una vista
  pròpia.

## Proves

| Nivell | Què cobreix |
|---|---|
| N2 estat (`accountGroups.test.ts`) | Sense grup, els inclosos; amb grup, exactament els seus comptes (també un d'exclòs); cada grup és una vista diferent i no afecta les vistes d'un compte; sortir de la vista unificada fa sortir del grup; noms obligatoris i únics; desament i lectura; dades malmeses com a «sense grups»; treure un compte el treu dels grups; suprimir el grup mostrat torna a tots |
| N2 navegació (`MailNavigation.test.tsx`) | Els grups apareixen sota la vista unificada i només el mostrat és marcat |
| N2 configuració (`AccountGroupsGroup.test.tsx`) | Crear amb els comptes triats; nom repetit rebutjat; suprimir demana confirmació i conserva els comptes |
| N4 pendent | A Windows, amb diversos comptes reals |
