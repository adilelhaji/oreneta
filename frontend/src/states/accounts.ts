import { observable } from '@legendapp/state'
import { t } from '../lib/i18n'
import { invoke } from '../lib/bridge'
import { boot } from '../boot'
import type { Account, AccountProxy, AccountSignature, Alias, ChatWallpaper } from '../types'
import { confirmAction, ui$, showToast } from './ui'
import { forgetAccountInGroups, inUnifiedScope } from './accountGroups'
import { forgetAccountFolderPrefs } from './folderPrefs'
import { setSignaturePlacement } from './settings'

// Accounts state — maps 1:1 to the `accounts` DB table. The list is loaded by
// boot()/account flows; the mutations here update it optimistically and persist
// via the sidecar, reverting on failure.
export const accounts$ = observable([] as Account[])

// Accounts that participate in the unified inbox. Excluded accounts still exist
// and are reachable by selecting them directly; they just don't merge in. With
// an account group chosen, the unified view is that group's accounts (#99).
export function unifiedAccounts() {
  return accounts$.get().filter(inUnifiedScope)
}

export function getActiveAccount() {
  const accounts = accounts$.get()
  const selected = ui$.selectedAccount.get()
  return accounts.find((account) => account.id === selected) ?? accounts[0] ?? null
}

export function isSendableAccount(acc: Account | undefined | null): boolean {
  return (
    !!acc &&
    acc.provider !== 'rss' &&
    acc.auth_type !== 'rss' &&
    // The local archive has no server to send through (ADR-0014).
    acc.auth_type !== 'local_archive' &&
    // Graph sends only with Mail.Send granted (#143).
    (acc.auth_type !== 'graph_oauth' || acc.graph_send === true) &&
    acc.needs_reconnect !== true
  )
}

// All send-as identities for an account: the primary address first (carrying the
// account's sender name), followed by each configured alias. Blank alias names
// inherit the account sender name, matching the backend send resolver.
export function accountIdentities(acc: Account): Alias[] {
  return [
    { email: acc.email, name: acc.sender_name },
    ...(acc.aliases ?? []).map((alias) => ({
      ...alias,
      name: alias.name?.trim() ? alias.name : acc.sender_name,
    })),
  ]
}

// Optimistically flip a boolean account field in local state, persist it via the
// given bridge method, and revert if the call fails. Backs the per-account
// toggles (images, unified-inbox inclusion, mute, pause).
async function setAccountFlag(
  accountId: string,
  field: 'load_remote_images' | 'conversation_html' | 'included_in_unified' | 'muted' | 'paused',
  method: string,
  enabled: boolean,
) {
  const previous = accounts$.get()
  accounts$.set(previous.map((acc) => (acc.id === accountId ? { ...acc, [field]: enabled } : acc)))
  try {
    await invoke(method, { id: accountId, enabled })
  } catch (error) {
    accounts$.set(previous)
    showToast(error instanceof Error ? error.message : t('accounts.toast.failedToUpdateSetting'), 'error')
  }
}

// Toggle whether an account renders remote (URL-based) inline images.
export function setAccountImages(accountId: string, enabled: boolean) {
  return setAccountFlag(accountId, 'load_remote_images', 'account.setImages', enabled)
}

// Toggle whether conversation bubbles render original HTML when available.
export function setAccountConversationHtml(accountId: string, enabled: boolean) {
  return setAccountFlag(accountId, 'conversation_html', 'account.setConversationHtml', enabled)
}

// Toggle whether an account's inbox folds into the unified inbox.
export function setAccountUnified(accountId: string, enabled: boolean) {
  return setAccountFlag(accountId, 'included_in_unified', 'account.setUnified', enabled)
}

// Toggle whether an account raises desktop notifications for new mail. When
// muted, messages still arrive and the UI refreshes; only the OS toast is gone.
export function setAccountMuted(accountId: string, enabled: boolean) {
  return setAccountFlag(accountId, 'muted', 'account.setMuted', enabled)
}

// Pause/resume automatic checking for new messages. While paused, the sidecar
// stops the IDLE watcher and skips background syncs for the account.
export function setAccountPaused(accountId: string, enabled: boolean) {
  return setAccountFlag(accountId, 'paused', 'account.setPaused', enabled)
}

export async function setAccountSaveSentCopy(accountId: string, value: boolean | null) {
  const previous = accounts$.get()
  accounts$.set(previous.map((acc) => (acc.id === accountId ? { ...acc, save_sent_copy: value } : acc)))
  try {
    await invoke('account.setSaveSentCopy', { id: accountId, value })
  } catch (error) {
    accounts$.set(previous)
    showToast(error instanceof Error ? error.message : t('accounts.toast.failedToUpdateSentCopy'), 'error')
  }
}

