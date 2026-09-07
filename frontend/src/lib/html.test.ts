import { describe, expect, it } from 'bun:test'
import { resolveInlineCids } from './html'

describe('resolveInlineCids', () => {
  it('rewrites cid refs to data URLs from the matching attachments', () => {
    const html =
      '<p>hi</p><img src="cid:oreneta-image-1-a@oreneta" alt="a.png"><p>mid</p><img src="cid:oreneta-image-2-b@oreneta" alt="b.png">'
    const out = resolveInlineCids(html, [
      { inlineId: 'oreneta-image-1-a@oreneta', mime: 'image/png', data: 'AAAA' },
      { inlineId: 'oreneta-image-2-b@oreneta', mime: 'image/jpeg', data: 'BBBB' },
    ])
    expect(out).toBe(
      '<p>hi</p><img src="data:image/png;base64,AAAA" alt="a.png"><p>mid</p><img src="data:image/jpeg;base64,BBBB" alt="b.png">',
    )
  })

  it('ignores attachments without an inlineId and leaves unmatched cids alone', () => {
    const html = '<img src="cid:known@oreneta"><img src="cid:unknown@oreneta">'
    const out = resolveInlineCids(html, [
      { mime: 'application/pdf', data: 'CCCC' },
      { inlineId: 'known@oreneta', mime: 'image/png', data: 'DDDD' },
    ])
    expect(out).toBe('<img src="data:image/png;base64,DDDD"><img src="cid:unknown@oreneta">')
  })
})
