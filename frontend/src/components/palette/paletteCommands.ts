import type { ReactNode } from 'react'
import type { ShortcutId } from '../../lib/shortcuts'

/**
 * The areas the app menu groups the commands under, in the order it shows
 * them (ADR-0068 §2). The palette lists the same commands and ignores them.
 */
export const COMMAND_AREAS = [
  'modules',
  'mail',
  'conversation',
  'accounts',
  'folders',
  'boards',
  'theme',
  'notifications',
  'settings',
  'app',
] as const

export type CommandArea = (typeof COMMAND_AREAS)[number]

export type Command = {
  id: string
  label: string
  /** Where the app menu shows the command. */
  area: CommandArea
  icon: ReactNode
  /** Extra words matched by the search box but not shown. */
  keywords?: string
  kind?: 'action' | 'setting'
  hint?: string
  disabled?: boolean
  shortcut?: ShortcutId
  /** Marks the command that reflects the current state (shows a check). */
  active?: boolean
  /**
   * Listed by the app menu, not by the palette: "Command palette" would only
   * open the palette that lists it (#343).
   */
  menuOnly?: true
  run: () => void
}

// Fold accents without deleting non-Latin scripts. Punctuation-only input must
// never normalize to an empty wildcard. Blank input alone lists everything.
export function normalizeCommandSearch(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
}

type Searchable = Pick<Command, 'label' | 'keywords' | 'hint'>

function matchRank(command: Searchable, query: string): number {
  if (!query.trim()) return 0
  const q = normalizeCommandSearch(query.trim())
  if (!q) return Infinity
  if (normalizeCommandSearch(command.label).includes(q)) return 0
  const haystack = normalizeCommandSearch(`${command.label} ${command.keywords ?? ''} ${command.hint ?? ''}`)
  if (haystack.includes(q)) return 1

  const compactHaystack = haystack.replace(/[^\p{L}\p{N}]/gu, '')
  const compactQuery = q.replace(/[^\p{L}\p{N}]/gu, '')
  if (!compactQuery) return Infinity
  if (compactHaystack.includes(compactQuery)) return 2

  let queryIndex = 0
  for (const char of compactHaystack) {
    if (char === compactQuery[queryIndex]) queryIndex += 1
    if (queryIndex === compactQuery.length) return 3
  }
  return Infinity
}

export function matchesCommand(command: Searchable, query: string): boolean {
  return Number.isFinite(matchRank(command, query))
}

/**
 * The commands by area, in the order of {@link COMMAND_AREAS}, each command
 * once. Inside an area the actions come first ("Open settings" before the
 * sections it can open), each kind in its list's order. Areas with no
 * command are left out.
 */
export function groupCommandsByArea<T extends Pick<Command, 'area' | 'kind'>>(
  commands: T[],
): { area: CommandArea; commands: T[] }[] {
  const destination = (command: T) => (command.kind === 'setting' ? 1 : 0)
  return COMMAND_AREAS.map((area) => ({
    area,
    commands: commands.filter((command) => command.area === area).sort((a, b) => destination(a) - destination(b)),
  })).filter((group) => group.commands.length > 0)
}

/** Exact label/word hits precede fuzzy abbreviations; ties retain source order. */
export function filterCommands<T extends Searchable>(commands: T[], query: string): T[] {
  return commands
    .map((command) => ({ command, rank: matchRank(command, query) }))
    .filter(({ rank }) => Number.isFinite(rank))
    .sort((a, b) => a.rank - b.rank)
    .map(({ command }) => command)
}