export async function setRSSSyncInterval(accountId: string, minutes: number) {
  const nextMinutes = Math.min(1440, Math.max(5, Math.round(minutes)))
  const previous = accounts$.get()
  accounts$.set(
    previous.map((acc) => (acc.id === accountId ? { ...acc, rss_sync_interval_minutes: nextMinutes } : acc)),
  )
  try {
    await invoke('account.setRSSSyncInterval', { id: accountId, minutes: nextMinutes })
  } catch (error) {
    accounts$.set(previous)
    showToast(error instanceof Error ? error.message : t('accounts.toast.failedToUpdateSyncInterval'), 'error')
  }
}

/** How often a mail account is checked for what push does not cover (#270);
 * 0 is "manual only". The core bounds anything else and says what it kept. */
export async function setMailCheckInterval(accountId: string, minutes: number) {
  const asked = Math.max(0, Math.round(minutes))
  const previous = accounts$.get()
  const withInterval = (value: number) =>
    accounts$.set(
      accounts$.get().map((acc) => (acc.id === accountId ? { ...acc, mail_check_interval_minutes: value } : acc)),
    )
  withInterval(asked)
  try {
    const res = await invoke<{ minutes?: number }>('account.setMailCheckInterval', { id: accountId, minutes: asked })
    if (typeof res?.minutes === 'number' && res.minutes !== asked) withInterval(res.minutes)
  } catch (error) {
    accounts$.set(previous)
    showToast(error instanceof Error ? error.message : t('accounts.toast.failedToUpdateMailCheckInterval'), 'error')
  }
}

export async function setAccountChatWallpaper(accountId: string, wallpaper: ChatWallpaper | null) {
  const previous = accounts$.get()
  accounts$.set(previous.map((acc) => (acc.id === accountId ? { ...acc, chat_wallpaper: wallpaper } : acc)))
  try {
    await invoke('account.setChatWallpaper', { id: accountId, wallpaper })
  } catch (error) {
    accounts$.set(previous)
    showToast(error instanceof Error ? error.message : t('accounts.toast.failedToUpdateChatBackground'), 'error')
  }
}

export async function writeAccountChatWallpaperFile(
  accountId: string,
  file: { name: string; mime: string; data: string },
) {
  const res = await invoke<{ url: string }>('account.writeChatWallpaperFile', {
    id: accountId,
    filename: file.name,
    mime: file.mime,
    data: file.data,
  })
  return res.url
}

/**
 * Every shared mailbox that opens through `account.id`'s own credentials —
 * derived from the loaded account list, not a separate fetch: `account.list`
 * already returns every account, shared mailboxes included, each carrying
 * `delegate_account_id`.
 */
export function sharedMailboxesOf(accountId: string): Account[] {
  return accounts$.get().filter((acc) => acc.delegate_account_id === accountId)
}

/**
 * Add a shared mailbox: an Exchange mailbox `accountId` has been granted
 * full-access permission on, reached through its own credentials rather
 * than its own. Re-runs the full boot sequence afterward — the same as
 * `deleteAccount` — because a new account row exists now, not something an
 * optimistic local patch can represent.
 */
export async function addSharedMailbox(accountId: string, address: string, displayName: string): Promise<void> {
  await invoke('account.addSharedMailbox', {
    parent_account: accountId,
    address,
    display_name: displayName,
  })
  await boot()
}

/** What removing an account kept on this computer (ADR-0011). */
export type KeptAfterRemoval = { drafts?: number; scheduled?: number; attempts?: number }

/**
 * The sentence that says what is still here after an account was removed, or
 * null when nothing is. Drafts and scheduled messages are the person's own
 * writing and stay; they are never sent from an account that is gone.
 */
export function keptAfterRemovalNotice(kept: KeptAfterRemoval | undefined): string | null {
  const drafts = kept?.drafts ?? 0
  const scheduled = kept?.scheduled ?? 0
  if (drafts === 0 && scheduled === 0) return null
  return t('accounts.toast.removedKept', {
    drafts,
    scheduled,
    defaultValue:
      'Account removed. Kept on this computer: {drafts, plural, =0 {} one {# draft} other {# drafts}}{drafts, plural, =0 {} other {{scheduled, plural, =0 {} other {, }}}}{scheduled, plural, =0 {} one {# scheduled message, not sent} other {# scheduled messages, not sent}}.',
  })
}

