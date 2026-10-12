import { EditorContent } from '@tiptap/react'
import { useState } from 'react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import { settings$ } from '../../states/settings'
import { accounts$ } from '../../states/accounts'
import { keepsServerDrafts } from '../../lib/mailCapabilities'
import { useComposer } from './useComposer'
import { ComposerHeaderFields } from './ComposerHeaderFields'
import { ComposerToolbar } from './ComposerToolbar'
import { ComposerAttachments } from './ComposerAttachments'
import { ComposerFooter } from './ComposerFooter'
import { GrammarPopover, GrammarStatus } from './GrammarPopover'
import { LocalDraftStatus } from './LocalDraftStatus'
import { closeMessageTab } from '../../states/compose'
import { confirmAction, showToast, showUndoToast } from '../../states/ui'
import { TranslateDraftDialog, type DraftTranslation } from './TranslateDraftDialog'
import { AssistantRewriteDialog } from './AssistantRewriteDialog'
import { assistantEnabled$ } from '../../states/assistant'
import { textToHtml } from './composerHelpers'
import { CURSOR_TOKEN, fillPlaceholders, takeCursor, type Filled } from '../../lib/placeholders'
import type { Template } from '../../states/templates'
import {
  insertAtCaret,
  messageTemplateFields,
  messageTemplateOverwrites,
  templateInsertHtml,
  templateInsertText,
} from './applyTemplate'

