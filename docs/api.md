# Operation contract

Node `dispatch(request, options)` accepts JSON `{action,...arguments}`. Python worker receives one JSON request on stdin and emits `{ok:true,result}` or `{ok:false,error}`. Core receives `library` absolute directory from adapter, never browser payload. Node unwraps result and throws on failure. Browser POST `./api` receives the same envelope. All pages are ONE-BASED; rects are PDF points in page response coordinates.

Core actions:

- `status` → `{count,library,...}`; the HTTP carrier adds `paper_conversations:boolean` to report native-conversation availability
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
- `save_conversation_feedback` with `id,text,model,annotation_ids:[],source_session_id,source_message_id,page=1` → standard PDF note containing the native assistant reply and provenance. Requires an attached PDF and 1–28,000 text characters. Session and message identifiers must be 1–200 characters without control characters. Duplicate source Session/message pairs return the existing note without rewriting the PDF or its backup. The return includes `annotation_id,page,kind:'ai-feedback',model,annotation_ids:[],source_kind:'dsh-conversation',source_session_id,source_message_id,generated,comment,duplicate`; the reply body is in `comment`, while `text` retains its ordinary selected-PDF-text meaning. Internal worker operation: call through the verified native-conversation adapter, never browser JSON.
- `feedback` with `id` → `{feedback:[...]}`

Node additions:

- `cite` with `ids:[...],format='apa'|'biblatex'|'csl-json'` → `{text,html?,filename,mime}`
- `export_library` with `format='biblatex'|'csl-json'` → `{text,filename,mime,count}`; consistent metadata snapshot, citation formatter batches100 in short-lived processes, max10000 records
- `import` with exactly one of `doi`, `url`, `path`, `items`, or `content_base64`. `url` accepts public HTTP(S), DOI and arXiv identifiers. A downloaded PDF is parsed before catalog insertion. Local PDFs use bounded inspection, optionally enrich from Crossref only after exact normalized parsed-title matching, and preserve portable user metadata. Results extend the core envelope with `acquisition:{status:'downloaded'|'metadata_only'|'reused',...}` and warnings. Always use `item.pdf` to determine whether a managed PDF exists. Metadata-only imports do not imply a saved full text.
- `ai_feedback` with `id,annotation_ids?,provider,model,reasoning_effort?` is the compatibility path for independent annotation feedback. It invokes the configured LLM service and persists a complete result after checking the annotation snapshot; it does not create or continue a native conversation. Optional `session_id` is attribution, not a server route resolver. The installed Harness reader uses the `chat_*` operations below for its conversation workflow.

## Native paper conversations

The authenticated Harness HTTP carrier routes `chat_*` requests to `options.paperChat(input,{signal})`, separate from the generic Node `dispatch`. Standalone HTTP returns an explicit unavailable error for these operations. Browser requests cannot select a deployment directory, submit an arbitrary native Session ID for sending, or provide the text to be saved as an AI reply.

Every operation requires the catalog paper `id`. A stable native Session ID is derived from the canonical library directory and paper ID; distinct papers and libraries remain separate. Opening a paper creates its Session on demand through `sessions.prepare` and the public `sessionPersistence` handle, then attaches it to the library Workspace. The Session remains cold: no Agent or model request starts. Importing a batch does not create Sessions. Persistence failures propagate; only a definite absence permits recreation under the same identity. Archived Sessions return an error and are not replaced. Moving a library directory currently changes the derived identity.

After the first log is flushed and its handle closed, the adapter optionally calls public `sessionProjectionCache.write(prepared)` so native lists can read the durable title and blank-state hints without loading the Session. A cache failure is nonfatal. This does not change Harness's zero-turn semantics: noncurrent empty Sessions are hidden, the selected empty Session displays “New Session”, and its main header stays hidden until the first prompt. “Open main conversation” can select the stored identity throughout. The plugin does not manufacture a turn to change those native UI rules.

`source_session_id?` may identify the current Harness conversation during first creation. The adapter reads only that live Session's public model projection, taking its pending selection or last-used route; without one it uses `agentDefaultModel.currentSelection()`. The choice is persisted once as `model/selection` before Agent activation. Reusing the paper Session preserves its own selection. The adapter never calls `selectModel` or changes the global default; caller-supplied `provider` and `model` do not override native routing.

| Action | Input beyond `id` | Result |
|---|---|---|
| `chat_ensure` | `source_session_id?` | `{sessionId,created,title,model?,modelSource:'harness-session'}` |
| `chat_context` | `annotation_ids?,question?,selection?:{page,text}` | Session fields plus `{text,annotation_ids,context_hash}`; prepares a prompt without submitting it |
| `chat_send` | Context fields plus required `request_id` | Context/session fields plus `{requestId,accepted:true}` after the native prompt is accepted |
| `chat_history` | No additional input | Session fields plus `{messages,running,queued,hasMore,outcome?}` |
| `chat_save_feedback` | Required `message_id` from this paper's history | Session fields plus `{saved,messageId}`; `saved` is the portable PDF note described above |

`chat_context` accepts up to 40 annotation IDs, a question of at most 4,000 characters and a selection of at most 8,000 characters with a real one-based page within the attached PDF. Source annotations are read from the PDF and bounded to 40 entries / 12,000 text-and-comment characters. Omit `annotation_ids` to include available source annotations; an empty array explicitly omits them. A request must have a question, selection or source annotation. The prompt uses readable Markdown with the paper title, citation key, real pages and annotation identifiers. Quotes and reader comments remain visibly separated source material, with a brief instruction to treat them as untrusted data and distinguish them from the reader's question. It does not supply the whole PDF. `context_hash` is the selected annotation digest or `null` when none are included.

