# Recordatorios del calendario: suspensión, reinicio y zona horaria (#209)

Decisión: [ADR-0056](../adr/0056-reminders-across-sleep-and-time-zones.md).
Fila SET-29 del [libro de paridad](../emclient-parity-acceptance.md).

## Dónde vive

| Pieza | Qué hace |
|---|---|
| `meron-core/src/calendar/reminders.rs` | Cuándo suena un aviso en una zona (`timing`), qué avisos da una mirada (`due`), la mirada anterior por cuenta (`previous_look`, `record_look`) y la relectura pendiente tras un cambio de zona (`mark_reread`, `reread_due`). |
| `meron-core/src/pim/reminders.rs` | Una mirada sobre varias cuentas (`look`): marca cada aviso como dado, anota la mirada si terminó bien y dice qué cuentas releer. Lo que dice cada aviso (`reminder_detail`). La usan el escritorio y el móvil (`take_due`). |
| `meron-core/src/main.rs` | El vigilante del escritorio: mira cada minuto y al recibir `system.resumed`; emite `calendar.reminder` y lanza las relecturas (`give_calendar_reminders`). |
| `notify.go` | La notificación: título, cuándo (`local_date`, `local_time`, «Empezó a las…» si `started`) y lugar. |

## Comportamiento

- **Una vez.** Cada aviso dado se anota como `<evento>@<inicio guardado>`
  (`calendar_reminders_fired`) antes de devolverlo. Un evento movido es un
  inicio nuevo y se avisa de nuevo. La anotación se borra cuando ese inicio
  y el momento en que se dio quedan más de 16 días atrás
  (`forget_old_reminders`, `GIVEN_KEPT`; #222): un aviso puesto semanas
  antes de su evento no se da dos veces, y la tabla no crece sin fin.
- **A tiempo**: se da en la primera mirada desde su hora mientras el evento
  no ha empezado.
- **Tras una suspensión o con la aplicación cerrada**: si venció después de la
  mirada anterior y el evento sigue en curso, se da en la primera mirada al
  volver, una vez, con `started: true`. Si el evento ya terminó, no se da
  (a confirmar por el propietario: eM Client y Outlook muestran los
  vencidos). Un hueco se mira como mucho 14 días hacia atrás; un reloj
  atrasado no abre hueco.
- **Al empezar** (0 minutos): se da en la primera mirada desde el inicio. Un
  evento que empieza en el mismo segundo de la mirada aún no ha empezado, así
  que también lo da una primera mirada sin otra anterior. Un evento sin
  duración cuenta como en curso durante su primer minuto.
- **Al despertar** el escritorio mira en el acto (`system.resumed`), sin
  esperar al minuto siguiente.
- **Si el almacén falla**, el aviso afectado no se da y la mirada no se
  anota: la siguiente lo da, una vez.
- **Cuenta en pausa o silenciada**: no se avisa; lo vencido entretanto no se
  da después como perdido, pero un aviso cuyo evento aún no ha empezado sí se
  da al reanudar.
- **Zona horaria**:
  - evento con hora: un instante; su aviso no cambia con la zona, y
    `local_time` lo muestra en el reloj de la zona actual;
  - día completo: cuenta desde la medianoche local de la fecha en la zona
    actual. Al ir hacia el este, un aviso que la nueva zona deja atrás con el
    día ya empezado se da en ese momento, una vez; al ir hacia el oeste,
    espera a su hora allí;
  - hora flotante: se lee en la zona del equipo al leer el calendario. Tras
    un cambio de zona, las cuentas con calendarios CalDAV o suscritos se
    releen: en el acto y cada 15 minutos hasta que todos se hayan leído
    después del cambio (en pausa, al reanudar). El aviso sigue esa lectura
    como un evento movido: si ya se dio y la nueva hora es posterior (hacia
    el oeste), se da otra vez.
- **Cambio de zona**: la zona actual da al instante de la mirada anterior otro
  desfase que el anotado. El horario de verano no es un cambio de zona.
- **Móvil**: mismas reglas; relee en su refresco de cada 15 minutos.
  Pendiente de prueba nativa: que `chrono::Local` dé la zona real en Android.

## Pruebas

Todas con reloj y zona controlados (instantes fijos y zonas con nombre), sin
esperas. CI pasa `calendar::` y `pim::reminders::` también con
`TZ=Asia/Tokyo` y `TZ=America/Los_Angeles`.

- `pim::reminders::tests`:
  - suspensión: `a_reminder_due_during_a_suspend_fires_exactly_once_after_resume`,
    `a_suspend_that_ends_before_the_event_starts_gives_the_reminder_on_waking`,
    `a_reminder_whose_event_ended_during_a_suspend_is_not_given`,
    `a_look_cut_off_before_it_was_recorded_gives_nothing_twice`,
    `a_paused_accounts_missed_reminders_are_not_saved_up`;
  - errores: `a_look_the_store_could_not_answer_is_not_recorded`,
    `a_reminder_that_could_not_be_recorded_is_given_at_the_next_look`;
  - al empezar: `an_at_the_start_reminder_is_given_when_its_event_starts`,
    `an_all_day_at_the_start_reminder_rings_at_the_local_midnight`,
    `a_zero_length_events_at_the_start_reminder_is_given_in_its_first_minute`;
  - reinicio: `no_reminder_fires_twice_across_a_restart_followed_by_a_resume`
    (almacén en archivo y dos motores);
  - registro (#222): `a_reminder_set_weeks_ahead_is_given_once`,
    `old_records_are_forgotten`, y en `calendar::tests`
    `records_of_given_reminders_are_forgotten_by_their_events_start`;
  - zona: `after_a_time_zone_change_timed_reminders_keep_their_instant_and_all_day_ones_follow`,
    `a_time_zone_change_asks_to_reread_floating_calendars_until_they_are_read`,
    `a_muted_account_reads_again_and_a_paused_one_keeps_its_zone_change_until_resumed`,
    `a_floating_event_read_again_in_the_new_zone_is_reminded_at_its_time_there`,
    `a_floating_event_reminded_before_a_move_west_is_reminded_again_at_its_new_time`,
    `an_all_day_reminder_follows_this_machines_zone` (zona del equipo, según `TZ`);
  - lo que dice: `a_reminder_detail_says_when_on_the_readers_clock`.
- `calendar::reminders::tests`: medianoche local de un día completo, día sin
  medianoche (Santiago de Chile), instante igual en toda zona, evento sin
  duración, detección del cambio de zona frente al horario de verano, cambio
  de horario entre dos miradas, mirada anotada ilegible, relectura pendiente,
  hueco y fin del evento, reloj atrasado, límite de 14 días, cambio de zona
  al este y al oeste.
- Binario: `system_resumed_wakes_the_reminder_watch_before_its_tick`,
  `a_zone_change_makes_the_reminder_watch_read_floating_calendars_again`,
  `the_reminder_watch_uses_the_shared_reminders`.
- Go: `TestReminderShowsTheCoresLocalTime`.
- Kotlin: `PimRefreshTest.theCoresLocalTimeIsKeptWhenItSaysOne`.

## Fuera de alcance

La prueba nativa en Windows y Android (suspensión y cambio de zona reales,
N4) se hace una vez sobre la versión final.
