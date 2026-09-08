import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import SettingsModal from './components/SettingsModal.tsx'

// Tag <html> with the OS so index.css can pick the native font stack.
const platformClass: Record<string, string | undefined> = {
  darwin: 'platform-mac',
  win32: 'platform-win',
}
const osClass = platformClass[window.whisperFlow.platform]
if (osClass) document.documentElement.classList.add(osClass)

// The same bundle backs two windows: the floating pill and the Settings window,
// which the main process opens at `index.html#settings`.
const isSettingsWindow = window.location.hash.replace(/^#\/?/, '') === 'settings'

createRoot(document.getElementById('root')!).render(
  <StrictMode>{isSettingsWindow ? <SettingsModal /> : <App />}</StrictMode>,
)
