# ADR-0028: Remitents bloquejats i permesos; executar regles tal com s'han previsualitzat

- Estat: acceptada; presa per delegació i revisada pel propietari
  el 2026-10-12.
- Data: 2026-10-12.
- Abast: el que faltava de #50 després de l'ADR-0005.

## Decisió

- **Llistes per compte (`sender_lists`):**
  - per adreça o per domini (`@dominio`); l'adreça compta abans que
    el seu domini, de manera que es pot permetre una persona d'un domini
    bloquejat i a l'inrevés;
  - un remitent bloquejat es marca com a correu brossa amb el motiu «l'has bloquejat»;
  - un de permès mai no es marca, i això pesa més que tot el que s'ha après;
  - **continua sent només un suggeriment:** res no es mou sense que la persona
    actuï, com demana l'ADR-0005; moure automàticament és cosa d'una regla,
    que la persona escriu i veu;
  - canviar una llista torna a jutjar a l'instant els missatges que ja són
    a l'equip;
  - en suprimir un compte se suprimeixen les seves llistes.
- **El que es veu és el que es fa:**
  - el pla d'una regla fa primer les marques i després l'únic
    moviment;
  - abans, una acció que anava darrere de «moure» sortia a la previsualització i
    no es feia mai, perquè el missatge ja no era on es cercava;
  - un segon moviment no es podria fer i no es planifica.
- **Executar sobre el correu que ja hi ha:**
  - la previsualització de les regles desades lliura una revisió d'un sol
    ús, lligada al compte, la carpeta, el seu UIDVALIDITY i l'empremta de les
    regles (com l'escombratge de #27);
  - executar fa exactament aquests passos sobre exactament aquests missatges;
  - qualsevol canvi obliga a tornar a previsualitzar;
  - cada pas queda al registre de regles, i l'informe diu què ha fallat i
    per què;
  - una fallada atura els passos d'aquest missatge, no els dels altres.

## Pendent

- Validació amb proveïdors reals (N5).
