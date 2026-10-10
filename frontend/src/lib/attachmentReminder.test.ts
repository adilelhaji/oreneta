import { describe, expect, it } from 'bun:test'
import { attachmentKeywords, mentionsAttachment, ownWords, shouldRemindAttachment } from './attachmentReminder'

const draft = (over: Partial<Parameters<typeof shouldRemindAttachment>[0]> = {}) => ({
  subject: '',
  rich: false,
  html: '',
  text: '',
  attachments: [] as { inlineId?: string }[],
  ...over,
})

describe('the missing-attachment reminder (#39)', () => {
  it('notices a mention in the body or the subject', () => {
    expect(shouldRemindAttachment(draft({ text: 'Please see the attached report.' }), '')).toBe(true)
    expect(shouldRemindAttachment(draft({ subject: 'Attachment: Q3 numbers' }), '')).toBe(true)
    expect(shouldRemindAttachment(draft({ text: 'I have enclosed the form.' }), '')).toBe(true)
  })

  it('stays quiet when a file is attached, or nothing is mentioned', () => {
    const file = [{}]
    expect(shouldRemindAttachment(draft({ text: 'See attached.', attachments: file }), '')).toBe(false)
    expect(shouldRemindAttachment(draft({ text: 'Lunch at noon?' }), '')).toBe(false)
  })

  it('does not count an inline image as the attachment mentioned', () => {
    expect(shouldRemindAttachment(draft({ text: 'See attached.', attachments: [{ inlineId: 'cid-1' }] }), '')).toBe(
      true,
    )
  })

  it('ignores what the writer is quoting', () => {
    expect(ownWords({ rich: false, html: '', text: 'Thanks!\n> see the attached file' })).toBe('Thanks!')
    expect(
      shouldRemindAttachment(
        draft({ rich: true, html: '<p>Thanks!</p><blockquote><p>See attached.</p></blockquote>' }),
        '',
      ),
    ).toBe(false)
    expect(shouldRemindAttachment(draft({ rich: true, html: '<p>Te lo <b>adjunto</b>.</p>' }), 'adjunt|anexo')).toBe(
      true,
    )
  })

  it('needs a stem to start a word where words are separated', () => {
    const words = attachmentKeywords('')
    expect(mentionsAttachment('We reattached the cable', words)).toBe(false)
    expect(mentionsAttachment('ATTACHING the deck now', words)).toBe(true)
    expect(mentionsAttachment('(attached)', words)).toBe(true)
  })

  it('checks the interface language together with English', () => {
    const spanish = attachmentKeywords('adjunt|anexo')
    expect(mentionsAttachment('Te envío el contrato adjunto', spanish)).toBe(true)
    expect(mentionsAttachment('Please find attached', spanish)).toBe(true)
  })

  it('matches scripts without word spacing, and Arabic behind its article', () => {
    expect(mentionsAttachment('資料を添付します', attachmentKeywords('添付'))).toBe(true)
    expect(mentionsAttachment('请查看附件', attachmentKeywords('附件|附上'))).toBe(true)
    expect(mentionsAttachment('يرجى مراجعة الملف المرفق', attachmentKeywords('مرفق|أرفق'))).toBe(true)
  })

  it('folds case and accents the way the catalog writes them', () => {
    expect(mentionsAttachment('PIÈCE JOINTE', attachmentKeywords('pièce jointe|ci-joint'))).toBe(true)
    expect(mentionsAttachment('Ci-joint le devis', attachmentKeywords('pièce jointe|ci-joint'))).toBe(true)
  })
})
