import { useValue } from '@legendapp/state/react'
import { Forward, Heading, ListOrdered, Paperclip, Quote, Reply, TextQuote } from 'lucide-react'
import { useTranslation } from '../../lib/i18n'
import type { ReplyForwardPrefs } from '../../lib/replyForward'
import { settings$ } from '../../states/settings'
import { SegmentedRow, SettingsGroup, ToggleRow } from './AccountSettingsRows'

/**
 * Mail → Replies and forwards (SET-09, ADR-0047): where a reply goes relative
 * to the quoted original, how the original is quoted and introduced, and how a
 * forward carries it. Every control writes `settings$.replyForward`, which the
 * settings store persists as one row.
 */
export function RepliesForwardsGroup() {
  const { t } = useTranslation()
  const prefs = useValue(settings$.replyForward)
  const set = (partial: Partial<ReplyForwardPrefs>) => settings$.replyForward.set({ ...prefs, ...partial })
  const icon = { size: 16, strokeWidth: 1.75 }
  return (
    <SettingsGroup
      section="repliesForwards"
      title={t('settings.sections.repliesForwards', { defaultValue: 'Replies and forwards' })}
    >
      <ToggleRow
        icon={<TextQuote {...icon} />}
        title={t('settings.replies.includeOriginal', { defaultValue: 'Include the original message in replies' })}
        hint={t('settings.replies.includeOriginalHint', {
          defaultValue: 'A reply opened in the full editor quotes the message it answers.',
        })}
        checked={prefs.includeOriginal}
        onChange={() => set({ includeOriginal: !prefs.includeOriginal })}
      />
      {prefs.includeOriginal && (
        <>
          <SegmentedRow
            icon={<Reply {...icon} />}
            title={t('settings.replies.position', { defaultValue: 'Write the reply' })}
            value={prefs.replyPosition}
            options={[
              { value: 'above', label: t('settings.replies.positionAbove', { defaultValue: 'Above the quote' }) },
              { value: 'below', label: t('settings.replies.positionBelow', { defaultValue: 'Below the quote' }) },
            ]}
            onChange={(replyPosition) => set({ replyPosition })}
          />
          <SegmentedRow
            icon={<Quote {...icon} />}
            title={t('settings.replies.quoteStyle', { defaultValue: 'Quote the original as' })}
            hint={t('settings.replies.quoteStyleHint', {
              defaultValue:
                'HTML keeps the original’s formatting in an indented block; plain text puts “>” before every line.',
            })}
            value={prefs.quoteStyle}
            options={[
              { value: 'html', label: t('settings.replies.quoteHtml', { defaultValue: 'HTML block' }) },
              { value: 'plain', label: t('settings.replies.quotePlain', { defaultValue: 'Plain text “>”' }) },
            ]}
            onChange={(quoteStyle) => set({ quoteStyle })}
          />
          <SegmentedRow
            icon={<Heading {...icon} />}
            title={t('settings.replies.header', { defaultValue: 'Reply header' })}
            hint={t('settings.replies.headerHint', {
              defaultValue: 'A one-line “On … wrote:”, or a From / Sent / To / Cc / Subject block as Outlook writes it.',
            })}
            value={prefs.headerStyle}
            options={[
              { value: 'short', label: t('settings.replies.headerShort', { defaultValue: 'On … wrote:' }) },
              { value: 'outlook', label: t('settings.replies.headerOutlook', { defaultValue: 'Full header' }) },
            ]}
            onChange={(headerStyle) => set({ headerStyle })}
          />
        </>
      )}
      <ToggleRow
        icon={<ListOrdered {...icon} />}
        title={t('settings.replies.collapsePrefixes', { defaultValue: 'Shorten “Re: Re:” to “Re:”' })}
        hint={t('settings.replies.collapsePrefixesHint', {
          defaultValue: 'Repeated reply or forward prefixes in the subject, in any language, become one.',
        })}
        checked={prefs.collapsePrefixes}
        onChange={() => set({ collapsePrefixes: !prefs.collapsePrefixes })}
      />
      <SegmentedRow
        icon={<Forward {...icon} />}
        title={t('settings.replies.forwardMode', { defaultValue: 'Forward messages' })}
        hint={t('settings.replies.forwardModeHint', {
          defaultValue: 'Inline quotes the message in the body; as attachment sends the original .eml file untouched.',
        })}
        value={prefs.forwardMode}
        options={[
          { value: 'inline', label: t('settings.replies.forwardInline', { defaultValue: 'Inline' }) },
          { value: 'attachment', label: t('settings.replies.forwardAttachment', { defaultValue: 'As attachment' }) },
        ]}
        onChange={(forwardMode) => set({ forwardMode })}
      />
      {prefs.forwardMode === 'inline' && (
        <ToggleRow
          icon={<Paperclip {...icon} />}
          title={t('settings.replies.forwardAttachments', {
            defaultValue: 'Include the original’s attachments when forwarding',
          })}
          checked={prefs.forwardAttachments}
          onChange={() => set({ forwardAttachments: !prefs.forwardAttachments })}
        />
      )}
    </SettingsGroup>
  )
}
