# Recordatorios del calendario: suspensión, reinicio y zona horaria (#209)

Decisión: [ADR-0056](../adr/0056-reminders-across-sleep-and-time-zones.md).
Fila SET-29 del [libro de paridad](../emclient-parity-acceptance.md).

## Dónde vive

| Pieza | Qué hace |
|---|---|
| `meron-core/src/calendar/reminders.rs` | Cuándo suena un aviso en una zona (`timing`), qué avisos da una mirada (`due`) y la mirada anterior por cuenta (`previous_look`, `record_look`). |
| `meron-core/src/pim/reminders.rs` | Una mirada sobre varias cuentas (`look`): marca cada aviso como dado, anota la mirada y dice qué cuentas releer tras un cambio de zona. La usan el escritorio y el móvil (`take_due`). |
| `meron-core/src/main.rs` | El vigilante del escritorio: mira cada minuto y al recibir `system.resumed`; emite `calendar.reminder` y relee las cuentas que `look` nombra. |
| `notify.go` | La notificación: título, `local_time` y lugar. |

## Comportamiento

- **Una vez.** Cada aviso dado se anota como `<evento>@<inicio guardado>`
  (`calendar_reminders_fired`) antes de devolverlo. Un evento movido es un
  inicio nuevo y se avisa de nuevo.
- **A tiempo**: se da en la primera mirada desde su hora mientras el evento
  no ha empezado.
- **Tras una suspensión o con la aplicación cerrada**: si venció después de la
  mirada anterior y el evento sigue en curso, se da en la primera mirada al
  volver, una vez. Si el evento ya terminó, no se da. Un hueco se mira como
  mucho 14 días hacia atrás; un reloj atrasado no abre hueco.
- **Al despertar** el escritorio mira en el acto (`system.resumed`), sin
  esperar al minuto siguiente.
- **Cuenta en pausa o silenciada**: no se avisa y lo que vence entretanto no
  se guarda para después.
- **Zona horaria**:
  - evento con hora: un instante; su aviso no cambia con la zona, y
    `local_time` lo muestra en el reloj de la zona actual;
  - día completo: cuenta desde la medianoche local de la fecha en la zona
    actual. Al ir hacia el este, un aviso que la nueva zona deja atrás con el
    día ya empezado se da en ese momento, una vez; al ir hacia el oeste,
    espera a su hora allí;
  - hora flotante: se lee en la zona del equipo al leer el calendario. Tras
    un cambio de zona se releen las cuentas con calendarios CalDAV o
    suscritos, y el aviso sigue esa lectura como un evento movido.
- **Cambio de zona**: la zona actual da al instante de la mirada anterior otro
  desfase que el anotado. El horario de verano no es un cambio de zona.

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
  - reinicio: `no_reminder_fires_twice_across_a_restart_followed_by_a_resume`
    (almacén en archivo y dos motores);
  - zona: `after_a_time_zone_change_timed_reminders_keep_their_instant_and_all_day_ones_follow`,
    `a_time_zone_change_asks_once_to_reread_calendars_that_can_hold_floating_times`,
    `a_floating_event_read_again_in_the_new_zone_is_reminded_at_its_time_there`,
    `a_floating_event_reminded_before_a_move_west_is_reminded_again_at_its_new_time`,
    `an_all_day_reminder_follows_this_machines_zone` (zona del equipo, según `TZ`).
- `calendar::reminders::tests`: medianoche local de un día completo, día sin
  medianoche (Santiago de Chile), instante igual en toda zona, detección del
  cambio de zona frente al horario de verano, hueco y fin del evento, reloj
  atrasado, límite de 14 días, cambio de zona al este y al oeste.
- Binario: `system_resumed_wakes_the_reminder_watch_before_its_tick`,
  `the_reminder_watch_uses_the_shared_reminders`.
- Go: `TestReminderShowsTheCoresLocalTime`.

## Fuera de alcance

La prueba nativa en Windows (suspensión y cambio de zona reales, N4) se hace
una vez sobre la versión final.
