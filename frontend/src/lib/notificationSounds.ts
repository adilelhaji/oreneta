// The notification sounds (ADR-0049). Each one is a few notes synthesized with
// WebAudio oscillators at play time: nothing is fetched or bundled, so there is
// no audio file to license and nothing for the CSP to allow (an oscillator is
// not a media source).

import type { NotificationSoundId } from './quietHours'

type Note = {
  /** Hz. */
  freq: number
  /** Seconds from the start of the sound. */
  at: number
  /** Seconds until it has faded out. */
  length: number
  wave: OscillatorType
  /** Relative loudness of this note, 0–1. */
  level: number
}

const note = (freq: number, at: number, length: number, wave: OscillatorType = 'sine', level = 1): Note => ({
  freq,
  at,
  length,
  wave,
  level,
})

/** Short, soft and distinct from each other; none lasts over a second. */
export const SOUND_NOTES: Record<NotificationSoundId, Note[]> = {
  // Two rising notes (E6, A6).
  chime: [note(1318.5, 0, 0.35), note(1760, 0.12, 0.5)],
  // A struck bell: fundamental plus an inharmonic partial, long tail.
  bell: [note(880, 0, 0.9), note(880 * 2.76, 0, 0.45, 'sine', 0.35), note(880 * 5.4, 0, 0.2, 'sine', 0.15)],
  // A single short blip.
  pop: [note(660, 0, 0.12, 'triangle'), note(990, 0.03, 0.1, 'triangle', 0.5)],
  // Three quick wooden notes (C6, E6, G6).
  marimba: [note(1046.5, 0, 0.22, 'triangle'), note(1318.5, 0.1, 0.22, 'triangle'), note(1568, 0.2, 0.3, 'triangle')],
}

type AudioContextLike = Pick<AudioContext, 'currentTime' | 'destination' | 'createOscillator' | 'createGain'> & {
  state?: AudioContextState
  resume?: () => Promise<void>
}

let shared: AudioContextLike | null = null

function defaultContext(): AudioContextLike | null {
  if (shared) return shared
  const Ctor = (globalThis as any).AudioContext ?? (globalThis as any).webkitAudioContext
  if (!Ctor) return null
  try {
    shared = new Ctor() as AudioContextLike
  } catch {
    return null
  }
  return shared
}

/**
 * Play `id` at `volume` (0–100). Returns false when nothing could play (no
 * WebAudio, volume 0). Never throws: a sound is a nicety, not worth an error.
 */
export function synthesizeSound(
  id: NotificationSoundId,
  volume: number,
  context: AudioContextLike | null = defaultContext(),
): boolean {
  const notes = SOUND_NOTES[id]
  if (!context || !notes || volume <= 0) return false
  try {
    // A context made before any click starts suspended in some engines.
    if (context.state === 'suspended') void context.resume?.().catch(() => {})
    // Perceived loudness is roughly logarithmic; square the slider so its
    // lower half is still usable, and keep the top well short of clipping.
    const master = Math.min(1, volume / 100) ** 2 * 0.4
    const t0 = context.currentTime
    for (const n of notes) {
      const osc = context.createOscillator()
      const gain = context.createGain()
      osc.type = n.wave
      osc.frequency.setValueAtTime(n.freq, t0 + n.at)
      const peak = Math.max(0.0001, master * n.level)
      gain.gain.setValueAtTime(0.0001, t0 + n.at)
      gain.gain.exponentialRampToValueAtTime(peak, t0 + n.at + 0.01)
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + n.at + n.length)
      osc.connect(gain)
      gain.connect(context.destination)
      osc.start(t0 + n.at)
      osc.stop(t0 + n.at + n.length + 0.05)
    }
    return true
  } catch {
    return false
  }
}

/**
 * The one way the app plays a sound. An object rather than a bare function so
 * tests can replace `play` and assert what would have sounded.
 */
export const soundPlayer = {
  play: (id: NotificationSoundId, volume: number): boolean => synthesizeSound(id, volume),
}
