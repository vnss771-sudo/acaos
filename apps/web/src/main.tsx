import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import { installGlobalErrorHandlers } from './lib/errorReporting'
import './base.css'
import './animations.css'
import './a11y.css'

installGlobalErrorHandlers()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
