import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useTranslation } from '../../lib/i18n'

/** The part of a pdf.js page this file uses. */
type PdfPage = {
  getViewport: (options: { scale: number }) => { width: number; height: number }
  render: (options: {
    canvas: HTMLCanvasElement
    canvasContext: CanvasRenderingContext2D
    viewport: { width: number; height: number }
  }) => { promise: Promise<void>; cancel: () => void }
}

/** The part of a pdf.js document this file uses. */
type PdfDocument = {
  numPages: number
  getPage: (page: number) => Promise<PdfPage>
}

/**
 * The handle that owns the document and its worker.
 *
 * Closing goes through here rather than through the document: in pdf.js it is
 * the loading task that owns the worker, and destroying it is what actually
 * lets the thread go.
 */
type PdfLoadingTask = { promise: Promise<unknown>; destroy: () => Promise<void> }

type PdfResources = {
  pdfjs: {
    GlobalWorkerOptions: { workerSrc: string }
    getDocument: (options: Record<string, unknown>) => PdfLoadingTask
  }
  workerSrc: string
}

async function loadPdfResources(): Promise<PdfResources> {
  const [pdfjs, worker] = await Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')])
  return { pdfjs, workerSrc: worker.default }
}

/** A render may finish after the attachment or page has changed. */
export function isCurrentPdfRender(
  generation: number,
  currentGeneration: number,
  document: PdfDocument | null,
  currentDocument: PdfDocument | null,
): boolean {
  return generation === currentGeneration && document !== null && document === currentDocument
}

/**
 * A PDF, drawn a page at a time.
 *
 * WebKitGTK carries no PDF viewer, so the pages are rendered by pdf.js onto a
 * canvas. Only rendered: no annotation layer, no forms, no scripting. A PDF
 * that arrives by mail was written by a stranger, and there is no reading of
 * "preview this attachment" that should mean "run it". The cost is that a link
 * inside the document is not clickable, which is the right way round — saving
 * the file and opening it in a real reader is one click away and is never
 * taken off the table.
 *
 * pdf.js is fetched when a PDF is actually opened rather than with the app. It
 * is a megabyte of code most sessions never need, and paying for it at startup
 * would make every launch slower to make one dialog faster.
 */
