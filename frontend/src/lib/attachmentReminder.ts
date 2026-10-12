// "You mentioned an attachment but there is none" (#39).
//
// A reminder, never a block: it asks once, and "Send anyway" sends. The words
// are stems kept in each locale's catalog (composer.attachmentReminder.keywords,
// separated by "|"), checked together with English, because people often write
// in a language other than the one their interface is in.
//
// Only the writer's own words count. Quoted text — `>` lines in plain text,
// <blockquote> in rich text — is someone else's mention of their attachment.

const ENGLISH = ['attach', 'enclos']

/** The text the writer wrote, without what they are quoting. */
export function ownWords(draft: { rich: boolean; html: string; text: string }): string {
  if (!draft.rich) {
    return draft.text
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('>'))
      .join('\n')
  }
  const doc = new DOMParser().parseFromString(draft.html, 'text/html')
  for (const quote of Array.from(doc.querySelectorAll('blockquote'))) quote.remove()
  return doc.body.textContent ?? ''
}

/** Stems from the catalog plus English, lower-cased, without blanks or repeats. */
export function attachmentKeywords(catalog: string): string[] {
  const words = [...catalog.split('|'), ...ENGLISH].map((word) => word.trim().toLocaleLowerCase()).filter(Boolean)
  return [...new Set(words)]
}

// Scripts that separate words, where a stem must start a word: "attach" in
// "reattached" is not a mention. Others (Arabic with its attached article,
// Chinese, Japanese, Korean) are matched anywhere.
const WORD_SCRIPT = /[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}]/u
const escape = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Whether the text mentions an attachment by any of the stems. */
export function mentionsAttachment(text: string, keywords: string[]): boolean {
  const haystack = text.normalize('NFC').toLocaleLowerCase()
  return keywords.some((word) => {
    const stem = word.normalize('NFC')
    if (!WORD_SCRIPT.test(stem)) return haystack.includes(stem)
    return new RegExp(`(?<![\\p{L}\\p{N}])${escape(stem)}`, 'u').test(haystack)
  })
}

/** Whether to remind: a mention in the subject or the writer's words, and no file. */
export function shouldRemindAttachment(
  draft: { subject: string; rich: boolean; html: string; text: string; attachments: { inlineId?: string }[] },
  catalog: string,
): boolean {
  // An inline image is in the body, not attached; it does not answer "see attached".
  if (draft.attachments.some((file) => !file.inlineId)) return false
  const keywords = attachmentKeywords(catalog)
  return mentionsAttachment(draft.subject, keywords) || mentionsAttachment(ownWords(draft), keywords)
}
