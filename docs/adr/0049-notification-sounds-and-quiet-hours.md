# ADR-0049: Sons de notificació, no molestar i hores de silenci

- Estat: acceptada per delegació («Tomo yo la recomendada»); pendent de
  revisió del propietari al final del pla.
- Data: 2026-10-13.
- Abast: la fila SET-01 de la paritat amb eM Client 10.4 (#114), «General →
  Notificacions». Ja existien les notificacions del sistema per al correu
  nou (que obren la conversa), el silenci per compte, amagar i mostrar
  des de la safata i els comptadors de no llegits opcionals. Faltaven els
  sons i un estat de silenci («no molestar»).

## Decisió

- **Sons:**
  - dos interruptors a Paràmetres → Notificacions: «So per al correu
    nou» i «So per als recordatoris» (de calendari i de tasques).
    Tots dos comencen **desactivats**, així ningú no sent res de nou per actualitzar;
  - quatre sons propis —campaneta, campana, pop i marimba— i un
    volum de 0 a 100 (60 per defecte), comú a tots dos. Cada fila té
    «Reproduir» per sentir-lo amb el volum triat; la prova sona sempre,
    encara que estigui en silenci;
  - els sons no són fitxers: se sintetitzen al moment amb WebAudio
    (oscil·ladors amb una envolupant curta, menys d'un segon). No hi ha
    àudio de tercers per llicenciar ni res per baixar, i la CSP de
    producció no ha de permetre res de nou: un oscil·lador no és un
    recurs multimèdia ni fa peticions;
  - sonen a la vista, amb els mateixos esdeveniments dels quals el pont Go
    treu les notificacions del sistema (`mail.newMessages`,
    `calendar.reminder` —també els del mòdul comú de recordatoris
    `pim/reminders.rs`— i `tasks.reminder`). El nucli ja posa en cada
    esdeveniment de correu si el compte està silenciat (`muted`), i un compte
    silenciat tampoc no sona.
- **No molestar:**
  - s'activa «durant 1 hora», «fins demà» (demà a les 8:00, hora
    local) o «fins que el desactivi», des de Paràmetres, des del menú «Més»
    de la barra lateral i des de la safata del sistema (una casella «No
    molestar» que l'activa fins a desactivar-lo, o el reprèn si ja ho està);
  - mentre dura: no hi ha finestres emergents del sistema, tampoc l'avís
    «correu nou» dins de l'aplicació, i no sona res. Els comptadors de no
    llegits, la icona de la safata i les llistes continuen actualitzant-se;
  - els recordatoris de calendari i tasques continuen mostrant-se (i sonant,
    si el seu so està actiu), perquè arriben a una hora concreta; una
    casella, «Mostrar els recordatoris encara que estigui en silenci» (activada
    per defecte, com a eM Client), permet silenciar-los també;
  - quan està en silenci, la barra lateral mostra un indicador (campana
    barrada) que diu fins quan, i un clic a sobre el reprèn. El menú
    «Més» i la fila de Paràmetres també ofereixen «Reprendre».
- **Hores de silenci:**
  - un horari diari opcional: hora d'inici, hora de fi i dies de la
    setmana (tots per defecte, 22:00–07:00);
  - les hores són de rellotge local: les 22:00 són les 22:00 al rellotge de paret, sigui quin sigui
    el desfasament aquell dia. Les dates es construeixen amb el constructor local
    de `Date`, que ja cau en l'instant correcte en els canvis d'hora
    (una hora que no existeix, com les 02:30 el dia que s'avança l'hora, passa a
    les 03:30; una nit de 22:00 a 07:00 dura vuit hores aquell dia i deu el que
    es retarda);
  - una fi anterior o igual a l'inici travessa la mitjanit: el període acaba
    l'endemà. Inici igual a fi és el dia sencer. El dia marcat és
    el dia en què **comença** el període: amb només feiners, la nit de
    divendres a dissabte és de silenci i la de diumenge a dilluns no;
  - «Reprendre» durant un període programat el salta fins al final; el
    següent s'aplica normalment.
- **Una sola decisió, dos llocs que l'apliquen:**
  - les regles són en una funció pura a la vista
    (`lib/quietHours.ts`: `quietStateAt`, `shouldShowNotification`,
    `soundFor`, `quietIntervals`), que rep `now` i es prova en
    qualsevol instant;
  - el pont Go, que és qui mostra les notificacions del sistema, no
    repeteix l'horari: rep per `notify.setQuiet` els intervals de
    silenci dels pròxims vuit dies (mil·lisegons, `[inicio, fin)`),
    si hi ha una pausa sense fi, si els recordatoris passen i si ara està en
    silenci (per a la casella de la safata). Només comprova si «ara»
    hi cau dins. La vista els hi envia quan canvia alguna cosa i cada hora, així el
    pont continua decidint bé encara que la finestra, amagada a la safata,
    tingui els temporitzadors alentits;
  - el silenci per compte se segueix aplicant abans, com sempre.
- **Es desa** com una fila de paràmetres (`notification_prefs`, el patró
  `DB_KEY`): els sons, el volum, la pausa (amb la seva fi, o sense fi),
  l'horari, el salt per «Reprendre» i la casella de recordatoris. Un camp
  invàlid torna al seu valor per defecte sense tocar els altres. Una pausa
  «fins que el desactivi» sobreviu al reinici.

## Alternatives descartades

- **Incloure fitxers d'àudio (WAV/OGG):** caldria revisar llicències i
  afegirien pes; per a avisos curts n'hi ha prou amb uns quants tons sintetitzats.
- **Reproduir el so des de Go amb l'API de cada sistema:** tres
  implementacions (i una dependència d'àudio a Linux) per a una cosa que el
  motor web ja fa igual a tot arreu.
- **Que la vista enviï només «en silenci sí/no» al pont:** dependria que
  la finestra es desperti just en el canvi; amb la finestra a la safata
  els seus temporitzadors es poden endarrerir i se n'escaparia una notificació.
- **Repetir l'horari a Go:** dues implementacions de la mateixa regla, amb
  canvis d'hora i mitjanit, que podrien discrepar.
- **«Fins demà» com a mitjanit:** activar-lo a les 23:30 duraria mitja
  hora. Es fa servir demà a les 8:00 i el menú ho diu.

## Pendent

- Fer servir el mode «no molestar» o «concentració» del mateix sistema (Windows,
  macOS, GNOME) per entrar-hi i sortir-ne sols.
- Un so per compte o per carpeta, i sons propis triats per la
  persona.
- La casella de la safata s'actualitza quan la vista envia l'estat; amb
  la finestra molt adormida pot anar amb retard, encara que les notificacions sí
  que se silencien a temps.
- Prova nativa a Windows (so i safata) per passar la fila a
  verificada.
