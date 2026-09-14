#!/usr/bin/env node
import { dispatch } from './bridge.mjs';

// JSON on stdin keeps paths/Unicode and batch requests shell-quoting independent.
const args=process.argv.slice(2);
if (args.includes('--help')) {
  console.log('paper-library [--library /path] < request.json\nRequest: {"action":"list","query":"urban"}\nSee docs/api.md for actions.');
} else {
  try {
    let input='';
    for await (const chunk of process.stdin) {
      input += chunk;
      if (input.length > 40*1024*1024) throw new Error('Request exceeds 40 MB');
    }
    const request=JSON.parse(input);
    const library=args.includes('--library') ? args[args.indexOf('--library')+1] : undefined;
    console.log(JSON.stringify({ok:true,result:await dispatch(request,{library})}));
  } catch(error) { console.log(JSON.stringify({ok:false,error:error.message})); process.exitCode=1; }
}
