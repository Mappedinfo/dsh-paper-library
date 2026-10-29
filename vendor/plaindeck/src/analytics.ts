export interface AnalyticsConfig {
  googleMeasurementId?: string
  baiduSiteId?: string
  enabled?: boolean
}

const GOOGLE_ID_PATTERN = /^G-[A-Z0-9]+$/i
const BAIDU_ID_PATTERN = /^[a-f0-9]{32}$/i

function appendScript(id: string, src: string) {
  if (document.getElementById(id)) return
  const script = document.createElement('script')
  script.id = id
  script.async = true
  script.src = src
  document.head.appendChild(script)
}

function initializeGoogleAnalytics(measurementId: string) {
  const analyticsWindow = window as typeof window & {
    dataLayer?: unknown[]
    gtag?: (...args: unknown[]) => void
  }

  appendScript('plaindeck-google-analytics', `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}`)
  analyticsWindow.dataLayer = analyticsWindow.dataLayer ?? []
  analyticsWindow.gtag = function gtag(...args: unknown[]) { analyticsWindow.dataLayer?.push(args) }
  analyticsWindow.gtag('js', new Date())
  analyticsWindow.gtag('config', measurementId, {
    send_page_view: true,
    allow_google_signals: false,
    allow_ad_personalization_signals: false,
  })
}

function initializeBaiduAnalytics(siteId: string) {
  const analyticsWindow = window as typeof window & { _hmt?: unknown[][] }
  analyticsWindow._hmt = analyticsWindow._hmt ?? []
  appendScript('plaindeck-baidu-analytics', `https://hm.baidu.com/hm.js?${encodeURIComponent(siteId)}`)
}

export function initializeAnalytics({
  googleMeasurementId = '',
  baiduSiteId = '',
  enabled = true,
}: AnalyticsConfig = {}) {
  if (!enabled || typeof window === 'undefined' || typeof document === 'undefined') return

  const googleId = googleMeasurementId.trim()
  const baiduId = baiduSiteId.trim()

  if (GOOGLE_ID_PATTERN.test(googleId)) initializeGoogleAnalytics(googleId)
  if (BAIDU_ID_PATTERN.test(baiduId)) initializeBaiduAnalytics(baiduId)
}
