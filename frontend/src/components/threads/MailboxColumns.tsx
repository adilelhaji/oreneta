import { useId, useState } from 'react'
import { useValue } from '@legendapp/state/react'
import { ArrowDown, ArrowUp, Columns3 } from 'lucide-react'
import { useTranslation } from '../../lib/i18n'
import {
  changeMailboxColumns,
  DEFAULT_MAILBOX_COLUMNS,
  parseMailboxViews,
  resolveMailboxColumns,
  type MailboxColumn,
  type MailboxScope,
} from '../../lib/mailboxViews'
import { settings$ } from '../../states/settings'
import { Button } from '../button/Button'
import { IconButton } from '../button/IconButton'
import { Dialog } from '../dialog/Dialog'
import { SelectInput, TextInput } from '../field/Field'

export function MailboxColumns({ accountId, folderId }: MailboxScope) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  return (
    <div className="shrink-0 border-b border-border bg-header px-2 py-1">
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        <Columns3 size={14} strokeWidth={1.75} aria-hidden="true" />
        {t('mailboxColumns.title')}
      </Button>
      {open && (
        <ColumnEditor
          key={`${accountId.length}:${accountId}${folderId}`}
          accountId={accountId}
          folderId={folderId}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  )
}

function ColumnEditor({ accountId, folderId, onClose }: MailboxScope & { onClose: () => void }) {
  const { t } = useTranslation()
  const errorId = useId()
  const raw = useValue(settings$.mailboxViews)
  const parsed = parseMailboxViews(raw)
  const folderScope = { accountId, folderId }
  const hasOverride =
    parsed.kind === 'ready' &&
    parsed.value.folders.some((folder) => folder.accountId === accountId && folder.folderId === folderId)
  const [scope, setScope] = useState<'general' | 'folder'>(hasOverride ? 'folder' : 'general')
  const [columns, setColumns] = useState<MailboxColumn[]>(() =>
    (resolveMailboxColumns(raw, folderScope) ?? DEFAULT_MAILBOX_COLUMNS).map((column) => ({ ...column })),
  )
  const [widths, setWidths] = useState<Record<string, string>>({})
  const widthIsInvalid = (id: string) => {
    const value = widths[id]
    return (
      value !== undefined &&
      (!value.trim() || !Number.isFinite(Number(value)) || Number(value) < 64 || Number(value) > 640)
    )
  }
  const invalidWidth = columns.some((column) => widthIsInvalid(column.id))
  const label = (id: string) => t(id === 'account' ? 'mailboxColumns.account' : `table.${id}`)
  const move = (index: number, delta: number) => {
    const next = [...columns]
    ;[next[index], next[index + delta]] = [next[index + delta], next[index]]
    setColumns(next)
  }
  const save = () => {
    if (invalidWidth) return
    const next = columns.map((column) =>
      widths[column.id] === undefined ? column : { ...column, width: Number(widths[column.id]) },
    )
    settings$.mailboxViews.set(changeMailboxColumns(raw, scope === 'folder' ? folderScope : null, next))
    onClose()
  }
  return (
    <Dialog
      title={t('mailboxColumns.title')}
      icon={Columns3}
      onClose={onClose}
      width="lg"
      footer={
        parsed.kind !== 'unsupported' ? (
          <Button onClick={save} disabled={invalidWidth}>
            {t('buttons.save')}
          </Button>
        ) : undefined
      }
    >
      {parsed.kind === 'unsupported' ? (
        <>
          <p className="text-ui text-secondary">{t('mailboxColumns.unsupported')}</p>
          <Button
            onClick={() => {
              settings$.mailboxViews.set(null)
              onClose()
            }}
          >
            {t('mailboxColumns.resetAll')}
          </Button>
        </>
      ) : (
        <>
          <label className="flex flex-col gap-1 text-ui">
            {t('mailboxColumns.scope')}
            <SelectInput
              value={scope}
              onChange={(event) => {
                const next = event.target.value as 'general' | 'folder'
                setScope(next)
                setColumns(
                  (next === 'folder'
                    ? resolveMailboxColumns(raw, folderScope)
                    : parsed.kind === 'ready'
                      ? parsed.value.defaultColumns
                      : null
                  )?.map((column) => ({ ...column })) ?? DEFAULT_MAILBOX_COLUMNS.map((column) => ({ ...column })),
                )
                setWidths({})
              }}
            >
              <option value="general">{t('mailboxColumns.general')}</option>
              {!!accountId && !!folderId && <option value="folder">{t('mailboxColumns.folder')}</option>}
            </SelectInput>
          </label>
          <p className="text-caption text-secondary">{t('mailboxColumns.inheritance')}</p>
          <div className="flex flex-col gap-2">
            {columns.map((column, index) => (
              <div
                key={column.id}
                className="flex flex-wrap items-center gap-2 rounded-control border border-border p-2"
              >
                <label className="flex min-w-28 flex-1 items-center gap-2 text-ui">
                  <input
                    type="checkbox"
                    checked={column.visible}
                    disabled={column.id === 'subject'}
                    onChange={(event) =>
                      setColumns(
                        columns.map((item) =>
                          item.id === column.id ? { ...item, visible: event.target.checked } : item,
                        ),
                      )
                    }
                  />
                  {label(column.id)}
                </label>
                <label className="flex items-center gap-1 text-caption">
                  {t('mailboxColumns.width')}
                  <TextInput
                    type="number"
                    min={64}
                    max={640}
                    step="any"
                    aria-label={`${t('mailboxColumns.width')}: ${label(column.id)}`}
                    invalid={widthIsInvalid(column.id)}
                    aria-describedby={widthIsInvalid(column.id) ? errorId : undefined}
                    disabled={column.width === 'auto'}
                    className="w-20"
                    value={column.width === 'auto' ? '' : (widths[column.id] ?? column.width)}
                    onChange={(event) => setWidths({ ...widths, [column.id]: event.target.value })}
                  />
                </label>
                {column.id === 'subject' && (
                  <label className="flex items-center gap-1 text-caption">
                    <input
                      type="checkbox"
                      checked={column.width === 'auto'}
                      onChange={(event) => {
                        setColumns(
                          columns.map((item) =>
                            item.id === column.id ? { ...item, width: event.target.checked ? 'auto' : 200 } : item,
                          ),
                        )
                        setWidths(({ subject: _, ...rest }) => rest)
                      }}
                    />
                    {t('mailboxColumns.auto')}
                  </label>
                )}
                <div className="ml-auto flex shrink-0 items-center gap-2">
                  <IconButton
                    icon={ArrowUp}
                    label={`${t('mailboxColumns.moveUp')}: ${label(column.id)}`}
                    disabled={index === 0}
                    onClick={() => move(index, -1)}
                  />
                  <IconButton
                    icon={ArrowDown}
                    label={`${t('mailboxColumns.moveDown')}: ${label(column.id)}`}
                    disabled={index === columns.length - 1}
                    onClick={() => move(index, 1)}
                  />
                </div>
              </div>
            ))}
          </div>
          {invalidWidth && (
            <p id={errorId} role="alert" className="text-caption text-danger">
              {t('mailboxColumns.widthRange')}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="ghost"
              onClick={() => {
                setColumns(DEFAULT_MAILBOX_COLUMNS.map((column) => ({ ...column })))
                setWidths({})
              }}
            >
              {t('common.resetToDefault')}
            </Button>
            {scope === 'folder' && hasOverride && (
              <Button
                variant="ghost"
                onClick={() => {
                  settings$.mailboxViews.set(changeMailboxColumns(raw, folderScope, null))
                  onClose()
                }}
              >
                {t('mailboxColumns.useGeneral')}
              </Button>
            )}
          </div>
        </>
      )}
    </Dialog>
  )
}
