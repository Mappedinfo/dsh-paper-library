// PlainDeck 的颜色和字体是 CSS 值。共享边界在入屏、写盘和导出前使用，
// 不把正文当作 CSS 扫描，也不允许借样式触发外部请求或注入样式声明。
const paint = /^(?:#[\da-f]{3,8}|[a-z]+|(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\([a-z\d\s.,%+\/-]+\)|var\(--[a-z][a-z\d_-]*(?:,\s*(?:#[\da-f]{3,8}|[a-z]+))?\))$/i
const font = /^[\p{L}\p{N} ,'"_.-]+$/u
const fields = ['color', 'fill', 'stroke', 'textColor', 'headerTextColor', 'headerFill', 'stripeFill', 'ruleColor', 'accentColor']
export function assertSafeSlideStyles(document) {
  const check = (value, type) => {
    if (value === undefined) return
    if (typeof value !== 'string' || value.length > 300 || !value.trim() || !(type === 'font' ? font : paint).test(value.trim())) {
      throw Object.assign(new Error('颜色或字体包含不支持的样式；请使用颜色值和本机字体名称。'), { code: 'SLIDES_INVALID', status: 400 })
    }
  }
  for (const value of Object.values(document.theme?.colors || {})) check(value, 'paint')
  for (const value of Object.values(document.theme?.fonts || {})) check(value, 'font')
  check(document.deck?.footer?.color, 'paint')
  for (const slide of Object.values(document.slides || {})) {
    check(slide.background?.color, 'paint')
    for (const element of slide.elements || []) {
      for (const field of fields) check(element[field], 'paint')
      check(element.fontFamily, 'font')
    }
  }
  return document
}
