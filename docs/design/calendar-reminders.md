# Recordatoris del calendari: suspensió, reinici i zona horària (#209, #225)

Decisió: [ADR-0056](../adr/0056-reminders-across-sleep-and-time-zones.md).
Fila SET-29 del [registre d'acceptació de paritat](../emclient-parity-acceptance.md).

## On es troba

| Peça | Què fa |
|---|---|
| `meron-core/src/calendar/reminders.rs` | Quan sona un avís en una zona (`timing`), quins avisos dona una comprovació i quins són perduts (`due`, `Due::missed`), la comprovació anterior per compte (`previous_look`, `record_look`) i la relectura pendent després d'un canvi de zona (`mark_reread`, `reread_due`). |
| `meron-core/src/pim/reminders.rs` | Una comprovació sobre diversos comptes (`look`): marca cada avís com a donat, aplega els perduts en un avís (`Look::missed`), anota la comprovació si ha acabat bé i indica quins comptes cal rellegir. El que diu cada avís (`reminder_detail`). La fan servir l'escriptori i el mòbil (`take_due`, sense perduts). |
| `meron-core/src/main.rs` | El vigilant de l'escriptori: comprova cada minut i en rebre `system.resumed`; emet `calendar.reminder` i `calendar.missedReminders` i llança les relectures (`give_calendar_reminders`). |
| `notify.go` | La notificació: títol, quan (`local_date`, `local_time`, «Ha començat a les…» si `started`) i lloc, com a text d'una línia (`notificationLine`). |
| `notify_missed.go` | L'avís de perduts: el guarda fins que el pot mostrar (idioma i pla de silenci en arrencar, fi de les hores de silenci), suma per clau els que arriben mentrestant, el mostra (`showMissedReminders`) i en confirma les claus al nucli (`reminders.missedShown`). |
| `frontend/src/states/notificationClick.ts`, `calendar.ts` | El clic en una notificació (`onNotificationClicked`); el de perduts obre el calendari (`openCalendarFromNotification`). |

## Comportament

- **Una vegada.** Cada avís donat s'anota com a `<esdeveniment>@<inici desat>`
  (`calendar_reminders_fired`) abans de retornar-lo. Un esdeveniment mogut és
  un inici nou i se n'avisa de nou. L'anotació s'esborra quan aquell inici i el
  moment en què es va donar queden més de 16 dies enrere
  (`forget_old_reminders`, `GIVEN_KEPT`; #222): un avís configurat setmanes
  abans de l'esdeveniment no es dona dues vegades, i la taula no creix
  indefinidament.
- **A temps**: es dona a la primera comprovació des de la seva hora mentre
  l'esdeveniment no ha començat.
- **Després d'una suspensió o amb l'aplicació tancada**: si ha vençut després de
  la comprovació anterior i l'esdeveniment continua en curs, es dona a la
  primera comprovació en tornar, una vegada, amb `started: true`. Un buit es
  revisa com a màxim 14 dies enrere; un rellotge endarrerit no obre cap buit.
- **Perduts** (#225): si l'esdeveniment ja ha acabat, l'avís és un perdut (una
  reunió rebutjada, no). Tots els perduts d'una comprovació, de tots els
  comptes, surten en un sol `calendar.missedReminders` (`count`, `day`,
  `first_day`, els 20 més recents a `reminders`), una sola notificació:
  «N avisos perduts» i, un per línia i del més recent al més antic, quan i què
  (fins a 5, després «…»). En prémer-la s'obre el calendari al dia més recent,
  o a la seva setmana si hi ha perduts de més dies. Go no el descarta mai: el
  guarda en arrencar fins que coneix l'idioma i el pla de silenci (30 s com a
  màxim) i durant les hores de silenci, sumant per clau els que arribin. Cada
  un s'anota com a donat i, en la mateixa transacció, es desa a `meta`
  (`reminders.missed`) fins que Go confirma que ha mostrat l'avís
  (`reminders.missedShown`): el vigilant el torna a dir en arrencar, de manera
  que tancar l'aplicació abans de mostrar-lo no el perd, i un cop confirmat ja
  no es diu més. No es repeteix després d'una altra comprovació, d'un reinici
  o d'un despertar. «Més recent» es determina per `at`, l'inici a la zona actual. Sense
  comprovació anterior no hi ha perduts. El mòbil encara no els mostra (els
  deixa sense anotar, com abans).
- **El que hi ha en comprovar**: en despertar-se es comprova abans de rellegir
  els calendaris, de manera que una reunió cancel·lada o moguda mentre l'equip
  dormia pot sortir com a perduda; i un esdeveniment passat que arriba dins del
  buit (una sincronització, un calendari que es torna a mostrar) surt com a
  perdut si el seu avís ha vençut i l'esdeveniment ha acabat dins del buit.
- **En començar** (0 minuts): es dona a la primera comprovació des de l'inici.
  Un esdeveniment que comença en el mateix segon de la comprovació encara no ha
  començat, de manera que també el dona una primera comprovació sense cap
  d'anterior. Un esdeveniment sense durada es considera en curs durant el seu
  primer minut.
- **En despertar-se**, l'escriptori comprova immediatament (`system.resumed`),
  sense esperar el minut següent.
- **Si el magatzem falla**, l'avís afectat no es dona i la comprovació no
  s'anota: la següent el dona, una vegada.
- **Compte en pausa o silenciat**: no s'avisa ni surt a l'avís de perduts; el
  que ha vençut mentrestant no es dona després com a perdut, però un avís
  l'esdeveniment del qual encara no ha començat sí que es dona en reprendre'l.
- **Zona horària**:
  - esdeveniment amb hora: un instant; el seu avís no canvia amb la zona, i
    `local_time` el mostra amb el rellotge de la zona actual;
  - dia sencer: compta des de la mitjanit local de la data a la zona actual.
    En anar cap a l'est, un avís que la nova zona deixa enrere amb el dia ja
    començat es dona en aquell moment, una vegada; en anar cap a l'oest, espera
    la seva hora allà;
  - hora flotant: es llegeix a la zona de l'equip en llegir el calendari.
    Després d'un canvi de zona, els comptes amb calendaris CalDAV o subscrits
    es rellegeixen: immediatament i cada 15 minuts fins que tots s'hagin
    llegit després del canvi (si estan en pausa, en reprendre'ls). L'avís
    segueix aquesta lectura com un esdeveniment mogut: si ja s'havia donat i la
    nova hora és posterior (cap a l'oest), es torna a donar.
- **Canvi de zona**: la zona actual dona a l'instant de la comprovació anterior
  un desfasament diferent de l'anotat. L'horari d'estiu no és un canvi de zona.
- **Mòbil**: les mateixes regles excepte els perduts (encara sense avís agrupat
  a Android i iOS; `pim.refresh` no canvia); rellegeix en l'actualització de
  cada 15 minuts. Pendent de prova nativa: que `chrono::Local` doni la zona
  real a Android.

## Proves

Totes amb el rellotge i la zona controlats (instants fixos i zones amb nom),
sense esperes. La CI executa `calendar::` i `pim::reminders::` també amb
`TZ=Asia/Tokyo`, `TZ=America/Los_Angeles` i `TZ=Pacific/Auckland` (UTC+12
o +13, #221).

- `pim::reminders::tests`:
  - suspensió: `a_reminder_due_during_a_suspend_fires_exactly_once_after_resume`,
    `a_suspend_that_ends_before_the_event_starts_gives_the_reminder_on_waking`,
    `a_look_cut_off_before_it_was_recorded_gives_nothing_twice`,
    `a_paused_accounts_missed_reminders_are_not_saved_up`;
  - errors: `a_look_the_store_could_not_answer_is_not_recorded`,
    `a_reminder_that_could_not_be_recorded_is_given_at_the_next_look`;
  - en començar: `an_at_the_start_reminder_is_given_when_its_event_starts`,
    `an_all_day_at_the_start_reminder_rings_at_the_local_midnight`,
    `a_zero_length_events_at_the_start_reminder_is_given_in_its_first_minute`;
  - reinici: `no_reminder_fires_twice_across_a_restart_followed_by_a_resume`
    (magatzem en fitxer i dos motors);
  - registre (#222): `a_reminder_set_weeks_ahead_is_given_once`,
    `old_records_are_forgotten`, i a `calendar::tests`
    `records_of_given_reminders_are_forgotten_by_their_events_start`;
  - zona: `after_a_time_zone_change_timed_reminders_keep_their_instant_and_all_day_ones_follow`,
    `a_time_zone_change_asks_to_reread_floating_calendars_until_they_are_read`,
    `a_muted_account_reads_again_and_a_paused_one_keeps_its_zone_change_until_resumed`,
    `a_floating_event_read_again_in_the_new_zone_is_reminded_at_its_time_there`,
    `a_floating_event_reminded_before_a_move_west_is_reminded_again_at_its_new_time`,
    `an_all_day_reminder_follows_this_machines_zone` (zona de l'equip, segons `TZ`);
  - el que diu: `a_reminder_detail_says_when_on_the_readers_clock`;
  - perduts (#225):
    `a_reminder_whose_event_ended_during_a_suspend_is_given_once_in_the_missed_notice`,
    `several_missed_reminders_make_exactly_one_notice_with_all_of_them`,
    `a_reminder_still_on_is_given_on_its_own_beside_the_missed_notice`,
    `a_paused_or_muted_account_shows_no_missed_reminders`,
    `a_missed_reminder_is_not_given_twice_across_a_restart_followed_by_a_resume`,
    `a_missed_reminder_that_could_not_be_recorded_is_in_the_next_notice`,
    `a_notice_details_the_most_recent_missed_reminders_and_counts_them_all`,
    `an_event_synced_in_or_shown_again_during_the_gap_is_reported_as_missed`,
    `a_notice_held_when_the_host_quit_is_said_again_until_shown`,
    `reminders_not_yet_shown_stay_in_later_notices_until_confirmed`,
    `newest_first_is_by_the_local_start_of_each_event`,
    `reminders_kept_unshown_are_let_go_after_the_gap_a_look_looks_into`,
    `the_phones_look_leaves_missed_reminders_as_before`.
- `calendar::reminders::tests`: mitjanit local d'un dia sencer, dia sense
  mitjanit (Santiago de Xile), instant igual a totes les zones, esdeveniment
  sense durada, detecció del canvi de zona davant de l'horari d'estiu, canvi
  d'horari entre dues comprovacions, comprovació anotada il·legible, relectura
  pendent, buit i fi de l'esdeveniment (i quan un avís passa a perdut),
  rellotge endarrerit, límit de 14 dies, canvi de zona cap a l'est i cap a
  l'oest, sense perduts en una primera comprovació ni d'abans de la
  comprovació anterior, ni reunions rebutjades.
- Binari: `system_resumed_wakes_the_reminder_watch_before_its_tick`,
  `a_zone_change_makes_the_reminder_watch_read_floating_calendars_again`,
  `the_reminder_watch_uses_the_shared_reminders`,
  `the_reminder_watch_gathers_missed_reminders_into_one_notice`.
- Go: `TestReminderShowsTheCoresLocalTime`, i a `notify_missed_test.go`
  `TestMissedRemindersMakeOneNotificationThatOpensTheCalendar`,
  `TestMissedAndSingleRemindersShowSubjectsAsOneLineOfText`,
  `TestMissedRemindersWaitForQuietHoursToEnd`,
  `TestMissedRemindersWaitAtStartForTheLanguageAndTheQuietPlan`,
  `TestMissedRemindersGoAfterThirtySecondsWithoutTheFrontend`,
  `TestMissedRemindersTitleWithoutPluralForms`,
  `TestMergedMissedNoticesKeepTheNewestTwentyAndSpanTheirDays`,
  `TestMissedRemindersAreMergedByKeyAndConfirmedOnceShown`,
  `TestMergedMissedNoticesOrderByTheLocalStart`.
- Interfície: `calendarNotification.test.ts` (el clic, per
  `onNotificationClicked`, obre el dia o la setmana), `notifications.test.ts`
  (sona quan Go el mostra).
- Kotlin: `PimRefreshTest.theCoresLocalTimeIsKeptWhenItSaysOne`.

## Fora d'abast

La prova nativa a Windows i Android (suspensió i canvi de zona reals, N4) es fa
una vegada sobre la versió final.
