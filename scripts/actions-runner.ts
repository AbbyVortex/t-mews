import {GitHubStateStore} from '../src/actions/store';
import {runAction} from '../src/actions/run';
const mode=process.argv[2]??'check';
try {
 if(!['check','test','monitor'].includes(mode))throw new Error('Invalid operation');
 const store=new GitHubStateStore(process.env.GITHUB_REPOSITORY??'',process.env.GITHUB_TOKEN??'');
 const result=await runAction(mode as 'check'|'test'|'monitor',store,{user:process.env.PUSHOVER_USER_KEY??'',token:process.env.PUSHOVER_APP_TOKEN??''});
 console.log(JSON.stringify(result));
}catch {
 console.error('T-MEWS stopped safely. Check repository access, Actions Secrets, and monitor-state/state.json. No secret values or upstream response bodies are logged.');
 process.exitCode=1;
}
