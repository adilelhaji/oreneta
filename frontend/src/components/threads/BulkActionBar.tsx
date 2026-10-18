import { copyBlocked, messageChangesBlocked, readOnlyTarget } from '../../lib/mailCapabilities'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Archive,
  Ban,
  Copy,
  FolderInput,
  Mail,
  MailOpen,
  MoreHorizontal,
  Star,
  Trash2,
  ListChecks,
  Tag,
  Check,
  Minus,
  X,
  Zap,
} from 'lucide-react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import { clsx } from '../../lib/utils'
import type { BulkSelectionItem } from '../../states/ui'
import { clearBulkSelection, setBulkSelection } from '../../states/ui'
import { accounts$ } from '../../states/accounts'
import {
  bulkArchiveSelected,
  bulkCopySelectedToFolder,
  bulkDeleteSelected,
  bulkMarkSelectedJunk,
  bulkMarkSelectedRead,
  bulkMarkSelectedUnread,
  bulkMoveSelectedToFolder,
  bulkStarSelected,
  ensureAccountFolders,
  isJunkFolderId,
  mail$,
} from '../../states/mail'
import { IconButton } from '../button/IconButton'
import { FloatingContextMenu } from '../menu/FloatingContextMenu'
import { FolderMenuTree } from '../menu/FolderMenuTree'
import { MenuItem } from '../menu/MenuItem'
import { MenuGroup, MenuSeparator } from '../menu/Menu'
import { SubmenuItem } from '../menu/SubmenuItem'
import { settings$ } from '../../states/settings'
import { startQuickAction } from '../../states/quickActions'
import { bulkLabelSelected, labelCoverage, labels$ } from '../../states/labels'
import { endAlignedX } from '../../lib/direction'

