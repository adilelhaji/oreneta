import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'

// Where the Go bridge / Rust sidecar write cached attachment + feed images in
// Wails dev. Must match app.go's mediaDir(): MERON_MEDIA_DIR, else
// $XDG_CACHE_HOME (or ~/.cache) + oreneta-dev/attachments.
function mediaRoot() {
  if (process.env.MERON_MEDIA_DIR) return process.env.MERON_MEDIA_DIR
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache')
  return path.join(base, 'oreneta-dev', 'attachments')
}

const MEDIA_MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
}

// In `wails dev` Wails serves the page from wails.localhost but proxies every
// request to this Vite server (see frontend:dev:serverUrl), bypassing the Go
// AssetServer's mediaHandler — so `/media/<key>` reaches Vite, not Go, and Vite's
// SPA fallback would answer with index.html and the image renders broken. Serve
// those files here from the same on-disk root instead.
// Production builds embed the frontend and fall through to the Go handler, so
// this plugin only hooks the dev server (configureServer).
function orenetaMedia() {
  const root = path.resolve(mediaRoot())
  return {
    name: 'oreneta-media',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url || !req.url.startsWith('/media/')) return next()
        const rel = decodeURIComponent(req.url.slice('/media/'.length).split('?')[0])
        const filePath = path.resolve(root, rel)
        if (filePath !== root && !filePath.startsWith(root + path.sep)) {
          res.statusCode = 403
          return res.end('forbidden')
        }
        fs.readFile(filePath, (err, data) => {
          if (err) {
            res.statusCode = 404
            return res.end('not found')
          }
          res.setHeader('Content-Type', MEDIA_MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream')
          res.end(data)
        })
      })
    },
  }
}

// pdf.js needs two folders of data at run time that are not code and so are
// not bundled: metrics for the standard fonts a PDF is allowed to reference
// without embedding, and the character maps a CJK document needs. Without them
// a perfectly good invoice renders as blank boxes — a failure that looks like
// a broken file rather than a missing asset.
//
// Copied out of the package rather than committed, so the version that ships
// is always the version of pdf.js that is installed. Served from node_modules
// in dev and copied into the build for production, where the AssetServer hands
// them out like any other embedded asset.
function pdfjsData() {
  const source = path.resolve('node_modules/pdfjs-dist')
  const folders = ['standard_fonts', 'cmaps']
  return {
    name: 'pdfjs-data',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url || !req.url.startsWith('/pdfjs/')) return next()
        const rel = decodeURIComponent(req.url.slice('/pdfjs/'.length).split('?')[0])
        const filePath = path.resolve(source, rel)
        if (!folders.some((folder) => filePath.startsWith(path.join(source, folder) + path.sep))) {
          res.statusCode = 403
          return res.end('forbidden')
        }
        fs.readFile(filePath, (err, data) => {
          if (err) {
            res.statusCode = 404
            return res.end('not found')
          }
          res.end(data)
        })
      })
    },
    closeBundle() {
      for (const folder of folders) {
        fs.cpSync(path.join(source, folder), path.resolve('dist/pdfjs', folder), { recursive: true })
      }
    },
  }
}

// Bergamot (#106, ADR-0031) runs as a classic worker that loads its glue
// script and WebAssembly by name from its own folder, so the three files are
// served and shipped as they are, from the installed package: served from
// node_modules in dev and copied into the build for production.
function bergamotWorker() {
  const source = path.resolve('node_modules/@browsermt/bergamot-translator/worker')
  const files = ['translator-worker.js', 'bergamot-translator-worker.js', 'bergamot-translator-worker.wasm']
  const type = (file) => (file.endsWith('.wasm') ? 'application/wasm' : 'text/javascript')
  return {
    name: 'bergamot-worker',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const file = req.url?.startsWith('/bergamot/') && req.url.slice('/bergamot/'.length).split('?')[0]
        if (!file || !files.includes(file)) return next()
        res.setHeader('Content-Type', type(file))
        res.end(fs.readFileSync(path.join(source, file)))
      })
    },
    closeBundle() {
      fs.mkdirSync(path.resolve('dist/bergamot'), { recursive: true })
      for (const file of files) fs.copyFileSync(path.join(source, file), path.resolve('dist/bergamot', file))
    },
  }
}

// `vite preview` is what the e2e suite runs against: it answers with the exact
// Content-Security-Policy the production build sends (read from csp_prod.go),
// so a feature the policy would block in the app fails in a test instead of
// only on someone's computer.
export function productionCsp(source = fs.readFileSync(new URL('../csp_prod.go', import.meta.url), 'utf8')) {
  const decl = source.slice(source.indexOf('const contentSecurityPolicy ='))
  const end = decl.search(/"\s*\n\s*\n|"\s*\n\s*(func|const|var|\/\/)|"\s*$/)
  const policy = [...decl.slice(0, end + 1).matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]).join('')
  if (!policy.includes('default-src')) throw new Error('csp_prod.go: contentSecurityPolicy not found')
  return policy
}

function previewCsp() {
  return {
    name: 'preview-csp',
    configurePreviewServer(server) {
      const policy = productionCsp()
      server.middlewares.use((_req, res, next) => {
        res.setHeader('Content-Security-Policy', policy)
        next()
      })
    },
  }
}

export default defineConfig({
  // Linked/hoisted packages must share the renderer's React dispatcher.
  resolve: { dedupe: ['react', 'react-dom'] },
  plugins: [react(), tailwindcss(), orenetaMedia(), pdfjsData(), bergamotWorker(), previewCsp()],
})
