/** Read back the public remote; never creates repositories or pushes commits. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const run = (command,args) => execFileSync(command,args,{encoding:'utf8',maxBuffer:2*1024*1024}).trim();
const api = path => JSON.parse(run('gh',['api',path]));
const repo = 'mappedinfo/dsh-paper-library';
const metadata = api(`repos/${repo}`);
const branch = metadata.default_branch;
const remoteHead = api(`repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`).object.sha;
const localHead = run('git',['rev-parse','HEAD']);
const license = api(`repos/${repo}/contents/LICENSE?ref=${remoteHead}`);
const origin = run('git',['remote','get-url','origin']);
assert.equal(metadata.full_name.toLowerCase(),repo);
assert.equal(metadata.private,false);
assert.equal(branch,'main');
assert.equal(remoteHead,localHead,'Public main must match the verified local commit');
assert.match(origin,/github\.com[:/]mappedinfo\/dsh-paper-library(?:\.git)?$/);
assert.equal(Buffer.from(license.content,'base64').toString('utf8'),await readFile('LICENSE','utf8'));
assert.match(await readFile('LICENSE','utf8'),/^MIT License\n/);
const report = {verified_at:new Date().toISOString(),ok:true,repository:metadata.full_name,url:metadata.html_url,visibility:metadata.visibility,default_branch:branch,local_head:localHead,remote_head:remoteHead,root_license:'MIT',github_license:metadata.license?.spdx_id || null,origin};
await mkdir('.local',{recursive:true});
await writeFile('.local/github-publication.json',JSON.stringify(report,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify(report));
