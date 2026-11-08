import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveResourcePolicy,resourcePolicyFor,RESOURCE_DEFAULTS,RESOURCE_PROFILES} from '../src/resource-policy.mjs';

test('resource profiles separate memory targets, cache allocations and disk budgets',()=>{
 for(const [profile,memory]of [['eco',256],['balanced',512],['performance',1024]]){const p=resolveResourcePolicy({resource_profile:profile});assert.equal(p.memory_target_mb,memory);assert.equal(p.memory_hard_limit,false);assert.ok(p.preview_bytes<=memory*1048576/4);assert.equal(p.batch_pages,RESOURCE_PROFILES[profile].values.resource_batch_pages);}
 assert.equal(resolveResourcePolicy().profile,'balanced');assert.equal(resolveResourcePolicy().library_index_limit_bytes,1024*1048576);
 const custom=resolveResourcePolicy({...RESOURCE_DEFAULTS,resource_profile:'custom',resource_memory_mb:128,resource_preview_mb:32,resource_batch_pages:6});assert.equal(custom.source_limit_bytes,32*1048576);assert.equal(custom.image_pixels,128*32768);assert.equal(custom.batch_pages,6);
 for(const patch of [{resource_memory_mb:127},{resource_preview_mb:257},{resource_batch_pages:0},{resource_batch_gap_ms:249},{resource_profile:'custom',resource_memory_mb:128,resource_preview_mb:33},{resource_profile:'custom',resource_paper_index_mb:512,resource_library_index_mb:64}])assert.throws(()=>resolveResourcePolicy(patch));
});

test('resource settings cache coalesces reads and invalidates on host changes',async()=>{let reads=0,listener,profile='balanced';const settings={async get(){reads++;return {value:{resource_profile:profile}};},subscribe(fn){listener=fn;}};const [a,b]=await Promise.all([resourcePolicyFor({settings}),resourcePolicyFor({settings})]);assert.equal(reads,1);assert.equal(a,b);assert.equal((await resourcePolicyFor({settings})).memory_target_mb,512);assert.equal(reads,1);profile='performance';listener();assert.equal((await resourcePolicyFor({settings})).memory_target_mb,1024);assert.equal(reads,2);});
