import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bundledFetchSkill, registerBundledSkills } from '../src/harness/skills.mjs';

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
    assert.equal(list.length,1);assert.equal(list[0].name,'paper-library-fetch');
    assert.equal(list[0].path,skillPath);
    assert.deepEqual(list[0].invocation,{modelInvocable:true,userInvocable:true});
    const loaded=await ctx.skills.get('paper-library-fetch',{});
    assert.equal(loaded.path,skillPath);
    assert.deepEqual(loaded.resourceBase,{kind:'directory',path:skillDirectory});
    assert.equal(loaded.content,bundledFetchSkill().content);
    assert.match(loaded.content,/library_import/);assert.match(loaded.content,/metadata_only/);
    dispose();assert.equal((await ctx.skills.list({})).length,0);
  } finally {await ctx.fiber.dispose();}
});
