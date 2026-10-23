import type { DragEvent } from 'react'
import { useValue } from '@legendapp/state/react'
import { moveFeed, RSS_FEED_DRAG_TYPE } from '../../states/feeds'
import { inboxUnread, mail$ } from '../../states/mail'
import { settings$ } from '../../states/settings'
import type { Account } from '../../types'

// What the vertical rail and the mail folder pane both show of an account
// (ADR-0068 §5): its state, its inbox count and the feeds it takes. One place,
// so the two say the same thing until the rail goes (piece 14b).

/** The state an account is in that its row marks, the most pressing first; null when none. */
export type AccountStatus = 'reconnect' | 'paused' | 'muted'

export function accountStatus(account: Account): AccountStatus | null {
  if (account.needs_reconnect === true) return 'reconnect'
  if (account.paused) return 'paused'
  if (account.muted) return 'muted'
  return null
}

/** The account's inbox unread count, or 0 while the unread badges are turned off. */
export function useAccountUnread(accountId: string): number {
  const shown = useValue(settings$.showUnreadAccountBadge)
  const folders = useValue(mail$.foldersByAccount[accountId])
  return shown ? inboxUnread(folders) : 0
}

export function isRssAccount(account: Pick<Account, 'provider' | 'auth_type'>): boolean {
  return account.provider === 'rss' || account.auth_type === 'rss'
}

/**
 * The feed a drag from the conversation list carries; null for any other drag.
 * Only the drop can read what it carries: while it is held over a target, a
 * browser shows the type alone, and then the feed has no thread.
 */
function draggedFeed(data: DataTransfer | null): { threadId?: string; accountId?: string } | null {
  if (!data || !Array.from(data.types).includes(RSS_FEED_DRAG_TYPE)) return null
  try {
    const raw = data.getData(RSS_FEED_DRAG_TYPE)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as { threadId?: string; accountId?: string }
    return { threadId: parsed.threadId, accountId: parsed.accountId }
  } catch {
    return null
  }
}

/**
 * A feed held over an RSS account: accepted, unless it is known to come from
 * that account. Says whether it was accepted, so a row can mark the drop.
 */
export function feedDragOver(event: DragEvent<HTMLElement>, account: Account): boolean {
  if (!isRssAccount(account)) return false
  const feed = draggedFeed(event.dataTransfer)
  if (!feed || feed.accountId === account.id) return false
  event.preventDefault()
  event.dataTransfer.dropEffect = 'move'
  return true
}

/** A feed dropped on an RSS account moves there, its items and their read state with it. */
export function feedDrop(event: DragEvent<HTMLElement>, account: Account): boolean {
  if (!isRssAccount(account)) return false
  const feed = draggedFeed(event.dataTransfer)
  if (!feed?.threadId || feed.accountId === account.id) return false
  event.preventDefault()
  event.stopPropagation()
  void moveFeed(feed.threadId, account.id)
  return true
}
