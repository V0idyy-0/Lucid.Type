import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import SettingsModal from './components/SettingsModal.tsx'
import Onboarding from './components/Onboarding.tsx'
import History from './components/History.tsx'
import About from './components/About.tsx'

// Tag <html> with the OS so index.css can pick the native font stack.
const platformClass: Record<string, string | undefined> = {
  darwin: 'platform-mac',
  win32: 'platform-win',
}
const osClass = platformClass[window.whisperFlow.platform]
if (osClass) document.documentElement.classList.add(osClass)

// The same bundle backs five windows: the floating pill, plus the Settings,
// onboarding, dictation-history, and About windows — the main process opens the
// latter four at `index.html#settings` / `#onboarding` / `#history` / `#about`.
const hash = window.location.hash.replace(/^#\/?/, '')

function Root() {
  if (hash === 'settings') return <SettingsModal />
  if (hash === 'onboarding') return <Onboarding />
  if (hash === 'history') return <History />
  if (hash === 'about') return <About />
  return <App />
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
