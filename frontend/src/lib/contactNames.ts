// Contacts → General (SET-19, ADR-0052): how a person's name is shown and
// sorted. Pure functions only; states/settings.ts holds the two preferences.
//
// A name is only reordered when the address book keeps its parts apart (vCard
// `N`, Google's given and family names, the editor's two fields). A whole name
// with no parts is shown as written: splitting "María José García López" or
// "Kim Min-jun" into first and last would be a guess, and wrong for much of
// the world. Names from message headers never come through here at all.

/** How a name with known parts is written. 'auto' follows the language. */
export type NameDisplay = 'auto' | 'first_last' | 'last_comma_first' | 'last_first'
export const NAME_DISPLAYS: readonly NameDisplay[] = ['auto', 'first_last', 'last_comma_first', 'last_first']

/** Which part a list is ordered by. 'auto' follows the language. */
export type NameSort = 'auto' | 'first' | 'last'
export const NAME_SORTS: readonly NameSort[] = ['auto', 'first', 'last']

export type NameParts = { name: string; given?: string; family?: string }

// Languages that put the family name first (CLDR person-name order): Chinese,
// Japanese, Korean, Hungarian, Vietnamese. Their speakers also look people up
// by family name.
const FAMILY_FIRST = new Set(['zh', 'ja', 'ko', 'hu', 'vi'])

function baseLanguage(language: string): string {
  return (language || 'en').toLowerCase().split(/[-_]/)[0]
}

/** What 'auto' means in this language. */
export function localeNameDefaults(language: string): {
  display: Exclude<NameDisplay, 'auto'>
  sort: Exclude<NameSort, 'auto'>
} {
  return FAMILY_FIRST.has(baseLanguage(language))
    ? { display: 'last_first', sort: 'last' }
    : { display: 'first_last', sort: 'first' }
}

export function resolveDisplay(choice: NameDisplay, language: string): Exclude<NameDisplay, 'auto'> {
  return choice === 'auto' ? localeNameDefaults(language).display : choice
}

export function resolveSort(choice: NameSort, language: string): Exclude<NameSort, 'auto'> {
  return choice === 'auto' ? localeNameDefaults(language).sort : choice
}

export function sanitizeNameDisplay(value: unknown): NameDisplay | null {
  return NAME_DISPLAYS.includes(value as NameDisplay) ? (value as NameDisplay) : null
}

export function sanitizeNameSort(value: unknown): NameSort | null {
  return NAME_SORTS.includes(value as NameSort) ? (value as NameSort) : null
}

// Han, kana and hangul: written without a space between the two names.
const CJK = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/

/** A person's name as the reader chose to see names. */
export function formatName(person: NameParts, display: Exclude<NameDisplay, 'auto'>): string {
  const given = (person.given ?? '').trim()
  const family = (person.family ?? '').trim()
  const whole = person.name.trim()
  // Without both parts there is nothing to reorder.
  if (!given || !family) return whole || given || family
  switch (display) {
    case 'first_last':
      return `${given} ${family}`
    case 'last_comma_first':
      return `${family}, ${given}`
    case 'last_first':
      return CJK.test(family) && CJK.test(given) ? `${family}${given}` : `${family} ${given}`
  }
}

/** The text a list is ordered by. */
export function sortKey(person: NameParts, sort: Exclude<NameSort, 'auto'>): string {
  const given = (person.given ?? '').trim()
  const family = (person.family ?? '').trim()
  const whole = person.name.trim()
  if (sort === 'last' && family) return `${family} ${given}`
  if (sort === 'first' && given) return `${given} ${family}`
  return whole || given || family
}

/** People in the reader's order: by the chosen part, then by whole name. */
export function sortByName<T extends NameParts>(people: T[], sort: Exclude<NameSort, 'auto'>, language: string): T[] {
  let collator: Intl.Collator
  try {
    collator = new Intl.Collator(language.replace('_', '-') || undefined, { sensitivity: 'base', numeric: true })
  } catch {
    collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })
  }
  return [...people].sort(
    (a, b) => collator.compare(sortKey(a, sort), sortKey(b, sort)) || collator.compare(a.name, b.name),
  )
}
