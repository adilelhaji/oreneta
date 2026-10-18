# Importació des de Thunderbird (ADR-0041)

## Ús

A **Configuració → Còpia de seguretat → Importa correu → Des de Thunderbird…**:
1. Es tria un dels perfils trobats, o una altra carpeta.
2. Es marquen les carpetes que es volen importar. Les còpies de comptes
   IMAP comencen sense marcar.
3. **Comprova** diu quants missatges són nous, quants ja són a
   l'arxiu i quants estaven esborrats a Thunderbird.
4. **Importa** els desa a l'arxiu local, sota `Thunderbird/`.

## Nucli

- `meron-core/src/thunderbird/`: perfils, exploració, missatges esborrats i
  carpeta de destinació.
- Ordres: `thunderbird.profiles`, `thunderbird.scan`,
  `thunderbird.preview` i `thunderbird.import`.
- El pont hi afegeix `thunderbird.pickFolder`.

## Proves

| Nivell | Què cobreix |
|---|---|
| N1 (`thunderbird/tests.rs`) | Un perfil amb l'estructura de Thunderbird: carpetes i subcarpetes `.sbd`, noms amb punts, sense filtres, sense estat POP, sense índexs solts ni carpetes buides; còpia IMAP marcada; carpeta triada a mà; missatges esborrats exclosos i comptats; `profiles.ini` relatiu i absolut, perfil inexistent exclòs; carpeta de destinació amb nivells i sense `/` dins d'un nom |
| N1 distribuïdor (`main.rs`) | Explorar, previsualització sense desar res, importar a `Thunderbird/<compte>/<carpetes>`, dues vegades sense duplicats, l'esborrat no hi entra, es rebutja un identificador que l'exploració no ha donat |
| N2 (`ThunderbirdImportDialog.test.tsx`) | Perfil llistat; còpies IMAP sense marcar; previsualització abans d'importar; s'importen exactament les triades; canviar la selecció demana una altra comprovació |
| N4 pendent | Amb un perfil real de Thunderbird a Windows |
