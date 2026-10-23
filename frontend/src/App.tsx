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
import { FolderPane } from './components/shell/FolderPane'
import { AppHeader } from './components/shell/AppHeader'
import { AppLayers } from './components/shell/AppLayers'
import { ThreadList } from './components/threads/ThreadList'
import { KanbanView } from './components/kanban/KanbanView'
import { CalendarView } from './components/calendar/CalendarView'
import { PeopleView } from './components/people/PeopleView'
import { TasksView } from './components/tasks/TasksView'
import { NotesView } from './components/notes/NotesView'
import { MessagingView } from './components/messaging/MessagingView'
import { AttachmentsView } from './components/attachments/AttachmentsView'
import { MessagePane } from './components/chat/MessagePane'
import { KanbanPaneResizer } from './components/resizer/PaneResizers'
import { ErrorBoundary } from './components/ErrorBoundary'
import { MacTitleBar } from './components/titlebar/MacTitleBar'
import { ConnectivityBanner } from './components/banner/ConnectivityBanner'
import { UpdateBanner } from './components/banner/UpdateBanner'
import { SetupScreen } from './components/setup/SetupScreen'

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

  // No account yet: the first-account setup, under the band (#343).
  if (system && accounts.length === 0) return <SetupScreen />

  return (
    <div className="flex h-full w-full flex-col bg-app text-primary">
      <MacTitleBar />
      {/* Title bar, header, notices, then the rest (ADR-0068 §1): the header's
          first row is the top band with the app menu (§2). */}
      <ErrorBoundary label="top band">
        <AppHeader />
      </ErrorBoundary>
      <ConnectivityBanner />
      <UpdateBanner />
      {/* One <main>, named after the module on screen (ADR-0068 §1). The rail
          and, after it, the folder pane are still inside it until the module
          strip replaces the rail (ADR-0068 §9, step 4). */}
      <main ref={mainRef} aria-label={moduleNames[activeModule]} className="flex min-h-0 w-full flex-1 overflow-hidden">
        <ErrorBoundary label="side navigation">
          <SideNav />
        </ErrorBoundary>
        {activeModule === 'mail' && !activeBoardId && (
          // The common folder pane, mail first (ADR-0068 §4 and §9, step 2):
          // today's accounts and folders are its body.
          <ErrorBoundary label="mail navigation">
            <FolderPane title={t('mailNavigation.title')}>
              <MailNavigation />
            </FolderPane>
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
            {activeBoardId ? <KanbanView boardId={activeBoardId} /> : <ThreadList width={threadListWidth} resizable />}
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
      <AppLayers />
    </div>
  )
}
