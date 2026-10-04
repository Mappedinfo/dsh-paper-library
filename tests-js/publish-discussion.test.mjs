import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile, chmod, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, delimiter} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';

// Run the real CLI in an isolated cwd with a fake gh executable. The fake has
// no network transport; every attempted GitHub operation is recorded for checks.
const script=fileURLToPath(new URL('../scripts/publish-discussion.mjs',import.meta.url));
const hash=value=>createHash('sha256').update(value).digest('hex');
const imagePath='docs/images/synthetic.jpg', image='synthetic-image';
const oldBody=`非官方项目\nOriginal content\nhttps://example.invalid/main/${imagePath}\n`;
const newBody=`非官方项目\nUpdated content\nhttps://example.invalid/main/${imagePath}\n`;
const title='DSH | Paper Library | Updated synthetic showcase';
const oldTitle='DSH | Paper Library | Original synthetic showcase';
const original={id:'discussion-one',number:6623,title:oldTitle,body:oldBody,url:'https://github.com/example/upstream/discussions/6623',author:{login:'owner'},category:{id:'category-one',name:'Plugins'},repository:{id:'repository-one',nameWithOwner:'example/upstream'},createdAt:'2026-09-14T00:00:00Z',updatedAt:'2026-09-14T00:00:00Z'};
const verified={ok:true,id:original.id,number:original.number,title:oldTitle,author:'owner',verifiedAt:'2026-09-14T00:00:01Z',bodySha256:hash(oldBody)};
const fakeGh=`#!${process.execPath}
const fs=require('node:fs');
const path='mock-github.json',state=JSON.parse(fs.readFileSync(path,'utf8'));
const args=process.argv.slice(2),save=()=>fs.writeFileSync(path,JSON.stringify(state));
if(args[0]!=='api')throw Error('Unexpected gh command');
if(args[1]!=='graphql'){
  state.calls.push({kind:'image',path:args[1]});save();
  console.log(JSON.stringify({encoding:'base64',content:Buffer.from(state.image).toString('base64')}));
}else{
  const {query,variables}=JSON.parse(fs.readFileSync(0,'utf8'));
  state.calls.push({kind:'graphql',query,variables});
  let data;
  if(query.includes('viewer {'))data={viewer:{login:state.viewer}};
  else if(query.includes('search(query:')){const nodes=state.searchNodes??(state.node?[state.node]:[]);data={search:{discussionCount:nodes.length,nodes}};}
  else if(query.includes('updateDiscussion(input:')){
    state.mutations.push({kind:'update',input:variables.input});
    state.node={...state.node,title:variables.input.title,body:variables.input.body,updatedAt:'2026-10-04T00:00:00Z'};
    if(state.failUpdateAck){state.failUpdateAck=false;save();process.exit(2);}
    data={updateDiscussion:{discussion:{id:state.node.id}}};
  }else if(query.includes('createDiscussion(input:')){
    state.mutations.push({kind:'create',input:variables.input});
    state.node={...state.template,title:variables.input.title,body:variables.input.body};
    data={createDiscussion:{discussion:{id:state.node.id}}};
  }else if(query.includes('node(id:')){
    state.nodeReads=(state.nodeReads||0)+1;
    if(state.failReadback&&state.nodeReads>1){state.failReadback=false;save();process.exit(2);}
    data={node:state.nodeReads>1&&state.readbackOverride?{...state.node,...state.readbackOverride}:state.node};
  }else throw Error('Unexpected GraphQL request');
  save();console.log(JSON.stringify({data}));
}
`;

async function fixture(t,{receipt=verified,node=original,body=newBody,configTitle=title,...mock}={}){
  const cwd=await mkdtemp(join(tmpdir(),'paper-discussion-'));
  t.after(()=>rm(cwd,{recursive:true,force:true}));
  await Promise.all([mkdir(join(cwd,'docs/community'),{recursive:true}),mkdir(join(cwd,'docs/images'),{recursive:true}),mkdir(join(cwd,'bin'))]);
  const config={repository:'example/upstream',repositoryId:'repository-one',categoryId:'category-one',title:configTitle,bodyFile:'docs/community/showcase.md',images:[imagePath]};
  await Promise.all([
    writeFile(join(cwd,'docs/community/showcase.json'),JSON.stringify(config)),
    writeFile(join(cwd,'docs/community/showcase.md'),body),writeFile(join(cwd,imagePath),image),
    writeFile(join(cwd,'mock-github.json'),JSON.stringify({viewer:'owner',node,template:original,image,calls:[],mutations:[],...mock})),
    writeFile(join(cwd,'bin/gh'),fakeGh),
    ...(receipt?[writeFile(join(cwd,'docs/community/discussion.json'),JSON.stringify(receipt))]:[]),
  ]);
  await chmod(join(cwd,'bin/gh'),0o755);
  return {
    run:(...args)=>spawnSync(process.execPath,[script,...args],{cwd,env:{...process.env,PATH:`${join(cwd,'bin')}${delimiter}${process.env.PATH}`},encoding:'utf8'}),
    state:async()=>JSON.parse(await readFile(join(cwd,'mock-github.json'),'utf8')),
    receipt:async()=>JSON.parse(await readFile(join(cwd,'docs/community/discussion.json'),'utf8')),
  };
}

