import { cite, parseBibtex } from './citations.mjs';

try {
  let input='';
  for await(const chunk of process.stdin) {
    input+=chunk;
    if(input.length>24*1024*1024) throw new Error('Citation request exceeds 24 MB');
  }
  const request=JSON.parse(input);
  let result;
  if(request.action==='cite') result=await cite(request.items,request.format);
  else if(request.action==='parse') result=await parseBibtex(request.text);
  else if(request.action==='latex-citation-check') {
    result=[];
    for(const {path,text} of request.resources) {
      let entries;
      try { entries=await parseBibtex(text); }
      catch { throw new Error(`无法解析书目「${path}」。请修正 BibTeX 语法后重试。`); }
      for(const item of entries) {
        if(item.citekey.toLowerCase()!==request.citekey.toLowerCase())continue;
        result.push({path,citekey:item.citekey,title:item.title,DOI:item.DOI,author:item.author?.slice(0,1)});
      }
    }
  }
  else throw new Error('Unknown citation operation');
  process.stdout.write(JSON.stringify({ok:true,result})+'\n');
} catch(error) {
  process.stdout.write(JSON.stringify({ok:false,error:error.message})+'\n');
  process.exitCode=1;
}
