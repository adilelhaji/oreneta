import { expect, it } from 'bun:test'
import { SOUND_NOTES, synthesizeSound } from './notificationSounds'
import { NOTIFICATION_SOUNDS } from './quietHours'

/** Records what an AudioContext would have been asked to do. */
function fakeContext(state: AudioContextState = 'running') {
  const log = { oscillators: [] as any[], peaks: [] as number[], resumed: 0 }
  const param = () => ({
    setValueAtTime: (value: number) => log.peaks.push(value),
    exponentialRampToValueAtTime: (value: number) => log.peaks.push(value),
  })
  const context = {
    state,
    currentTime: 10,
    destination: {} as AudioDestinationNode,
    resume: async () => {
      log.resumed++
    },
    createOscillator: () => {
      const osc = {
        type: 'sine',
        frequency: { setValueAtTime: (hz: number) => (osc.hz = hz) },
        hz: 0,
        startedAt: -1,
        stoppedAt: -1,
        connect: () => {},
        start: (at: number) => (osc.startedAt = at),
        stop: (at: number) => (osc.stoppedAt = at),
      }
      log.oscillators.push(osc)
      return osc as unknown as OscillatorNode
    },
    createGain: () => ({ gain: param(), connect: () => {} }) as unknown as GainNode,
  }
  return { context, log }
}

it('every bundled sound is a few short synthesized notes, under a second', () => {
  for (const id of NOTIFICATION_SOUNDS) {
    const notes = SOUND_NOTES[id]
    expect(notes.length).toBeGreaterThan(0)
    for (const n of notes) expect(n.at + n.length).toBeLessThanOrEqual(1)
  }
})

it('schedules one oscillator per note from the current time', () => {
  const { context, log } = fakeContext()
  expect(synthesizeSound('chime', 60, context)).toBe(true)
  expect(log.oscillators).toHaveLength(SOUND_NOTES.chime.length)
  expect(log.oscillators.map((osc) => osc.hz)).toEqual(SOUND_NOTES.chime.map((n) => n.freq))
  expect(log.oscillators[1].startedAt).toBeCloseTo(10 + SOUND_NOTES.chime[1].at)
  for (const osc of log.oscillators) expect(osc.stoppedAt).toBeGreaterThan(osc.startedAt)
})

it('the volume scales the peak, and zero plays nothing', () => {
  const quiet = fakeContext()
  const loud = fakeContext()
  synthesizeSound('pop', 20, quiet.context)
  synthesizeSound('pop', 100, loud.context)
  expect(Math.max(...loud.log.peaks)).toBeGreaterThan(Math.max(...quiet.log.peaks))
  expect(Math.max(...loud.log.peaks)).toBeLessThanOrEqual(0.4)
  const silent = fakeContext()
  expect(synthesizeSound('pop', 0, silent.context)).toBe(false)
  expect(silent.log.oscillators).toHaveLength(0)
})

it('wakes a suspended context, and is a no-op without WebAudio', () => {
  const { context, log } = fakeContext('suspended')
  synthesizeSound('bell', 50, context)
  expect(log.resumed).toBe(1)
  expect(synthesizeSound('bell', 50, null)).toBe(false)
})