test('--update changes only the verified identity, preserves immutable fields and reads back before recording success',async t=>{
  const f=await fixture(t,{node:{...original,body:oldBody.replace(/\n/g,'\r\n')+'\r\n'}}),r=f.run('--update');
  assert.equal(r.status,0,r.stderr);
  const state=await f.state(),receipt=await f.receipt();
  assert.deepEqual(state.mutations,[{kind:'update',input:{discussionId:original.id,title,body:newBody}}]);
  assert.equal(state.nodeReads,2);assert.ok(state.calls.findIndex(c=>c.query?.includes('node(id:'))<state.calls.findIndex(c=>c.query?.includes('updateDiscussion(input:')));
  assert.equal(receipt.mode,'updated');assert.equal(receipt.id,original.id);assert.equal(receipt.repositoryId,original.repository.id);assert.equal(receipt.categoryId,original.category.id);
  assert.equal(receipt.bodyHashNormalization,'lf-trim-end');assert.equal(receipt.bodySha256,hash(newBody.trimEnd()));
  assert.equal(f.run('--verify').status,0);assert.equal((await f.state()).mutations.length,1);
});

for(const [name,patch] of [
  ['identity',{id:'wrong-id'}],['number',{number:99}],['author',{author:{login:'other'}}],
  ['repository ID',{repository:{...original.repository,id:'other-repository'}}],
  ['repository name',{repository:{...original.repository,nameWithOwner:'other/upstream'}}],
  ['category',{category:{id:'other-category',name:'Other'}}],
])test(`--update refuses a changed ${name} before any mutation`,async t=>{
  const f=await fixture(t,{node:{...original,...patch},searchNodes:[{id:original.id,title:oldTitle}]}),r=f.run('--update');
  assert.notEqual(r.status,0);assert.equal((await f.state()).mutations.length,0);assert.deepEqual(await f.receipt(),verified);
});

for(const [name,patch] of [['body',{body:oldBody+'Remote edit'}],['title',{title:'DSH | Paper Library | Remote title'}]])
  test(`--update refuses a stale remote ${name} and preserves the prior receipt`,async t=>{
    const f=await fixture(t,{node:{...original,...patch}}),r=f.run('--update');
    assert.notEqual(r.status,0);assert.match(r.stderr,/changed since the last verified receipt/);
    assert.equal((await f.state()).mutations.length,0);assert.deepEqual(await f.receipt(),verified);
  });

test('--update cannot create from search results or an unverified pending receipt',async t=>{
  for(const receipt of [null,{id:original.id,author:'owner',status:'created_pending_readback'}]){
    const f=await fixture(t,{receipt}),r=f.run('--update');
    assert.notEqual(r.status,0);assert.match(r.stderr,/requires an existing verified/);assert.equal((await f.state()).mutations.length,0);
  }
});

test('--update refuses conflicting duplicate search results and unpublished screenshot bytes',async t=>{
  for(const options of [{searchNodes:[original,{...original,id:'duplicate'}]},{image:'different remote bytes'}]){
    const f=await fixture(t,options),r=f.run('--update');assert.notEqual(r.status,0);assert.equal((await f.state()).mutations.length,0);
  }
});

test('an uncertain update or readback can be retried without a second mutation',async t=>{
  for(const option of ['failUpdateAck','failReadback']){
    const f=await fixture(t,{[option]:true}),first=f.run('--update');
    assert.notEqual(first.status,0);assert.deepEqual(await f.receipt(),verified);
    const retry=f.run('--update');assert.equal(retry.status,0,retry.stderr);
    assert.equal((await f.state()).mutations.length,1);assert.equal((await f.receipt()).mode,'existing');
  }
});

test('a changed readback cannot replace the last verified receipt',async t=>{
  const f=await fixture(t,{readbackOverride:{body:'Changed during update'}}),r=f.run('--update');
  assert.notEqual(r.status,0);assert.match(r.stderr,/Remote body differs/);assert.equal((await f.state()).mutations.length,1);assert.deepEqual(await f.receipt(),verified);
});

test('--publish still creates only when missing, and never updates an existing changed post',async t=>{
  const existing=await fixture(t),refused=existing.run('--publish');
  assert.notEqual(refused.status,0);assert.equal((await existing.state()).mutations.length,0);
  const missing=await fixture(t,{receipt:null,node:null}),preflight=missing.run();
  assert.equal(preflight.status,0,preflight.stderr);assert.equal((await missing.state()).mutations.length,0);
  const published=missing.run('--publish');assert.equal(published.status,0,published.stderr);
  assert.equal((await missing.state()).mutations[0].kind,'create');assert.equal((await missing.receipt()).mode,'published');
  assert.equal(missing.run('--publish').status,0);assert.equal((await missing.state()).mutations.length,1);
});

test('mutating and verification modes cannot be combined',async t=>{
  const f=await fixture(t),r=f.run('--update','--publish');assert.notEqual(r.status,0);assert.equal((await f.state()).calls.length,0);
});
