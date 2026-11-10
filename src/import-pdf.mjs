import { resolveDOIMetadata, resolveTitleMetadata } from './paper-fetch.mjs';

// Network metadata is data: never allow attachment paths or worker arguments to
// arrive from a publisher response. Only bibliographic fields can be imported.
const fields = ['type','title','author','editor','translator','issued','DOI','URL','abstract','container-title','collection-title','publisher','publisher-place','volume','issue','page','ISBN','ISSN','language','edition','number','event-title','event-place','archive','archive_location','publication_dates','journal_rankings'];
export function bibliographicMetadata(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return Object.fromEntries(fields.filter(key => raw[key] !== undefined && raw[key] !== null).map(key => [key,raw[key]]));
}
const normalize = value => String(value || '').normalize('NFKC').replace(/\u00ad/g,'').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();

/** A detected identifier can be a cited paper; require title evidence before enrichment. */
export function metadataMatchesPDF(metadata, inspection) {
  const title = normalize(metadata.title);
  if (title.length < 8) return false;
  if (inspection.parse?.field_sources?.title === 'filename-fallback') return false;
  const local = normalize(inspection.metadata?.title);
  // A reference, review paragraph, or filename is not document-title evidence.
  // Ambiguous/truncated titles remain reviewable rather than becoming verified.
  return local === title;
}

export async function importPDF(path, options, core, remote = {}) {
  const inspection = await core({action:'inspect_pdf',path},options);
  const warnings = [...(remote.warnings || [])];
  let metadata = {}, source, enrichment;
  const portable = inspection.parse?.portable_metadata;
  const local = inspection.metadata || {};
  const incomplete = !local.DOI || !local.author?.length || !local.issued?.['date-parts']?.[0]?.[0] || !local['container-title'];
  let identity = {status:portable?'preserved_portable_metadata':'not_checked'};
  if (!portable && remote.metadata?.title) {
    if (metadataMatchesPDF(remote.metadata,inspection)) {
      metadata = bibliographicMetadata(remote.metadata); source = remote.metadata_source || 'paper-fetch';
      identity = {status:'title_match',method:'parsed_title'};
    } else {
      identity = {status:'unmatched',method:'parsed_title'};
      warnings.push('下载页面的文献信息与 PDF 标题未能匹配；保留 PDF 本地解析结果，请核对资料。');
    }
  }
  if ((!portable || incomplete) && !source && !remote.metadata) {
    const candidates = inspection.doi_candidates || [];
    const doi = inspection.metadata?.DOI || (candidates.length === 1 ? candidates[0] : null);
    const titleLookup = !doi && normalize(local.title).length >= 8 && inspection.parse?.field_sources?.title !== 'filename-fallback';
    if (doi || titleLookup) {
      try {
        // One bounded public bibliographic lookup per import. Never send PDF
        // text, scan the library or delay import on unavailable services.
        const lookupOptions={...options.fetchOptions,signal:options.signal,timeoutMs:10000,crossrefOnly:true};
        const result = doi ? await resolveDOIMetadata(doi,lookupOptions) : await resolveTitleMetadata(local.title,lookupOptions);
        warnings.push(...(result.warnings || []));
        enrichment = {...result.provenance,status:result.metadata?'resolved':'unavailable',warnings:[...(result.warnings || [])]};
        if (result.metadata && metadataMatchesPDF(result.metadata,inspection)) {
          metadata = bibliographicMetadata(result.metadata); source = 'crossref';
          identity = {status:'title_match',method:'parsed_title'};
        } else {
          identity = {status:'unmatched',method:'parsed_title'};
          warnings.push(doi?'检测到 DOI，但未确认在线题名与 PDF 一致；资料保留为待核验。':'未找到唯一匹配题名的 DOI；已保留本地资料，可使用「补全资料」重试。');
        }
      } catch (error) {
        options.signal?.throwIfAborted();
        const detail = String(error?.message || error).slice(0,500);
        enrichment = {target:doi||local.title,fetched_at:new Date().toISOString(),requests:[],status:'unavailable',warnings:[detail]};
        warnings.push(detail);
        warnings.push('在线资料补全暂不可用；PDF 将按本地解析结果保存。');
      }
    }
  }
  const provenance = remote.provenance || enrichment ? {
    ...(remote.provenance || {kind:'local-pdf'}),
    validation:'pdf_parser',
    metadata_identity:identity,
    ...(enrichment?{enrichment}:{}),
    warnings:[...new Set(warnings)],
  } : undefined;
  if (provenance) metadata.acquisition = provenance;
  const result = await core({action:'import',path,...(Object.keys(metadata).length?{metadata,metadata_source:source || 'source-provenance',metadata_verified:Boolean(source)}:{})},options);
  result.warnings = [...(result.warnings || []),...warnings];
  if (remote.status) result.acquisition = {
    status:result.items?.some(item=>item.pdf)?'downloaded':'metadata_only',
    source_url:remote.provenance?.source_url,
    warnings,
    provenance,
  };
  return result;
}
