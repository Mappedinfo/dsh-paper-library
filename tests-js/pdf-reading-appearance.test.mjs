import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{JSDOM}=require(process.env.JSDOM_MODULE||'jsdom');
const source=await readFile(new URL('../web/pdf-reader.js',import.meta.url),'utf8');
const css=await readFile(new URL('../web/pdf-reader.css',import.meta.url),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const plain=value=>JSON.parse(JSON.stringify(value));

async function fixture(t,{words=[[30,40,100,54,'Attention'],[110,40,150,54,'works.'],[30,70,44,84,'x'],[45,70,58,84,'='],[60,70,110,84,'value'],[120,70,180,84,'tokens'],[30,100,110,114,'中文'],[120,100,150,114,'2025']],measured=true,pages=8,image='iVBORw0KGgo=',appearance}={}){
 const dom=new JSDOM(`<style>${css}</style><div id="reader"></div>`,{runScripts:'outside-only',pretendToBeVisual:true,url:'http://synthetic.invalid/'}),{window:w}=dom,root=w.document.querySelector('#reader'),calls=[];
 Object.defineProperties(root,{clientWidth:{value:640},clientHeight:{value:500}});root.getBoundingClientRect=()=>({left:0,top:0,width:640,height:500,right:640,bottom:500});
 w.ResizeObserver=class{observe(){}disconnect(){}};w.HTMLImageElement.prototype.decode=async()=>{};
 const native=w.HTMLElement.prototype.getBoundingClientRect;
 w.HTMLElement.prototype.getBoundingClientRect=function(){if(this.matches('.pdr-word')){const [x,y,right,bottom]=JSON.parse(this.dataset.rect);return {left:x,top:y,width:right-x,height:bottom-y,right,bottom};}return native.call(this);};
 if(measured)w.Range.prototype.getBoundingClientRect=function(){const run=this.startContainer.nodeType===3?this.startContainer.parentNode:this.startContainer,scale=Number(/scaleX\(([^)]+)\)/.exec(run.style?.transform||'')?.[1]||1),length=this.startContainer.nodeType===3?this.endOffset-this.startOffset:run.textContent.length;return {width:length*6*scale,left:0,right:length*6*scale,top:0,bottom:12,height:12};};
 w.eval(source);
 const layout=Array.from({length:pages},(_,i)=>({page:i+1,width:400,height:600,rotation:0}));let paper={id:'synthetic',pdf:'synthetic.pdf'};
 const ui=w.PaperPDFReader.create({root,getPaper:()=>paper,api:async(action,args)=>{assert.equal(action,'page');calls.push(plain(args));return {page:args.page,width:400,height:600,page_count:pages,scale:1,image,words,annotations:[],internal_links:[{rect:[30,40,100,54],page:pages,to:[0,40]}],layout:{page_count:pages,pages:layout}};}});
 t.after(()=>{ui.dispose();w.close();});if(appearance)ui.setReadingAppearance(appearance);await ui.open({id:'synthetic',pdf:'synthetic.pdf'});await tick();
 return {w,root,ui,calls,open:async value=>{paper=value;return ui.open(paper);}};
}

test('reading appearance toggles do not split/copy duplicate text, move selection or request new PDF pages',async t=>{
 const f=await fixture(t),sheet=f.root.querySelector('.pdr-sheet[data-loaded="true"]'),runs=[...sheet.querySelectorAll('.pdf-word-text')],nodes=runs.map(run=>run.firstChild),text=sheet.querySelector('.pdr-word-layer').textContent,rects=[...sheet.querySelectorAll('.pdr-word')].map(s=>s.dataset.rect),before=f.calls.length;
 const range=f.w.document.createRange();range.setStart(nodes[0],1);range.setEnd(nodes[1],3);f.w.getSelection().addRange(range);const selected=f.w.getSelection().toString(),top=f.root.scrollTop;
 assert.deepEqual(plain(f.ui.setReadingAppearance({darkPdf:true,bionic:true})),{darkPdf:true,bionic:true});
 assert.equal(f.root.scrollTop,top);assert.equal(f.calls.length,before);assert.equal(f.w.getSelection().toString(),selected);
 assert.equal(sheet.querySelector('.pdr-word-layer').textContent,text);runs.forEach((run,i)=>{assert.equal(run.firstChild,nodes[i]);assert.equal(run.childNodes.length,1);});
 assert.deepEqual([...sheet.querySelectorAll('.pdr-word')].map(s=>s.dataset.rect),rects);
 const layer=sheet.querySelector('.pdr-bionic-layer');assert.ok(layer);assert.equal(layer.getAttribute('aria-hidden'),'true');assert.equal(layer.textContent,'');assert.equal(layer.dataset.bionicWords,'2','Formula line and non-English tokens stay unchanged');
 assert.equal(f.w.getComputedStyle(layer).pointerEvents,'none');assert.equal(f.w.getComputedStyle(layer).userSelect,'none');
 assert.equal(layer.querySelector('image').getAttribute('href'),sheet.querySelector('.pdr-page-image').src);assert.ok(layer.querySelector('feMorphology'));
 assert.equal(f.w.getComputedStyle(sheet.querySelector('.pdr-page-image')).filter,'invert(.9) hue-rotate(180deg)');
 assert.equal(sheet.querySelector('.pdr-internal-link').dataset.internalLink,'0');
 f.ui.setReadingAppearance({bionic:false});assert.equal(sheet.querySelector('.pdr-bionic-layer'),null);assert.ok(f.root.classList.contains('pdr-dark-pdf'));assert.equal(f.w.getSelection().toString(),selected);
 f.ui.setReadingAppearance({darkPdf:false});assert.equal(f.root.classList.contains('pdr-dark-pdf'),false);assert.equal(f.calls.length,before);
});

