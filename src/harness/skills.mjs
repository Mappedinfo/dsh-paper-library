import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const directory = fileURLToPath(new URL('../../skills/paper-library-fetch/',import.meta.url));
const path = fileURLToPath(new URL('../../skills/paper-library-fetch/SKILL.md',import.meta.url));

/** A small bundled definition; no filesystem watchers or external skill installation. */
export function bundledFetchSkill() {
  const source = readFileSync(path,'utf8');
  if (source.length > 16000) throw new Error('Bundled fetch skill exceeds its size budget');
  const match = /^---\r?\nname: ([a-z0-9-]+)\r?\ndescription: ("[^\n]+")\r?\n---\r?\n([\s\S]+)$/.exec(source);
  if (!match) throw new Error('Invalid bundled fetch skill frontmatter');
  return {name:match[1],description:JSON.parse(match[2]),content:match[3].trim(),source:'bundled',path,resourceBase:{kind:'directory',path:directory},invocation:{modelInvocable:true,userInvocable:true}};
}

export function registerBundledSkills(ctx) {
  return ctx.skills.register(bundledFetchSkill());
}
