import { describe, expect, it } from 'bun:test'
import { previewKind, TEXT_PREVIEW_MAX_BYTES } from './attachmentPreview'

const file = (over: Partial<Parameters<typeof previewKind>[0]> = {}) => ({
  filename: 'note.txt',
  mime: 'text/plain',
  size: 100,
  key: 'k1',
  ...over,
})

describe('which attachments can be shown without leaving the app', () => {
  it('shows images', () => {
    expect(previewKind(file({ filename: 'photo.png', mime: 'image/png' }))).toBe('image')
    expect(previewKind(file({ filename: 'photo.jpg', mime: 'image/jpeg' }))).toBe('image')
  })

  it('does not show an SVG', () => {
    // An SVG is an image that can carry script, and it would render from the
    // app's own origin.
    expect(previewKind(file({ filename: 'logo.svg', mime: 'image/svg+xml' }))).toBeNull()
  })

  it('shows text, by type or by extension', () => {
    expect(previewKind(file())).toBe('text')
    expect(previewKind(file({ filename: 'data.json', mime: 'application/json' }))).toBe('text')
    expect(previewKind(file({ filename: 'feed.atom', mime: 'application/atom+xml' }))).toBe('text')
    // A server that called a CSV "octet-stream" has not made it un-readable.
    expect(previewKind(file({ filename: 'rows.csv', mime: 'application/octet-stream' }))).toBe('text')
    expect(previewKind(file({ filename: 'invite.ics', mime: 'application/octet-stream' }))).toBe('text')
  })

  it('does not offer a PDF', () => {
    // WebKitGTK carries no PDF viewer, and a preview that renders a blank
    // frame tells the reader their file is empty when it is not.
    expect(previewKind(file({ filename: 'report.pdf', mime: 'application/pdf' }))).toBeNull()
  })

  it('does not offer what it cannot read', () => {
    expect(previewKind(file({ filename: 'archive.zip', mime: 'application/zip' }))).toBeNull()
    // No key means the file is not on disk yet: there is nothing to show.
    expect(previewKind(file({ key: null }))).toBeNull()
  })

  it('stops offering a text preview once it would be a wait', () => {
    expect(previewKind(file({ size: TEXT_PREVIEW_MAX_BYTES + 1 }))).toBeNull()
    expect(previewKind(file({ size: TEXT_PREVIEW_MAX_BYTES }))).toBe('text')
  })
})
