import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import { compose$, withoutHydratedQuickReplyDraft } from '../../states/compose'
import { ui$ } from '../../states/ui'
import { mail$, loadThread } from '../../states/mail'
import {
  openThreadSearch,
  resetThreadView,
  takeThreadSearchRequest,
  thread$,
  type ConversationMode,
} from '../../states/thread'
import { Gallery } from './Gallery'
import { EmptyState } from '../empty-state/EmptyState'
import { QuickReplyComposer } from './QuickReplyComposer'
import { ConversationTabs } from './ConversationTabs'
import { ReaderTabView } from './ReaderTabView'
import { ReaderTextSize } from './ReaderTextSize'
import { ConversationHeader } from './ConversationHeader'
import { ThreadSearchBarMobile } from './ThreadSearchBarMobile'
import { ConversationMessageList } from './ConversationMessageList'
import { MessageContextMenu, type MessageContextMenuState } from './MessageContextMenu'
import { buildGalleryItems } from './conversationMedia'
import { useActiveConversation } from './activeConversation'
import { useThreadSearch } from './useThreadSearch'
import { useConversationScroll } from './useConversationScroll'
import { ArrowRight } from 'lucide-react'
import { wallpaperCss } from '../../lib/wallpapers'
import { clearMediaSession } from '../../lib/mediaSession'

