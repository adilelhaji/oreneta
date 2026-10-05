/** ADR 0009: display order is independent of whole-mailbox sort order. */
export type MailboxColumnId = 'sender' | 'subject' | 'date' | 'account'
export type MailboxColumn = { id: MailboxColumnId; visible: boolean; width: number | 'auto' }
export type MailboxFolderView = { accountId: string; folderId: string; columns: MailboxColumn[] }
export type MailboxViews = { version: 1; defaultColumns: MailboxColumn[]; folders: MailboxFolderView[] }
export type MailboxScope = { accountId: string; folderId: string }
export type ParsedMailboxViews = { kind: 'legacy' } | { kind: 'unsupported' } | { kind: 'ready'; value: MailboxViews }

export const DEFAULT_MAILBOX_COLUMNS: readonly MailboxColumn[] = [
  { id: 'sender', visible: true, width: 120 },
  { id: 'subject', visible: true, width: 'auto' },
  { id: 'date', visible: true, width: 80 },
  { id: 'account', visible: false, width: 120 },
]

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

/** Reject a malformed layout as a unit; never hide its required subject. */
export function sanitizeMailboxColumns(raw: unknown): MailboxColumn[] | null {
  if (!Array.isArray(raw) || raw.length !== 4) return null
  const seen = new Set<string>()
  const columns: MailboxColumn[] = []
  for (const item of raw) {
    if (!record(item) || !DEFAULT_MAILBOX_COLUMNS.some((column) => column.id === item.id)) return null
    const id = item.id as MailboxColumnId
    if (seen.has(id) || typeof item.visible !== 'boolean' || (id === 'subject' && !item.visible)) return null
    const width = item.width
    if (
      !(id === 'subject' && width === 'auto') &&
      !(typeof width === 'number' && Number.isFinite(width) && width >= 64 && width <= 640)
    )
      return null
    seen.add(id)
    columns.push({ id, visible: item.visible, width: width as number | 'auto' })
  }
  return columns
}

export function parseMailboxViews(raw: unknown): ParsedMailboxViews {
  if (!record(raw)) return { kind: 'legacy' }
  if (typeof raw.version === 'number' && Number.isInteger(raw.version) && raw.version > 1)
    return { kind: 'unsupported' }
  if (raw.version !== 1) return { kind: 'legacy' }
  const defaultColumns = sanitizeMailboxColumns(raw.defaultColumns)
  if (!defaultColumns || !Array.isArray(raw.folders)) return { kind: 'legacy' }
  const folders: MailboxFolderView[] = []
  for (const item of raw.folders) {
    if (
      !record(item) ||
      typeof item.accountId !== 'string' ||
      !item.accountId.trim() ||
      typeof item.folderId !== 'string' ||
      !item.folderId.trim()
    )
      continue
    const columns = sanitizeMailboxColumns(item.columns)
    if (!columns || folders.some((folder) => folder.accountId === item.accountId && folder.folderId === item.folderId))
      continue
    folders.push({ accountId: item.accountId, folderId: item.folderId, columns })
  }
  return { kind: 'ready', value: { version: 1, defaultColumns, folders } }
}

export function resolveMailboxColumns(raw: unknown, scope: MailboxScope): MailboxColumn[] | null {
  const parsed = parseMailboxViews(raw)
  if (parsed.kind !== 'ready') return null // Preserve the existing proportional layout.
  return (
    parsed.value.folders.find((folder) => folder.accountId === scope.accountId && folder.folderId === scope.folderId)
      ?.columns ?? parsed.value.defaultColumns
  )
}

/** null columns removes an override; null scope changes the general layout. */
export function changeMailboxColumns(
  raw: unknown,
  scope: MailboxScope | null,
  columns: MailboxColumn[] | null,
): MailboxViews {
  const parsed = parseMailboxViews(raw)
  if (parsed.kind === 'unsupported') throw new Error('Unsupported mailbox view version')
  const valid = columns && sanitizeMailboxColumns(columns)
  if (columns && !valid) throw new Error('Invalid mailbox columns')
  if (scope && (!scope.accountId.trim() || !scope.folderId.trim())) throw new Error('Invalid mailbox scope')
  const value: MailboxViews =
    parsed.kind === 'ready'
      ? parsed.value
      : {
          version: 1,
          defaultColumns: DEFAULT_MAILBOX_COLUMNS.map((column) => ({ ...column })),
          folders: [],
        }
  if (!scope) return { ...value, defaultColumns: valid ?? DEFAULT_MAILBOX_COLUMNS.map((column) => ({ ...column })) }
  const folders = value.folders.filter(
    (folder) => folder.accountId !== scope.accountId || folder.folderId !== scope.folderId,
  )
  if (valid) folders.push({ ...scope, columns: valid })
  return { ...value, folders }
}