export function BulkActionBar({
  items,
  allItems,
  className,
}: {
  items: BulkSelectionItem[]
  /** Every selectable row of the surface the bar belongs to, in display order — backs "select all". */
  allItems?: BulkSelectionItem[]
  className?: string
}) {
  const { t } = useTranslation()
  const accounts = useValue(accounts$)
  const foldersByAccount = useValue(mail$.foldersByAccount)
  const quickActions = useValue(settings$.quickActions)
  const labels = useValue(labels$.labels)
  // Read so the marks below follow the list as labels change.
  useValue(mail$.threads)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [copyOpen, setCopyOpen] = useState(false)
  const [copyLoading, setCopyLoading] = useState(false)
  const [, setCopyFoldersVersion] = useState(0)
  const copyLoadRef = useRef(false)
  const mailItems = useMemo(() => items.filter((item) => item.kind === 'mail'), [items])
  // Every action here changes messages: on Microsoft Graph that needs the
  // change permission (#141), and copying stays within the same account.
  const readOnly = items.some((item) => messageChangesBlocked(accounts, item.accountId))
  const mailAccounts = accounts.filter(
    (account) =>
      account.auth_type !== 'rss' &&
      account.provider !== 'rss' &&
      account.needs_reconnect !== true &&
      mailItemsAll(items).every((item) => !copyBlocked(accounts, item.accountId, account.id)),
  )
  const accountIds = Array.from(new Set(mailItems.map((item) => item.accountId)))
  const singleAccountId = accountIds.length === 1 ? accountIds[0] : ''
  const selectedFolders = new Set(mailItems.map((item) => item.folderId))
  const canArchive = !readOnly && mailItems.length > 0 && mailItems.every((item) => !item.draft && !item.trash)
  const canMove = !readOnly && mailItems.length > 0 && !!singleAccountId
  const canCopy = !readOnly && mailItems.length > 0 && mailAccounts.length > 0
  // Junk (#245): offered as a button, not only inside a menu, because a reader
  // looking for it scans the bar, not the overflow. A draft is never junk. Filing
  // junk manages the mailbox, which Graph does not offer at all (#141) — a
  // stricter test than the message changes above.
  const junkItems = mailItems.filter((item) => !item.draft)
  const junkBlocked = junkItems.some((item) => readOnlyTarget(accounts, item.accountId))
  // Everything already in junk: the useful gesture is taking it back out. A
  // mixed selection files the rest as junk and leaves the junk ones alone.
  // `foldersByAccount` above keeps this in step with the folder list.
  const allInJunk = junkItems.length > 0 && junkItems.every((item) => isJunkFolderId(item.accountId, item.folderId))

  const loadCopyTargetFolders = async () => {
    if (copyLoadRef.current) return
    copyLoadRef.current = true
    setCopyLoading(true)
    try {
      await Promise.all(
        mailAccounts.map((account) =>
          ensureAccountFolders(account.id, { refreshIfBootstrapOnly: true, waitForRefresh: true }),
        ),
      )
    } finally {
      copyLoadRef.current = false
      setCopyLoading(false)
      setCopyFoldersVersion((version) => version + 1)
    }
  }

  useEffect(() => {
    if (singleAccountId) void ensureAccountFolders(singleAccountId, { refreshIfBootstrapOnly: true })
  }, [singleAccountId])

  // While "Copy to" is open, the folders of every target load, also those of
  // an account that appears meanwhile. The submenus close with the menu.
  useEffect(() => {
    if (!copyOpen) return
    void loadCopyTargetFolders()
  }, [accounts, copyOpen])

  if (items.length === 0) return null

  const moveFolders = singleAccountId ? (foldersByAccount[singleAccountId] ?? []) : []
  const hasMoveTarget = moveFolders.some((folder) => !selectedFolders.has(folder.id))
  const copyAccountGroups = mailAccounts.map((account) => ({
    account,
    folders: foldersByAccount[account.id] ?? [],
  }))

  const selectedLabel = t('threads.bulk.selectedCount', { count: items.length })
  // Hidden once every row is already selected, so the menu never offers a no-op.
  const selectableItems = allItems ?? []
  const canSelectAll = selectableItems.some((item) => !items.some((selected) => selected.key === item.key))

  return (
    <div
      className={clsx(
        'shrink-0 border-b border-accent/15 bg-accent/[0.045] px-3 select-none dark:bg-accent/[0.08]',
        className,
      )}
    >
      <div className="flex min-h-[inherit] items-center gap-3">
        <IconButton
          icon={X}
          size="md"
          radius="lg"
          label={t('common.close')}
          className="text-secondary hover:bg-accent/10 hover:text-primary"
          onClick={clearBulkSelection}
        />
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="min-w-0 truncate text-sm font-semibold text-primary">{selectedLabel}</span>
        </div>
        {canSelectAll && (
          <IconButton
            icon={ListChecks}
            size="md"
            radius="lg"
            label={t('threads.actions.selectAll')}
            className="hover:bg-accent/10"
            onClick={() => setBulkSelection(selectableItems)}
          />
        )}
        {junkItems.length > 0 && (
          <IconButton
            icon={Ban}
            size="md"
            radius="lg"
            label={allInJunk ? t('threads.actions.markNotJunk') : t('threads.actions.markJunk')}
            disabled={junkBlocked}
            className="hover:bg-accent/10"
            onClick={() => void bulkMarkSelectedJunk(junkItems, !allInJunk)}
          />
        )}
        <IconButton
          icon={MoreHorizontal}
          size="md"
          radius="lg"
          label={t('common.more')}
          active={!!menu}
          aria-haspopup="menu"
          aria-expanded={!!menu}
          className="hover:bg-accent/10"
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect()
            setMenu({ x: endAlignedX(rect, 190), y: rect.bottom + 4 })
          }}
        />
      </div>

      {menu && (
        <FloatingContextMenu
          x={menu.x}
          y={menu.y}
          label={selectedLabel}
          overlay
          onClose={() => setMenu(null)}
          className="fixed z-50 min-w-[190px] rounded-control border border-border bg-chats p-1 shadow-overlay animate-fade-in"
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
        >
          {quickActions.length > 0 && (
            <>
              {quickActions.map((action, index) => (
                <MenuItem
                  key={action.id}
                  icon={<Zap size={14} className="text-secondary" strokeWidth={1.75} />}
                  label={action.name}
                  trailing={<span className="text-2xs text-secondary">Alt+{index + 1}</span>}
                  disabled={readOnly || mailItems.length === 0}
                  onClick={() => {
                    setMenu(null)
                    startQuickAction(action, mailItems)
                  }}
                />
              ))}
              <MenuSeparator />
            </>
          )}
          <MenuItem
            icon={<MailOpen size={14} className="text-secondary" strokeWidth={1.75} />}
            label={t('threads.actions.markAsRead')}
            disabled={readOnly || mailItems.length === 0}
            onClick={() => {
              setMenu(null)
              void bulkMarkSelectedRead(mailItems)
            }}
          />
          <MenuItem
            icon={<Mail size={14} className="text-secondary" strokeWidth={1.75} />}
            label={t('threads.actions.markAsUnread')}
            disabled={readOnly || mailItems.length === 0}
            onClick={() => {
              setMenu(null)
              void bulkMarkSelectedUnread(mailItems)
            }}
          />
          <MenuItem
            icon={<Star size={14} className="text-secondary" strokeWidth={1.75} />}
            label={t('threads.actions.starThread')}
            disabled={readOnly || mailItems.length === 0}
            onClick={() => {
              setMenu(null)
              void bulkStarSelected(mailItems, true)
            }}
          />
          <MenuItem
            icon={<Star size={14} className="fill-warning text-warning" strokeWidth={1.75} />}
            label={t('threads.actions.unstarThread')}
            disabled={readOnly || mailItems.length === 0}
            onClick={() => {
              setMenu(null)
              void bulkStarSelected(mailItems, false)
            }}
          />
          {labels.length > 0 && (
            <MenuGroup
              separated
              label={t('labels.forSelection', { defaultValue: 'Labels (on all, some or none)' })}
              labelClassName="px-2 pb-0.5 pt-1 text-2xs font-semibold text-secondary"
            >
              {labels.map((label) => {
                const ids = mailItems.map((item) => item.threadId)
                const coverage = labelCoverage(ids, label.id)
                const Mark = coverage === 'all' ? Check : coverage === 'some' ? Minus : Tag
                return (
                  <MenuItem
                    key={label.id}
                    icon={<Mark size={14} style={{ color: label.colour }} strokeWidth={1.75} />}
                    label={
                      coverage === 'all'
                        ? t('labels.removeFromSelection', { name: label.name, defaultValue: 'Remove “{name}”' })
                        : t('labels.addToSelection', { name: label.name, defaultValue: 'Add “{name}”' })
                    }
                    disabled={readOnly || mailItems.length === 0}
                    onClick={() => {
                      setMenu(null)
                      void bulkLabelSelected(mailItems, label.id, coverage !== 'all')
                    }}
                  />
                )
              })}
            </MenuGroup>
          )}
          <MenuSeparator />
          <MenuItem
            icon={<Archive size={14} className="text-secondary" strokeWidth={1.75} />}
            label={t('threads.actions.archiveThread')}
            disabled={readOnly || !canArchive}
            onClick={() => {
              setMenu(null)
              void bulkArchiveSelected(mailItems)
            }}
          />
          <SubmenuItem
            icon={<FolderInput size={14} className="text-secondary" strokeWidth={1.75} />}
            label={t('threads.actions.moveTo')}
            disabled={readOnly || !canMove}
          >
            {/* Said as a disabled item so the arrow keys reach it too. */}
            {!hasMoveTarget && <MenuItem disabled label={t('folders.noneAvailable')} />}
            <FolderMenuTree
              folders={moveFolders}
              excludedFolderIds={selectedFolders}
              onPick={(folder) => {
                setMenu(null)
                void bulkMoveSelectedToFolder(mailItems, folder.id)
              }}
            />
          </SubmenuItem>
          <SubmenuItem
            icon={<Copy size={14} className="text-secondary" strokeWidth={1.75} />}
            label={t('threads.actions.copyTo')}
            disabled={readOnly || !canCopy}
            width={230}
            panelClassName="fixed z-[51] max-h-[calc(100vh-1rem)] min-w-[230px] overflow-y-auto rounded-control border border-border bg-chats p-1 shadow-overlay animate-fade-in"
            onOpenChange={setCopyOpen}
          >
            {copyAccountGroups.map(({ account, folders }) => (
              <MenuGroup
                key={account.id}
                label={account.display_name || account.email || account.id}
                labelClassName="px-3 pb-1 pt-2 text-caption font-semibold text-secondary"
              >
                {folders.length === 0 && (
                  <MenuItem disabled label={copyLoading ? t('folders.loading') : t('folders.noneAvailable')} />
                )}
                <FolderMenuTree
                  folders={folders}
                  onPick={(folder) => {
                    setMenu(null)
                    void bulkCopySelectedToFolder(mailItems, account.id, folder.id)
                  }}
                />
              </MenuGroup>
            ))}
          </SubmenuItem>
          <MenuSeparator />
          <MenuItem
            icon={<Trash2 size={14} strokeWidth={1.75} />}
            label={t('buttons.delete')}
            danger
            disabled={readOnly || mailItems.length === 0}
            onClick={() => {
              setMenu(null)
              void bulkDeleteSelected(mailItems)
            }}
          />
        </FloatingContextMenu>
      )}
    </div>
  )
}

function mailItemsAll(items: BulkSelectionItem[]): BulkSelectionItem[] {
  return items.filter((item) => item.kind === 'mail')
}
