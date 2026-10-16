# ADR-0006: Proveïdor explícit de l'assistent i límit del context

- Estat: acceptada
- Data: 2026-09-10
- Abast: incidència #51 / capacitat C24
- Aprovació: l'usuari va aprovar la recomanació de prioritat local més proveïdor remot explícit el 2026-09-10

## Decisió

Oreneta exposa un assistent mitjançant un contracte neutral respecte del
proveïdor, amb dos modes explícits:

1. **Prioritat local**: un proveïdor local configurat rep el context
   seleccionat sense que surti del dispositiu. Si no hi ha cap proveïdor local
   configurat, l'acció no està disponible, en lloc de recórrer en silenci a un
   servei de xarxa.
2. **Proveïdor remot**: un punt d'accés configurat per l'usuari s'activa
   explícitament per a cada acció. La petició declara el proveïdor, el punt
   d'accés, l'identificador del model i el context seleccionat. Oreneta no
   allotja cap model ni fa passar peticions per cap servei d'Oreneta.

La interfície ha de mostrar un manifest del context revisable abans de
l'activació. Només es poden enviar els missatges i els fitxers adjunts
seleccionats explícitament per a aquella acció. Un testimoni de
previsualització lliga el proveïdor, l'acció i el context revisats a la
petició d'execució posterior; les previsualitzacions obsoletes o alterades es
rebutgen.
L'assumpte, el remitent i el cos es tracten com a entrada no fiable; les
instruccions que es trobin al correu mai no autoritzen enviar, suprimir,
moure, arxivar, canviar regles ni cridar cap altra eina.

El contracte admet una mida d'entrada acotada, errors del proveïdor i una
fallada explícita sense connexió. El consumidor pot descartar un resultat
pendent; la cancel·lació del transport continua sent una qüestió de seguiment
de la incidència #52. La capa de l'assistent no desa les peticions ni les
respostes. Aquest fragment no desa credencials del proveïdor; qualsevol
emmagatzematge futur de credencials ha de fer servir el límit de secrets
existent. Les respostes del proveïdor només es conserven per a l'acció
activa, tret que el consumidor desi el resultat com a contingut ordinari
escrit per l'usuari.

## Conseqüències

- Es poden afegir adaptadors de proveïdor sense canviar l'emmagatzematge del
  correu ni la sincronització dels comptes.
- L'ús remot es pot auditar al límit de l'acció i no es pot convertir en un
  indexador ocult de la bústia en segon pla.
- Un proveïdor local és l'opció per defecte que preserva la privadesa, però
  requereix que l'usuari instal·li i configuri un entorn d'execució
  compatible; aquest ADR no inclou cap entorn d'execució de models.
- Les implementacions de resums, esborranys i extracció de tasques continuen
  sent un paquet de treball separat (#52) i han de consumir aquest contracte
  en lloc d'esquivar-lo.

## Fora d'abast

- Cap servei d'IA allotjat per Oreneta, subscripció, telemetria ni indexació
  remota de la bústia.
- Cap acció automàtica derivada del contingut dels missatges.
- Aquest ADR no selecciona cap SDK ni flux de credencials específic de cap
  proveïdor.
