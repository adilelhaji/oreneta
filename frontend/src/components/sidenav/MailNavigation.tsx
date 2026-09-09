import { useState } from 'react'
import { useValue } from '@legendapp/state/react'
import { ChevronRight, Mail } from 'lucide-react'
import { accounts$ } from '../../states/accounts'
import { mail$, inboxUnread } from '../../states/mail'
import { settings$ } from '../../states/settings'
import { clearBulkSelection, ui$ } from '../../states/ui'
import { openMailAccount } from '../../states/kanban'
import { buildFolderTree, type TreeNode } from '../../lib/folderTree'
import { folderIcon } from '../../lib/folderIcon'
import { unifiedFolders } from '../../lib/unifiedFolders'
import { useTranslation } from '../../lib/i18n'
import type { Account, Folder } from '../../types'

function FolderBranch({
  node,
  selected,
  onSelect,
}: {
  node: TreeNode
  selected: string
  onSelect: (id: string) => void
}) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(true)
  const Icon = folderIcon(node.folder)
  const current = node.folder?.id === selected || (node.folder?.role === 'inbox' && selected.toLowerCase() === 'inbox')
  return (
    <li>
      <div className="mail-folder-row">
        {node.children.length > 0 ? (
          <button
            type="button"
            className="mail-folder-expander"
            aria-label={t(expanded ? 'mailNavigation.collapseFolder' : 'mailNavigation.expandFolder', {
              folder: node.name,
            })}
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            <ChevronRight size={14} strokeWidth={1.75} className={expanded ? 'rotate-90' : ''} />
          </button>
        ) : (
          <span className="mail-folder-spacer" />
        )}
        {node.folder ? (
          <button
            type="button"
            className="mail-folder-destination"
            title={node.folder.name}
            aria-current={current ? 'page' : undefined}
            onClick={() => onSelect(node.folder!.id)}
          >
            <Icon size={16} strokeWidth={1.75} />
            <span>{node.name}</span>
            {node.folder.unread > 0 && <small>{node.folder.unread}</small>}
          </button>
        ) : (
          <span className="mail-folder-structural">{node.name}</span>
        )}
      </div>
      {expanded && node.children.length > 0 && (
        <ul className="mail-folder-children">
          {node.children.map((child) => (
            <FolderBranch key={child.folder?.id ?? child.name} node={child} selected={selected} onSelect={onSelect} />
          ))}
        </ul>
      )}
    </li>
  )
}

export function MailNavigationView({
  accounts,
  folders,
  selectedAccount,
  selectedFolder,
  unifiedVisible,
  onAccount,
  onFolder,
}: {
  accounts: Account[]
  folders: Folder[]
  selectedAccount: string
  selectedFolder: string
  unifiedVisible: boolean
  onAccount: (id: string) => void
  onFolder: (id: string) => void
}) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const needle = query.trim().toLocaleLowerCase()
  const tree = buildFolderTree(folders.filter((folder) => !needle || folder.name.toLocaleLowerCase().includes(needle)))
  const active = accounts.find((account) => account.id === selectedAccount)
  const isRSS = active?.provider === 'rss' || active?.auth_type === 'rss'
  return (
    <nav className="mail-navigation" aria-label={t('mailNavigation.title')}>
      <h2>{t('mailNavigation.accounts')}</h2>
      <div className="mail-navigation-accounts">
        {unifiedVisible && (
          <button
            type="button"
            className="mail-account-destination"
            aria-current={selectedAccount === 'unified' ? 'true' : undefined}
            onClick={() => onAccount('unified')}
          >
            <Mail size={16} strokeWidth={1.75} />
            <span>{t('kanban.columns.unifiedInbox')}</span>
          </button>
        )}
        {accounts.map((account) => (
          <button
            key={account.id}
            type="button"
            className="mail-account-destination"
            title={account.email || account.display_name}
            aria-current={account.id === selectedAccount ? 'true' : undefined}
            onClick={() => onAccount(account.id)}
          >
            <Mail size={16} strokeWidth={1.75} />
            <span>
              <strong>{account.display_name || account.email}</strong>
              {account.email && <small>{account.email}</small>}
            </span>
          </button>
        ))}
      </div>
      <h2>{t('mailNavigation.folders')}</h2>
      {isRSS ? (
        <button type="button" className="mail-account-destination" onClick={() => onFolder('inbox')}>
          {t('filters.allFeeds')}
        </button>
      ) : (
        <>
          <input
            type="search"
            aria-label={t('folders.searchPlaceholder')}
            placeholder={t('folders.searchPlaceholder')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {tree.length ? (
            <ul className="mail-folder-tree">
              {tree.map((node) => (
                <FolderBranch
                  key={node.folder?.id ?? node.name}
                  node={node}
                  selected={selectedFolder}
                  onSelect={onFolder}
                />
              ))}
            </ul>
          ) : (
            <p className="mail-navigation-empty">{t(needle ? 'mailNavigation.noMatches' : 'folders.noneAvailable')}</p>
          )}
        </>
      )}
    </nav>
  )
}

export function MailNavigation() {
  const { t } = useTranslation()
  const accounts = useValue(accounts$)
  const selectedAccount = useValue(ui$.selectedAccount)
  const selectedFolder = useValue(ui$.selectedFolder)
  const byAccount = useValue(mail$.foldersByAccount)
  const hidden = useValue(settings$.hiddenSideNavAccounts)
  const showUnified = useValue(settings$.showUnifiedInboxInSideNav)
  const visibleAccounts = accounts.filter((account) => account.id === selectedAccount || !hidden.includes(account.id))
  const folders =
    selectedAccount === 'unified'
      ? unifiedFolders(
          t,
          accounts
            .filter((account) => account.included_in_unified !== false)
            .reduce((total, account) => total + inboxUnread(byAccount[account.id]), 0),
        )
      : (byAccount[selectedAccount] ?? []).filter((folder) => folder.account_id === selectedAccount)

  function navigate(account: string, folder: string) {
    clearBulkSelection()
    ui$.selectedThread.set('')
    ui$.mobilePane.set('threads')
    openMailAccount(account, folder, false)
  }
  return (
    <MailNavigationView
      key={selectedAccount}
      accounts={visibleAccounts}
      folders={folders}
      selectedAccount={selectedAccount}
      selectedFolder={selectedFolder}
      unifiedVisible={showUnified || selectedAccount === 'unified'}
      onAccount={(account) => {
        if (account !== selectedAccount) navigate(account, 'inbox')
      }}
      onFolder={(folder) => {
        if (folder !== selectedFolder) navigate(selectedAccount, folder)
      }}
    />
  )
}
