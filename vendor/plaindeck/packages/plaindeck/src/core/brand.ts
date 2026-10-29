/**
 * Brand identity constants — single source of truth for brand colors.
 * Colors are adopted from the open-source Palette Lab color archive
 * (色卡实验室 · https://mappedinfo.github.io/palette-lab/ · 机器可读档案 llms-full.txt):
 * - BRAND_ACCENT = 珊瑚 Coral #E97A46（组5 深色/强调类）
 * - BRAND_THEME_COLOR = 编辑器深色外壳，沿用既有暗色
 * Consumers: schema defaults, theme presets, PWA manifest (vite.config).
 * NOTE: `index.html` is a static shell and mirrors these literals
 * (`#171714` theme-color, `#e97a46` mask-icon) — keep them in sync here.
 */
export const BRAND_ACCENT = '#E97A46'
export const BRAND_THEME_COLOR = '#171714'
