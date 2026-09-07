// Shared data-model types, mirroring the sidecar's bridge shapes. Imported by
// both the state modules and the UI; no runtime code lives here.

import type { SignatureMark } from './lib/signature'

export type AuthType = 'password' | 'gmail_oauth' | 'outlook_oauth' | 'rss'

/** A send-as identity for an account: an owned address and an optional From
 * display name (blank falls back to the account's `sender_name`). */
export type Alias = {
  email: string
  name?: string
}

export type Account = {
  id: string
  email: string
  display_name: string
  avatar_url?: string
  provider: string
  auth_type: AuthType
  /** The IMAP/SMTP login, which is not always the address. */
  username?: string
  imap_host: string
  imap_port: number
  smtp_host: string
  smtp_port: number
  tls: boolean
  starttls?: boolean
  smtp_tls?: boolean
  smtp_starttls?: boolean
  ews_url?: string
  /** Set only for a shared mailbox: the account whose credentials actually
   * open it. Empty for every other account, including the one granting
   * access — see meron-core's `imap::Creds::delegate_account_id`. */
  delegate_account_id?: string
  /** Server certificates this account accepted, when they cannot be validated normally. */
  cert_pin?: string
  smtp_cert_pin?: string
  /** Whether remote (URL-based) inline images render for this account. */
  load_remote_images?: boolean
  /** Whether message views prefer original HTML when available (default true). */
  conversation_html?: boolean
  /** Whether Oreneta uploads a Sent copy after SMTP send. null/absent uses provider default. */
  save_sent_copy?: boolean | null
  /** Per-account conversation background; absent uses Oreneta's default pattern. */
  chat_wallpaper?: ChatWallpaper | null
  /** Whether this account's inbox folds into the unified inbox (default true). */
  included_in_unified?: boolean
  /** Whether new-mail desktop notifications are suppressed (default false). */
  muted?: boolean
  /** Whether automatic checking for new messages is paused (default false). */
  paused?: boolean
  /** True when account metadata was restored but the OS keychain secret is missing. */
  needs_reconnect?: boolean
  /** RSS automatic sync interval in minutes (default 60). */
  rss_sync_interval_minutes?: number
  feed_url?: string
  sender_name?: string
  /** Additional send-as addresses (besides the primary `email`). */
  aliases?: Alias[]
  /** Signature override; absent means "follow the app-wide signature". */
  signature?: AccountSignature | null
  /** How this account proxies its connections; absent means "follow the app proxy". */
  proxy?: AccountProxy
}

/**
 * Per-account signature choice: follow the app-wide signature, send none, or
 * use this account's own `html`. The html is kept across mode changes so
 * flipping to 'global'/'none' and back doesn't lose the text.
 */
export type AccountSignature = {
  mode: 'global' | 'none' | 'custom'
  html: string
}

/**
 * Per-account proxy choice: follow the app-wide proxy, always connect directly,
 * or override it with this account's own HTTP/SOCKS5 proxy.
 */
export type AccountProxy = {
  mode: 'global' | 'direct' | 'http' | 'socks5'
  host?: string
  port?: number
  username?: string
  password?: string
}

export type ChatWallpaper = { kind: 'preset'; presetId: string } | { kind: 'custom'; url: string }

export type Folder = {
  id: string
  account_id: string
  name: string
  role: string
  delimiter?: string
  unread: number
}

/** A correspondent surfaced for recipient autocomplete. */
export type Contact = {
  name: string
  addr: string
  /**
   * True when this came out of an address book rather than out of mail seen.
   *
   * Two different claims: somebody the reader keeps, versus an address that
   * went past in a header and which they may not recognise at all.
   */
  known?: boolean
  /** Where they work, when a book said so. */
  organisation?: string
  /** True when this came from the organisation's directory, asked just now. */
  directory?: boolean
}

/** Somebody in an address book. */
export type Person = {
  id: string
  /** "carddav", "google", "exchange", "local". */
  source: string
  /** The account whose book they are in; empty for a book that is nobody's. */
  account: string
  book: string
  name: string
  organisation: string
  note: string
  /** Media key of their picture, served at `/media/<key>`; empty when none. */
  photo: string
  emails: { addr: string; label: string }[]
  phones: { number: string; label: string }[]
}

export type Attachment = {
  filename: string
  mime: string
  size: number
  /** Relative media key served at `/media/<key>`; null for non-image files. */
  key: string | null
  /** Remote image URL (RSS inline images); null/absent for local attachments. */
  url?: string | null
}

export type ComposerAttachment = {
  id: string
  filename: string
  mime: string
  size: number
  data: string // base64 encoded
  /** Content-ID for images embedded in the rich-text body. */
  inlineId?: string
}

