/** 从公开使用手册生成 PDF、可编辑 PlainDeck 项目与动态 PPTX。
 * PLAYWRIGHT_MODULE / MARKED_MODULE 可指向已有依赖；不访问私人资料或模型。
 */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {build} from 'esbuild';
import JSZip from 'jszip';
import {createDeckTemplate,assertDocument,canonicalJson,auditPresentation} from '../lib/plaindeck-core.mjs';
import {buildSlidesPptx} from '../src/slides-pptx.mjs';
const root=resolve('docs/demo'),qa=resolve('.local/user-guide');
await mkdir(root,{recursive:true});await mkdir(qa,{recursive:true});
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const {marked}=await import(process.env.MARKED_MODULE||'marked');
const md=await readFile(join(root,'guide.md'),'utf8'),sections=md.split(/^## /m).slice(1);
const escape=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const intro=md.split(/^## /m)[0];
const manual=`<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>Paper Library 使用手册</title><style>
@page{size:A4;margin:0}*{box-sizing:border-box}body{margin:0;color:#192620;background:#fffefa;font:16px/1.85 "PingFang SC","Microsoft YaHei",sans-serif}section{width:210mm;height:297mm;padding:20mm 21mm 22mm;position:relative;break-after:page}header{font:600 12px/1.4 sans-serif;letter-spacing:1px;color:#245c49;margin-bottom:18mm}h1{font-size:30px;line-height:1.3;margin:0 0 8px}h2{font-size:26px;line-height:1.4;margin:0 0 24px;color:#245c49}h3{font-size:17px}p{margin:12px 0}li{margin:9px 0;padding-left:3px}ol,ul{padding-left:22px}blockquote{margin:18px 0;padding:12px 18px;border-left:4px solid #885526;background:#faf0e2}footer{position:absolute;bottom:15mm;left:21mm;right:21mm;display:flex;justify-content:space-between;font-size:11px;color:#52635b;border-top:1px solid #d8e1dc;padding-top:6px}a{color:#285a80;overflow-wrap:anywhere}code{font-size:12px;overflow-wrap:anywhere} .intro{border-bottom:1px solid #d8e1dc;padding-bottom:12px;margin-bottom:20px}.intro p{font-size:12px}.intro h1{font-size:24px}
</style></head><body>${sections.map((s,i)=>`<section><header>PAPER LIBRARY / 使用手册</header>${i===0?`<div class="intro">${marked.parse(intro)}</div>`:''}${marked.parse('## '+s)}<footer><span>社区维护 · main 源码 · 2026-11-06</span><span>${i+1} / ${sections.length}</span></footer></section>`).join('')}</body></html>`;
await writeFile(join(root,'guide.html'),manual);
const d=createDeckTemplate('blank',{title:'Paper Library 使用说明',lang:'zh'});
d.deck.slides=[];d.slides={};d.theme.fonts={title:'PingFang SC',body:'PingFang SC',mono:'Menlo'};d.theme.colors={background:'#FFFEFA',text:'#192620',muted:'#52635B',accent:'#245C49',surface:'#FFFFFF'};
d.deck.footer={left:{type:'none'},center:{type:'none'},right:{type:'none'}};
const C={green:'#245C49',purple:'#695187',blue:'#285A80',gold:'#885526',ink:'#192620',muted:'#52635B'};
let seq=0;
const text=(value,x,y,w,h,size=32,color=C.ink,weight=400)=>({type:'text',id:`t${++seq}`,text:value,fontSize:size,fontWeight:weight,fontFamily:'PingFang SC',color,frame:{x,y,w,h},fit:'none'});
const box=(label,x,y,w,h,color=C.green,delay=0)=>({type:'shape',id:`s${++seq}`,shape:'rounded-rectangle',radius:12,fill:color,text:label,textColor:'#FFFFFF',fontFamily:'PingFang SC',fontSize:34,frame:{x,y,w,h},animation:{enter:'fade-up',delayFrames:delay,durationFrames:24}});
const line=(x,y,w,color=C.green)=>({type:'line',id:`l${++seq}`,color,strokeWidth:4,arrowEnd:true,frame:{x,y,w,h:1}});
function slide(title,kicker,elements,{dark=false,camera=false}={}){const i=d.deck.slides.length+1,p=`./slides/${String(i).padStart(3,'0')}.json`;d.deck.slides.push(p);d.slides[p]={id:`guide-${i}`,name:title,background:{color:dark?'#173B30':'#FFFEFA'},elements:[text(kicker,90,55,1400,45,23,dark?'#D8C49B':C.gold,600),text(title,90,125,1400,110,52,dark?'#FFFFFF':C.ink,600),...elements,text('PAPER LIBRARY · 使用说明',90,840,1200,40,22,dark?'#D7E5DC':C.muted),text(`${i} / 10`,1400,840,140,40,22,dark?'#D7E5DC':C.muted)],...(camera?{motion:{camera:{fromScale:.96,toScale:1,delayFrames:0,durationFrames:150}}}:{})};}
slide('从一份 PDF，走到一份可演示的成果','PAPER LIBRARY / DSH 社区插件',[
 text('阅读、提问、整理、写作与演示，围绕同一份本地资料继续工作。',95,270,1360,100,36,'#E1EBE5'),
 ...[['读',C.green],['想',C.purple],['写',C.blue],['讲',C.gold]].map(([t,c],i)=>box(t,95+i*370,440,290,170,c,i*12)),
 text('本演示的内容就是使用说明；页面、表格与流程节点可以继续编辑。',95,690,1380,80,28,'#D7E5DC')],{dark:true,camera:true});
slide('先导入，再核对资料','01 / 开始使用',[
 box('导入 PDF',95,290,380,130,C.green),line(500,355,90),box('核对元数据',615,290,380,130,C.green,15),line(1020,355,90),box('阅读与引用',1135,290,370,130,C.green,30),
 text('PDF、DOI、公开链接\nJSON、RIS、BibTeX',100,460,380,145,32),text('标题、作者、日期、DOI\n缺失项保留待核对',620,460,380,145,32),text('检索与阅读项目\nAPA 7 与 BibLaTeX',1140,460,370,145,32),
 text('练习：把配套 PDF 手册导入文献库，作为工具文档阅读。',95,700,1400,70,30,C.muted)]);
slide('把具体问题留在原文旁','02 / 阅读与批注',[
 box('批注随管理副本 PDF 导出',95,285,900,145,C.green),
 text('选中这句话 → 高亮 → 写下问题',100,480,850,70,38,C.green,600),text('“换一个阅读器，还能看到这条批注吗？”',100,585,880,120,33),
 box('问 DSH',1100,285,400,145,C.purple,18),text('回复关联原批注\n标明 AI 来源\n继续对照原文核实',1100,480,410,200,32),
 text('原文件保持不变；实时伴学可选开启，会使用模型额度。',95,755,1400,50,26,C.muted)]);
slide('项目整理资料，画板表达关系','03 / 知识与画板',[
 box('读说明',115,330,360,130,C.purple),line(500,395,120,C.purple),box('写问题',645,330,360,130,C.purple,15),line(1030,395,100,C.purple),box('试导出',1155,330,330,130,C.purple,30),
 text('阅读项目\n文献可属于多个主题。\n移出项目只解除关联。',110,535,640,190,32),text('文献画板\n文字、便签与连线；文献节点可返回阅读器。',855,535,640,190,32),
 text('AI 知识图谱与精读笔记是待审阅草稿，保留出处后再采用。',110,765,1390,50,26,C.muted)]);
slide('写作提案经检查后才落到文件','04 / LATEX 工作台',[
 box('编辑与保存',95,300,420,130,C.blue),box('编译并看 PDF',590,300,420,130,C.blue,15),box('自审与提问',1085,300,420,130,C.blue,30),
 text('源码 / PDF 并排\n章节与源码搜索',100,480,420,150,34),text('本机 latexmk + TeX\n错误与历史版本可回查',595,480,420,150,34),text('比较具体替换内容\n接受提案后写入',1090,480,410,150,34),
 text('另一窗口已修改时会提示版本冲突；先保留草稿，再比较和恢复。',95,720,1410,90,30,C.muted)]);
slide('说明本身就是可编辑的 Slides 项目','05 / PLAINDECK',[
 box('导入本套 ZIP',95,310,420,130,C.gold),box('修改一句话',590,310,420,130,C.gold,15),box('保存并导出',1085,310,420,130,C.gold,30),
 text('文字 · 图片 · 原生表格\n制作指导 · 主题 · 放映',100,510,650,180,35),text('入场动画 + 镜头缩放\nPPTX 中进入放映查看',870,510,630,180,35),
 text('PlainDeck ZIP 可重新导入；PPTX 导入目前不支持。',95,755,1400,60,28,C.muted)],{camera:true});
slide('按交付用途选择导出格式','06 / 文件互通',[
 {type:'table',id:'formats',cells:[['格式','适合做什么','继续编辑 / 动画'],['PPTX','交付、演讲、对象编辑','原生对象；支持入场与镜头'],['PDF','阅读、打印、批注','静态页面'],['HTML','离线查看与翻页','不等同于 PPTX 动画播放'],['ZIP','保留 PlainDeck 项目','可重新导入并继续编辑']],headerRows:1,style:'rules',fontSize:30,headerFill:C.green,headerTextColor:'#FFFFFF',textColor:C.ink,ruleColor:'#C8D5CD',cellPadding:20,columnWidths:[1,2,2.5],frame:{x:95,y:295,w:1410,h:430},animation:{enter:'fade',durationFrames:24}},
 text('PowerPoint 已有合成放映验证；WPS 尚未完成实机验收。',95,765,1410,50,26,C.muted)]);
slide('两套配色，四种功能含义','07 / 可切换工作台主题',[
 box('墨绿铜金',100,290,650,100,C.green),box('深海蓝灰',850,290,650,100,'#254E70',12),
 text('温暖纸面与墨绿操作色',110,425,630,80,34),text('清亮白底与海蓝操作色',860,425,630,80,34),
 ...[['阅读',C.green],['知识',C.purple],['写作',C.blue],['Slides',C.gold]].map(([t,c],i)=>box(t,100+i*365,565,300,100,c,i*9)),
 text('设置 → 界面配色。明暗随 DSH；PDF 和批注颜色保持原样。',100,755,1400,60,28,C.muted)]);
slide('让 DSH 找到已保存项目并导出','08 / AI 调用',[
 text('“找到「Paper Library 使用说明」，导出为 PowerPoint，\n返回文件位置和导出提示。”',100,285,1400,155,40,C.green,600),
 box('查找项目',100,500,420,110,C.green),box('导出已保存版本',590,500,420,110,C.green,15),box('读取文件与提示',1080,500,420,110,C.green,30),
 text('library_slides_list',100,650,440,65,28,C.muted),text('library_slides_export_pptx',590,650,490,65,27,C.muted),text('path · revision · warnings',1080,650,440,65,27,C.muted)]);
slide('从本套示例开始，保留自己的文件','09 / 上手练习',[
 box('1  导入手册 PDF 并批注',100,290,1400,110,C.green),box('2  导入 Slides ZIP，修改一句话',100,435,1400,110,C.blue,15),box('3  导出 PPTX，进入放映检查',100,580,1400,110,C.gold,30),
 text('安装与完整说明：github.com/Mappedinfo/dsh-paper-library',100,750,1400,65,28,C.muted)]);
assertDocument(d);
const report=auditPresentation(d,{audience:'general',purpose:'让首次使用者完成一次本地阅读到演示的流程',minutes:8,evidenceDepth:'supported',locale:'zh'});
await writeFile(join(qa,'review.json'),JSON.stringify(report,null,2));
await writeFile(join(root,'slides.json'),canonicalJson(d));
const zip=new JSZip();zip.file('deck.json',canonicalJson(d.deck));zip.file('theme.json',canonicalJson(d.theme));for(const[p,s]of Object.entries(d.slides))zip.file(p.replace(/^\.\//,''),canonicalJson(s));
await writeFile(join(root,'slides.zip'),await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'}));
const pptx=await buildSlidesPptx(d,()=>{throw Error('No external assets');});await writeFile(join(root,'slides.pptx'),pptx.bytes);
const bundled=await build({entryPoints:['vendor/plaindeck/packages/plaindeck/src/render/html.ts'],bundle:true,write:false,platform:'node',format:'esm'});
const {renderHtml}=await import('data:text/javascript;base64,'+Buffer.from(bundled.outputFiles[0].text).toString('base64'));
await writeFile(join(root,'slides.html'),renderHtml(d));
const browser=await chromium.launch({headless:true});
try{
 const page=await browser.newPage({viewport:{width:1600,height:900},deviceScaleFactor:1});
 await page.setContent(manual);await page.evaluate(()=>document.fonts.ready);
 const over=await page.locator('section').evaluateAll(nodes=>nodes.map((n,i)=>({page:i+1,overflow:n.scrollHeight>n.clientHeight+1})));if(over.some(x=>x.overflow))throw Error('Manual page overflow '+JSON.stringify(over));
 await page.pdf({path:join(root,'guide.pdf'),printBackground:true,preferCSSPageSize:true});
 await page.setContent(renderHtml(d,{mode:'document'}));await page.evaluate(()=>document.fonts.ready);
 await page.pdf({path:join(root,'slides.pdf'),printBackground:true,preferCSSPageSize:true});
 for(let i=0;i<d.deck.slides.length;i++)await page.locator('.slide').nth(i).screenshot({path:join(qa,`slide-${String(i+1).padStart(2,'0')}.png`)});
 const overflow=await page.locator('.text-content,.shape-label').evaluateAll(nodes=>nodes.filter(n=>n.scrollHeight>n.clientHeight+2||n.scrollWidth>n.clientWidth+2).map(n=>n.innerText));
 if(overflow.length)throw Error('Slide text overflow '+JSON.stringify(overflow));
 console.log(JSON.stringify({manualPages:sections.length,slides:d.deck.slides.length,warnings:pptx.warnings,output:root}));
}finally{await browser.close();}
