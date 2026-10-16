# Referència del flux de treball del correu (#32)

## Abast i direcció

La instrucció de l'usuari del 2026-09-09 prioritza un espai de treball de correu
semblant al d'eM Client. La referència concreta la [direcció d'art](art-direction.md),
i preserva el cobalt i el blau marí, les escales tipogràfiques i de radis
existents i l'arquitectura nativa Wails/Go/Rust.
Referència: [eM Client desktop](https://es.emclient.com/), revisada el 2026-09-09.
No es copia cap element gràfic ni marca de producte de tercers.

Això és un escenari de disseny navegable, no una implementació de correu
publicada. Fa servir el mateix compte i els mateixos missatges sintètics que [la
base](../baseline.md), les variables CSS de disseny (tokens) de producció i les icones Lucide. Els
controls del correu només simulen l'estat local: no hi ha Wails, transport de
xarxa, credencials, inicialització de comptes ni preferències persistents.

## Composició i acceptació

- Carpetes persistents amb etiqueta; una llista compacta i un lector tradicional a
  amplada completa.
- Accions visibles de Missatge nou, Respon, Reenvia, Arxiva i Suprimeix; les
  caselles de selecció es distingeixen del pes de no llegit, del tint de la fila
  oberta i del focus del teclat.
- Les escenes de taula, selecció múltiple, editor de missatges i enviament incert
  es poden adreçar.
- Un enviament incert no informa mai d'èxit ni ofereix cap reintent automàtic;
  l'esborrany continua visible i editable. Això il·lustra un estat, no la
  recuperació del lliurament.
- A 1440px es mostren carpetes, llista i lector; a 1024px es redueixen les
  amplades de carpetes i llista; a <=600px es mostra una sola subfinestra de
  correu amb navegació explícita enrere i accés a les carpetes.
- Tots dos temes fan servir dades d'escenari idèntiques, inclosos noms i
  assumptes llargs. La cerca, les carpetes buides, la selecció, la validació de
  l'esborrany i la recuperació són interactives.
- No es toquen els valors per defecte ni les preferències existents de l'usuari.
  Valors per defecte de producció proposats: lector tradicional i llista compacta;
  només es migren les preferències absents, i mai no se sobreescriuen les
  seleccions desades de xat, targetes o tema (#33–#35).

La referència de <=600px anterior descriu aquest escenari sintètic històric.
Actualment, producció fa servir <769 píxels CSS per al correu d'una sola
subfinestra; vegeu [límits del correu](mail-boundaries.md).
Feu servir aquest contracte de producció per a l'acceptació nova, no el llindar
de l'escenari antic.

## Límits del lliurament

Responsabilitats de referència reutilitzables: navegació de l'espai de treball,
llista o taula de missatges, accions del lector, formulari d'esborrany i avís de
lliurament. L'adopció en producció correspon a #33–#36; calendari, contactes i
tasques queden fora d'aquesta referència del correu (#38).
No s'afirma cap paritat funcional, validació amb proveïdors ni certificació
d'accessibilitat.

La CI executa els casos Playwright de la referència amb `bun run baseline:verify`
al costat de la base històrica, que no canvia. Obriu
`/reference.html?scene=reader&theme=light` al servidor de la base aïllat. Les
captures de pantalla inclouen la procedència: l'SHA provat, l'indicador d'arbre
amb canvis, la suma de verificació de l'escenari, el tema, la finestra gràfica i
el transport sintètic.

## Registre de verificació

Windows: la comprovació de tipus i tots els 62 casos Playwright inicials de base
i referència van passar. Es van inspeccionar les renderitzacions del lector i la
taula en clar a 1440px, l'enviament incert en fosc a 1024px i el lector en clar a
600px. Defectes de la revisió corregits: escriure a la cerca robava el focus; el
resum de la conversa anomenava incorrectament "earlier" una resposta posterior.
Les proves de seguiment cobreixen l'ordenació i la selecció de la taula i la
redacció amb el menú de carpetes estret obert. El commit final i les proves de la
CI es registren a la PR del lliurament. Les captures de pantalla locals
registren un arbre amb canvis; no s'han de descriure com una execució de la CI
d'un commit net.
