import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { DeckDocument } from '../core/schema.js'
import { prepareDocumentAssets, type PrepareAssetsOptions } from './assets.js'
import { renderHtml } from './html.js'

import { PlainDeckError } from '../core/errors.js'
export interface BrowserRenderOptions extends PrepareAssetsOptions {
  output: string
  browserExecutable?: string
}

export interface PngRenderOptions extends BrowserRenderOptions {
  slide?: number | string
  scale?: number
}

async function launchChromium(executablePath?: string) {
  try {
    const { chromium } = await import('playwright')
    return await chromium.launch({ headless: true, executablePath })
  } catch (error) {
    throw new PlainDeckError('playwright-chromium-required', { zh: `PNG/PDF 渲染需要 Playwright Chromium。请运行：npm install playwright && npx playwright install chromium\n${error instanceof Error ? error.message : String(error)}`, en: `PNG/PDF rendering requires Playwright Chromium. Run: npm install playwright && npx playwright install chromium\n${error instanceof Error ? error.message : String(error)}` }, { cause: error })
  }
}

function resolveSlide(document: DeckDocument, selector: number | string) {
  if (typeof selector === 'number' || /^\d+$/.test(selector)) {
    const index = Number(selector) - 1
    const path = document.deck.slides[index]
    if (!path) throw new PlainDeckError('slide-index-out-of-range', { zh: `页面序号不存在：${selector}`, en: `Slide index does not exist: ${selector}` })
    return { path, index }
  }
  const index = document.deck.slides.indexOf(selector)
  if (index < 0) throw new PlainDeckError('slide-not-found', { zh: `页面不存在：${selector}`, en: `Slide not found: ${selector}` })
  return { path: selector, index }
}

const slug = (value: string) => value.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'slide'

export async function renderPng(input: DeckDocument, options: PngRenderOptions) {
  const prepared = await prepareDocumentAssets(input, options)
  const browser = await launchChromium(options.browserExecutable)
  const scale = Math.max(0.25, Math.min(4, options.scale ?? 1))
  const targets = options.slide === undefined
    ? prepared.document.deck.slides.map((path, index) => ({ path, index }))
    : [resolveSlide(prepared.document, options.slide)]
  const files: string[] = []
  try {
    const page = await browser.newPage({ viewport: { ...prepared.document.deck.canvas }, deviceScaleFactor: scale })
    if (!options.allowNetwork) await page.route(/^https?:/, route => route.abort())
    await page.setContent(renderHtml(prepared.document, { mode: 'document' }), { waitUntil: 'load' })
    if (options.slide === undefined) await mkdir(options.output, { recursive: true })
    for (const target of targets) {
      const slide = prepared.document.slides[target.path]
      const file = options.slide === undefined
        ? join(options.output, `${String(target.index + 1).padStart(3, '0')}-${slug(slide.name ?? slide.id)}.png`)
        : options.output
      await mkdir(dirname(file), { recursive: true })
      await page.locator('.slide').nth(target.index).screenshot({ path: file })
      files.push(file)
    }
  } finally {
    await browser.close()
  }
  return { files, warnings: prepared.warnings }
}

export async function renderPdf(input: DeckDocument, options: BrowserRenderOptions) {
  const prepared = await prepareDocumentAssets(input, options)
  const browser = await launchChromium(options.browserExecutable)
  try {
    const page = await browser.newPage({ viewport: { ...prepared.document.deck.canvas } })
    if (!options.allowNetwork) await page.route(/^https?:/, route => route.abort())
    await page.setContent(renderHtml(prepared.document, { mode: 'document' }), { waitUntil: 'load' })
    await mkdir(dirname(options.output), { recursive: true })
    await page.pdf({ path: options.output, printBackground: true, preferCSSPageSize: true })
  } finally {
    await browser.close()
  }
  return { file: options.output, warnings: prepared.warnings }
}
