import { act } from 'react'
import { afterEach, describe, expect, it } from 'bun:test'
import { render } from '@testing-library/react'
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
})