test('appearance set before opening survives virtual-page eviction, reload, zoom and document changes',async t=>{
 const f=await fixture(t,{appearance:{bionic:true,darkPdf:true}});assert.ok(f.root.querySelector('.pdr-bionic-layer'));await f.ui.goTo(8);await tick();
 assert.ok(f.root.querySelector('.pdr-sheet[data-pdf-page="8"] .pdr-bionic-layer'));
 assert.ok(f.ui.getSnapshot().residentPages.length<=3);await f.ui.goTo(1);await tick();
 const sheet=f.root.querySelector('.pdr-sheet[data-pdf-page="1"]');assert.ok(sheet.querySelector('.pdr-bionic-layer'));
 f.ui.setZoom(1.5);assert.equal(sheet.querySelectorAll('.pdr-bionic-layer').length,1);assert.ok(sheet.querySelector('.pdr-bionic-layer path').getAttribute('d').startsWith('M30.000 40H'));
 await f.open({id:'synthetic-two',pdf:'second.pdf'});await tick();assert.deepEqual(plain(f.ui.getReadingAppearance()),{darkPdf:true,bionic:true});assert.ok(f.root.querySelector('.pdr-bionic-layer'));
 f.ui.setReadingAppearance({bionic:false,darkPdf:false});assert.equal(f.root.querySelector('.pdr-bionic-layer'),null);
});

test('image-only pages and unmeasurable text never invent bionic overlays',async t=>{
 for(const options of [{words:[]},{measured:false}]){const f=await fixture(t,options);f.ui.setReadingAppearance({bionic:true,darkPdf:true});assert.equal(f.root.querySelector('.pdr-bionic-layer'),null);assert.ok(f.root.classList.contains('pdr-dark-pdf'));}
});

test('English prefix uses letters, preserves punctuation, and excludes formula tokens',async t=>{
 const f=await fixture(t),prefix=f.w.PaperPDFReader.bionicPrefix;
 assert.deepEqual(plain(prefix('Attention')),[0,5]);assert.deepEqual(plain(prefix('(reading),')),[1,5]);assert.deepEqual(plain(prefix("don't")),[0,2]);
 for(const token of ['AI','x','2025','中文','x=abc','R_i','sin','value²','a'.repeat(161)])assert.equal(prefix(token),null,token);
});

test('bionic raster visibly strengthens only the measured prefix pixels',async t=>{
 const {default:sharp}=await import('sharp');
 const marks=Array.from({length:9},(_,i)=>`<path d="M${32+i*7.5} 42V52" stroke="black" stroke-width="1"/>`).join('');
 const image=await sharp(Buffer.from(`<svg width="400" height="600"><rect width="400" height="600" fill="white"/>${marks}<rect x="230" y="100" width="80" height="80" fill="#135fac"/></svg>`)).png().toBuffer();
 const f=await fixture(t,{words:[[30,40,100,54,'Attention']],image:image.toString('base64'),pages:1});f.ui.setReadingAppearance({bionic:true});
 const overlay=f.root.querySelector('.pdr-bionic-layer'),radius=Number(overlay.querySelector('feMorphology').getAttribute('radius'));
 assert.ok(radius>0);overlay.setAttribute('width','400');overlay.setAttribute('height','600');
 const serialized=new f.w.XMLSerializer().serializeToString(overlay);
 const before=await sharp(image).removeAlpha().raw().toBuffer();
 const after=await sharp(image).composite([{input:Buffer.from(serialized)}]).removeAlpha().raw().toBuffer();
 let originalDark=0,bionicDark=0;
 for(let y=0;y<600;y++)for(let x=0;x<400;x++){
   const at=(y*400+x)*3,inside=x>=30&&x<69&&y>=40&&y<54;
   if(inside){if(before[at]<200)originalDark++;if(after[at]<200)bionicDark++;}
   else if(x<30||x>70||y<40||y>=54)assert.deepEqual(after.subarray(at,at+3),before.subarray(at,at+3),`unchanged outside prefix ${x},${y}`);
 }
 assert.ok(bionicDark>originalDark*1.2,`${originalDark} → ${bionicDark} dark pixels`);
});
