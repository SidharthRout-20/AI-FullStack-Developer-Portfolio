import '@fontsource-variable/inter'
import '@fontsource-variable/jetbrains-mono'
import '@fontsource-variable/caveat'
import './index.css'
import { watchFrameRate } from './lib/lite'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Root } from './Root.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
watchFrameRate()
