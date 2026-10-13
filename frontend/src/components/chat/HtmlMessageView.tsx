import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Attachment } from '../../types'
import { Gallery, type GalleryItem } from './Gallery'
import { HtmlFrame } from './HtmlFrame'
import { LinkHoverPreview } from './LinkHoverPreview'
import { htmlReferencesMedia, isImage, mediaSrc } from './messageHelpers'
import { applyReaderFont, applyReaderLayout, stripTrackingPixels } from './readerHtml'
import { useMessageFrameFont } from './useMessageFrameFont'
import { useValue } from '@legendapp/state/react'
import { settings$ } from '../../states/settings'
import { applyHtmlFolds } from './quoteFolding'
import { PlainFoldedText, useFoldLabels, useFoldOptions } from './ReaderFolds'
import { createWidthFitter, type WidthFitter } from './fitWidth'

const readerScrollPositions = new Map<string, number>()

interface HtmlMessageViewProps {
  scrollKey: string
  title: string
  /** Iframe-ready HTML, or undefined for a plain-text message. */
  html?: string
  /** Plain-text body, shown in Plain mode or when no HTML is available. */
  text: string
  /** Attachments snapshotted with the reader tab; used for plain/image-only messages. */
  attachments?: Attachment[]
  viewMode: 'html' | 'plain'
}

