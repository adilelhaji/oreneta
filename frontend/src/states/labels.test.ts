import { beforeEach, describe, expect, it } from 'bun:test'
import { assignLabels, LABEL_COLOURS, labelById, labels$, loadLabels, newLabel, saveLabels } from './labels'
import { mail$ } from './mail'
import { activeLabelId, nextFilters } from './ui'
import type { Label } from './labels'

const label = (id: string, name: string): Label => ({ id, name, colour: '#2056dd' })

describe('names the reader puts on conversations', () => {
  const calls: { command: string; payload: any }[] = []
  let answer: (command: string) => any = () => ({ ok: true })

  beforeEach(() => {
    calls.length = 0
    answer = () => ({ ok: true })
    labels$.labels.set([])
    labels$.loaded.set(false)
    mail$.threads.set([])
    ;(window as any).go = {
      main: {
        App: {
          Invoke: async (command: string, payload: any) => {
            calls.push({ command, payload })
            return answer(command)
          },
        },
      },
    }
  })

  it('gives a new label a colour that is not the last one used', () => {
    const first = newLabel([])
    const second = newLabel([first])
    expect(first.colour).toBe(LABEL_COLOURS[0])
    expect(second.colour).toBe(LABEL_COLOURS[1])
    expect(first.id).not.toBe(newLabel([]).id)
  })

  it('keeps the last known labels when they cannot be read', async () => {
    labels$.labels.set([label('l-1', 'Work')])
    answer = () => {
      throw new Error('engine unavailable')
    }

    await loadLabels()

    // Showing none would invite making them again on top of the ones already
    // there.
    expect(labels$.labels.peek()).toHaveLength(1)
  })

  it('does not save a label with no name', async () => {
    await saveLabels([label('l-1', 'Work'), label('l-2', '  ')])

    const saved = calls.find((call) => call.command === 'labels.save')
    expect(saved?.payload.labels.map((l: Label) => l.id)).toEqual(['l-1'])
  })

  it('takes a deleted label off the conversations on screen', async () => {
    mail$.threads.set([
      { thread_id: 't-1', labels: ['l-1', 'l-2'] },
      { thread_id: 't-2', labels: ['l-2'] },
    ] as any)

    await saveLabels([label('l-2', 'Home')])

    // The rows were painted from an answer that is no longer true.
    expect(mail$.threads.peek()[0].labels).toEqual(['l-2'])
    expect(mail$.threads.peek()[1].labels).toEqual(['l-2'])
  })

  it('repaints a conversation from what the core stored, not what was asked', async () => {
    mail$.threads.set([{ thread_id: 't-1', labels: [] }] as any)
    // The core drops a label that no longer exists; the row must not show it
    // sticking.
    answer = () => ({ labels: ['l-1'] })

    const applied = await assignLabels('t-1', ['l-1', 'l-gone'])

    expect(applied).toEqual(['l-1'])
    expect(mail$.threads.peek()[0].labels).toEqual(['l-1'])
  })

  it('finds a label by id and shrugs off one that is gone', () => {
    const labels = [label('l-1', 'Work')]
    expect(labelById(labels, 'l-1')?.name).toBe('Work')
    expect(labelById(labels, 'l-9')).toBeUndefined()
  })

  it('narrows to one label at a time', () => {
    // Two would mean a conversation carrying both, which is almost never what
    // someone picking a second one meant.
    const one = nextFilters(['unread'], 'label:l-1')
    expect(one).toEqual(['unread', 'label:l-1'])
    expect(nextFilters(one, 'label:l-2')).toEqual(['unread', 'label:l-2'])
    expect(activeLabelId(one)).toBe('l-1')
    expect(activeLabelId(['unread'])).toBe('')
    // And picking the same one again lets it go.
    expect(nextFilters(one, 'label:l-1')).toEqual(['unread'])
  })
})
