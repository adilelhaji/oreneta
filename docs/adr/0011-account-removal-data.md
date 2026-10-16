# ADR-0011: Què se suprimeix en suprimir un compte

- Estat: acceptada.
- Data: 2026-10-11.
- Abast: `store::delete_account`; troballa de la validació de #42.
- Aprovació humana: «Borrar todo salvo tu contenido», escollida entre les
  opcions presentades el 2026-10-11 (suprimir-ho tot excepte el contingut, preguntar
  en suprimir, suprimir-ho absolutament tot, deixar-ho com està).

## Decisió

En suprimir un compte se suprimeixen, en la mateixa transacció, tot el seu estat i les seves
dades personals:
- etiquetes, ajornats, prioritat, correu brossa i regles amb el seu registre;
- contactes sincronitzats, les seves llibretes i els corresponsals;
- registres de respostes automàtiques i de recordatoris;
- tasques.

Es conserva el contingut escrit per la persona: esborranys locals, enviaments
programats i intents d'enviament. Un intent de resultat incert és, a més, l'evidència
de #29 que un missatge podria haver sortit. L'aplicació avisa que aquest
contingut continua a l'equip i permet exportar-lo o suprimir-lo explícitament.
Mai no s'envia res d'un compte suprimit.

## Conseqüències

- Una prova recorre totes les taules amb columna de compte i falla si alguna
  no és a la llista de suprimides ni a la de conservades. Així, una taula nova
  no pot quedar fora sense haver-ho decidit.
- Els enviaments programats d'un compte suprimit no s'executen, perquè no hi ha
  credencials; queden com a contingut conservat.
