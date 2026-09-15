import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** A small bundled definition; no filesystem watchers or external skill installation. */
function bundledSkill(name) {
  const directory = fileURLToPath(new URL(`../../skills/${name}/`,import.meta.url));
  const path = fileURLToPath(new URL(`../../skills/${name}/SKILL.md`,import.meta.url));
  const source = readFileSync(path,'utf8');
  if (source.length > 16000) throw new Error('Bundled fetch skill exceeds its size budget');
  const match = /^---\r?\nname: ([a-z0-9-]+)\r?\ndescription: ("[^\n]+")\r?\n---\r?\n([\s\S]+)$/.exec(source);
  if (!match) throw new Error('Invalid bundled fetch skill frontmatter');
  return {name:match[1],description:JSON.parse(match[2]),content:match[3].trim(),source:'bundled',path,resourceBase:{kind:'directory',path:directory},invocation:{modelInvocable:true,userInvocable:true}};
}

export function bundledFetchSkill() { return bundledSkill('paper-library-fetch'); }
export function bundledLibrarySkills() { return ['paper-library-fetch','paper-library-knowledge','paper-library-notes'].map(bundledSkill); }

export function registerBundledSkills(ctx) {
  const disposers=[];
  try { for(const skill of bundledLibrarySkills()) disposers.push(ctx.skills.register(skill)); }
  catch(error) { for(const dispose of disposers.reverse()) dispose(); throw error; }
  return () => { for(const dispose of disposers.reverse()) dispose(); };
}