export function MessagePane() {
  const { t } = useTranslation()
  const messages = useValue(mail$.messages)
  const messagesCursor = useValue(mail$.messagesCursor)
  const messagesLoadingMore = useValue(mail$.messagesLoadingMore)
  const threadLoading = useValue(mail$.threadLoading)
  const threadErrorId = useValue(mail$.threadErrorId)
  const mobilePane = useValue(ui$.mobilePane)
  const revealedRemote = useValue(thread$.revealedRemote)
  const galleryIndex = useValue(thread$.galleryIndex)
  const modeOverrides = useValue(thread$.conversationModeOverrides)
  // Ring-highlight for a message jumped to from the starred list; shares the
  // search-match ring styling in ConversationMessageList.
  const flashMessageId = useValue(thread$.flashMessageId)
  const quickReplyDraftId = useValue(compose$.quickReplyDraftId)
  const quickReplyDraftSaved = useValue(compose$.quickReplyDraftSaved)
  // The conversation's details are the app sidebar's Conversa panel now
  // (ADR-0069), which reads the same conversation.
  const { accounts, activeTab, activeDocumentTab, activeThread, activeAccount, isRSS } = useActiveConversation()
  const conversationActiveTab = activeDocumentTab ? activeTab : ''
  const activeThreadId = activeThread?.thread_id ?? ''
  const conversationWallpaper = wallpaperCss(activeAccount?.chat_wallpaper)
  // Show a spinner instead of the previous thread's messages while a freshly
  // selected thread loads. Suppressed once any loaded message belongs to the
  // active thread, so re-reads of the open thread (sync refresh) don't flash.
  const showThreadLoading = threadLoading && !messages.some((message) => message.thread_id === activeThreadId)
  // The load failed and there's nothing of this thread to show — offer a retry
  // instead of a blank pane. Suppressed while a (re)load is in flight.
  const showThreadError =
    !showThreadLoading &&
    threadErrorId === activeThreadId &&
    !messages.some((message) => message.thread_id === activeThreadId)
  const retryThreadLoad = useCallback(() => {
    if (activeThreadId) void loadThread(activeThreadId).catch(console.error)
  }, [activeThreadId])
  // Keep the draft hydrated into the quick-reply bar out of the conversation,
  // including while an optimistic sending bubble follows it.
  const displayMessages = useMemo(
    () => withoutHydratedQuickReplyDraft(messages, quickReplyDraftId, quickReplyDraftSaved),
    [messages, quickReplyDraftId, quickReplyDraftSaved],
  )
  const unreadKey = displayMessages.map((message) => `${message.id}:${message.unread ? '1' : '0'}`).join('|')

  const accountConversationMode: ConversationMode = (activeAccount?.conversation_html ?? true) ? 'html' : 'plain'
  const conversationMode: ConversationMode = activeAccount
    ? (modeOverrides[activeAccount.id] ?? accountConversationMode)
    : 'plain'
  const setQuickConversationMode = useCallback(
    (mode: ConversationMode) => {
      if (!activeAccount) return
      thread$.conversationModeOverrides[activeAccount.id].set(mode)
    },
    [activeAccount],
  )

  const { galleryItems, galleryOffsets } = useMemo(
    () => buildGalleryItems(displayMessages, accounts, revealedRemote),
    [displayMessages, accounts, revealedRemote],
  )

  const threadSearchFocus = useValue(thread$.searchFocus)
  const desktopThreadSearchInputRef = useRef<HTMLInputElement | null>(null)
  const mobileThreadSearchInputRef = useRef<HTMLInputElement | null>(null)
  const { threadSearchOpen, searchMatches, activeSearchIndex, activeSearchId, goToSearchMatch } =
    useThreadSearch(displayMessages)
  const { scrollRef, bottomAnchorRef, messagesWrapperRef, handleConversationScroll, setScrollTop } =
    useConversationScroll(activeThreadId, displayMessages, conversationActiveTab, unreadKey)

  const [contextMenu, setContextMenu] = useState<MessageContextMenuState | null>(null)

  // The conversation whose search this pane opened on a request from another
  // module (#344). Kept by the pane, not by the request: a replayed mount
  // effect (StrictMode, in development) resets the view again, and opens the
  // search again after it.
  const searchAskedFor = useRef('')
  useEffect(() => {
    resetThreadView()
    // No conversation shown: whatever was answered is over, so coming back to
    // the same conversation later does not open its search again.
    if (!activeThreadId) {
      searchAskedFor.current = ''
      return
    }
    if (takeThreadSearchRequest(activeThreadId)) searchAskedFor.current = activeThreadId
    else if (searchAskedFor.current !== activeThreadId) searchAskedFor.current = ''
    if (searchAskedFor.current) openThreadSearch()
  }, [activeThreadId])

  useLayoutEffect(() => {
    return () => {
      const container = scrollRef.current
      if (container) {
        container.querySelectorAll<HTMLMediaElement>('video, audio').forEach((media) => {
          try {
            media.pause()
            media.querySelectorAll('source').forEach((source) => source.remove())
            media.removeAttribute('src')
            media.load()
          } catch {
            // Ignore
          }
        })

        container.querySelectorAll('iframe').forEach((iframe) => {
          try {
            const doc = iframe.contentDocument
            const win = iframe.contentWindow
            if (doc) {
              doc.querySelectorAll<HTMLMediaElement>('video, audio').forEach((media) => {
                try {
                  media.pause()
                  media.querySelectorAll('source').forEach((source) => source.remove())
                  media.removeAttribute('src')
                  media.load()
                } catch {
                  // Ignore
                }
              })
              doc.querySelectorAll('iframe').forEach((nestedIframe) => {
                try {
                  nestedIframe.removeAttribute('src')
                  nestedIframe.src = 'about:blank'
                  nestedIframe.remove()
                } catch {
                  // Ignore
                }
              })
            }
            if (win) {
              clearMediaSession(win)
            }
            iframe.removeAttribute('src')
            iframe.src = 'about:blank'
          } catch {
            // Ignore
          }
        })
      }
      clearMediaSession()
    }
  }, [activeThreadId])

  useEffect(() => {
    if (!threadSearchOpen) return
    // threadSearchFocus also re-runs this when ⌘/Ctrl+F is pressed with the bar
    // already open — including from inside an HTML message frame, which is
    // where focus otherwise stays.
    const frame = window.requestAnimationFrame(() => {
      // The one drawn: the header's field from 900 px in a header of 32 rem,
      // the bar under it otherwise (#347). The window's width alone chose the
      // header's at the app's 200 % in a 1025 px window, where it is hidden.
      const header = desktopThreadSearchInputRef.current
      const input = header && header.getClientRects().length > 0 ? header : mobileThreadSearchInputRef.current
      input?.focus()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [threadSearchOpen, threadSearchFocus])

  useEffect(() => {
    if (!activeSearchId) return
    const container = scrollRef.current
    const match = container?.querySelector<HTMLElement>(`[data-search-match-id="${CSS.escape(activeSearchId)}"]`)
    match?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [activeSearchId])

  const conversationContent = activeThread ? (
    <>
      <ConversationHeader
        activeThread={activeThread}
        isRSS={isRSS}
        conversationMode={conversationMode}
        setQuickConversationMode={setQuickConversationMode}
        searchMatches={searchMatches}
        activeSearchIndex={activeSearchIndex}
        goToSearchMatch={goToSearchMatch}
        desktopSearchInputRef={desktopThreadSearchInputRef}
      />

      {activeThread.original_thread_id && (
        <div className="flex shrink-0 items-center justify-between bg-accent/10 dark:bg-accent/15 px-4 py-2.5 text-xs border-b border-border select-none transition-colors">
          <span className="text-secondary/90 font-medium">{t('chat.branchNotice')}</span>
          <button
            onClick={() => ui$.selectedThread.set(activeThread.original_thread_id!)}
            className="flex items-center gap-1 font-semibold text-accent-fg hover:underline cursor-pointer"
          >
            <span>{t('chat.viewOriginalTopic')}</span>
            <ArrowRight size={14} strokeWidth={1.75} />
          </button>
        </div>
      )}

      {threadSearchOpen && (
        <ThreadSearchBarMobile
          searchMatches={searchMatches}
          activeSearchIndex={activeSearchIndex}
          goToSearchMatch={goToSearchMatch}
          inputRef={mobileThreadSearchInputRef}
        />
      )}

      <ReaderTextSize />
      <ConversationMessageList
        messages={displayMessages}
        showThreadLoading={showThreadLoading}
        showThreadError={showThreadError}
        onRetryThreadLoad={retryThreadLoad}
        messagesCursor={messagesCursor}
        messagesLoadingMore={messagesLoadingMore}
        activeThreadId={activeThreadId}
        searchMatches={searchMatches}
        activeSearchId={activeSearchId}
        jumpMessageId={flashMessageId}
        galleryOffsets={galleryOffsets}
        scrollRef={scrollRef}
        messagesWrapperRef={messagesWrapperRef}
        bottomAnchorRef={bottomAnchorRef}
        wallpaperClassName={conversationWallpaper.className}
        wallpaperStyle={conversationWallpaper.style}
        onScroll={handleConversationScroll}
        onSetScrollTop={setScrollTop}
        onOpenContextMenu={setContextMenu}
      />

      {activeAccount?.auth_type === 'graph_oauth' && !activeAccount.graph_send ? (
        <p role="status" className="border-t border-border px-4 py-3 text-caption text-secondary">
          {activeAccount.graph_writes
            ? t('accounts.graph.changesNotice')
            : t('accounts.graph.readerNotice', {
                defaultValue:
                  'Microsoft Graph — read-only. Sending is not available; changes can be allowed in the account settings.',
              })}
        </p>
      ) : (
        !isRSS && <QuickReplyComposer />
      )}
    </>
  ) : (
    <div
      style={conversationWallpaper.style}
      className={`flex-1 flex items-center justify-center p-6 ${conversationWallpaper.className}`}
    >
      <EmptyState title={t('empty.noConversationSelected')} text={t('empty.noConversationSelectedText')} />
    </div>
  )

  return (
    <div
      data-message-pane
      data-region="reader"
      className={`relative flex min-w-0 flex-1 flex-col overflow-hidden min-[769px]:min-w-[360px] ${
        mobilePane === 'conversation' ? 'max-[769px]:flex' : 'max-[769px]:hidden'
      }`}
    >
      <ConversationTabs />
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <section className="relative flex flex-1 flex-col overflow-hidden bg-chat">
          {/* Under an open reader or compose tab the conversation stays mounted,
              hidden, so it is made inert as well as invisible: `visibility`
              alone lets a child with `transition-all` stay visible, and
              focusable, while the transition runs, and Tab could land inside
              an aria-hidden region (#243). */}
          <div
            data-conversation
            aria-hidden={!!activeDocumentTab}
            inert={!!activeDocumentTab}
            className={`relative flex min-h-0 flex-1 flex-col ${
              activeDocumentTab ? 'pointer-events-none invisible' : ''
            }`}
          >
            {conversationContent}
          </div>
          {activeDocumentTab && (
            <div className="absolute inset-0 z-20 flex flex-col bg-chat">
              <ReaderTabView tab={activeDocumentTab} />
            </div>
          )}
        </section>
      </div>

      {galleryIndex !== null && galleryItems[galleryIndex] && (
        <Gallery
          items={galleryItems}
          index={galleryIndex}
          onIndexChange={(idx) => thread$.galleryIndex.set(idx)}
          onClose={() => thread$.galleryIndex.set(null)}
        />
      )}

      {contextMenu && <MessageContextMenu state={contextMenu} isRSS={isRSS} onClose={() => setContextMenu(null)} />}
    </div>
  )
}
