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
  else throw new Error('Unknown citation operation');
  process.stdout.write(JSON.stringify({ok:true,result})+'\n');
} catch(error) {
  process.stdout.write(JSON.stringify({ok:false,error:error.message})+'\n');
  process.exitCode=1;
}
