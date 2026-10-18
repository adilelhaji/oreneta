import { useRef } from 'react'
import { useValue } from '@legendapp/state/react'
import { ui$, type AppModule } from './states/ui'
import { useTranslation } from './lib/i18n'
import { mail$ } from './states/mail'
import { compose$ } from './states/compose'
import { accounts$ } from './states/accounts'
import { kanban$ } from './states/kanban'
import { settings$ } from './states/settings'
import { useAppEffects } from './useAppEffects'
import { SideNav } from './components/sidenav/SideNav'
import { MailNavigation } from './components/sidenav/MailNavigation'
import { ThreadList } from './components/threads/ThreadList'
import { KanbanView } from './components/kanban/KanbanView'
import { CalendarView } from './components/calendar/CalendarView'
import { PeopleView } from './components/people/PeopleView'
import { TasksView } from './components/tasks/TasksView'
import { NotesView } from './components/notes/NotesView'
import { MessagingView } from './components/messaging/MessagingView'
import { AttachmentsView } from './components/attachments/AttachmentsView'
import { TaskDialog } from './components/tasks/TaskDialog'
import { QuickActionDialog } from './components/quick/QuickActionDialog'
import { AwaitingDialog } from './components/awaiting/AwaitingDialog'
import { MergeDialog } from './components/merge/MergeDialog'
import { MessagePane } from './components/chat/MessagePane'
import { KanbanPaneResizer } from './components/resizer/PaneResizers'
import { AboutDialog } from './components/dialog/AboutDialog'
import { ChangelogDialog } from './components/dialog/ChangelogDialog'
import { CommandPalette } from './components/palette/CommandPalette'
import { ErrorBoundary } from './components/ErrorBoundary'
import { AppHotkeys } from './components/dialog/AppHotkeys'
import { ShortcutsDialog } from './components/dialog/ShortcutsDialog'
import { AppToast } from './components/toast/AppToast'
import { AppConfirm } from './components/dialog/AppConfirm'
import { CertificateTrustDialog } from './components/dialog/CertificateTrustDialog'
import { MacTitleBar } from './components/titlebar/MacTitleBar'
import { ConnectivityBanner } from './components/banner/ConnectivityBanner'
import { UpdateBanner } from './components/banner/UpdateBanner'
import { SetupScreen } from './components/setup/SetupScreen'
import { AccountDialog } from './components/dialog/AccountDialog'
import { SettingsDialog } from './components/dialog/SettingsDialog'
import { AddFeedDialog } from './components/dialog/AddFeedDialog'
import { FeedEditDialog } from './components/dialog/FeedEditDialog'
import { ScheduledSendsDialog } from './components/dialog/ScheduledSendsDialog'
import { RuleLogDialog } from './components/dialog/RuleLogDialog'
import { DesignCatalogue } from './components/dialog/DesignCatalogue'
import { SweepDialog } from './components/dialog/SweepDialog'

