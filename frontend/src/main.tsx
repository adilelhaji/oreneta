import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './lib/i18n'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
// Inter is bundled, not fetched from a font service: opening the app asks
// no one for anything.
import '@fontsource-variable/inter/opsz.css'
import '@fontsource-variable/inter/opsz-italic.css'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
