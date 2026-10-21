# Valors per defecte de cobalt (#83)

Els perfils nous fan servir `oreneta-light` o `oreneta-dark`, d'acord amb la
[direcció artística](art-direction.md) i la [referència del correu](mail-reference.md)
acceptades. La primera execució tria l'aparença del sistema operatiu quan és
disponible i, si no, la clara. L'elecció resultant que queda a la memòria cau és
explícita: els canvis posteriors del sistema operatiu no la sobreescriuen. Aquesta
part no introdueix el seguiment continu del sistema.

Els 14 identificadors de tema anteriors i els colors de les seves paletes continuen
disponibles, amb els ajustos de #287 descrits més avall. Les entrades verdes `light`/`dark` es mostren com a Legacy Green/Legacy
Green Dark per no confondre-les amb els nous valors per defecte de cobalt. Les
preferències existents a la base de dades continuen tenint prioritat sobre la
memòria cau d'arrencada; no es fa cap reescriptura massiva de preferències. Els
usuaris trien Oreneta Light/Dark explícitament a Configuració > Tema per adoptar-los.
Suprimir un tema personalitzat actiu torna al valor per defecte de l'aparença
corresponent.

Tots els temes integrats i els temes personalitzats derivats de nou exposen tokens
de primer pla i suaus per a èxit, avís, perill i informació, i un token de text
d'accent. Les paletes personalitzades antigues conserven tots els tokens desats;
les posicions semàntiques que falten s'emplenen sense regenerar-ne els colors. El
text d'accent que falta es deriva de l'accent desat, inclosos els accents
personalitzats antics de to pàl·lid. Les paletes personalitzades noves també el
deriven del contrast sRGB opac; els accents personalitzats transparents
requereixen un fons resolt i no estan certificats. Els colors de text d'accent
desats explícitament no canvien. La migració dels colors d'estat fixos a tota la
interfície continua sent #33 i no forma part d'aquesta part de la paleta per
defecte.

Els tokens CSS de reserva coincideixen amb les dues paletes per defecte del
registre. Els controls emplenats antics `bg-accent text-white` fan servir el
token de text d'accent: l'accent cobalt fosc pàl·lid requereix text fosc; els
accents antics també fan servir un primer pla contrastat sense canviar l'accent
mateix. La classe `.dark` del tema actiu continua controlant les variants de
Tailwind i el `color-scheme` natiu.

Verificació: les comprovacions unitàries cobreixen la completesa dels tokens, la
coherència entre CSS i registre, el contrast opac, la conservació dels tokens
personalitzats antics, tots els identificadors integrats, la hidratació, la
selecció explícita, els identificadors personalitzats suprimits o desconeguts i
l'aparença de la primera execució. Les proves d'entrada de producció cobreixen
els dos temes nous, l'Indigo existent, una paleta personalitzada antiga desada,
la selecció explícita al selector, la recàrrega i els canvis del sistema
operatiu. Les captures de pantalla a 1440/1024/600 fan servir dades sintètiques
del pont, no una certificació nativa ni del proveïdor. Els valors per defecte
del lector i de la llista i el defecte conegut del lector a 600 px continuen
sent #84/#85.

## Tons de marc i contingut (#287)

El [sistema de disseny](design-system.md) defineix dos tons de superfície per a tots els
temes: el marc (finestra, capçaleres, barres i panell de carpetes) i el contingut
(llistes i lector). Oreneta Light i Dark prenen els valors aprovats el 2026-10-17: el
marc `#e3eaf4`/`#0c1526`, la selecció `#d6e3fb`/`#243a5e`, la superfície elevada blanca
en clar i la barra de mòduls `#08111f` en fosc. Els altres 14 temes donen a la capçalera el color de
fons de la finestra i set enfosqueixen el text secundari fins a 4,5:1; cap accent no canvia.
Tots els temes, i els personalitzats derivats o desats, tenen el token nou
`--me-border-input` per a la vora dels camps, derivat fins a 3:1 quan els colors ho
permeten (una vora ja desada es conserva). L'anell de focus és l'accent sòlid
i els radis passen a 4/6/8/12 px. La llavor de l'editor de temes personalitzats segueix
els valors nous d'Oreneta. Vuit temes integrats tenien l'accent per sota de 4,5:1 com a
text; el token derivat `--me-accent-fg` ho corregeix sense canviar cap accent (#311, vegeu
[design-system.md](design-system.md#laccent-com-a-text-i-com-a-anell-311)).