export async function deleteAccount(accountId: string) {
  if (
    !(await confirmAction({
      title: 'Remove account?',
      message: t('accounts.removeKeepsWriting', {
        defaultValue:
          'This account will be removed from Oreneta with its mail, contacts and settings. Your unsent drafts and scheduled messages stay on this computer and are not sent.',
      }),
      confirmLabel: 'Remove',
      tone: 'danger',
    }))
  ) {
    return
  }
  try {
    const result = await invoke<{ kept?: KeptAfterRemoval }>('account.remove', { id: accountId })
    forgetAccountInGroups(accountId)
    forgetAccountFolderPrefs(accountId)
    setSignaturePlacement(accountId, 'withText')
    showToast(keptAfterRemovalNotice(result?.kept) ?? t('accounts.toast.accountRemoved'))
    await boot()
  } catch (error) {
    showToast(error instanceof Error ? error.message : t('accounts.toast.failedToRemove'), 'error')
  }
}

export async function reorderAccounts(oldIndex: number, newIndex: number) {
  const previous = accounts$.get()
  const accounts = [...previous]
  const [removed] = accounts.splice(oldIndex, 1)
  accounts.splice(newIndex, 0, removed)
  accounts$.set(accounts)
  try {
    await invoke('account.reorder', { accounts: accounts.map((acc) => acc.id) })
  } catch (error) {
    accounts$.set(previous)
    showToast(error instanceof Error ? error.message : t('accounts.toast.failedToReorder'), 'error')
  }
}

/**
 * The order of every account after one of those shown moves to where another
 * shown one is. The others keep their places in the saved order, so moving
 * among the accounts on screen never moves a hidden one (ADR-0068 §5: the rail
 * and «Comptes i carpetes» show one order). Null when either is not shown.
 */
export function shownAccountOrder(
  allIds: string[],
  shownIds: string[],
  movedId: string,
  targetId: string,
): string[] | null {
  const shown = new Set(shownIds)
  const visible = allIds.filter((id) => shown.has(id))
  const from = visible.indexOf(movedId)
  const to = visible.indexOf(targetId)
  if (from === -1 || to === -1) return null
  visible.splice(to, 0, ...visible.splice(from, 1))
  let next = 0
  return allIds.map((id) => (shown.has(id) ? visible[next++] : id))
}

/** Moves a shown account to where another shown one is, and saves the order. */
export async function moveShownAccount(shownIds: string[], movedId: string, targetId: string) {
  if (movedId === targetId) return
  const order = shownAccountOrder(
    accounts$.peek().map((account) => account.id),
    shownIds,
    movedId,
    targetId,
  )
  if (order) await reorderAccountIds(order)
}

export async function reorderAccountIds(accountIds: string[]) {
  const previous = accounts$.get()
  const byId = new Map(previous.map((account) => [account.id, account]))
  const next = accountIds.flatMap((id) => {
    const account = byId.get(id)
    return account ? [account] : []
  })
  if (next.length !== previous.length) return
  accounts$.set(next)
  try {
    await invoke('account.reorder', { accounts: accountIds })
  } catch (error) {
    accounts$.set(previous)
    showToast(error instanceof Error ? error.message : t('accounts.toast.failedToReorder'), 'error')
  }
}

// Set a friendly name/label for an account.
export async function setAccountName(accountId: string, name: string) {
  const previous = accounts$.get()
  accounts$.set(previous.map((acc) => (acc.id === accountId ? { ...acc, display_name: name } : acc)))
  try {
    await invoke('account.setName', { id: accountId, name })
  } catch (error) {
    accounts$.set(previous)
    showToast(error instanceof Error ? error.message : t('accounts.toast.failedToUpdateAccountName'), 'error')
  }
}

// Set the sender name (outgoing mail From display name) for an account.
export async function setAccountSenderName(accountId: string, name: string) {
  const previous = accounts$.get()
  accounts$.set(previous.map((acc) => (acc.id === accountId ? { ...acc, sender_name: name } : acc)))
  try {
    await invoke('account.setSenderName', { id: accountId, name })
  } catch (error) {
    accounts$.set(previous)
    showToast(error instanceof Error ? error.message : t('accounts.toast.failedToUpdateSenderName'), 'error')
  }
}

export async function writeAccountAvatarFile(accountId: string, file: { name: string; mime: string; data: string }) {
  const res = await invoke<{ url: string }>('account.writeAvatarFile', {
    id: accountId,
    filename: file.name,
    mime: file.mime,
    data: file.data,
  })
  return res.url
}

/// Takes the pictures from the core's list again, after it stored a copy that
/// could not be fetched earlier (#194). Only pictures change; nothing else the
/// person may be editing is touched.
export async function refreshAccountPictures() {
  try {
    const res = await invoke<{ accounts: Account[] }>('account.list')
    const pictures = new Map((res?.accounts ?? []).map((acc) => [acc.id, acc.avatar_url]))
    accounts$.set(
      accounts$.get().map((acc) => (pictures.has(acc.id) ? { ...acc, avatar_url: pictures.get(acc.id) } : acc)),
    )
  } catch {
    // The pictures stay as they were; the next start reads them again.
  }
}