export type Message = {
  id: string
  account_id: string
  folder_id: string
  folder_role?: Folder['role']
  thread_id: string
  from_name: string
  from_addr: string
  to: string
  /** Comma-separated Reply-To addresses from the original message ("Name <addr>" or "addr"). */
  reply_to?: string
  /** Comma-separated Cc addresses from the original message. */
  cc?: string
  /** Comma-separated Bcc addresses. Present only on outgoing copies (Sent/Drafts);
   * received messages never carry Bcc (the sending server strips it). */
  bcc?: string
  /** Normalized Message-ID ("id@host", no angle brackets). Replies use this for In-Reply-To. */
  message_id?: string
  /** Normalized References chain (space-separated bare ids). */
  references?: string
  subject: string
  preview: string
  body: string
  /** Iframe-ready original email HTML for "HTML mode"; absent for plain-text messages. */
  body_html?: string
  /** True when the body isn't cached yet — the on-demand fetch failed or is
   * still filling in the background (a `mail.synced` re-read delivers it). */
  body_missing?: boolean
  /** Send time as Unix epoch seconds (0 when unknown). Format via lib/date helpers. */
  date: number
  /** Sent by this account, classified by the core (own address or Sent-folder
   * provenance) — true even for aliases not configured in Oreneta. Absent on
   * rows shaped before the flag existed; the UI then falls back to matching
   * the From address against the account's identities. */
  outgoing?: boolean
  unread: boolean
  unread_count?: number
  /** Total messages in the thread, read or not; absent when not grouped. */
  message_count?: number
  starred: boolean
  /** RSS thread only: at least one item in the feed is starred. This does not
   * mean the feed card itself is starred. */
  has_starred_items?: boolean
  has_draft?: boolean
  has_attachments: boolean
  /** Ids of the local labels on this conversation, in the reader's order. */
  labels?: string[]
  /**
   * What the message's own structure declares was done to it: "pgpEncrypted",
   * "pgpSigned", "smimeEnveloped" and so on; absent when nothing was.
   *
   * A claim, not a verdict. Whether a signature is good needs keys and is a
   * separate answer, so the interface must not present this as one.
   */
  protection?: string
  /**
   * Whether this is worth interrupting for, as the core judged it.
   *
   * Absent means nobody has judged it — a message cached before this existed —
   * which is not the same as judged unimportant.
   */
  priority?: boolean
  /**
   * Whether the learned spam filter flags this, as the core judged it.
   *
   * Absent means nobody has judged it — the identical rule as `priority`,
   * and the same reason: unjudged must never read as "checked and clean".
   * Never acted on by itself; see `components/chat/SpamNotice.tsx`.
   */
  spam?: boolean
  /** The open task on this conversation, if any — never a completed one; the
   * Tasks view is where those are found. */
  task?: { id: number; due_at: number | null } | null
  attachments?: Attachment[]
  /** Source feed URL; present on RSS feed threads only. */
  feed_url?: string
  /** Cached feed-icon media key (served at `/media/<key>`); present on RSS feed
   * threads only, empty when the feed declared no icon or it isn't cached yet. */
  feed_icon?: string
  original_thread_id?: string
  /** On an outbound thread card, the count of recipients beyond the one shown,
   * rendered as a "+N" hint. Absent/0 for inbound or single-recipient threads. */
  recipient_overflow?: number
  /** Local send lifecycle for an optimistically-rendered outgoing message.
   * Absent on messages loaded from the engine (treated as already sent). */
  send_status?: 'queued' | 'sending' | 'sent' | 'failed'
}

// Editable state for a compose/reply draft living inside a compose tab.
export type ComposeDraft = {
  accountId: string
  /** Chosen send-as address (the account's primary or one of its aliases).
   * Empty means the account's primary address. */
  fromEmail: string
  to: string
  cc: string
  bcc: string
  /** Outgoing `Reply-To` header. Optional — most messages don't set one. */
  replyTo: string
  subject: string
  rich: boolean // true = rich-text (HTML) editor, false = plaintext
  html: string // body when rich
  text: string // body when plaintext
  showCcBcc: boolean
  /** Parent message's bare Message-ID, used to set In-Reply-To/References on send. */
  inReplyTo: string
  /** Parent's References chain (space-separated bare ids) plus parent's Message-ID. */
  references: string
  /** Stable Message-ID reused across draft autosaves so the server-side Drafts
   * copy is replaced in place instead of duplicated. Generated on tab creation. */
  draftMessageId: string
  /**
   * What this draft knows about the signature in its body: the one the app
   * inserted (so a change of From account can swap it), `null` for "the app
   * inserted none", or absent for a body it did not compose. See
   * `SignatureTracking` in lib/signature.ts — the three states differ.
   */
  signature?: SignatureMark | null
  /** Server-side draft row this compose tab was restored from, if any. */
  sourceDraft?: {
    threadId: string
    messageId: string
    folderId: string
  }
  attachments: ComposerAttachment[]
  /** Sign with the sender's own OpenPGP key before sending. */
  pgpSign: boolean
  /** Encrypt to every recipient's OpenPGP key before sending. */
  pgpEncrypt: boolean
}

/** An open reader tab for a single message (alongside the default conversation view).
 * The body is snapshotted at open time so the tab survives switching threads (which
 * reloads `mail$.messages`). */
export type MessageTab = {
  id: string
  kind: 'reader' | 'compose' | 'thread'
  messageId: string
  threadId: string
  /** Present on thread tabs so they can render outside the currently selected mailbox. */
  accountId?: string
  /** Present on thread tabs so message loading does not depend on side navigation. */
  folderId?: string
  subject: string
  from: string
  /** Raw correspondent header strings ("Name <addr>", comma-separated), snapshotted
   * at open time so the reader tab can show the full From/To/Cc/Reply-To list.
   * Present only on reader tabs. */
  fromRaw?: string
  to?: string
  cc?: string
  bcc?: string
  replyTo?: string
  /** Original message date as Unix epoch seconds, shown in the reader tab header. */
  date?: number
  body: string
  bodyHtml?: string
  attachments?: Attachment[]
  viewMode: 'html' | 'plain'
  /** Present only when kind === "compose". */
  compose?: ComposeDraft
}

export type SystemCheck = {
  platform: string
  mail_engine: 'meron_mail'
  meron_mail: {
    configured: boolean
    available: boolean
    server_path: string
  }
  gmail_oauth_configured: boolean
  outlook_oauth_configured: boolean
  database_path: string
  log_path?: string
}
