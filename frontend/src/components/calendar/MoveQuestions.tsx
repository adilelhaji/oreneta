import { useValue } from '@legendapp/state/react'
import i18n, { useTranslation } from '../../lib/i18n'
import { answerNotify, answerScope, cancelMove, move$ } from '../../states/calendarMove'
import { NotifyAsk } from './NotifyAsk'
import { ScopeAsk } from './ScopeAsk'
import { formatTime } from './AgendaView'

/// The questions a move or a resize on the grid raises (#266), the same ones
/// the editor asks: which occurrences of a series, then whether to tell the
/// people on it. Cancelling either gives the move up, and nothing is written.
export function MoveQuestions() {
  const question = useValue(move$.question)
  if (!question) return null
  if (question.kind === 'scope') return <ScopeAsk action="save" onChoose={answerScope} onCancel={cancelMove} />
  return (
    <NotifyAsk
      action="save"
      people={question.people}
      from={question.from}
      onChoose={answerNotify}
      onCancel={cancelMove}
    />
  )
}

/// Says where the event in hand would land, for a keyboard move above all:
/// the event itself stays where it is until the move is saved, so this line is
/// what tells a screen reader, and anyone watching, what Enter will do. The
/// live region is always there, so what appears in it is announced; a pointer
/// drag is shown beside it rather than in it, since it would read out every
/// step the pointer crosses.
export function MoveStatus() {
  const { t } = useTranslation()
  const moving = useValue(move$.moving)
  let text = ''
  if (moving && !moving.settled) {
    const day = new Date(moving.start * 1000).toLocaleDateString(i18n.language.replace('_', '-'), {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      ...(moving.event.all_day ? { timeZone: 'UTC' } : {}),
    })
    const when = moving.event.all_day ? day : `${day}, ${formatTime(moving.start)}–${formatTime(moving.end)}`
    const subject = moving.event.subject || t('calendar.noSubject', { defaultValue: '(no subject)' })
    text =
      moving.via === 'keyboard'
        ? t('calendar.moveStatusKeyboard', {
            subject,
            when,
            defaultValue: '{subject}: {when}. Press Enter to save the change or Escape to cancel it.',
          })
        : t('calendar.moveStatusPointer', {
            subject,
            when,
            defaultValue: '{subject}: {when}. Release to move it there; press Escape to cancel.',
          })
  }
  const bar = 'shrink-0 wrap-anywhere border-b border-accent/30 bg-accent/10 px-4 py-1.5 text-caption text-primary'
  const keyboard = moving?.via === 'keyboard'
  return (
    <>
      <div role="status" className="shrink-0">
        {text && keyboard && (
          <p data-move-status className={bar}>
            {text}
          </p>
        )}
      </div>
      {text && !keyboard && (
        <p data-move-status className={bar}>
          {text}
        </p>
      )}
    </>
  )
}