export default function App() {
  const { t } = useTranslation()
  const mainRef = useRef<HTMLElement | null>(null)
  const kanbanPaneRef = useRef<HTMLDivElement | null>(null)
  const system = useValue(ui$.system)
  const accounts = useValue(accounts$)
  const activeBoardId = useValue(kanban$.activeBoardId)
  const composeTabs = useValue(compose$.tabs)
  const activeComposeTab = useValue(compose$.activeTab)
  const threadListWidth = useValue(settings$.threadListWidth)
  const kanbanPaneThreadId = useValue(kanban$.paneThreadId)
  const kanbanPaneWidth = useValue(settings$.kanbanPaneWidth)
  const activeModule = useValue(ui$.module)
  const taskEditor = useValue(ui$.taskEditor)
  const setupOpen = useValue(ui$.setupOpen)
  const settingsOpen = useValue(ui$.settingsOpen)
  const addFeedAccount = useValue(ui$.addFeedAccount)
  const editFeed = useValue(ui$.editFeed)
  const scheduledSendsOpen = useValue(ui$.scheduledSendsOpen)
  const ruleLogOpen = useValue(ui$.ruleLogOpen)
  const catalogueOpen = useValue(ui$.catalogueOpen)
  const sweepTarget = useValue(ui$.sweep)

  useAppEffects()

  // The name each module gives <main>: the one its own heading and its rail
  // button already use.
  const moduleNames: Record<AppModule, string> = {
    mail: t('shell.region.mail'),
    calendar: t('calendar.title'),
    people: t('people.title'),
    tasks: t('tasks.title'),
    notes: t('notes.title'),
    chat: t('messaging.title'),
    attachments: t('attachmentsView.title'),
  }

  const showKanbanMessagePane = !!kanbanPaneThreadId || composeTabs.some((tab) => tab.id === activeComposeTab)

  if (system && accounts.length === 0) {
    return (
      <div className="flex h-full w-full flex-col bg-app text-primary">
        <MacTitleBar />
        <div className="min-h-0 flex-1">
          <SetupScreen />
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full w-full flex-col bg-app text-primary">
      <MacTitleBar />
      <ConnectivityBanner />
      <UpdateBanner />
      {/* One <main>, named after the module on screen (ADR-0068 §1). The rail
          and the mail navigation are still inside it until the folder pane
          and the module strip replace them (ADR-0068 §9). */}
      <main ref={mainRef} aria-label={moduleNames[activeModule]} className="flex min-h-0 w-full flex-1 overflow-hidden">
        <ErrorBoundary label="side navigation">
          <SideNav />
        </ErrorBoundary>
        {activeModule === 'mail' && !activeBoardId && (
          <ErrorBoundary label="mail navigation">
            <MailNavigation />
          </ErrorBoundary>
        )}
        {activeModule === 'people' ? (
          <ErrorBoundary label="people">
            <PeopleView />
          </ErrorBoundary>
        ) : activeModule === 'calendar' ? (
          <ErrorBoundary label="calendar">
            <CalendarView />
          </ErrorBoundary>
        ) : activeModule === 'tasks' ? (
          <ErrorBoundary label="tasks">
            <TasksView />
          </ErrorBoundary>
        ) : activeModule === 'notes' ? (
          <ErrorBoundary label="notes">
            <NotesView />
          </ErrorBoundary>
        ) : activeModule === 'attachments' ? (
          <ErrorBoundary label="attachments">
            <AttachmentsView />
          </ErrorBoundary>
        ) : activeModule === 'chat' ? (
          <ErrorBoundary label="messaging">
            <MessagingView />
          </ErrorBoundary>
        ) : (
        <ErrorBoundary label="thread list">
          {activeBoardId ? (
            <KanbanView boardId={activeBoardId} />
          ) : (
            <ThreadList width={threadListWidth} resizable />
          )}
        </ErrorBoundary>
        )}
        {activeModule !== 'mail' ? null : !activeBoardId ? (
          <ErrorBoundary label="conversation">
            <MessagePane />
          </ErrorBoundary>
        ) : showKanbanMessagePane ? (
          <div
            ref={kanbanPaneRef}
            className="relative flex shrink-0 overflow-hidden border-s border-border bg-chat max-[600px]:w-full"
            style={{ width: `${kanbanPaneWidth}%`, minWidth: 320 }}
          >
            {/* The width is a percentage of the app shell, kept in settings. */}
            <KanbanPaneResizer pane={kanbanPaneRef} shell={mainRef} />
            <ErrorBoundary label="conversation">
              <MessagePane />
            </ErrorBoundary>
          </div>
        ) : null}
      </main>

      {/* Dialogs, toasts and confirmations are siblings of the regions, not
          part of the module in <main> (ADR-0068 §1). */}
      <AppHotkeys />
      <CommandPalette />
      <ShortcutsDialog />
      <AboutDialog />
      <ChangelogDialog />

      {/* Settings first so the add-account dialog (setupOpen), opened from within
        Settings, layers on top and returns here when closed. */}
      {settingsOpen && <SettingsDialog />}
      {setupOpen && <AccountDialog />}
      {addFeedAccount && <AddFeedDialog />}
      {editFeed && <FeedEditDialog />}
      {scheduledSendsOpen && <ScheduledSendsDialog />}
      {ruleLogOpen && <RuleLogDialog />}
      {catalogueOpen && <DesignCatalogue />}
      {/* Keyed by the task, so moving from one to another starts from that one's fields. */}
      {taskEditor && <TaskDialog key={`${taskEditor.threadId}:${taskEditor.id}`} />}
      <QuickActionDialog />
      <AwaitingDialog />
      <MergeDialog />
      {sweepTarget && (
        <SweepDialog
          accountId={sweepTarget.accountId}
          folder={sweepTarget.folder}
          sender={sweepTarget.sender}
          onClose={() => ui$.sweep.set(null)}
        />
      )}

      <AppToast />
      <AppConfirm />
      <CertificateTrustDialog />
    </div>
  )
}
