import { createRoot } from 'react-dom/client'
import { ReferenceMail } from './ReferenceMail'
import { createFixture } from './fixtures'
import '../src/index.css'
import './reference.css'

export const REFERENCE_SCENES = ['inbox', 'reader', 'composer', 'table', 'selection', 'uncertain'] as const
const params = new URLSearchParams(location.search)
const scene = params.get('scene') ?? 'reader'
const theme = params.get('theme') ?? 'light'
if (!REFERENCE_SCENES.includes(scene as (typeof REFERENCE_SCENES)[number]) || !['light', 'dark'].includes(theme)) {
  throw new Error('Unknown mail reference scenario')
}
document.documentElement.classList.toggle('dark', theme === 'dark')
const fixture = createFixture()
createRoot(document.getElementById('root')!).render(<ReferenceMail fixture={fixture} scene={scene} theme={theme} />)
