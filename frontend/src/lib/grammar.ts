// Offline grammar checking with Harper (#105, ADR-0030).
//
// Harper runs here, in a worker, from the WebAssembly file shipped with the
// app: no text leaves the computer. It knows English only (American, British,
// Canadian, Australian); text that does not read as English is not checked,
// and says so, rather than being "corrected" into nonsense. Nothing is
// changed until the person picks a suggestion.

export type GrammarDialect = 'american' | 'british' | 'canadian' | 'australian'

export type GrammarIssue = {
  /** Offsets into the checked text, in JavaScript string units. */
  start: number
  end: number
  problem: string
  message: string
  kind: string
  suggestions: string[]
  /** Stable for the same problem in the same wording: what "ignore" remembers. */
  key: string
}

export type GrammarResult =
  | { state: 'checked'; issues: GrammarIssue[] }
  | { state: 'notEnglish' }
  | { state: 'tooLong'; limit: number }
  | { state: 'stale' }

/** What the checker needs from Harper; a fake stands in for it in tests. */
export interface GrammarEngine {
  lint(text: string, dialect: GrammarDialect): Promise<Omit<GrammarIssue, 'key'>[]>
  isEnglish(text: string): Promise<boolean>
}

/** Longer than this is not checked as a whole: a reply quoting a long
 * thread would otherwise keep a core busy on every pause in typing. */
export const MAX_CHECK_CHARS = 20_000

export const issueKey = (issue: Pick<GrammarIssue, 'kind' | 'problem' | 'message'>) =>
  `${issue.kind}|${issue.problem.toLowerCase()}|${issue.message}`

/**
 * One checker per editor: runs one check at a time, and answers `stale`
 * for a check overtaken by a newer one, so an old answer never paints over
 * newer text.
 */
export class GrammarChecker {
  private latest = 0
  private ignored = new Set<string>()

  constructor(private readonly engine: () => Promise<GrammarEngine>) {}

  ignore(issue: GrammarIssue) {
    this.ignored.add(issue.key)
  }

  async check(text: string, dialect: GrammarDialect): Promise<GrammarResult> {
    const run = ++this.latest
    if (text.length > MAX_CHECK_CHARS) return { state: 'tooLong', limit: MAX_CHECK_CHARS }
    if (!text.trim()) return { state: 'checked', issues: [] }
    const engine = await this.engine()
    if (run !== this.latest) return { state: 'stale' }
    // A few words say little about a language; only a longer text is asked.
    if (text.trim().split(/\s+/).length >= 6 && !(await engine.isEnglish(text))) {
      return run === this.latest ? { state: 'notEnglish' } : { state: 'stale' }
    }
    const found = await engine.lint(text, dialect)
    if (run !== this.latest) return { state: 'stale' }
    const issues = found
      .map((issue) => ({ ...issue, key: issueKey(issue) }))
      .filter((issue) => !this.ignored.has(issue.key))
    return { state: 'checked', issues }
  }
}

/** Applies a suggestion to plain text, returning the text and where the
 * caret goes. Offsets are those of the issue. */
export function applyToText(text: string, issue: GrammarIssue, replacement: string) {
  return {
    text: text.slice(0, issue.start) + replacement + text.slice(issue.end),
    caret: issue.start + replacement.length,
  }
}

// ---- Harper ------------------------------------------------------------------

/** The parts of a Harper linter this uses: a worker's or, in tests, a local one. */
type HarperLinter = {
  setup(): Promise<void>
  setDialect(dialect: number): Promise<void>
  lint(
    text: string,
    options: { language: 'plaintext' },
  ): Promise<
    {
      span(): { start: number; end: number }
      get_problem_text(): string
      message(): string
      lint_kind(): string
      suggestions(): { get_replacement_text(): string }[]
    }[]
  >
  isLikelyEnglish(text: string): Promise<boolean>
}

/** A checker engine over a Harper linter, set up and ready. */
export async function engineFrom(
  linter: HarperLinter,
  dialects: Record<GrammarDialect, number>,
): Promise<GrammarEngine> {
  await linter.setup()
  let current: GrammarDialect | null = null
  return {
    async lint(text, dialect) {
      if (current !== dialect) {
        await linter.setDialect(dialects[dialect])
        current = dialect
      }
      const lints = await linter.lint(text, { language: 'plaintext' })
      return lints.map((lint) => {
        const span = lint.span()
        return {
          start: span.start,
          end: span.end,
          problem: lint.get_problem_text(),
          message: lint.message(),
          kind: lint.lint_kind(),
          suggestions: lint.suggestions().map((s) => s.get_replacement_text()),
        }
      })
    },
    isEnglish: (text) => linter.isLikelyEnglish(text),
  }
}

let harper: Promise<GrammarEngine> | null = null

/**
 * Harper in a worker, from the WebAssembly file shipped with the app, loaded
 * on first use. A failure to load is kept and reported for this session
 * rather than retried on every keystroke.
 */
export function harperEngine(): Promise<GrammarEngine> {
  harper ??= (async () => {
    const [{ WorkerLinter, Dialect }, { binary }] = await Promise.all([import('harper.js'), import('harper.js/binary')])
    return engineFrom(new WorkerLinter({ binary }), {
      american: Dialect.American,
      british: Dialect.British,
      canadian: Dialect.Canadian,
      australian: Dialect.Australian,
    })
  })()
  return harper
}
