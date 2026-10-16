# Controls del lector (#156)

Part de #35; fa servir la preferència de mida del text, la renderització i els
camins de l'editor de missatges existents.

- Els lectors de conversa i independents mostren **Mida del text del missatge**, amb
  valors predefinits del 80 al 400% i Restableix el valor per defecte (100%). Un
  valor personalitzat vàlid de Configuració continua disponible. Canviar-lo fa
  servir `message_font_scale`; la mida del text de tota l'aplicació no canvia.
  La preferència s'aplica a tots els cossos dels missatges i es manté a través
  del camí de persistència de la configuració existent; no és una preferència per
  missatge.
- Les capçaleres tradicionals dels missatges ajusten els noms i les adreces
  llargs del remitent. Les accions del missatge ocupen una fila pròpia, amb accés
  directe a Reenvia a través de l'editor de missatges existent. El nom accessible
  del seu grup identifica el remitent i la data. Reenvia no està disponible per al
  correu de només lectura de Graph i s'omet per als esborranys i els elements de
  canals.
- Expandir i replegar fa servir botons de teclat natius amb `aria-expanded`. Els
  detalls i les accions del missatge continuen separats de l'acció de replegar.
  Les icones compartides fan servir colors semàntics.

Les proves cobreixen valors personalitzats, límit i de restabliment, l'escala de
l'aplicació sense canvis, accions i replegament separats, el reenviament del
contingut triat i les restriccions de només lectura.
Els casos de navegador sobre el punt d'entrada de producció cobreixen tots dos
temes cobalt a 1440px i 600px: escalat del cos HTML i de text pla, contenció de
l'HTML d'amplada fixa, commutadors de teclat, controls del lector independent i
captures de pantalla. Totes les respostes de correu i del pont són
sintètiques; l'acceptació nativa i amb proveïdors és a part.

No canvia cap contingut rebut ni la política de neteja o d'entorn aïllat. No hi ha
cap API d'impressió nova, cap política d'ajust a l'amplada ni cap plegament de
citacions o signatures. Aquests punts i l'acceptació completa de #35 continuen
oberts; aquest canvi de codi font no substitueix cap executable ni cap instal·lador.

## Preparació del marc HTML (#175)

La CI posterior a la fusió de `8543671f` va revelar una fallada real de la
conversa en tornar a obrir un missatge HTML: el document d'un iframe hi era però
el seu element arrel encara no. Ara la connexió del marc espera tots dos, el
document i l'arrel, abans de posar marcadors d'escolta o de cridar les funcions de
retorn de preparació; l'esdeveniment de càrrega natiu torna a provar-ho amb
normalitat. El cicle de vida de neteja anterior es manté intacte fins que el
substitut està preparat.

Unes proves de components deterministes reprodueixen l'antiga fallada en el
muntatge i en la substitució de srcDoc, i després verifiquen la recuperació, un
sol gestor de clics i la neteja després de la càrrega. Els casos sense document o
sense finestra continuen sense estar preparats. Les proves existents del lector
de producció no canvien i exerciten tots dos temes i finestres estretes i
d'escriptori. Això no altera l'entorn aïllat dels missatges ni neteja l'HTML rebut
de manera diferent.
