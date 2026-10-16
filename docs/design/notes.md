# Notes (#104, ADR-0015)

## Ús

La icona de nota de la barra lateral obre **Notes**: la llista a l'esquerra
(primer les fixades, després les més recents) i la nota oberta a la dreta. Es
cerca pel títol, el text i les etiquetes (hi han d'aparèixer totes les paraules);
les etiquetes filtren amb un clic. Una nota nova es desa tan bon punt té alguna
cosa escrita, i cada canvi es desa al cap d'un instant. En obrir una altra nota
no es perd el que estava pendent.

Si la nota ha canviat en una altra finestra, apareix un avís amb la versió desada
i dos botons: **Mantén la meva** i **Fes servir la desada**. No se sobreescriu
res sense triar.

## Proves

| Nivell | Què cobreix |
|---|---|
| N1 (`store/notes/tests.rs`) | Neteja de l'HTML (scripts, gestors d'esdeveniments, `javascript:`, imatges remotes, `data:` fora d'`<img>`) i text pla; revisió i conflicte; nota buida, enorme o amb massa etiquetes; cerca per paraules amb `%` literal; etiquetes sense distingir majúscules; paperera, restauració, supressió definitiva sense etiquetes òrfenes i caducitat als 30 dies |
| N1 distribuïdor (`main.rs`) | Crear, llistar amb etiquetes, editar, conflicte, paperera, restaurar i suprimir del tot |
| N2 (`NotesView.test.tsx`) | Crear en escriure i editar a partir de la revisió; conflicte amb «Mantén la meva» i «Fes servir la desada» sense escriure; paperera i restauració |
| N6 (`startup.e2e.ts`) | Auditoria axe de la visualització amb una nota oberta, en clar i en fosc |
