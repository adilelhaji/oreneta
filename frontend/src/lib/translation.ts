// Offline translation with Bergamot (#106, ADR-0031).
//
// Bergamot runs here, in a worker, from the WebAssembly shipped with the app.
// Its models are downloaded only when the person asks for a language, by the
// core, from the one source in the bundled registry; the core checks every
// file before putting it in place, and each file is checked again here before
// it is loaded. Once a model is here, translating needs no network.

export type ModelFile = { part: string; name: string; size: number; sha256: string }
export type ModelPair = { from: string; to: string; files: ModelFile[]; size: number; installed: boolean }

export type TranslationStatus = {
  pairs: ModelPair[]
  languages: string[]
  used: number
  quota: number
  source: string
  downloading: Record<string, { done: number; total: number }>
}

export const pairKey = (pair: { from: string; to: string }) => `${pair.from}${pair.to}`

/** The models a translation needs: one, or two through English. Null when
 * no model covers the pair. */
export function route<P extends { from: string; to: string }>(pairs: P[], from: string, to: string): P[] | null {
  if (from === to) return null
  const find = (a: string, b: string) => pairs.find((p) => p.from === a && p.to === b)
  const direct = find(from, to)
  if (direct) return [direct]
  const first = find(from, 'en')
  const second = find('en', to)
  return first && second ? [first, second] : null
}

/** Longer than this is not translated as a whole: it would keep a core busy
 * for minutes. */
export const MAX_TRANSLATE_CHARS = 100_000

/** The text of translated HTML, a line per block: for the plain view and
 * for reading a translation before it is used. */
export function plainTextOf(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  for (const block of doc.querySelectorAll('p, div, br, li, tr, h1, h2, h3, h4, h5, h6, blockquote')) {
    block.append('\n')
  }
  return (doc.body.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim()
}

// ---- Guessing the language ----------------------------------------------------

// The commonest short words of each language a model exists for. Bergamot
// does not say what language a text is in; this guess only picks the default,
// and the person can always change it.
const COMMON: Record<string, string[]> = {
  cs: ['a', 'je', 'se', 'na', 'že', 'to', 'v', 'jsem', 'pro', 'ale', 'jak', 'není', 'bych', 'také', 'děkuji'],
  de: ['der', 'die', 'und', 'ich', 'nicht', 'das', 'ist', 'mit', 'sie', 'für', 'wir', 'auf', 'ein', 'eine', 'den'],
  en: ['the', 'and', 'you', 'is', 'to', 'of', 'for', 'that', 'with', 'this', 'are', 'have', 'it', 'be', 'will'],
  es: ['el', 'la', 'que', 'de', 'y', 'los', 'por', 'para', 'con', 'una', 'te', 'las', 'del', 'es', 'gracias'],
  et: ['ja', 'on', 'et', 'ei', 'see', 'ka', 'kui', 'oma', 'mis', 'aga', 'ma', 'sa', 'tänan', 'või', 'oli'],
  fr: ['le', 'la', 'les', 'et', 'des', 'est', 'pour', 'que', 'une', 'vous', 'pas', 'nous', 'avec', 'dans', 'merci'],
  it: ['il', 'di', 'che', 'e', 'la', 'per', 'non', 'sono', 'una', 'con', 'grazie', 'del', 'gli', 'ti', 'mi'],
  nb: ['og', 'jeg', 'det', 'er', 'ikke', 'på', 'til', 'med', 'som', 'en', 'har', 'vi', 'av', 'for', 'takk'],
  pl: ['i', 'w', 'nie', 'się', 'na', 'jest', 'że', 'to', 'do', 'z', 'jak', 'dla', 'ale', 'dziękuję', 'mam'],
  pt: ['o', 'a', 'que', 'de', 'e', 'não', 'para', 'com', 'um', 'uma', 'os', 'do', 'da', 'obrigado', 'você'],
}

/** The likeliest of `languages` for a text, or null when nothing stands out. */
export function guessLanguage(text: string, languages: string[]): string | null {
  const sample = text.slice(0, 4000).toLowerCase()
  // Bulgarian is the only language here written in Cyrillic.
  const cyrillic = (sample.match(/[Ѐ-ӿ]/g) ?? []).length
  const latin = (sample.match(/[a-zÀ-ɏ]/g) ?? []).length
  if (cyrillic > latin && languages.includes('bg')) return 'bg'
  const words = sample.split(/[^a-zÀ-ɏ]+/).filter(Boolean)
  if (words.length === 0) return null
  let best: string | null = null
  let bestScore = 0
  for (const language of languages) {
    const common = COMMON[language]
    if (!common) continue
    const set = new Set(common)
    const score = words.filter((word) => set.has(word)).length
    if (score > bestScore) {
      best = language
      bestScore = score
    }
  }
  // A couple of matches in a long text is noise.
  return bestScore >= Math.min(3, Math.ceil(words.length / 8)) ? best : null
}

// ---- Checking and loading models ---------------------------------------------

export async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buffer)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

export class ModelIntegrityError extends Error {
  constructor(readonly file: string) {
    super(`${file} does not match the published model`)
  }
}

