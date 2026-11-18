import '@fontsource-variable/inter'
import { ShellProvider } from '@appcore/web/ui'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import SafarnamaApp from './App'
import './styles/app.css'

// Safarnaama on its own site: mounted at the root, plain light / dark control, no portfolio links.
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ShellProvider>
      <SafarnamaApp basePath="" />
    </ShellProvider>
  </StrictMode>,
)
