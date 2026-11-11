/** 对合成稿件实测翻页、拖放和可见渲染量；使用临时资料库。 */
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { createFetchHandler } from '../src/http.mjs'
import { createSlidesStore } from '../src/slides-store.mjs'
import { createDeckTemplate } from '../lib/plaindeck-core.mjs'
const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')
const root = await mkdtemp(join(tmpdir(), 'dsh-plain-bench-'))
const library = join(root, 'library')
await mkdir(library)
const handler = createFetchHandler({ library, localStateHome: join(root,'state') })
const server = createServer(async (req, res) => {
  try {
    const response = await handler(new Request('http://' + req.headers.host + req.url, {
      method: req.method, headers: req.headers,
      ...(!['GET', 'HEAD'].includes(req.method) && { body: Readable.toWeb(req), duplex: 'half' }),
    }))
    res.writeHead(response.status, Object.fromEntries(response.headers))
    res.end(Buffer.from(await response.arrayBuffer()))
  } catch {
    res.writeHead(500); res.end()
  }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = 'http://127.0.0.1:' + server.address().port
let browser
const median = arr => Math.round([...arr].sort((a,b)=>a-b)[Math.floor(arr.length / 2)] * 10)/10
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined })
  for (const [count, density] of [[8,12], [30,40]]) {
    const document = createDeckTemplate('blank', { title: '合成性能测试', lang:'zh' })
    document.deck.slides = Array.from({length:count}, (_, i)=>'./slides/slide-'+(i+1)+'.json')
    document.slides = Object.fromEntries(document.deck.slides.map((path,i)=>[path, {
      id:'page-'+(i+1),name:'测试页 '+(i+1),
      elements: Array.from({length:density},(_,n)=>{
        const common={id:'element-'+(n+1), frame:{x:55+n%8*190, y:64+Math.floor(n/8)*145, w:145, h:56}}
        return n%2 ? {...common,type:'text',text:'合成内容 '+n,fontSize:20} : {...common,type:'shape',shape:'rectangle',fill:'#28758d'}
      }),
    }]))
    const created = await createSlidesStore({library}).handle({action:'slides_create',document,title:'合成性能测试'})
    const page = await browser.newPage({ viewport:{ width:1512,height:982 }, locale:'zh-CN' })
    const errors=[]
    page.on('pageerror', err=>errors.push(err.message))
    await page.route('**/*',route=>route.request().url().startsWith(origin) ? route.continue() : route.abort())
    await page.goto(origin+'/slides.html?project='+created.project.id)
    await page.locator('.editor-surface [data-element-id="element-1"]').waitFor()
    await page.locator('.thumb-crop [data-element-id="element-1"]').first().waitFor()
    const counts = await page.evaluate(()=>({
      thumbnails:document.querySelectorAll('.thumb-crop .slide-element').length,
      editing:document.querySelectorAll('.editor-surface .slide-element').length,
      printing:document.querySelectorAll('.print-deck .slide-element').length,
    }))
    if (!process.argv.includes('--baseline') && (counts.printing !== 0 || counts.thumbnails >= count * density && count === 30)) {
      throw new Error(`Unexpected eager rendering: ${JSON.stringify(counts)}`)
    }
    const timings=await page.evaluate(async()=>{
      const frame=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))
      const tabs=[...document.querySelectorAll('.slide-thumb')]
      const times=[]
      for (const i of [1,2,0,3,4,1,0,2,3,0,4,1,0]) {
        const start=performance.now()
        tabs[i].click()
        await frame()
        if (!tabs[i].classList.contains('active')) throw new Error('Wrong active slide')
        times.push(performance.now()-start)
      }
      return times.slice(3)
    })
    const element=page.locator('.editor-surface [data-element-id="element-1"]')
    const drop=[]
    for(let i=0;i<7;i++){
      const box=await element.boundingBox(), x=box.x+box.width/2, y=box.y+box.height/2
      const before=await element.evaluate(el=>el.style.left)
      await page.mouse.move(x,y); await page.mouse.down(); await page.mouse.move(x+(i%2?-27:27),y+3,{steps:8})
      await page.evaluate(()=>{window.lastUp=0;window.addEventListener('pointerup',()=>{window.lastUp=performance.now()},{once:true,capture:true})})
      await page.mouse.up()
      drop.push(await page.evaluate(async()=>{await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));return performance.now()-window.lastUp}))
      const after=await element.evaluate(el=>el.style.left)
      if(before===after) throw new Error('Element did not move')
    }
    if(errors.length) throw new Error(errors.join('\n'))
    console.log(JSON.stringify({count,density,counts,flipMedianMs:median(timings),dropMedianMs:median(drop)}))
    await page.close()
  }
} finally {
  await browser?.close()
  server.closeAllConnections()
  await new Promise(resolve=>server.close(resolve))
  await rm(root,{recursive:true,force:true})
}