/** Reads a model's files and checks each against the registry. */
export async function readModel(
  pair: ModelPair,
  fetchFile: (path: string) => Promise<ArrayBuffer>,
): Promise<Record<string, ArrayBuffer>> {
  const buffers: Record<string, ArrayBuffer> = {}
  for (const file of pair.files) {
    const buffer = await fetchFile(`/models/${pairKey(pair)}/${file.name}`)
    if (buffer.byteLength !== file.size || (await sha256Hex(buffer)) !== file.sha256) {
      throw new ModelIntegrityError(file.name)
    }
    buffers[file.part] = buffer
  }
  return buffers
}

/** Bergamot's file set for a model: one shared vocabulary or one per side. */
export function bergamotBuffers(buffers: Record<string, ArrayBuffer>) {
  const vocabs = buffers.vocab ? [buffers.vocab] : [buffers.srcvocab, buffers.trgvocab]
  if (!buffers.model || !buffers.lex || vocabs.some((v) => !v)) throw new Error('the model is missing files')
  return { model: buffers.model, shortlist: buffers.lex, vocabs }
}

// ---- The engine -----------------------------------------------------------------

/** What the translator needs from Bergamot; a fake stands in for it in tests. */
export interface TranslationEngine {
  load(pair: { from: string; to: string }, buffers: Record<string, ArrayBuffer>): Promise<void>
  translate(models: { from: string; to: string }[], texts: { text: string; html: boolean }[]): Promise<string[]>
  stop(): void
}

export type TranslateResult =
  | { state: 'done'; text: string }
  | { state: 'tooLong'; limit: number }
  | { state: 'stopped' }

/**
 * Loads each model once and translates one request at a time. Stopping ends
 * the worker, and with it a translation half done; the next request starts a
 * fresh one.
 */
export class Translator {
  private engine: Promise<TranslationEngine> | null = null
  private loaded = new Set<string>()
  private run = 0

  constructor(
    private readonly start: () => Promise<TranslationEngine>,
    private readonly fetchFile: (path: string) => Promise<ArrayBuffer>,
  ) {}

  async translate(text: string, models: ModelPair[], html: boolean): Promise<TranslateResult> {
    if (text.length > MAX_TRANSLATE_CHARS) return { state: 'tooLong', limit: MAX_TRANSLATE_CHARS }
    const run = ++this.run
    this.engine ??= this.start()
    const engine = await this.engine
    for (const model of models) {
      if (this.loaded.has(pairKey(model))) continue
      const buffers = await readModel(model, this.fetchFile)
      if (run !== this.run) return { state: 'stopped' }
      await engine.load(model, buffers)
      this.loaded.add(pairKey(model))
    }
    if (run !== this.run) return { state: 'stopped' }
    const [out] = await engine.translate(
      models.map(({ from, to }) => ({ from, to })),
      [{ text, html }],
    )
    return run === this.run ? { state: 'done', text: out } : { state: 'stopped' }
  }

  stop() {
    this.run++
    void this.engine?.then((engine) => engine.stop())
    this.engine = null
    this.loaded.clear()
  }
}

/** The parts of a worker this uses: the browser's, or Node's in tests. */
export type WorkerLike = {
  postMessage(message: unknown): void
  onmessage: ((event: MessageEvent) => void) | null
  onerror: ((event: ErrorEvent) => void) | null
  terminate(): void
}

/** Bergamot in its worker, from the files shipped with the app. */
export function bergamotEngine(
  makeWorker: () => WorkerLike = () => new Worker('/bergamot/translator-worker.js'),
): Promise<TranslationEngine> {
  const worker = makeWorker()
  let next = 0
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  const fail = (error: Error) => {
    for (const p of pending.values()) p.reject(error)
    pending.clear()
  }
  worker.onmessage = ({ data }: MessageEvent<{ id: number; result?: unknown; error?: { message?: string } }>) => {
    const call = pending.get(data.id)
    if (!call) return
    pending.delete(data.id)
    if (data.error) call.reject(new Error(data.error.message ?? 'translation failed'))
    else call.resolve(data.result)
  }
  worker.onerror = (event) => fail(new Error(event.message || 'the translator could not start'))
  const call = <T>(name: string, ...args: unknown[]) =>
    new Promise<T>((resolve, reject) => {
      const id = ++next
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      worker.postMessage({ id, name, args })
    })
  return call('initialize', { cacheSize: 0 }).then(() => ({
    load: (pair, buffers) => call<void>('loadTranslationModel', pair, bergamotBuffers(buffers)),
    translate: async (models, texts) =>
      (await call<{ target: { text: string } }[]>('translate', { models, texts })).map((r) => r.target.text),
    stop: () => {
      fail(new Error('stopped'))
      worker.terminate()
    },
  }))
}

let shared: Translator | null = null

/** Puts a stand-in in place of Bergamot, for tests that do not need the real one. */
export function setAppTranslator(translator: Translator | null) {
  shared = translator
}

/** The app's one translator. */
export function appTranslator(): Translator {
  shared ??= new Translator(bergamotEngine, async (path) => {
    const response = await fetch(path)
    if (!response.ok) throw new Error(`${path}: ${response.status}`)
    return response.arrayBuffer()
  })
  return shared
}
