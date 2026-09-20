import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bundledFetchSkill, bundledLibrarySkills, registerBundledSkills } from '../src/harness/skills.mjs';

const harness=resolve(process.env.DSH_CHECKOUT || '../../deepseek-ai/deepseek-harness');
const skillPath=fileURLToPath(new URL('../skills/paper-library-fetch/SKILL.md',import.meta.url));
const skillDirectory=fileURLToPath(new URL('../skills/paper-library-fetch/',import.meta.url));
test('bundled paper-library-fetch skill is discoverable and loadable through the actual Harness registry',{skip:!existsSync(join(harness,'packages/skill/skill/lib/index.js'))},async()=>{
  const {Context}=await import(pathToFileURL(join(harness,'vendor/cordis/lib/index.js')));
  const {default:SkillRegistry}=await import(pathToFileURL(join(harness,'packages/skill/skill/lib/index.js')));
  const ctx=new Context();
  try {
    await ctx.plugin(SkillRegistry);
    const dispose=registerBundledSkills(ctx);
    const list=await ctx.skills.list({cwd:'/tmp/synthetic-workspace'});
    assert.deepEqual(list.map(s=>s.name).sort(),['paper-library-fetch','paper-library-knowledge','paper-library-notes','paper-library-review']);
    const fetchEntry=list.find(s=>s.name==='paper-library-fetch');
    assert.equal(fetchEntry.path,skillPath);
    assert.deepEqual(fetchEntry.invocation,{modelInvocable:true,userInvocable:true});
    const loaded=await ctx.skills.get('paper-library-fetch',{});
    assert.equal(loaded.path,skillPath);
    assert.deepEqual(loaded.resourceBase,{kind:'directory',path:skillDirectory});
    assert.equal(loaded.content,bundledFetchSkill().content);
    assert.match(loaded.content,/library_import/);assert.match(loaded.content,/metadata_only/);
    for(const expected of bundledLibrarySkills().slice(1)) {
      const actual=await ctx.skills.get(expected.name,{});
      assert.equal(actual.path,expected.path);
      assert.equal(actual.content,expected.content);
      assert.match(actual.content,/library_knowledge/);
    }
    // The bundled review skill carries the generic evidence-atlas methodology and
    // its references, and never a private overlay.
    const review=await ctx.skills.get('paper-library-review',{});
    assert.match(review.content,/evidence-atlas-review\.md/);
    assert.match(review.content,/reviewProfile/);
    assert.deepEqual(review.invocation,{modelInvocable:true,userInvocable:true});
    for(const reference of ['evidence-atlas-review.md','review-rubric.md','output-template.md','auto-parse.md']) {
      assert.ok(existsSync(join(review.resourceBase.path,'references',reference)),`Missing bundled review reference ${reference}`);
    }
    dispose();assert.equal((await ctx.skills.list({})).length,0);
  } finally {await ctx.fiber.dispose();}
});
