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
import { MailNavigation } from './components/sidenav/MailNavigation'
import { FOLDER_PANE_MIN_WINDOW, FolderPane } from './components/shell/FolderPane'
import { ModuleSwitcher } from './components/shell/ModuleSwitcher'
import { AppFrame } from './components/shell/AppFrame'
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
import { useWideWindow } from './components/resizer/useElementWidth'
import { kanbanAreaBase, KANBAN_PANE_MIN_PX, KANBAN_PANE_NARROW_MIN_PX } from './lib/paneResize'
import { ErrorBoundary } from './components/ErrorBoundary'
import { ConnectivityBanner } from './components/banner/ConnectivityBanner'
import { UpdateBanner } from './components/banner/UpdateBanner'
import { SetupScreen } from './components/setup/SetupScreen'

export default function App() {
  const { t } = useTranslation()
  const mainRef = useRef<HTMLElement | null>(null)
  const kanbanPaneRef = useRef<HTMLDivElement | null>(null)
  const boardAreaRef = useRef<HTMLDivElement | null>(null)
  const system = useValue(ui$.system)
  const accounts = useValue(accounts$)
  const activeBoardId = useValue(kanban$.activeBoardId)
  const composeTabs = useValue(compose$.tabs)
  const activeComposeTab = useValue(compose$.activeTab)
  const threadListWidth = useValue(settings$.threadListWidth)
  const kanbanPaneThreadId = useValue(kanban$.paneThreadId)
  const kanbanPaneWidth = useValue(settings$.kanbanPaneWidth)
  const kanbanColumnWidth = useValue(settings$.kanbanColumnWidth)
  // From 769 px the reader keeps 360 px, so the board's pane does too.
  const readerKeepsItsWidth = useWideWindow(769)
  // From 769 to 1024 px, where the folder pane (and the module strip at its
  // foot) is not drawn, the modules are a narrow bar (ADR-0068 §5); below
  // 769 px they open from the app menu.
  const folderPaneDrawn = useWideWindow(FOLDER_PANE_MIN_WINDOW)
  const narrowBar = readerKeepsItsWidth && !folderPaneDrawn
  const activeModule = useValue(ui$.module)

  useAppEffects()

  // The name each module gives <main>: the one its own heading and its button
  // in the module switcher already use.
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

  // No account yet: the first-account setup, in the same frame as the
  // window's, which stays mounted when the first account arrives (#343).
  const setup = !!system && accounts.length === 0

  return (
    <AppFrame setup={setup}>
      {setup ? (
        <SetupScreen />
      ) : (
        <>
          <ConnectivityBanner />
          <UpdateBanner />
          {/* One <main>, named after the module on screen (ADR-0068 §1). The
              narrow module bar and the folder pane, which each module draws
              with the module strip at its foot, are still inside it. */}
          <main
            ref={mainRef}
            aria-label={moduleNames[activeModule]}
            className="flex min-h-0 w-full flex-1 overflow-hidden"
          >
            {narrowBar && (
              <ErrorBoundary label="module bar">
                <ModuleSwitcher variant="bar" />
              </ErrorBoundary>
            )}
            {activeModule === 'mail' && (
              // The common folder pane, mail first (ADR-0068 §4 and §9, step 2):
              // today's accounts and folders are its body. It stays with a
              // board open, which its «Taulers» section marks (piece 14a).
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
            ) : activeBoardId ? (
              // The board and its conversation pane, whose width is a share of
              // this area: the row less the folders, or the narrow bar (ADR-0068 §4).
              // It asks for one column and the reader, so the folder pane gives
              // way first where the row is short.
              <div
                ref={boardAreaRef}
                className="flex min-w-0 overflow-hidden"
                style={{ flex: `1 1 ${kanbanAreaBase(kanbanColumnWidth, showKanbanMessagePane)}px` }}
              >
                <ErrorBoundary label="thread list">
                  <KanbanView boardId={activeBoardId} />
                </ErrorBoundary>
                {showKanbanMessagePane && (
                  <div
                    ref={kanbanPaneRef}
                    className="relative flex shrink-0 overflow-hidden border-s border-border bg-chat max-[600px]:w-full"
                    style={{
                      width: `${kanbanPaneWidth}%`,
                      minWidth: readerKeepsItsWidth ? KANBAN_PANE_MIN_PX : KANBAN_PANE_NARROW_MIN_PX,
                    }}
                  >
                    {/* The width is a percentage of the board's area, kept in settings. */}
                    <KanbanPaneResizer pane={kanbanPaneRef} shell={boardAreaRef} />
                    <ErrorBoundary label="conversation">
                      <MessagePane />
                    </ErrorBoundary>
                  </div>
                )}
              </div>
            ) : (
              <>
                <ErrorBoundary label="thread list">
                  <ThreadList width={threadListWidth} resizable />
                </ErrorBoundary>
                <ErrorBoundary label="conversation">
                  <MessagePane />
                </ErrorBoundary>
              </>
            )}
          </main>
        </>
      )}
    </AppFrame>
  )
}
