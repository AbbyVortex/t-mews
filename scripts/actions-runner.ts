import {GitHubStateStore} from '../src/actions/store';
import {runAction,type ActionMode} from '../src/actions/run';
import {GitHubLiveStore} from '../src/actions/ai-live-store';
import {liveConfig} from '../src/ai-live';
import {enrichLiveContext} from '../src/ai-live-context';
const mode=process.argv[2]??'check';
try {
 if(!['check','test','monitor','recover'].includes(mode))throw new Error('Invalid operation');
 const store=new GitHubStateStore(process.env.GITHUB_REPOSITORY??'',process.env.GITHUB_TOKEN??'');
 const config=liveConfig(process.env);
 const result=await runAction(mode as ActionMode,store,{user:process.env.PUSHOVER_USER_KEY??'',token:process.env.PUSHOVER_APP_TOKEN??''},undefined,undefined,process.env.T_MEWS_RECOVER_POST_ID,
  {...config,store:new GitHubLiveStore(process.env.GITHUB_REPOSITORY??'',process.env.GITHUB_TOKEN??''),enrich:(candidate,signal)=>enrichLiveContext(candidate,fetch,signal),
   report:summary=>console.log(JSON.stringify({aiLive:summary}))});
 console.log(JSON.stringify(result));
}catch {
 console.error('T-MEWS stopped safely. Check repository access, Actions Secrets, and monitor-state/state.json. No secret values or upstream response bodies are logged.');
 process.exitCode=1;
}
