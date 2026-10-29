/**
 * Local placeholder image for new image elements.
 * Inline SVG data URI (no network dependency) so the editor stays
 * local-first: offline-safe and identical in HTML/PDF/PNG exports.
 * Neutral gray palette — intentionally independent of any theme.
 */
const placeholderSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#F0F1ED"/>
      <stop offset="1" stop-color="#DCDED7"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="800" fill="url(#bg)"/>
  <g fill="none" stroke="#8A9088" stroke-width="10" stroke-linecap="round" stroke-linejoin="round">
    <rect x="440" y="280" width="320" height="240" rx="18"/>
    <circle cx="560" cy="360" r="28"/>
    <path d="M440 500 l96-96 64 64 56-56 64 64"/>
  </g>
  <text x="600" y="612" font-family="ui-monospace, monospace" font-size="34" font-weight="700" letter-spacing="8" fill="#8A9088" text-anchor="middle">IMAGE</text>
</svg>`

export const PLACEHOLDER_IMAGE_SRC = `data:image/svg+xml,${encodeURIComponent(placeholderSvg)}`
