import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import { PublicBrief } from './views/PublicBrief'

const pathMatch = window.location.pathname.match(/^\/for\/([a-f0-9]+)$/)
const root = document.getElementById('root')!

if (pathMatch) {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <PublicBrief token={pathMatch[1]} />
    </React.StrictMode>
  )
} else {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
}
