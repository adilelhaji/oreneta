import { useValue } from '@legendapp/state/react'
import { ui$ } from '../../states/ui'
import { AppHotkeys } from '../dialog/AppHotkeys'
import { CommandPalette } from '../palette/CommandPalette'
import { ShortcutsDialog } from '../dialog/ShortcutsDialog'
import { AboutDialog } from '../dialog/AboutDialog'
import { ChangelogDialog } from '../dialog/ChangelogDialog'
import { SettingsDialog } from '../dialog/SettingsDialog'
import { AccountDialog } from '../dialog/AccountDialog'
import { AddFeedDialog } from '../dialog/AddFeedDialog'
import { FeedEditDialog } from '../dialog/FeedEditDialog'
import { ScheduledSendsDialog } from '../dialog/ScheduledSendsDialog'
import { RuleLogDialog } from '../dialog/RuleLogDialog'
import { DesignCatalogue } from '../dialog/DesignCatalogue'
import { TaskDialog } from '../tasks/TaskDialog'
import { QuickActionDialog } from '../quick/QuickActionDialog'
import { AwaitingDialog } from '../awaiting/AwaitingDialog'
import { MergeDialog } from '../merge/MergeDialog'
import { SweepDialog } from '../dialog/SweepDialog'
import { AppToast } from '../toast/AppToast'
import { AppConfirm } from '../dialog/AppConfirm'
import { CertificateTrustDialog } from '../dialog/CertificateTrustDialog'

/**
 * The app's keyboard shortcuts, dialogs, toasts and confirmations: siblings of
 * the regions, not part of the module in <main> (ADR-0068 §1). The window and
 * the first-account setup screen have the same ones, so what the app menu
 * opens there (Settings, the palette, the shortcuts, About) opens the same way
 * (#343). On the setup screen only the app's own shortcuts act.
 */
export function AppLayers({ setup = false }: { setup?: boolean }) {
  const taskEditor = useValue(ui$.taskEditor)
  const setupOpen = useValue(ui$.setupOpen)
  const settingsOpen = useValue(ui$.settingsOpen)
  const addFeedAccount = useValue(ui$.addFeedAccount)
  const editFeed = useValue(ui$.editFeed)
  const scheduledSendsOpen = useValue(ui$.scheduledSendsOpen)
  const ruleLogOpen = useValue(ui$.ruleLogOpen)
  const catalogueOpen = useValue(ui$.catalogueOpen)
  const sweepTarget = useValue(ui$.sweep)

  return (
    <>
      <AppHotkeys setup={setup} />
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
    </>
  )
}
