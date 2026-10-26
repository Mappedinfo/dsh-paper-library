#!/usr/bin/env node
import { dispatch } from './bridge.mjs';
import { createHeadlessAnalysis, loadModelConfig } from './headless-analysis.mjs';

// JSON on stdin keeps paths/Unicode and batch requests shell-quoting independent.
const args=process.argv.slice(2);
if (args.includes('--help')) {
  console.log('paper-library [--library /path] [--python /path] [--state-home /path] [--model-config /path/config.json] < request.json\nRequest: {"action":"list","query":"urban"}\nBatch: {"action":"paper_analysis_run","ids":["paper-id"],"request_id":"batch-id","mode":"metadata"}\nSee docs/api.md for actions.');
} else {
  let headless, isAnalysis = false, parsed = false;
  try {
    const flags = new Map();
    for (let index=0;index<args.length;index+=2) {
      if (!['--library','--python','--state-home','--model-config'].includes(args[index]) || flags.has(args[index]) || !args[index+1] || args[index+1].startsWith('--')) throw new Error('Invalid CLI option');
      flags.set(args[index],args[index+1]);
    }
    let input='';
    for await (const chunk of process.stdin) {
      input += chunk;
      if (input.length > 40*1024*1024) throw new Error('Request exceeds 40 MB');
    }
    const request=JSON.parse(input);
    parsed=true;
    const library=flags.get('--library'), python=flags.get('--python');
    isAnalysis=typeof request?.action==='string' && request.action.startsWith('paper_analysis_');
    let result;
    if (isAnalysis) {
      const modelConfig=flags.has('--model-config') ? await loadModelConfig(flags.get('--model-config')) : undefined;
      headless=await createHeadlessAnalysis({library,python,localStateHome:flags.get('--state-home'),modelConfig});
      result=await headless(request);
      // CLI 退出会结束内核进程；start 必须等待，而 HTTP start 仍可立即返回 queued。
      if (request.action==='paper_analysis_start' && request.reuse!==true) {
        await headless.wait(request.id,request.request_id);
        result=await headless({action:'paper_analysis_get',id:request.id,request_id:request.request_id});
      }
    } else result=await dispatch(request,{library,python});
    const generated=isAnalysis && ['paper_analysis_run','paper_analysis_start'].includes(request.action) && !(request.action==='paper_analysis_start' && request.reuse===true);
    const ok=request.action==='latex_lint' ? result.ok===true : !generated || result.status==='complete' && !(result.warnings?.length);
    console.log(JSON.stringify({ok,result}));
    if (!ok) process.exitCode=1;
  } catch(error) {
    console.log(JSON.stringify({ok:false,error:isAnalysis?'文献后台操作未完成。':!parsed?'请求或命令行参数无效。':error.message,...(error.code?{code:error.code}:{})}));
    process.exitCode=1;
  } finally { headless?.dispose(); }
}
