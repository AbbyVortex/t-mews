import {readFileSync} from 'node:fs';
import {GitHubShadowStore} from '../src/actions/ai-shadow-store';
import {candidateFromSnapshot} from '../src/shadow-context';
import {classify} from '../src/classifier';
import {runShadow,shadowConfig,type ShadowCandidate} from '../src/ai-shadow';
import type {Snapshot} from '../src/actions/sqlite';

// Fixed owner-requested evaluation, not a scan/backfill of the legacy ledger.
const fixture=JSON.parse(readFileSync(new URL('../tests/fixtures/shadow-evaluation.json',import.meta.url),'utf8'));
const group=process.argv[2];
if(!['positive','control'].includes(group))throw Error('Invalid evaluation group');
const snapshot:Snapshot={version:1,tables:{posts:fixture.posts,events:[],state:[],source_health:[],notifications:[]}};
const now=Math.floor(Date.now()/1000);
const candidates:ShadowCandidate[]=fixture.cases.filter((c:any)=>c.group===group).map((c:any)=>{
 const source=c.postId?candidateFromSnapshot(snapshot,c.postId):undefined;
 if(c.postId&&!source)throw Error('Evaluation source unavailable');
 const verdict=classify(source?.text??c.text);
 return {...source,id:'eval:sol-context-v2:'+c.key,postId:c.postId,url:source?.url??null,text:source?.text??c.text,
  related:c.context?source?.related??[]:[],recentContext:c.context?source?.recentContext??[]:[],
  parentStatus:c.context?'captured_history':'deliberately_omitted',contextMode:c.context?'context':'bare',evaluation:true,discoveredAt:now,
  rule:{classification:verdict.classification,notify:verdict.notify,display:verdict.display??null}};
});
try{
 const config=shadowConfig(process.env);
 if(config.model!=='gpt-6.1-sol'||config.reasoning!=='medium'){
  console.log(JSON.stringify({status:'evaluation_model_mismatch',model:config.model,reasoning:config.reasoning}));
  process.exitCode=1;
 }else{
 const result=await runShadow(candidates,{...config,evaluation:true,
  store:new GitHubShadowStore(process.env.GITHUB_REPOSITORY??'',process.env.GITHUB_TOKEN??'')},now);
 console.log(JSON.stringify({evaluationGroup:group,...result}));
 if(['missing_key','invalid_model','invalid_reasoning','shadow_store_error','timeout'].includes(result.status))process.exitCode=1;
 }
}catch{console.error('Shadow evaluation failed. No credentials or upstream response bodies are logged.');process.exitCode=1;}
