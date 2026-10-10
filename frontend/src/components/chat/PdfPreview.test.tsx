import { act } from 'react'
import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { PdfPreview, isCurrentPdfRender } from './PdfPreview'

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void }

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function resources(task: { promise: Promise<unknown>; destroy: () => Promise<void> }) {
  const page = {
    getViewport: () => ({ width: 100, height: 100 }),
    render: () => ({ promise: Promise.resolve(), cancel: () => undefined }),
  }
  const document = { numPages: 1, getPage: async () => page }
  return {
    pdfjs: {
      GlobalWorkerOptions: { workerSrc: '' },
      getDocument: () => ({ ...task, promise: task.promise.then(() => document) }),
    },
    workerSrc: 'worker.js',
  }
}

afterEach(() => {
  cleanup()
  delete (HTMLCanvasElement.prototype as any).getContext
})

describe('PDF preview render generations', () => {
  it('accepts the active document and generation', () => {
    const document = {} as any
    expect(isCurrentPdfRender(3, 3, document, document)).toBe(true)
  })

  it('rejects an older or replaced document', () => {
    const document = {} as any
    expect(isCurrentPdfRender(2, 3, document, document)).toBe(false)
    expect(isCurrentPdfRender(3, 3, {} as any, {} as any)).toBe(false)
    expect(isCurrentPdfRender(3, 3, null, null)).toBe(false)
  })

  it('keeps the newer loading task owned when an older attachment resolves late', async () => {
    ;(HTMLCanvasElement.prototype as any).getContext = () => ({})
    const first = deferred<unknown>()
    const second = deferred<unknown>()
    let firstDestroyed = 0
    let secondDestroyed = 0
    const firstTask = { promise: first.promise, destroy: async () => void firstDestroyed++ }
    const secondTask = { promise: second.promise, destroy: async () => void secondDestroyed++ }
    const loadPdf = async () => (loadPdf.calls++ === 0 ? resources(firstTask) : resources(secondTask))
    loadPdf.calls = 0
    const view = render(<PdfPreview src="/media/first.pdf" onFailed={() => undefined} loadPdf={loadPdf} />)

    await act(async () => {
      await Promise.resolve()
      view.rerender(<PdfPreview src="/media/second.pdf" onFailed={() => undefined} loadPdf={loadPdf} />)
      await Promise.resolve()
    })
    second.resolve(undefined)
    await act(async () => {
      await second.promise
    })
    first.resolve(undefined)
    await act(async () => {
      await first.promise
    })
    expect(view.container.querySelector('canvas')).toBeTruthy()
    view.unmount()
    expect(firstDestroyed).toBe(1)
    expect(secondDestroyed).toBe(1)
  })

  // #40: a multipage document, its pages recorded as they are drawn.
  function multipage(drawn: number[], opened: { count: number }) {
    const pageOf = (n: number) => ({
      getViewport: () => ({ width: 100, height: 100 }),
      render: () => {
        drawn.push(n)
        return { promise: Promise.resolve(), cancel: () => undefined }
      },
    })
    const document = { numPages: 3, getPage: async (n: number) => pageOf(n) }
    return async () => ({
      pdfjs: {
        GlobalWorkerOptions: { workerSrc: '' },
        getDocument: () => {
          opened.count++
          return { promise: Promise.resolve(document), destroy: async () => undefined }
        },
      },
      workerSrc: 'worker.js',
    })
  }

  const settle = () =>
    act(async () => {
      for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0))
    })

  it('going back to the first page draws the first page again', async () => {
    ;(HTMLCanvasElement.prototype as any).getContext = () => ({})
    const drawn: number[] = []
    const opened = { count: 0 }
    const view = render(<PdfPreview src="/media/a.pdf" onFailed={() => undefined} loadPdf={multipage(drawn, opened)} />)
    await settle()
    expect(drawn).toEqual([1])

    fireEvent.click(view.getByRole('button', { name: 'Next page' }))
    await settle()
    fireEvent.click(view.getByRole('button', { name: 'Previous page' }))
    await settle()
    // Without this the canvas keeps showing page 2 under a "1 of 3" label.
    expect(drawn).toEqual([1, 2, 1])
    expect(view.container.textContent).toContain('1')
  })

  it('a parent re-render with a new failure callback does not open the document again', async () => {
    ;(HTMLCanvasElement.prototype as any).getContext = () => ({})
    const drawn: number[] = []
    const opened = { count: 0 }
    const loadPdf = multipage(drawn, opened)
    const view = render(<PdfPreview src="/media/a.pdf" onFailed={() => undefined} loadPdf={loadPdf} />)
    await settle()
    fireEvent.click(view.getByRole('button', { name: 'Next page' }))
    await settle()
    view.rerender(<PdfPreview src="/media/a.pdf" onFailed={() => undefined} loadPdf={loadPdf} />)
    await settle()
    expect(opened.count).toBe(1)
    // And the reader stays on the page they turned to.
    expect(drawn).toEqual([1, 2])
  })

  it('every open and close cycle releases its document and worker', async () => {
    ;(HTMLCanvasElement.prototype as any).getContext = () => ({})
    let destroyed = 0
    let opened = 0
    const page = {
      getViewport: () => ({ width: 100, height: 100 }),
      render: () => ({ promise: Promise.resolve(), cancel: () => undefined }),
    }
    const loadPdf = async () => ({
      pdfjs: {
        GlobalWorkerOptions: { workerSrc: '' },
        getDocument: () => {
          opened++
          return {
            promise: Promise.resolve({ numPages: 1, getPage: async () => page }),
            destroy: async () => void destroyed++,
          }
        },
      },
      workerSrc: 'worker.js',
    })
    for (let cycle = 0; cycle < 5; cycle++) {
      const view = render(<PdfPreview src={`/media/${cycle}.pdf`} onFailed={() => undefined} loadPdf={loadPdf} />)
      await settle()
      view.unmount()
    }
    expect(opened).toBe(5)
    expect(destroyed).toBe(5)
  })

  it('a document that cannot be opened is reported, not left as an empty frame', async () => {
    let failed = 0
    let destroyed = 0
    const loadPdf = async () => ({
      pdfjs: {
        GlobalWorkerOptions: { workerSrc: '' },
        getDocument: () => ({
          promise: Promise.reject(new Error('Invalid PDF structure')),
          destroy: async () => void destroyed++,
        }),
      },
      workerSrc: 'worker.js',
    })
    const view = render(<PdfPreview src="/media/broken.pdf" onFailed={() => void failed++} loadPdf={loadPdf} />)
    await settle()
    expect(failed).toBe(1)
    view.unmount()
    expect(destroyed).toBe(1)
  })
})