export async function setAccountAvatar(accountId: string, avatarUrl: string) {
  const previous = accounts$.get()
  const nextUrl = avatarUrl.trim()
  // Only a copy kept on this computer is ever shown. A remote address is not:
  // the core fetches it through the account's route, and until that works the
  // account keeps the picture it had (#194).
  if (nextUrl === '' || nextUrl.startsWith('/media/')) {
    accounts$.set(previous.map((acc) => (acc.id === accountId ? { ...acc, avatar_url: nextUrl } : acc)))
  }
  try {
    const res = await invoke<{ avatar_url?: string }>('account.setAvatar', { id: accountId, avatar_url: nextUrl })
    // A remote picture that was fetched comes back as its local copy.
    const stored = res?.avatar_url
    if (typeof stored === 'string' && stored !== nextUrl && (stored === '' || stored.startsWith('/media/'))) {
      accounts$.set(accounts$.get().map((acc) => (acc.id === accountId ? { ...acc, avatar_url: stored } : acc)))
    }
    return true
  } catch (error) {
    accounts$.set(previous)
    showToast(error instanceof Error ? error.message : t('accounts.toast.failedToUpdateAvatar'), 'error')
    return false
  }
}

/**
 * Point one account at its own proxy, at the app-wide one, or at a direct
 * connection. Takes effect as the account's connections are re-established.
 * Resolves to whether it was saved.
 */
export async function setAccountProxy(accountId: string, proxy: AccountProxy): Promise<boolean> {
  const previous = accounts$.get()
  accounts$.set(previous.map((acc) => (acc.id === accountId ? { ...acc, proxy } : acc)))
  try {
    await invoke('account.setProxy', { id: accountId, proxy })
    return true
  } catch (error) {
    accounts$.set(previous)
    showToast(error instanceof Error ? error.message : t('accounts.toast.failedToUpdateProxy'), 'error')
    return false
  }
}

// Set this account's signature choice. `null` clears the override, so the
// account follows the app-wide signature again.
/**
 * The signature writes still outstanding for one account.
 *
 * They are chained rather than fired in parallel: the settings editor can start
 * two in quick succession (the mode the user picked, then its editor's pending
 * text), and unordered bridge calls would let the older content land last.
 *
 * `persisted` is what the store is known to hold — which is what a failed write
 * rolls back to. The optimistic value is not that: two failures in a row would
 * otherwise leave the screen showing a value that never reached the database.
 * The entry is dropped once the chain drains, so the next edit reads a fresh
 * baseline.
 */
type SignatureWrites = { chain: Promise<void>; persisted: Account['signature'] }
const signatureWrites = new Map<string, SignatureWrites>()

function applyAccountSignature(accountId: string, signature: Account['signature']) {
  accounts$.set(accounts$.peek().map((acc) => (acc.id === accountId ? { ...acc, signature } : acc)))
}

/** Persist an account's signature choice. Resolves false when it did not land. */
export async function setAccountSignature(accountId: string, signature: AccountSignature | null): Promise<boolean> {
  const outstanding = signatureWrites.get(accountId)
  const entry: SignatureWrites = outstanding ?? {
    chain: Promise.resolve(),
    persisted: accounts$.peek().find((acc) => acc.id === accountId)?.signature,
  }
  applyAccountSignature(accountId, signature)

  let stored = false
  const write = async () => {
    try {
      await invoke('account.setSignature', { id: accountId, signature })
      entry.persisted = signature
      stored = true
    } catch (error) {
      // Roll back to what the store actually holds, and only while the screen
      // still shows the value this call set: a later write that already landed
      // must not be undone by an earlier one failing.
      if (accounts$.peek().find((acc) => acc.id === accountId)?.signature === signature) {
        applyAccountSignature(accountId, entry.persisted)
      }
      showToast(error instanceof Error ? error.message : t('accounts.toast.failedToUpdateSignature'), 'error')
    }
  }

  const chained = entry.chain.then(write, write)
  entry.chain = chained
  signatureWrites.set(accountId, entry)
  await chained
  if (signatureWrites.get(accountId)?.chain === chained) signatureWrites.delete(accountId)
  return stored
}

// Replace an account's send-as aliases (the whole list). The sidecar normalizes
// entries (trim, drop blank emails, dedupe by email).
export async function setAccountAliases(accountId: string, aliases: Alias[]) {
  const previous = accounts$.get()
  accounts$.set(previous.map((acc) => (acc.id === accountId ? { ...acc, aliases } : acc)))
  try {
    await invoke('account.setAliases', { id: accountId, aliases })
  } catch (error) {
    accounts$.set(previous)
    showToast(error instanceof Error ? error.message : t('accounts.toast.failedToUpdateAliases'), 'error')
  }
}
