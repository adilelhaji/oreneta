import { createRoot } from 'react-dom/client'
import { createFixture, scenario } from './fixtures'
import { createBaselineBridge } from './bridge'
import '../src/index.css'

const fixture = createFixture()
const { scene, theme } = scenario(new URLSearchParams(location.search))
const bridge = createBaselineBridge(fixture)
Object.assign(window, {
  go: { main: { App: bridge } },
  __baseline: { fixture, bridge, scene, theme },
})

// Import state only after the isolated bridge exists. No App/boot/useAppEffects.
const [
  { accounts$ },
  { mail$, threadListViewKey },
  { ui$ },
  { settings$ },
  { labels$ },
  { tasks$ },
  { openComposeTab },
  { default: i18n },
  { SideNav },
  { ThreadList },
  { MessagePane },
  { TasksView },
  { Composer },
] = await Promise.all([
  import('../src/states/accounts'),
  import('../src/states/mail'),
  import('../src/states/ui'),
  import('../src/states/settings'),
  import('../src/states/labels'),
  import('../src/states/tasks'),
  import('../src/states/compose'),
  import('../src/lib/i18n'),
  import('../src/components/sidenav/SideNav'),
  import('../src/components/threads/ThreadList'),
  import('../src/components/chat/MessagePane'),
  import('../src/components/tasks/TasksView'),
  import('../src/components/composer/Composer'),
])

await i18n.changeLanguage('en')
settings$.themeId.set(theme === 'dark' ? 'indigo-dark' : 'indigo')
settings$.markReadMode.set('manual')
settings$.autoUpdateCheck.set(false)
accounts$.set([structuredClone(fixture.account)])
ui$.selectedAccount.set(fixture.account.id)
ui$.selectedFolder.set('INBOX')
ui$.mobilePane.set(scene === 'reader' ? 'conversation' : 'threads')
mail$.folders.set(structuredClone(fixture.folders))
mail$.foldersByAccount.set({ [fixture.account.id]: structuredClone(fixture.folders) })
mail$.threads.set(structuredClone(fixture.threads))
mail$.threadsLoadedKey.set(threadListViewKey(fixture.account.id, 'INBOX', '', 'all'))
mail$.messages.set(structuredClone(fixture.messages))
labels$.set({
  loaded: true,
  labels: [
    { id: 'work', name: 'Work', colour: '#2056dd', inBar: true, links: {} },
    { id: 'review', name: 'Needs review', colour: '#e8830c', inBar: true, links: {} },
  ],
})
tasks$.items.set(structuredClone(fixture.tasks))
tasks$.loaded.set(true)
if (scene === 'reader') ui$.selectedThread.set(fixture.threads[0].thread_id)
const tabId =
  scene === 'composer'
    ? openComposeTab({
        accountId: fixture.account.id,
        to: 'morgan@example.test',
        subject: 'Re: Pilot checklist',
        text: 'Hello Morgan,\n\nHere is the synthetic review draft. Nothing will be sent.',
        rich: false,
      })
    : undefined

createRoot(document.getElementById('root')!).render(
  <div className="flex h-full flex-col bg-app text-primary">
    <header
      data-testid="baseline-banner"
      className="shrink-0 border-b border-border px-3 py-1 text-caption"
    >
      Synthetic baseline · {scene} · {theme} · no real backend
    </header>
    <main className="flex min-h-0 flex-1 overflow-hidden" data-testid="baseline-content">
      <SideNav />
      {scene === 'tasks' ? (
        <TasksView />
      ) : scene === 'composer' && tabId ? (
        <Composer tabId={tabId} />
      ) : (
        <>
          <ThreadList width={350} />
          <MessagePane />
        </>
      )}
    </main>
  </div>,
)