// Renders a single message either as its original email HTML (in a sandboxed
// iframe) or as the plain-text body. The HTML arrives pre-prepared from the
// backend: `cid:` inline images rewritten to `/media/<key>`, oversized images
// capped to the reader width, and a CSP <meta> that gates remote images. The
// iframe runs with `allow-scripts` (needed for our click listener to fire under
// WebKitGTK), but the backend's `default-src 'none'` CSP blocks all email JS, so
// nothing from the message executes. `allow-same-origin` lets us read the
// document to route link clicks to the system browser and open images in the
// shared gallery lightbox.
export function HtmlMessageView({ scrollKey, title, html, text, attachments, viewMode }: HtmlMessageViewProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const textRef = useRef<HTMLDivElement | null>(null)
  const messageFont = useMessageFrameFont()
  const foldOptions = useFoldOptions()
  const foldLabels = useFoldLabels()
  const fitWidth = useValue(settings$.readerFitWidth)
  const fitterRef = useRef<WidthFitter | null>(null)
  const [hoveredLink, setHoveredLink] = useState<string | null>(null)
  const [galleryItems, setGalleryItems] = useState<GalleryItem[]>([])
  const [galleryIndex, setGalleryIndex] = useState<number | null>(null)
  const positionKey = `${scrollKey}:${viewMode}`
  const attachmentImages = useMemo(
    () =>
      (attachments ?? []).filter((attachment) => {
        if (!isImage(attachment) || (!attachment.key && !attachment.url)) return false
        return !htmlReferencesMedia(html, attachment)
      }),
    [attachments, html],
  )

  const openAttachmentImage = useCallback(
    (index: number) => {
      setGalleryItems(
        attachmentImages.map((attachment) => ({
          src: mediaSrc(attachment),
          filename: attachment.filename,
        })),
      )
      setGalleryIndex(index)
    },
    [attachmentImages],
  )

  const saveScrollPosition = useCallback(() => {
    if (viewMode === 'plain' || !html) {
      const container = textRef.current
      if (container) readerScrollPositions.set(positionKey, container.scrollTop)
      return
    }

    const win = iframeRef.current?.contentWindow
    const doc = iframeRef.current?.contentDocument
    const top = win?.scrollY ?? doc?.documentElement.scrollTop ?? doc?.body.scrollTop
    if (typeof top === 'number') {
      readerScrollPositions.set(positionKey, top)
    }
  }, [html, positionKey, viewMode])

  const restoreScrollPosition = useCallback(() => {
    const top = readerScrollPositions.get(positionKey)
    if (top === undefined) return

    if (viewMode === 'plain' || !html) {
      const container = textRef.current
      if (container) container.scrollTop = top
      return
    }

    iframeRef.current?.contentWindow?.scrollTo(0, top)
  }, [html, positionKey, viewMode])

  useLayoutEffect(() => {
    return saveScrollPosition
  }, [saveScrollPosition])

  // Tracking pixels out, quoted history folded (ADR-0046), and the document
  // marked when it is to be fitted, so changing that reloads it.
  const sanitizedHtml = useMemo(() => {
    if (!html) return html
    const stripped = stripTrackingPixels(html)
    if (!foldOptions.quotes && !foldOptions.signatures && !fitWidth) return stripped
    try {
      const doc = new DOMParser().parseFromString(stripped, 'text/html')
      applyHtmlFolds(doc, foldOptions, foldLabels)
      if (fitWidth) doc.documentElement.setAttribute('data-oreneta-fit', '')
      return doc.documentElement.outerHTML
    } catch {
      return stripped
    }
  }, [html, foldOptions, foldLabels, fitWidth])

  useEffect(() => {
    setHoveredLink(null)
  }, [html, viewMode])

  const openImage = useCallback((doc: Document, img: HTMLImageElement, event: Event) => {
    event.preventDefault()
    event.stopPropagation()
    if (!img.currentSrc && !img.src) return
    const imgs = Array.from(doc.querySelectorAll<HTMLImageElement>('img')).filter((el) => {
      if (!el.currentSrc && !el.src) return false
      const w = el.getAttribute('width') || ''
      const h = el.getAttribute('height') || ''
      if ((w === '1' || w === '0') && (h === '1' || h === '0')) return false
      if (el.naturalWidth === 1 || el.naturalHeight === 1) return false
      return true
    })
    setGalleryItems(
      imgs.map((el) => ({
        src: el.currentSrc || el.src,
        filename: el.alt || el.title || 'image',
      })),
    )
    setGalleryIndex(Math.max(0, imgs.indexOf(img)))
  }, [])

  const handleFrameClick = useCallback(
    (event: MouseEvent, doc: Document) => {
      const target = event.target as Element | null
      if (!target || typeof target.closest !== 'function') return false
      const img = target.closest('img') as HTMLImageElement | null
      if (!img || !img.src) return false
      openImage(doc, img, event)
      return true
    },
    [openImage],
  )

  const handleFrameReady = useCallback(
    (doc: Document) => {
      applyReaderLayout(doc, messageFont)
      requestAnimationFrame(restoreScrollPosition)
      if (!fitWidth || !doc.documentElement.hasAttribute('data-oreneta-fit')) return
      const fitter = createWidthFitter(doc, messageFont.zoom)
      fitterRef.current = fitter
      const update = () => fitter.update()
      update()
      const observer = new ResizeObserver(update)
      observer.observe(doc.documentElement)
      if (doc.body) observer.observe(doc.body)
      const images = Array.from(doc.querySelectorAll('img'))
      images.forEach((img) => img.addEventListener('load', update))
      return () => {
        observer.disconnect()
        images.forEach((img) => img.removeEventListener('load', update))
        if (fitterRef.current === fitter) fitterRef.current = null
      }
    },
    [fitWidth, messageFont, restoreScrollPosition],
  )

  // The frame only re-runs `onReady` when its document is replaced, so repaint
  // the live document when the typography settings change under it.
  useEffect(() => {
    const doc = iframeRef.current?.contentDocument
    if (doc?.body) applyReaderFont(doc, messageFont)
    // The fit compounds with the text size, so it starts over from the new one.
    fitterRef.current?.reset(messageFont.zoom)
    fitterRef.current?.update()
  }, [messageFont, html, viewMode])

  useLayoutEffect(() => {
    if (viewMode !== 'plain' && html) return
    restoreScrollPosition()
    return saveScrollPosition
  }, [html, restoreScrollPosition, saveScrollPosition, viewMode])

  if (viewMode === 'plain' || !html) {
    return (
      <div ref={textRef} onScroll={saveScrollPosition} className="relative flex-1 overflow-y-auto bg-chat px-6 py-6">
        <div className="mx-auto max-w-[680px] space-y-5">
          {attachmentImages.length > 0 && (
            <AttachmentImageGrid images={attachmentImages} onOpen={openAttachmentImage} />
          )}
          <div className="whitespace-pre-wrap break-words font-message text-[calc(0.9375rem*var(--me-message-scale))] leading-relaxed text-primary select-text tracking-[0.01em]">
            {text ? (
              <PlainFoldedText text={text} render={(content) => content} />
            ) : attachmentImages.length > 0 ? (
              ''
            ) : (
              '(no content)'
            )}
          </div>
        </div>
        {galleryIndex !== null && galleryItems[galleryIndex] && (
          <Gallery
            items={galleryItems}
            index={galleryIndex}
            onIndexChange={setGalleryIndex}
            onClose={() => setGalleryIndex(null)}
          />
        )}
      </div>
    )
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col" onMouseLeave={() => setHoveredLink(null)}>
      <HtmlFrame
        ref={iframeRef}
        html={sanitizedHtml ?? ''}
        title={title}
        className="flex-1 w-full border-0 bg-white"
        onFrameClick={handleFrameClick}
        onReady={handleFrameReady}
        onLinkHover={setHoveredLink}
        onScroll={saveScrollPosition}
      />
      <LinkHoverPreview url={hoveredLink} />
      {attachmentImages.length > 0 && (
        <div className="shrink-0 border-t border-border bg-chat px-6 py-4">
          <div className="mx-auto max-w-[680px]">
            <AttachmentImageGrid images={attachmentImages} onOpen={openAttachmentImage} />
          </div>
        </div>
      )}
      {galleryIndex !== null && galleryItems[galleryIndex] && (
        <Gallery
          items={galleryItems}
          index={galleryIndex}
          onIndexChange={setGalleryIndex}
          onClose={() => setGalleryIndex(null)}
        />
      )}
    </div>
  )
}

function AttachmentImageGrid({ images, onOpen }: { images: Attachment[]; onOpen: (index: number) => void }) {
  const count = images.length
  const gridClass = count === 1 ? 'grid-cols-1' : count === 2 ? 'grid-cols-2' : 'grid-cols-3'
  const imageClass = count === 1 ? 'max-h-[60vh]' : 'h-44'

  return (
    <div className={`grid ${gridClass} gap-2`}>
      {images.map((image, index) => (
        <button
          key={`${image.filename}-${index}`}
          type="button"
          onClick={() => onOpen(index)}
          title={image.filename}
          className="overflow-hidden rounded-control-sm border border-border bg-black/[0.03] cursor-zoom-in"
        >
          <img src={mediaSrc(image)} alt={image.filename} className={`w-full object-contain ${imageClass}`} />
        </button>
      ))}
    </div>
  )
}
