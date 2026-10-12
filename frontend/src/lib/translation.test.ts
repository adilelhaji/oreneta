import { describe, expect, it } from 'bun:test'
import registry from '../../../meron-core/src/translation/registry.json'
import {
  bergamotBuffers,
  guessLanguage,
  MAX_TRANSLATE_CHARS,
  ModelIntegrityError,
  readModel,
  route,
  sha256Hex,
  Translator,
  type ModelPair,
  type TranslationEngine,
} from './translation'

// The same registry the core downloads from.
const pairs: ModelPair[] = Object.entries(registry).map(([key, files]) => {
  const list = Object.entries(files as Record<string, { name: string; size: number; expectedSha256Hash: string }>).map(
    ([part, f]) => ({ part, name: f.name, size: f.size, sha256: f.expectedSha256Hash }),
  )
  return {
    from: key.slice(0, 2),
    to: key.slice(2),
    files: list,
    size: list.reduce((n, f) => n + f.size, 0),
    installed: false,
  }
})

// The real engine is checked where it runs: by Node in
// build-tests/bergamot.check.mjs and in the browser by the e2e suite.

describe('which models a translation needs', () => {
  it('uses one model, or two through English, or says there is none', () => {
    expect(route(pairs, 'es', 'en')!.map((p) => p.from + p.to)).toEqual(['esen'])
    expect(route(pairs, 'es', 'de')!.map((p) => p.from + p.to)).toEqual(['esen', 'ende'])
    expect(route(pairs, 'en', 'nb')).toBeNull()
    expect(route(pairs, 'ca', 'en')).toBeNull()
    expect(route(pairs, 'es', 'es')).toBeNull()
  })
})

describe('guessing the language', () => {
  const languages = ['bg', 'cs', 'de', 'en', 'es', 'et', 'fr', 'it', 'nb', 'pl', 'pt']
  it('finds the language of an ordinary message', () => {
    expect(guessLanguage('Hola Marta, te mando el presupuesto para la cocina. Gracias por todo.', languages)).toBe('es')
    expect(guessLanguage('Bonjour, merci pour les documents. Nous avons une réunion dans la salle.', languages)).toBe(
      'fr',
    )
    expect(
      guessLanguage('Vielen Dank für die Unterlagen, wir sehen uns auf der Messe und ich bin da.', languages),
    ).toBe('de')
    expect(guessLanguage('Здравейте, изпращам ви документите за срещата.', languages)).toBe('bg')
    expect(guessLanguage('Thanks for the notes, I will have the report with you this week.', languages)).toBe('en')
  })

  it('does not guess from too little', () => {
    expect(guessLanguage('OK', languages)).toBeNull()
    expect(guessLanguage('12345 — 67', languages)).toBeNull()
  })
})

describe('models are checked before use', () => {
  const bytes = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer
  const pairOf = async (files: Record<string, string>): Promise<ModelPair> => ({
    from: 'xx',
    to: 'yy',
    size: 0,
    installed: true,
    files: await Promise.all(
      Object.entries(files).map(async ([part, text]) => ({
        part,
        name: `${part}.bin`,
        size: text.length,
        sha256: await sha256Hex(bytes(text)),
      })),
    ),
  })

  it('reads a model whose files match, from the app, never another host', async () => {
    const pair = await pairOf({ model: 'm', lex: 'l', vocab: 'v' })
    const asked: string[] = []
    const buffers = await readModel(pair, async (p) => {
      asked.push(p)
      return bytes(p.split('/').pop()![0])
    })
    expect(asked).toEqual(['/models/xxyy/model.bin', '/models/xxyy/lex.bin', '/models/xxyy/vocab.bin'])
    expect(bergamotBuffers(buffers).vocabs).toHaveLength(1)
  })

  it('refuses a file changed on disk since it was installed', async () => {
    const pair = await pairOf({ model: 'm', lex: 'l', vocab: 'v' })
    await expect(readModel(pair, async (p) => bytes(p.includes('lex') ? 'X' : p.split('/').pop()![0]))).rejects.toThrow(
      ModelIntegrityError,
    )
  })

  it('uses separate vocabularies when a model has them', () => {
    const b = (s: string) => bytes(s)
    expect(bergamotBuffers({ model: b('m'), lex: b('l'), srcvocab: b('s'), trgvocab: b('t') }).vocabs).toHaveLength(2)
    expect(() => bergamotBuffers({ model: b('m'), lex: b('l') })).toThrow()
  })
})

describe('the translator', () => {
  const fake = () => {
    const calls = { load: 0, translate: 0, stop: 0 }
    const engine: TranslationEngine = {
      load: async () => void calls.load++,
      translate: async (_models, texts) => {
        calls.translate++
        await new Promise((r) => setTimeout(r, 20))
        return texts.map((t) => t.text.toUpperCase())
      },
      stop: () => void calls.stop++,
    }
    return { engine, calls }
  }
  const model: ModelPair = { from: 'es', to: 'en', files: [], size: 0, installed: true }

  it('loads a model once and translates', async () => {
    const { engine, calls } = fake()
    const translator = new Translator(
      async () => engine,
      async () => new ArrayBuffer(0),
    )
    expect(await translator.translate('hola', [model], false)).toEqual({ state: 'done', text: 'HOLA' })
    await translator.translate('adiós', [model], false)
    expect(calls.load).toBe(1)
  })

  it('stopping ends the translation under way', async () => {
    const { engine, calls } = fake()
    const translator = new Translator(
      async () => engine,
      async () => new ArrayBuffer(0),
    )
    const pending = translator.translate('hola', [model], false)
    await new Promise((r) => setTimeout(r, 5))
    translator.stop()
    expect(await pending).toEqual({ state: 'stopped' })
    await new Promise((r) => setTimeout(r, 0))
    expect(calls.stop).toBe(1)
  })

  it('declines a text too long to translate as a whole', async () => {
    const { engine } = fake()
    const translator = new Translator(
      async () => engine,
      async () => new ArrayBuffer(0),
    )
    expect(await translator.translate('a'.repeat(MAX_TRANSLATE_CHARS + 1), [model], false)).toEqual({
      state: 'tooLong',
      limit: MAX_TRANSLATE_CHARS,
    })
  })
})
