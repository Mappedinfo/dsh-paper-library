import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import App from './App'
import { initializeAnalytics } from './analytics'
import './styles/app.css'

let applyUpdate: (reloadPage?: boolean) => Promise<void> = async () => undefined
applyUpdate = registerSW({
  onNeedRefresh() {
    window.dispatchEvent(new CustomEvent('plaindeck-update', { detail: applyUpdate }))
  },
})
initializeAnalytics({
  googleMeasurementId: import.meta.env.VITE_GOOGLE_ANALYTICS_ID,
  baiduSiteId: import.meta.env.VITE_BAIDU_ANALYTICS_ID,
  enabled: import.meta.env.PROD,
})

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
