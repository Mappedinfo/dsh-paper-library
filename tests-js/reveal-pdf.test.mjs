import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { revealPDF } from '../src/reveal-pdf.mjs';

test('file managers receive the exact catalog path as an argument, without shell interpretation', async t => {
  const root=await mkdtemp(join(tmpdir(),'paper-reveal-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const path=join(root,'synthetic $(echo unsafe) space.pdf');await writeFile(path,'%PDF-synthetic');
  for(const [platform,command,args] of [['darwin','open',['-R',path]],['win32','explorer.exe',[`/select,${path}`]],['linux','xdg-open',[root]]]){
    const calls=[];const result=await revealPDF(path,{platform,run:async(...values)=>calls.push(values)});
    assert.equal(result.opened,true);assert.equal(calls[0][0],command);assert.deepEqual(calls[0][1],args);assert.equal(calls[0][2].shell,undefined);assert.equal(calls[0][2].timeout,5000);
  }
  await assert.rejects(revealPDF(path,{platform:'darwin',run:async()=>{throw Error('no desktop')}}),/桌面环境/);
  await assert.rejects(revealPDF(root),/PDF 文件不存在/);
  await assert.rejects(revealPDF('relative.pdf'),/PDF 文件不存在/);
  await assert.rejects(revealPDF(path,{platform:'unsupported'}),/不支持/);
});
