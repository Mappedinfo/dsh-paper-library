# Operation contract

Node `dispatch(request, options)` accepts JSON `{action,...arguments}`. Python worker receives one JSON request on stdin and emits `{ok:true,result}` or `{ok:false,error}`. Core receives `library` absolute directory from adapter, never browser payload. Node unwraps result and throws on failure. Browser POST `./api` receives the same envelope. All pages are ONE-BASED; rects are PDF points in page response coordinates.

Core actions:

- `status` → `{count,library,...}`
- `import` with `path` (PDF/directory/JSON/RIS/BIB) or `items` (CSL array), `limit=100,offset=0` → `{imported,duplicates,skipped?,items:[item],warnings:[],next_offset?,done?,total_records?,total_files?}`; Node resolves DOI and BibTeX before core. Repeat with `offset=next_offset` until `done`; partial progress is committed per record. Uploaded JSON/BibTeX use `filename,content_base64` and preserve the same offset contract.
- `list` with `query=''`, `limit=40`, `offset=0` → `{items,total,limit,offset}`
- `get` with `id` → item (CSL fields plus `id,title,citekey,tags,pdf` boolean, actual `pdf_filename`, `parse`, `acquisition` when available, and `page_count`)
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
- `import` with exactly one of `doi`, `url`, `path`, `items`, or `content_base64`. `url` accepts public HTTP(S), DOI and arXiv identifiers. A downloaded PDF is parsed before catalog insertion. Local PDFs use bounded inspection, optionally enrich from Crossref only after exact normalized parsed-title matching, and preserve portable user metadata. Results extend the core envelope with `acquisition:{status:'downloaded'|'metadata_only'|'reused',...}` and warnings. Always use `item.pdf` to determine whether a managed PDF exists. Metadata-only imports do not imply a saved full text.
- `ai_feedback` with `id,annotation_ids?,provider,model,reasoning_effort?` invokes Harness's existing LLM service and persists result; explicit error if unconfigured. The sidebar sends the current shared composer route at request time. Optional `session_id` is UI context attribution, not a server route resolver.

`POST ./upload?filename=<encoded.pdf>` receives a raw `application/pdf` body, streams into a private temporary directory and dispatches PDF import. Maximum 250 MiB, at most two active uploads, 180-second upload/import signal. Partial and completed temporary files are removed after handling. Same-origin and host authentication rules apply before reading the body. Legacy metadata uploads remain JSON Base64, with a 45 MiB encoded HTTP body limit and 32 MiB decoded file limit. At most two JSON requests are admitted before reading their bodies; excess requests receive HTTP429. Queued imports share a conservative 96 MiB UTF-16 payload budget and 50-item cap, including non-HTTP callers.

`inspect_pdf` is an internal worker operation, rejected by browser dispatch. It returns metadata candidates and bounded evidence from at most three pages / 30,000 text characters. Inspection text is ephemeral and not persisted. `parse.needs_review` remains true for incomplete or unverified identity. DOI/arXiv text candidates alone are not bibliographic authority. `acquisition.validation:'pdf_parser'` means readable bytes; separate `metadata_identity` records title matching. Local DOI lookup receipts are retained under `acquisition.enrichment`.

Public acquisition limits: default60-second total deadline, 15seconds/request, five redirects per request, 16 requests, eight PDF candidates, 2 MiB per text response, 250 MiB PDF. All redirects and requests revalidate public DNS and pin the validated address to the socket. Credentials, nonstandard ports, private/reserved IPs and redirects into them are rejected. No proxy, browser cookie, logged-in provider or external fetch runtime is implied. Crossref, arXiv and generic citation meta tags supply candidates; HTML with a PDF filename does not pass validation.

Managed filename: `author-year-title--id8.pdf`, bounded to 210 UTF-8 bytes; collisions use the full stable id. Metadata edits use a recovery journal when renaming a managed file. Attaching a PDF to an existing metadata-only item preserves its bibliography/citekey and merges actual PDF parse, source hash and acquisition evidence. Original imported files remain unchanged.

The plugin registers `skills/paper-library-fetch/SKILL.md` as `paper-library-fetch` with Harness's scoped skill registry, both model- and user-invocable. Its tools are the existing `library_import`, `library_get`, `library_cite`, `library_annotations` and `library_feedback`. It does not install or watch a global skills directory.

The parent pane publishes version1 `paper-library:context` messages containing `sessionId,provider,model,reasoningEffort,status`. Both sides require the exact counterpart window and same origin. The frame announces `paper-library:ready`; the parent subscribes to `modelDirectories.directoryFor(sessionId).store` and responds without reloading the frame on model changes. Loading/unavailable/cleanup states clear old routes; no configuration secrets cross this boundary.

UI relative base: embedded Harness `/api/paper-library/` POST `api` or `upload`; standalone `/` with the same relative routes. Download GET `pdf/<encoded item id>`. Static `app.js,style.css,index.html`. No external fonts/CDNs or client PDF worker.