`chat_send` uses `sessionController.prompt(...,mode:'queue')`. Each paper's operations are serialized, with at most 32 admitted adapter requests. The native request identity is derived from the paper Session ID and caller `request_id`; retry the same logical submission with the same ID. Harness deduplicates an ID already in its inbox or durable user history. Acceptance means the message entered the native queue, not that an answer has completed. The adapter flushes the attached Session after admission. Tool use, permission requests, cancellation and model selection continue through Harness's normal conversation controls.

`chat_history` reads one `follow` opening snapshot, then aborts and closes the iterator before cold-Session promotion. The read has a 20-second deadline. It returns up to 20 committed human/assistant text messages, at most 6,000 characters each and 48,000 total. Message rows use `{id,role,text,interrupted?,model?,truncated?}`, where `id` is the durable event sequence as a string. It excludes system/plugin instructions, reasoning blocks, tool output and uncommitted token streams. `hasMore` reports omitted older messages; `outcome` may carry the latest native turn result such as `completed`, `error` or `aborted`. The visible inline view refreshes every four seconds and stops when hidden. Opening the main conversation or sending a prompt may activate a native Agent; the plugin does not own or dispose that Agent.

`chat_save_feedback` resolves `message_id` against this paper's current bounded native history, requires a completed, non-interrupted `assistant/message`, and reads its actual text server-side. Browser text, model labels and annotation associations are ignored. The PDF note goes on page 1, records Session/message provenance and uses `annotation_ids:[]`; the adapter does not guess which earlier annotation a later answer addresses. When the generating model header is absent from the current window, the saved label states that the model is unavailable rather than attributing the current model to an older answer. Replies outside the current history window, empty text and replies exceeding 28,000 characters are rejected. Full conversation history remains in Harness.

## Import and browser transport

`POST ./upload?filename=<encoded.pdf>` receives a raw `application/pdf` body, streams into a private temporary directory and dispatches PDF import. Maximum 250 MiB, at most two active uploads, 180-second upload/import signal. Partial and completed temporary files are removed after handling. Same-origin and host authentication rules apply before reading the body. Legacy metadata uploads remain JSON Base64, with a 45 MiB encoded HTTP body limit and 32 MiB decoded file limit. At most two JSON requests are admitted before reading their bodies; excess requests receive HTTP429. Queued imports share a conservative 96 MiB UTF-16 payload budget and 50-item cap, including non-HTTP callers.

`inspect_pdf` is an internal worker operation, rejected by browser dispatch. It returns metadata candidates and bounded evidence from at most three pages / 30,000 text characters. Inspection text is ephemeral and not persisted. `parse.needs_review` remains true for incomplete or unverified identity. DOI/arXiv text candidates alone are not bibliographic authority. `acquisition.validation:'pdf_parser'` means readable bytes; separate `metadata_identity` records title matching. Local DOI lookup receipts are retained under `acquisition.enrichment`.

Public acquisition limits: default60-second total deadline, 15seconds/request, five redirects per request, 16 requests, eight PDF candidates, 2 MiB per text response, 250 MiB PDF. All redirects and requests revalidate public DNS and pin the validated address to the socket. Credentials, nonstandard ports, private/reserved IPs and redirects into them are rejected. No proxy, browser cookie, logged-in provider or external fetch runtime is implied. Crossref, arXiv and generic citation meta tags supply candidates; HTML with a PDF filename does not pass validation.

Managed filename: `author-year-title--id8.pdf`, bounded to 210 UTF-8 bytes; collisions use the full stable id. Metadata edits use a recovery journal when renaming a managed file. Attaching a PDF to an existing metadata-only item preserves its bibliography/citekey and merges actual PDF parse, source hash and acquisition evidence. Original imported files remain unchanged.

The plugin registers `skills/paper-library-fetch/SKILL.md` as `paper-library-fetch` with Harness's scoped skill registry, both model- and user-invocable. Its tools are the existing `library_import`, `library_get`, `library_cite`, `library_annotations` and `library_feedback`. It does not install or watch a global skills directory.

The parent pane publishes version1 `paper-library:context` messages containing `sessionId,provider,model,reasoningEffort,status`. Both sides require the exact counterpart window and same origin. The frame announces `paper-library:ready`; the parent subscribes to the public model directory. This supplies first-creation context and the compatibility route, while an existing paper conversation's model remains authoritative for `chat_send`.

The version1 `paper-library:conversation-action` / `paper-library:conversation-result` exchange handles explicit `open`, `draft` and list `refresh` actions. The parent accepts only registered same-origin frame windows. `draft` opens the paper's main conversation and appends text through Harness's revision-guarded input event, preserving existing text, reference chips and attachments. Busy or blocked composers refuse the edit and retain the draft. No prompt is sent by draft preparation. A root-owned reader snapshot preserves paper/page/tab and text drafts across the Session-keyed sidebar remount; it is capped at 64 KiB and excludes rendered PDF images. No credentials cross either frame protocol.

UI relative base: embedded Harness `/api/paper-library/` POST `api` or `upload`; standalone `/` with the same relative routes. Download GET `pdf/<encoded item id>`. Static `app.js,paper-chat.js,style.css,index.html`. No external fonts/CDNs or client PDF worker.
