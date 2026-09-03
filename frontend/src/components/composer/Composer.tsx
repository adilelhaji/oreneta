import { EditorContent } from '@tiptap/react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import { settings$ } from '../../states/settings'
import { useComposer } from './useComposer'
import { ComposerHeaderFields } from './ComposerHeaderFields'
import { ComposerToolbar } from './ComposerToolbar'
import { ComposerAttachments } from './ComposerAttachments'
import { ComposerFooter } from './ComposerFooter'
import { closeMessageTab } from '../../states/compose'
import { confirmAction } from '../../states/ui'
import type { Template } from '../../states/templates'
import { insertAtCaret, messageTemplateFields, messageTemplateOverwrites } from './applyTemplate'

export function Composer({ tabId }: { tabId: string }) {
  const { t } = useTranslation()
  const spellCheck = useValue(settings$.spellCheck)
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
  } = useComposer(tabId)

  if (!draft) return null

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
      update(fields)
      // The editor holds its own copy of the body, so telling the draft is
      // not enough: what is on screen has to be told as well.
      if (draft.rich && editor) editor.commands.setContent(fields.html)
      return
    }

    if (draft.rich && editor) {
      editor.chain().focus().insertContent(template.bodyHtml || template.bodyText).run()
      return
    }

    const area = textRef.current
    const insert = template.bodyText || template.bodyHtml.replace(/<[^>]*>/g, '')
    const { text, caret } = insertAtCaret(
      draft.text,
      insert,
      area?.selectionStart ?? draft.text.length,
      area?.selectionEnd ?? draft.text.length,
    )
    update({ text })
    // After React has written the new value, put the cursor back where the
    // writer was rather than at the top of the box.
    queueMicrotask(() => {
      if (!area) return
      area.focus()
      area.setSelectionRange(caret, caret)
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
          <EditorContent editor={editor} />
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

      {error && <p className="shrink-0 px-4 pb-1 text-caption font-medium text-rose-500">{error}</p>}

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
        onDiscard={() => void closeMessageTab(tabId)}
        onSubmit={() => void submit()}
        onSchedule={(at) => void submit(at)}
      />
    </div>
  )
}