export function Composer({ tabId }: { tabId: string }) {
  const { t } = useTranslation()
  const spellCheck = useValue(settings$.spellCheck)
  const accounts = useValue(accounts$)
  const {
    draft,
    editor,
    focusBody,
    textRef,
    sending,
    error,
    saveStatus,
    saveError,
    canSend,
    update,
    toggleRich,
    pickAttachmentFiles,
    pickInlineImages,
    handlePaste,
    handleKeyDown,
    setLink,
    submit,
    pgpPassphrase,
    setPgpPassphrase,
    grammar,
  } = useComposer(tabId)
  const [translating, setTranslating] = useState(false)
  const [rewriting, setRewriting] = useState(false)
  const assistantEnabled = useValue(assistantEnabled$)

  if (!draft) return null

  /** A reviewed rewrite replaces the draft's text, with an undo (#52). */
  const applyRewrite = (text: string) => {
    setRewriting(false)
    if (draft.rich && editor) {
      const original = editor.getHTML()
      editor.commands.setContent(textToHtml(text) || '<p></p>')
      showUndoToast(t('assistant.rewrite.replaced', { defaultValue: 'Replaced with the rewrite' }), () =>
        editor.commands.setContent(original),
      )
      return
    }
    const original = draft.text
    update({ text })
    showUndoToast(t('assistant.rewrite.replaced', { defaultValue: 'Replaced with the rewrite' }), () =>
      update({ text: original }),
    )
  }

  /**
   * A reviewed translation goes in place of the draft, with an undo that
   * brings back exactly what was written, or below it, keeping it (#106).
   */
  const applyTranslation = (translation: DraftTranslation, how: 'replace' | 'below') => {
    setTranslating(false)
    if (draft.rich && editor) {
      const original = editor.getHTML()
      if (how === 'below') {
        editor.commands.insertContentAt(editor.state.doc.content.size, `<p></p>${translation.html ?? ''}`)
        return
      }
      editor.commands.setContent(translation.html ?? '<p></p>')
      showUndoToast(t('translation.replaced', { defaultValue: 'Replaced with the translation' }), () =>
        editor.commands.setContent(original),
      )
      return
    }
    const original = draft.text
    if (how === 'below') {
      update({ text: `${original.trimEnd()}\n\n${translation.text}` })
      return
    }
    update({ text: translation.text })
    showUndoToast(t('translation.replaced', { defaultValue: 'Replaced with the translation' }), () =>
      update({ text: original }),
    )
  }

  /**
   * Put kept text into this message.
   *
   * A snippet only ever adds, so it goes in at the cursor without asking. A
   * whole-message template states a subject and a body, which in a composer
   * that already has words in it means replacing them — so that case asks
   * first. Silently overwriting what somebody was writing is the one outcome
   * this must not have.
   */
  const useTemplate = async (template: Template) => {
    if (!draft) return

    // Placeholders are filled from this message (#88); what cannot be filled
    // is left as written and said, never dropped.
    const account = accounts.find((a) => a.id === draft.accountId)
    const alias = account?.aliases?.find((a) => a.email.toLowerCase() === draft.fromEmail.toLowerCase())
    const context = {
      to: draft.to,
      me: { name: alias?.name || account?.display_name || '', email: draft.fromEmail || account?.email || '' },
      subject: draft.subject,
      now: new Date(),
    }
    const left = { missing: new Set<string>(), unknown: new Set<string>() }
    const fill = (text: string, html: boolean) => {
      const filled: Filled = fillPlaceholders(text, context, html)
      filled.missing.forEach((name) => left.missing.add(name))
      filled.unknown.forEach((name) => left.unknown.add(name))
      return filled.text
    }
    const report = () => {
      if (left.unknown.size)
        showToast(
          t('templates.unknownPlaceholders', {
            names: [...left.unknown].map((n) => `{{${n}}}`).join(', '),
            defaultValue: 'Not a placeholder this knows, left as written: {names}',
          }),
          'error',
        )
      else if (left.missing.size)
        showToast(
          t('templates.missingPlaceholders', {
            names: [...left.missing].map((n) => `{{${n}}}`).join(', '),
            defaultValue: 'Nothing to fill these from yet, left as written: {names}',
          }),
          'error',
        )
    }
    // The first cursor mark becomes the caret; any others go.
    const caretAtMark = () => {
      if (!editor) return
      let first = -1
      for (;;) {
        let at = -1
        editor.state.doc.descendants((node, pos) => {
          if (at >= 0) return false
          const index = node.isText && node.text ? node.text.indexOf(CURSOR_TOKEN) : -1
          if (index >= 0) at = pos + index
          return true
        })
        if (at < 0) break
        editor.commands.deleteRange({ from: at, to: at + CURSOR_TOKEN.length })
        if (first < 0) first = at
      }
      if (first >= 0) editor.chain().focus().setTextSelection(first).run()
    }

    if (template.kind === 'message') {
      if (
        messageTemplateOverwrites(draft, template) &&
        !(await confirmAction({
          title: t('templates.replaceTitle'),
          message: t('templates.replaceMessage', { name: template.name }),
          confirmLabel: t('templates.replaceConfirm'),
          cancelLabel: t('buttons.cancel'),
        }))
      ) {
        return
      }
      const fields = messageTemplateFields(template, draft.rich)
      const subject = takeCursor(fill(fields.subject, false)).text
      if (draft.rich && editor) {
        update({ ...fields, subject, html: fill(fields.html, true) })
        // The editor holds its own copy of the body, so telling the draft is
        // not enough: what is on screen has to be told as well.
        editor.commands.setContent(fill(fields.html, true))
        caretAtMark()
      } else {
        const { text, cursor } = takeCursor(fill(fields.text, false))
        update({ ...fields, subject, text })
        queueMicrotask(() => {
          const area = textRef.current
          if (!area) return
          area.focus()
          area.setSelectionRange(cursor, cursor)
        })
      }
      report()
      return
    }

    if (draft.rich && editor) {
      editor
        .chain()
        .focus()
        .insertContent(fill(templateInsertHtml(template), true))
        .run()
      caretAtMark()
      report()
      return
    }

    const area = textRef.current
    const marked = takeCursor(fill(templateInsertText(template), false))
    const insert = marked.text
    const { text, caret } = insertAtCaret(
      draft.text,
      insert,
      area?.selectionStart ?? draft.text.length,
      area?.selectionEnd ?? draft.text.length,
    )
    update({ text })
    report()
    // After React has written the new value, put the cursor at the mark the
    // snippet carries, else after it, rather than at the top of the box.
    const at = caret - insert.length + marked.cursor
    queueMicrotask(() => {
      if (!area) return
      area.focus()
      area.setSelectionRange(at, at)
    })
  }

  // In the full editor, bare Enter must always insert a newline (long-form /
  // rich body), so send is bound to Cmd/Ctrl+Enter regardless of the global
  // send-shortcut setting. Bound on the outer container so it fires from any
  // field (To/Subject/body).
  const handleSendShortcut = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.shiftKey) {
      e.preventDefault()
      void submit()
    }
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-chat" onKeyDown={handleSendShortcut}>
      <ComposerHeaderFields draft={draft} update={update} focusTo={!focusBody} />

      {draft.rich && editor && <ComposerToolbar editor={editor} onSetLink={setLink} />}

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-4 py-3" onKeyDown={handleKeyDown}>
        {draft.rich ? (
          <>
            <EditorContent editor={editor} />
            {editor && grammar.pick && (
              <GrammarPopover
                editor={editor}
                checker={grammar.checker}
                pick={grammar.pick}
                onClose={grammar.closePick}
              />
            )}
            <GrammarStatus result={grammar.result} error={grammar.error} />
          </>
        ) : (
          <textarea
            ref={textRef}
            autoFocus={focusBody}
            value={draft.text}
            onChange={(e) => update({ text: e.target.value })}
            onPaste={handlePaste}
            placeholder={t('composer.placeholders.message')}
            spellCheck={spellCheck}
            className="h-full min-h-[240px] w-full resize-none bg-transparent text-sm leading-relaxed text-primary placeholder-secondary outline-none"
          />
        )}
      </div>

      <ComposerAttachments
        attachments={draft.attachments}
        onRemove={(id) => update({ attachments: draft.attachments.filter((a) => a.id !== id) })}
      />

      {error && <p className="shrink-0 px-4 pb-1 text-caption font-medium text-danger">{error}</p>}

      <LocalDraftStatus tabId={tabId} />

      {rewriting && (
        <AssistantRewriteDialog
          accountId={draft.accountId}
          rich={draft.rich}
          text={draft.rich ? (editor?.getText({ blockSeparator: '\n' }) ?? draft.text) : draft.text}
          onApply={applyRewrite}
          onClose={() => setRewriting(false)}
        />
      )}

      {translating && (
        <TranslateDraftDialog
          rich={draft.rich}
          html={editor?.getHTML() ?? draft.html}
          text={draft.rich ? (editor?.getText({ blockSeparator: '\n' }) ?? draft.text) : draft.text}
          onApply={applyTranslation}
          onClose={() => setTranslating(false)}
        />
      )}

      <ComposerFooter
        rich={draft.rich}
        sending={sending}
        saveStatus={error ? 'idle' : saveStatus}
        saveError={saveError}
        canSend={canSend}
        onPickFiles={() => void pickAttachmentFiles()}
        onPickInlineImages={() => void pickInlineImages()}
        onToggleRich={toggleRich}
        onUseTemplate={(template) => void useTemplate(template)}
        onTranslate={() => setTranslating(true)}
        onRewrite={assistantEnabled ? () => setRewriting(true) : undefined}
        pgpSign={draft.pgpSign}
        pgpEncrypt={draft.pgpEncrypt}
        pgpPassphrase={pgpPassphrase}
        onPgpSignChange={(value) => update({ pgpSign: value })}
        onPgpEncryptChange={(value) => update({ pgpEncrypt: value })}
        onPgpPassphraseChange={setPgpPassphrase}
        onDiscard={() => void closeMessageTab(tabId)}
        onSubmit={() => void submit()}
        onSchedule={(at) => void submit(at)}
        canSchedule={keepsServerDrafts(accounts.find((account) => account.id === draft.accountId))}
      />
    </div>
  )
}