export function PdfPreview({
  src,
  onFailed,
  loadPdf = loadPdfResources,
}: {
  src: string
  onFailed: () => void
  loadPdf?: () => Promise<PdfResources>
}) {
  const { t } = useTranslation()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const documentRef = useRef<PdfDocument | null>(null)
  const taskRef = useRef<PdfLoadingTask | null>(null)
  const renderRef = useRef<{ cancel: () => void } | null>(null)
  const generationRef = useRef(0)
  const [pages, setPages] = useState(0)
  const [page, setPage] = useState(1)
  const [drawn, setDrawn] = useState(false)

  const draw = useCallback(async (which: number, generation: number) => {
    const document = documentRef.current
    const canvas = canvasRef.current
    if (!document || !canvas || !isCurrentPdfRender(generation, generationRef.current, document, documentRef.current))
      return

    const pdfPage = await document.getPage(which)
    if (!isCurrentPdfRender(generation, generationRef.current, document, documentRef.current)) return
    const context = canvas.getContext('2d')
    if (!context) return

    // Drawn at the screen's own resolution, capped: a 4× display would
    // otherwise render a poster-sized bitmap into a dialog.
    const ratio = Math.min(window.devicePixelRatio || 1, 2)
    const viewport = pdfPage.getViewport({ scale: 1.5 * ratio })
    canvas.width = viewport.width
    canvas.height = viewport.height
    canvas.style.width = `${viewport.width / ratio}px`
    canvas.style.height = `${viewport.height / ratio}px`

    // A page turned before the last one finished cancels it, so two renders
    // cannot race onto the same canvas and leave half of each.
    renderRef.current?.cancel()
    const render = pdfPage.render({ canvas, canvasContext: context, viewport })
    renderRef.current = render
    try {
      await render.promise
    } finally {
      if (renderRef.current === render) renderRef.current = null
    }
    if (!isCurrentPdfRender(generation, generationRef.current, document, documentRef.current)) return
  }, [])

  // Opening the document. Once per file, not once per page.
  useEffect(() => {
    const generation = ++generationRef.current
    let live = true
    setPages(0)
    setPage(1)
    setDrawn(false)
    if (canvasRef.current) {
      canvasRef.current.width = 0
      canvasRef.current.height = 0
    }

    void (async () => {
      try {
        const { pdfjs, workerSrc } = await loadPdf()
        if (!live) return
        pdfjs.GlobalWorkerOptions.workerSrc = workerSrc

        // Nothing inside a document from a stranger gets to run, and that
        // holds by what is not here rather than by a flag: pdf.js keeps its
        // scripting in a separate sandbox build that this never loads, and
        // the annotation layer — links, forms, buttons — is never built. The
        // page is a picture.
        const loading: PdfLoadingTask = pdfjs.getDocument({
          url: src,
          // Where the font metrics and character maps live. Without them a
          // document that references a standard font without embedding it, or
          // one written in Japanese, renders as blank boxes — which reads as a
          // broken file rather than as a missing asset. See vite.config.js.
          standardFontDataUrl: '/pdfjs/standard_fonts/',
          cMapUrl: '/pdfjs/cmaps/',
          cMapPacked: true,
        })
        taskRef.current = loading
        const document = (await loading.promise) as PdfDocument
        if (!live) {
          if (taskRef.current === loading) {
            void loading.destroy()
            taskRef.current = null
          }
          return
        }
        documentRef.current = document
        setPages(document.numPages)
        await draw(1, generation)
        if (live) setDrawn(true)
      } catch {
        // Said plainly by the caller rather than left as an empty frame: a
        // blank box reads as an empty file, which is a lie about the file.
        if (live) onFailed()
      }
    })()

    return () => {
      live = false
      generationRef.current += 1
      renderRef.current?.cancel()
      void taskRef.current?.destroy()
      taskRef.current = null
      documentRef.current = null
    }
  }, [src, draw, onFailed])

  // Turning a page redraws into the document already open.
  useEffect(() => {
    if (!documentRef.current || page === 1) return
    const generation = generationRef.current
    let live = true
    void draw(page, generation).catch(() => {
      if (live) onFailed()
    })
    return () => {
      live = false
    }
  }, [page, draw, onFailed])

  return (
    <div className="flex min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-auto bg-app p-4">
        {!drawn && <p className="p-6 text-center text-ui text-secondary">{t('attachments.previewLoading')}</p>}
        <canvas ref={canvasRef} className="mx-auto block shadow-lg" />
      </div>
      {pages > 1 && (
        <div className="flex shrink-0 items-center justify-center gap-3 border-t border-border px-3 py-1.5">
          <button
            type="button"
            aria-label={t('attachments.previousPage')}
            title={t('attachments.previousPage')}
            disabled={page <= 1}
            onClick={() => setPage((current) => Math.max(1, current - 1))}
            className="flex h-7 w-7 items-center justify-center rounded-control-sm text-secondary transition-colors hover:bg-hover hover:text-primary cursor-pointer disabled:cursor-not-allowed disabled:opacity-30"
          >
            <ChevronLeft size={15} />
          </button>
          <span className="text-caption tabular-nums text-secondary">{t('attachments.pageOf', { page, pages })}</span>
          <button
            type="button"
            aria-label={t('attachments.nextPage')}
            title={t('attachments.nextPage')}
            disabled={page >= pages}
            onClick={() => setPage((current) => Math.min(pages, current + 1))}
            className="flex h-7 w-7 items-center justify-center rounded-control-sm text-secondary transition-colors hover:bg-hover hover:text-primary cursor-pointer disabled:cursor-not-allowed disabled:opacity-30"
          >
            <ChevronRight size={15} />
          </button>
        </div>
      )}
    </div>
  )
}
