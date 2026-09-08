import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: { dedupe: ['react', 'react-dom'] },
  root: fileURLToPath(new URL('.', import.meta.url)),
  publicDir: false,
  plugins: [
    {
      name: 'offline-baseline-fonts',
      enforce: 'pre',
      transform(code, id) {
        if (id.endsWith('/src/index.css')) {
          // Test-only override: do not request Google Fonts or expose cached media.
          return (
            code.replace(/@import url\('https:\/\/fonts\.googleapis\.com[^']+'\);/, '') +
            '\n@source "./";\n@source "../baseline";'
          )
        }
      },
    },
    react(),
    tailwindcss(),
  ],
  server: { host: '127.0.0.1', port: 4179, strictPort: true },
})
