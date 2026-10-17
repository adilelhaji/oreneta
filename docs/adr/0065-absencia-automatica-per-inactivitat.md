# ADR-0065: Absència automàtica per inactivitat al xat

- Estat: **proposada**; espera la decisió del propietari. No hi ha codi
  d'aquesta part fins que es decideixi.
- Data: 2026-10-17.
- Abast: #256, filla de #111 (fila SET-21, «Xat → General» d'eM Client 10.4).
  És l'últim punt pendent de l'ADR-0055 («Absent per inactivitat»); els altres
  tres els resol l'ADR-0064.

## Context

eM Client posa l'estat del xat a «Absent» quan l'ordinador fa una estona que
no s'usa i el torna a «Disponible» quan es torna a usar. Per fer-ho cal saber
quant de temps fa que la persona no toca el teclat ni el ratolí **a tot
l'ordinador**, no només a la finestra d'Oreneta. Avui cap part de l'aplicació
ho sap: el pont Go només escolta quan la màquina es desperta (`power_*.go`), i
la vista web només veu el que passa dins la seva finestra.

Les normes del projecte demanen aturar-se abans d'afegir una API nova del
sistema o una dependència, i deixar-ho decidit en un ADR.

## El que es faria en qualsevol opció

- Un paràmetre per compte, desactivat per defecte: «Posa'm absent després de
  N minuts d'inactivitat» (per exemple 5, 10, 15 o 30).
- L'estat automàtic **no substitueix el desat**: el nucli anuncia «Absent»
  mentre dura la inactivitat i torna a l'estat triat en tornar. No toca mai
  «Ocupat» ni «Invisible», ni un «Absent» triat per la persona.
- Als grups només arriba la disponibilitat, com ara (ADR-0055).
- Si la plataforma no sap dir la inactivitat, l'opció es mostra desactivada amb
  el motiu: inactivitat **desconeguda** no és inactivitat, i mai no posa ningú
  absent per suposició.

## Opcions

- **A) El pont Go llegeix la inactivitat del sistema i la passa al nucli**
  (recomanada):
  - Windows: `GetLastInputInfo` de `user32.dll`, que el pont ja carrega amb
    `golang.org/x/sys/windows` (cap dependència nova);
  - macOS: `CGEventSourceSecondsSinceLastEventType` (CoreGraphics) per cgo, com
    els fitxers `.m` que ja hi ha (`power_darwin.m`, `notify_darwin.m`); cal
    enllaçar el marc CoreGraphics;
  - Linux: per D-Bus de sessió, amb `godbus` (ja és dependència):
    `org.gnome.Mutter.IdleMonitor.GetIdletime` a GNOME i
    `org.freedesktop.ScreenSaver.GetSessionIdleTime` a KDE; en altres escriptoris
    de Wayland no hi ha una interfície comuna, i allà l'opció quedaria
    desactivada amb el motiu;
  - el pont la consulta cada 30 s i envia al nucli `chat.idle` (segons, o
    «desconegut»); el nucli decideix i anuncia;
  - cost: tres implementacions nadiues i la seva verificació nativa (N4 a
    Windows encara no existeix).
- **B) Només l'activitat dins la finestra d'Oreneta** (teclat, ratolí i focus a
  la vista web):
  - cap API nova; però algú que treballa en una altra aplicació sortiria
    «Absent» als seus contactes, que és una informació falsa;
  - es podria limitar a «la finestra no té el focus i fa N minuts», que continua
    sent una suposició.
- **C) No fer-ho:** SET-21 es queda `partial` per aquest punt.

## Recomanació

A, amb Windows primer (és la plataforma de la fila SET-21 i no necessita cap
dependència nova), i macOS i Linux en el mateix canvi o com a filles; on no es
pugui saber, l'opció desactivada amb el motiu. B es descarta perquè anunciaria
als contactes un estat que no és cert.

## Decisió

Pendent del propietari.
