/** Display translations never change source records, grouping, filters or numeric values. */
const nonEnglishScript = /[\u3000-\u303f\u3400-\u9fff\uf900-\ufaff\uff00-\uffef\u3040-\u30ff\uac00-\ud7af]/u;
export function validateRadarTranslations(doc) {
  if(doc.translations==null)return;
  if(typeof doc.translations!=='object'||Array.isArray(doc.translations))throw Error('translations must be a language map');
  for(const [language,section] of Object.entries(doc.translations)){
    if(!['zh','en'].includes(language)||!section||typeof section!=='object'||Array.isArray(section))throw Error('Supported translation languages are zh and en');
    const labels=section.labels??{};
    if(!labels||typeof labels!=='object'||Array.isArray(labels)||Object.keys(labels).length>3000)throw Error('Translation labels must be a map of at most 3000 entries');
    for(const [original,value]of Object.entries(labels))if(!original||original.length>16000||typeof value!=='string'||!value.trim()||value.length>20000||language==='en'&&nonEnglishScript.test(value))throw Error('English display translations must be nonempty English text; preserve original evidence separately');
  }
}
export function createRadarLocale(doc,language='zh'){
  if(!['zh','en'].includes(language))throw Error('Unsupported chart language');
  const dictionary=doc.translations?.[language]?.labels??{}, missing=new Set(),english=language==='en';
  const ui=(zh,en)=>english?en:zh;
  function content(value,fallback='Translation unavailable'){
    if(value==null)return '';
    if(Array.isArray(value))return value.map(v=>content(v,fallback)).filter(Boolean).join(' · ');
    if(typeof value==='object')return Object.entries(value).filter(([key])=>!key.endsWith('_ids')).map(([key,v])=>`${content(key)}: ${content(v,fallback)}`).join(' · ');
    const text=String(value),builtins={'未分类 / 未核验':'Unclassified / unverified','未知年份':'Unknown year','其余类别':'Other categories'},translated=Object.hasOwn(dictionary,text)?dictionary[text]:english?builtins[text]:null;
    if(translated!=null&&(!english||!nonEnglishScript.test(translated)))return translated;
    if(!english||!nonEnglishScript.test(text))return text;
    missing.add(text);
    return nonEnglishScript.test(fallback)?'Translation unavailable':fallback;
  }
  function report(){return{language,translation_missing:missing.size,translation_missing_originals:[...missing]};}
  function warning(){return missing.size?ui(`有 ${missing.size} 个显示标签缺少当前语言译文。`,`${missing.size} display labels lack English translations; neutral labels are shown. Original evidence is preserved.`):null;}
  return {language,english,ui,content,report,warning};
}
