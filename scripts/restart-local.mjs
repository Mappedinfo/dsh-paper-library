/** Restart only a verified project-owned local preview or configured Harness.
 * Harness restart requires the existing authenticated idle check to pass first.
 * Private PID/log files stay under .local; no user configuration is rewritten.
 */
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {open,readFile,writeFile,realpath} from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const project=dirname(dirname(fileURLToPath(import.meta.url))),flags=new Map();
for(let i=2;i<process.argv.length;i+=2)flags.set(process.argv[i],process.argv[i+1]);
const target=flags.get('--target'),port=Number(flags.get('--port'));
assert.ok(['preview','harness'].includes(target)&&Number.isInteger(port)&&port>0&&port<65536,'Usage: --target preview|harness --port PORT [--harness CHECKOUT --home HOME]');
const stem=target==='preview'?'ui-preview':'local-dsh-host',pidFile=join(project,'.local',`${stem}.pid`),log=join(project,'.local',`${stem}.log`);
const cwd=target==='preview'?project:await realpath(resolve(flags.get('--harness')||''));
if(target==='harness')assert.ok(flags.get('--home')&&flags.get('--harness'),'Harness checkout and existing home are required');
const oldPid=Number((await readFile(pidFile,'utf8')).trim());assert.ok(Number.isInteger(oldPid)&&oldPid>1);
const command=spawnSync('ps',['-p',String(oldPid),'-o','command='],{encoding:'utf8'});assert.equal(command.status,0,'Tracked process is not available');
assert.ok(target==='preview'?command.stdout.includes('src/server.mjs'):command.stdout.includes('apps/cli/src/bin.ts')&&command.stdout.includes('web'),'PID does not belong to the expected runtime');
const location=spawnSync('lsof',['-a','-p',String(oldPid),'-d','cwd','-Fn'],{encoding:'utf8'});assert.equal(location.status,0,'Cannot verify process working directory');assert.ok(location.stdout.split('\n').includes(`n${cwd}`),'PID belongs to another checkout');
if(target==='harness'){
  const check=spawnSync(process.execPath,['scripts/verify-live-harness.mjs','--log',log,'--port',String(port),'--require-idle','true','--require-chat','true','--require-references','true'],{cwd:project,encoding:'utf8'});
  assert.equal(check.status,0,'Existing Harness must be authenticated and idle before restart');
}
process.kill(oldPid,'SIGINT');
const alive=()=>{try{process.kill(oldPid,0);return true;}catch{return false;}};
for(let i=0;i<100&&alive();i++)await new Promise(r=>setTimeout(r,100));
assert.equal(alive(),false,'Previous process did not stop gracefully; inspect it before retrying');
const output=await open(log,'a',0o600);await output.chmod(0o600);
const args=target==='preview'?['src/server.mjs','--port',String(port)]:['--import','tsx/esm','apps/cli/src/bin.ts','web','--no-open','--port',String(port)];
const child=spawn(process.execPath,args,{cwd,env:{...process.env,...(target==='harness'?{DSH_HOME:resolve(flags.get('--home'))}:{})},detached:true,stdio:['ignore',output.fd,output.fd]});
await new Promise((accept,reject)=>{child.once('spawn',accept);child.once('error',reject);});child.unref();await output.close();await writeFile(pidFile,`${child.pid}\n`,{mode:0o600});
let ready=false;
for(let i=0;i<100;i++){
  try{const response=await fetch(`http://127.0.0.1:${port}/`,{signal:AbortSignal.timeout(800),redirect:'manual'});if([200,302,303,401].includes(response.status)){ready=true;break;}}catch{}
  await new Promise(r=>setTimeout(r,100));
}
assert.ok(ready,'New runtime did not become ready; inspect its private log');
console.log(JSON.stringify({target,port,previousPid:oldPid,pid:child.pid,ready,configurationChanged:false}));
