/** Reproducible pre-publication checks; reports locations, never secret values. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const git = (...args) => execFileSync('git',args,{encoding:'utf8',maxBuffer:16*1024*1024});
await writeFile('docs/validation/publication.json',JSON.stringify({verified_at:new Date().toISOString(),ok:false,status:'Checks started; no passing receipt yet.'},null,2)+'\n');
const manifest = JSON.parse(await readFile('package.json','utf8'));
const lock = JSON.parse(await readFile('package-lock.json','utf8'));
assert.equal(manifest.license,'MIT');
assert.equal(lock.packages[''].license,'MIT');
assert.match(await readFile('pyproject.toml','utf8'),/^license = "MIT"$/m);
assert.match(await readFile('LICENSE','utf8'),/^MIT License\n/);
assert.match(await readFile('THIRD_PARTY.md','utf8'),/Citation Style Language project/);
assert.match(await readFile('licenses/AGPL-3.0.txt','utf8'),/GNU AFFERO GENERAL PUBLIC LICENSE/);

const excluded = /(?:^|\/)(?:node_modules|\.venv|\.local|artifacts|data|\.data)(?:\/|$)|(?:^|\/)(?:\.env(?:\..*)?|id_rsa|id_ed25519)$|\.(?:pdf|sqlite\d?(?:-wal|-shm)?|db|pem|p12)$/i;
const secret = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:gh[pousr]_[a-zA-Z0-9]{30,}|github_pat_[a-zA-Z0-9_]{50,}|AKIA[A-Z0-9]{16}|sk-[a-zA-Z0-9]{32,})\b/;
const findings = [];
const trackedFiles = git('ls-files','-z').split('\0').filter(Boolean);
const files = [...new Set(git('ls-files','--cached','--others','--exclude-standard','-z').split('\0').filter(Boolean))];
for (const path of files) {
  if (excluded.test(path)) findings.push({scope:'current-tree',path,reason:'runtime or private file type'});
  const text = await readFile(path,'utf8');
  if (secret.test(text)) findings.push({scope:'current-tree',path,reason:'credential signature'});
}
let blobCount = 0;
for (const line of git('rev-list','--objects','--all').trim().split('\n')) {
  const [oid,...parts] = line.split(' '), path=parts.join(' ');
  if (!path || git('cat-file','-t',oid).trim()!=='blob') continue;
  blobCount++;
  if (excluded.test(path)) findings.push({scope:'history',oid,path,reason:'runtime or private file type'});
  if (secret.test(git('cat-file','blob',oid))) findings.push({scope:'history',oid,path,reason:'credential signature'});
}
const cache = process.env.DSH_NPM_CACHE || join(tmpdir(),'dsh-paper-library-npm-cache');
const packed = JSON.parse(execFileSync('npm',['pack','--dry-run','--json','--cache',cache],{encoding:'utf8',maxBuffer:4*1024*1024}))[0];
const paths = new Set(packed.files.map(file=>file.path));
for (const path of ['LICENSE','THIRD_PARTY.md','licenses/AGPL-3.0.txt','licenses/citeproc-NOTICE.txt','skills/paper-library-fetch/SKILL.md','skills/paper-library-knowledge/SKILL.md','skills/paper-library-notes/SKILL.md','docs/annotation-reference-design.md','docs/library-datasets-knowledge-design.md']) assert.ok(paths.has(path),`Missing packaged notice/skill/design: ${path}`);
for (const path of paths) if (excluded.test(path)) findings.push({scope:'package',path,reason:'runtime or private file type'});
const csl = JSON.parse(await readFile('vendor/csl/manifest.json','utf8'));
for (const resource of csl.resources) assert.equal(createHash('sha256').update(await readFile(`vendor/csl/${resource.name}`)).digest('hex'),resource.sha256);
const report = {
  verified_at:new Date().toISOString(),
  scope:'Pre-publication source, history, manifest and package checks; not remote publication or a legal opinion',
  ok:findings.length===0,
  source_license:'MIT',
  third_party_notices_preserved:true,
  history_commits:git('rev-list','--count','--all').trim(),
  history_blobs_checked:blobCount,
  tracked_files_checked:trackedFiles.length,
  source_files_checked:files.length,
  packaged_files_checked:paths.size,
  findings,
  limits:['Credential signatures are bounded checks, not proof that every possible secret is absent.','Default PDF/citation dependencies retain AGPL terms.'],
};
await writeFile('docs/validation/publication.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report));
if (!report.ok) process.exitCode=1;
