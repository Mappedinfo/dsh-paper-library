# Operation contract

Node `dispatch(request, options)` accepts JSON `{action,...arguments}`. Python worker receives one JSON request on stdin and emits `{ok:true,result}` or `{ok:false,error}`. Core receives `library` absolute directory from adapter, never browser payload. Node unwraps result and throws on failure. Browser POST `./api` receives the same envelope. All pages are ONE-BASED; rects are PDF points in page response coordinates.

Core actions:

- `status` → `{count,library,...}`
- `import` with `path` (PDF/directory/JSON/RIS/BIB) or `items` (CSL array), `limit=100,offset=0` → `{imported,duplicates,skipped?,items:[item],warnings:[],next_offset?,done?,total_records?,total_files?}`; Node resolves DOI and BibTeX before core. Repeat with `offset=next_offset` until `done`; partial progress is committed per record. Uploaded JSON/BibTeX use `filename,content_base64` and preserve the same offset contract.
- `list` with `query=''`, `limit=40`, `offset=0` → `{items,total,limit,offset}`
- `get` with `id` → item (CSL fields plus `id,title,citekey,tags,pdf` boolean and `page_count` if available)
- `update` with `id,metadata` → item
- `attach` with `id,path` → item; copy into managed storage
- `page` with `id,page=1,scale=1.25` → `{page,page_count,width,height,image:<base64 PNG>,words:[[x0,y0,x1,y1,text,...]],annotations:[annotation]}`
- `annotations` with `id` → `{annotations:[{id,page,type,text,comment,author,rect,rects?,created,modified,...}]}`
- `annotate` with `id,page,type='highlight'|'note',rects=[[x0,y0,x1,y1],...],text,comment,author='Reader',color='#ffdb66'` → `{annotation,...}`
- `annotation_update` with `id,annotation_id,comment` → `{annotation}`
- `annotation_delete` with `id,annotation_id` → `{deleted:true}`
- `export_annotations` with `id,format='xfdf'|'json'|'markdown'` → `{text,filename,mime}`
- `export_pdf` with `id` → `{path,filename}` (Node streams managed path, not browser-supplied path)
- `link` with `source,target,relation='related'|'supports'|'contradicts'|'cites',note=''` → link
- `graph` with `id?,limit=80` → `{nodes:[{id,label,type:'paper'|'tag'}],edges:[{source,target,relation,provenance}],truncated}`
- `feedback_context` with `id,annotation_ids?` → `{item,annotations,prompt,context_hash}`; bounded source context, source treated as untrusted data
- `save_feedback` with `id,text,model,annotation_ids,expected_context_hash?` → AI-labelled standard PDF note for attached papers; digest checked inside write lock when supplied. Internal adapter operation, not browser-callable.
- `feedback` with `id` → `{feedback:[...]}`

Node additions:

- `cite` with `ids:[...],format='apa'|'biblatex'|'csl-json'` → `{text,html?,filename,mime}`
- `export_library` with `format='biblatex'|'csl-json'` → `{text,filename,mime,count}`; consistent metadata snapshot, citation formatter batches100 in short-lived processes, max10000 records
- `import` with `doi` resolves official Crossref CSL metadata, then core import
- `ai_feedback` with `id,annotation_ids?,provider,model,reasoning_effort?` invokes Harness's existing LLM service and persists result; explicit error if unconfigured. The sidebar sends the current shared composer route at request time. Optional `session_id` is UI context attribution, not a server route resolver.

The parent pane publishes version1 `paper-library:context` messages containing `sessionId,provider,model,reasoningEffort,status`. Both sides require the exact counterpart window and same origin. The frame announces `paper-library:ready`; the parent subscribes to `modelDirectories.directoryFor(sessionId).store` and responds without reloading the frame on model changes. Loading/unavailable/cleanup states clear old routes; no configuration secrets cross this boundary.

UI relative base: embedded Harness `/api/paper-library/` POST `api`; standalone `/` POST `api`. Download GET `pdf/<encoded item id>`. Static `app.js,style.css,index.html`. No external fonts/CDNs or client PDF worker.
