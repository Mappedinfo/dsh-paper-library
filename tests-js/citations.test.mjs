import test from 'node:test';
import assert from 'node:assert/strict';
import { cite, parseBibtex, safeCitationHtml } from '../src/citations.mjs';

// Fictional split names retain the initials and multi-author formatting checks.
const article={id:'paper-1',citekey:'LearningNotes2020',type:'article-journal',title:'How to revise a reading note',author:[{family:'Example',given:'Reader A.'},{family:'Demo',given:'Learning B.'}],issued:{'date-parts':[[2020]]},'container-title':'Learning Methods Examples',volume:'12',issue:'3',page:'10-19',DOI:'10.5555/example'};
test('APA uses official style: initials, date, journal/volume italics and DOI',async()=>{
  const result=await cite([article]);
  assert.match(result.text,/Example, R\. A\., & Demo, L\. B\. \(2020\)\./);
  assert.match(result.text,/Learning Methods Examples, 12\(3\), 10–19/);
  assert.match(result.text,/https:\/\/doi\.org\/10\.5555\/example/);
  assert.match(result.html,/<i>Learning Methods Examples<\/i>/);
});
test('BibLaTeX roundtrip keeps citekey, names and DOI',async()=>{
  const result=await cite([{...article,citekey:'custom-key:2020'}],'biblatex');
  assert.match(result.text,/@article\{custom-key:2020,/i);
  const [item]=await parseBibtex(result.text);
  assert.equal(item.citekey,'custom-key:2020');
  assert.equal(item.DOI,article.DOI);
  assert.equal(item.author[0].family,'Example');
  assert.equal(item.author[1].family,'Demo');
});
test('CSL handles missing dates and 21 authors using APA ellipsis rule',async()=>{
  const item={...article,issued:undefined,author:Array.from({length:21},(_,i)=>({family:`Author${i+1}`,given:'First'}))};
  const result=await cite([item]);
  assert.match(result.text,/n\.d\./);
  assert.match(result.text,/Author21/);
  assert.doesNotMatch(result.text,/Author20/);
});
test('clipboard HTML never carries source event handlers or scripts',()=>{
  assert.equal(safeCitationHtml('<div class="csl-entry"><script>alert(1)</script><img src=x onerror=x><i onclick=x>Title</i></div>'),'<div><i>Title</i></div>');
});
