import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {LocalD1,type Snapshot} from '../src/actions/sqlite';

const specification=JSON.parse(readFileSync(new URL('./fixtures/ai-live-verification.json',import.meta.url),'utf8'));
const now=Date.parse('2026-11-08T03:00:00Z')/1000;
const githubToken='fixture-github-token-not-persisted',apiKey='fixture-openai-key-not-persisted';
let importSequence=0;

async function savedState():Promise<Snapshot> {
 const db=new LocalD1();
 for(const [index,example] of specification.cases.entries()){
  const isTraining=example.key==='training-chatter';
  await db.prepare('INSERT INTO posts VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(
   example.postId,example.postId.slice(2),'https://x.com/thsottiaux/status/'+example.postId.slice(2),'fixture-'+index,
   now-1000+index,now-900+index,isTraining?'@ForwardEditor We hesitated to embed https://x.com into the codex app to make sense of the resets, but decided against it.':example.key==='banked-counter'?'Day 28/ Banked 2/2':'Saved fixture '+example.key,
   'fxtwitter','post',isTraining?'CANDIDATE':'IRRELEVANT','original machine reason',0,isTraining?1:0,isTraining?'sent':'not_relevant',100
  ).run();
 }
 await db.prepare('INSERT INTO state VALUES(?,?)').bind('baselineAt',String(now-86400)).run();
 await db.prepare('INSERT INTO state VALUES(?,?)').bind('fxtwitter-with-replies-v1',String(now-86400)).run();
 await db.prepare('INSERT INTO state VALUES(?,?)').bind('aiLiveQueue','[]').run();
 await db.prepare('INSERT INTO source_health VALUES(?,?,?,?,?,?,?)').bind('fxtwitter','online',now,null,null,7,null).run();
 await db.prepare('INSERT INTO notifications VALUES(?,?,?,?,?,?)').bind('test',null,'test',now-86400,'sent',now-86400).run();
 await db.prepare('INSERT INTO notifications VALUES(?,?,?,?,?,?)').bind('post:x:2119308687676432672','x:2119308687676432672','alert',now-900,'sent',now-900).run();
 await db.prepare('INSERT INTO events VALUES(?,?,?,?)').bind('old-event','notification_sent',now-900,'{"retained":true}').run();
 const snapshot=JSON.parse(JSON.stringify(db.snapshot())) as Snapshot;db.close();return snapshot;
}

async function harness() {
 const original=await savedState();
 const files=new Map<string,{sha:string,text:string}>([
  ['state.json',{sha:'state-before',text:JSON.stringify(original,null,2)+'\n'}],
  ['ai-shadow.json',{sha:'legacy-v1',text:'{"version":1,"records":[{"legacy":true}]}'}],
  ['ai-shadow-v2.json',{sha:'legacy-v2',text:'{"version":2,"records":[{"legacy":true}]}'}],
 ]);
 const beforeLegacy=[files.get('ai-shadow.json')!.text,files.get('ai-shadow-v2.json')!.text];
 const requests:string[]=[],pushes:URLSearchParams[]=[],logs:string[]=[];
 let sequence=0,apiCalls=0,failDeliveredState=false;
 const snapshot=()=>JSON.parse(files.get('state.json')!.text) as Snapshot;
 const network=(async(input:any,init:any)=>{
  const url=String(input),method=init?.method??'GET';requests.push(method+' '+url);
  if(url==='https://api.openai.com/v1/responses'){
   apiCalls++;
   const body=JSON.parse(String(init.body)),candidate=JSON.parse(body.input);
   const example=specification.cases.find((c:any)=>c.postId===candidate.id);
   assert.ok(example,'only the six fixed saved posts can be evaluated');
   const record=JSON.parse(files.get('ai-live/posts/probe-live-20261108-'+example.key+'.json')!.text);
   assert.equal(record.status,'claimed');assert.equal(record.notificationAllowed,false);assert.equal(record.input.id,candidate.id);
   assert.equal(body.model,'gpt-6.1-sol');assert.equal(body.reasoning.effort,'medium');assert.equal(body.store,false);
   const category=example.key==='training-chatter'?'chatter':example.key==='banked-counter'?'announcement':example.key.startsWith('pro-')?'attention':example.key==='usage-doubled'?'limit_change':'unrelated';
   return Response.json({status:'completed',model:'gpt-6.1-sol',usage:{input_tokens:300,output_tokens:50,total_tokens:350,output_tokens_details:{reasoning_tokens:5}},
    output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({category,rationale:'モック応答。意味分類の実精度の証拠ではない。',confidence:.9,uncertainty:''})}]}]});
  }
  if(url==='https://api.pushover.net/1/messages.json'){
   const body=new URLSearchParams(init.body),state=snapshot();
   const key=body.get('priority')==='-1'?'diagnostic':'ai-only';
   const receipt=state.tables.notifications.find(n=>n.id==='ai-live-probe:20261108:'+key);
   assert.equal(receipt?.status,'sending','the exact synthetic notification has a durable pre-send claim');
   const record=JSON.parse(files.get('ai-live/posts/probe-live-20261108-display-'+key+'.json')!.text);
   assert.equal(record.status,'decided');assert.equal(record.synthetic,true);assert.equal(record.apiRequests,0);
   assert.match(body.get('title')!,/^\[表示試験\]/);assert.match(body.get('message')!,/新しい配布速報ではありません/);
   assert.equal(body.has('url'),false,'no saved real post is sent by the display probes');
   pushes.push(body);return Response.json({status:1});
  }
  const endpoint='https://api.github.com/repos/AbbyVortex/t-mews';
  if(url===endpoint){assert.equal(method,'GET');return Response.json({private:false,default_branch:'main'});}
  if(url===endpoint+'/git/ref/heads/monitor-state'){assert.equal(method,'GET');return Response.json({object:{sha:'existing-branch'}});}
  assert.ok(url.startsWith(endpoint+'/contents/'),'unexpected network request: '+url);
  const path=new URL(url).pathname.slice('/repos/AbbyVortex/t-mews/contents/'.length);
  assert.ok(path==='state.json'||path.startsWith('ai-live/posts/'),'legacy ledgers and unrelated files must not be requested');
  const previous=files.get(path);
  if(method==='GET')return previous?Response.json({sha:previous.sha,encoding:'base64',content:Buffer.from(previous.text).toString('base64')}):new Response('',{status:404});
  assert.equal(method,'PUT');const body=JSON.parse(String(init.body));
  assert.equal(body.branch,'monitor-state');assert.equal(body.sha,previous?.sha,'each file uses its own current CAS');
  const text=Buffer.from(body.content,'base64').toString('utf8');
  assert.ok(!text.includes(githubToken)&&!text.includes(apiKey));
  if(path==='state.json'&&failDeliveredState){
   const candidate=JSON.parse(text);
   if(candidate.tables.notifications.some((n:any)=>n.kind==='ai-live-probe'&&n.status==='sent'))return new Response('fixture post-delivery write failure',{status:503});
  }
  const sha='saved-'+(++sequence);files.set(path,{sha,text});return Response.json({content:{sha}});
 }) as typeof fetch;
 const run=async()=>{
  const oldFetch=globalThis.fetch,oldLog=console.log,oldError=console.error,oldExit=process.exitCode;
  const settings={GITHUB_REPOSITORY:'AbbyVortex/t-mews',GITHUB_TOKEN:githubToken,OPENAI_API_KEY:apiKey,T_MEWS_AI_MODEL:'gpt-6.1-sol',T_MEWS_AI_REASONING:'medium',PUSHOVER_USER_KEY:'u'.repeat(30),PUSHOVER_APP_TOKEN:'t'.repeat(30)};
  const oldSettings=Object.fromEntries(Object.keys(settings).map(k=>[k,process.env[k]]));
  Object.assign(process.env,settings);globalThis.fetch=network;console.log=(...args)=>{logs.push(args.join(' '));};console.error=(...args)=>{logs.push(args.join(' '));};process.exitCode=undefined;
  try {
   const script=new URL('../scripts/ai-live-verify.ts',import.meta.url);script.searchParams.set('mockRun',String(++importSequence));
   await import(script.href);return process.exitCode??0;
  }finally{
   globalThis.fetch=oldFetch;console.log=oldLog;console.error=oldError;process.exitCode=oldExit;
   for(const [key,value] of Object.entries(oldSettings)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  }
 };
 const checkPreserved=()=>{
  const final=snapshot();
  for(const table of ['posts','source_health','state'])assert.deepEqual(final.tables[table],original.tables[table],table+' is unchanged');
  assert.deepEqual(final.publicStatus,original.publicStatus);
  for(const table of ['events','notifications'])for(const row of original.tables[table])assert.deepEqual(final.tables[table].find(r=>r.id===row.id),row,'old '+table+' row preserved');
  assert.deepEqual([files.get('ai-shadow.json')!.text,files.get('ai-shadow-v2.json')!.text],beforeLegacy);
  assert.deepEqual(final.tables.notifications.filter(n=>!original.tables.notifications.some(old=>old.id===n.id)).map(n=>n.id).sort(),['ai-live-probe:20261108:ai-only','ai-live-probe:20261108:diagnostic']);
  assert.ok(!logs.join('\n').includes(githubToken)&&!logs.join('\n').includes(apiKey));
 };
 return {run,files,snapshot,requests,pushes,checkPreserved,get apiCalls(){return apiCalls;},set failDeliveredState(value:boolean){failDeliveredState=value;}};
}

test('verification script evaluates six past posts without sending them, delivers exactly two synthetic probes, and deduplicates a repeated run',async()=>{
 const h=await harness();assert.equal(await h.run(),0);
 assert.equal(h.apiCalls,6);assert.equal(h.pushes.length,2);
 assert.deepEqual(h.pushes.map(p=>p.get('priority')),['-1','1']);
 h.checkPreserved();
 const stateBeforeRestart=h.files.get('state.json')!.text;
 assert.equal(await h.run(),0);assert.equal(h.apiCalls,6);assert.equal(h.pushes.length,2);
 assert.equal(h.files.get('state.json')!.text,stateBeforeRestart);h.checkPreserved();
 assert.equal([...h.files.keys()].filter(p=>p.startsWith('ai-live/posts/')).length,8);
});

test('verification restart retains an uncertain sent probe and never repeats its API calls or Pushover request',async()=>{
 const h=await harness();h.failDeliveredState=true;
 assert.equal(await h.run(),1);assert.equal(h.apiCalls,6);assert.equal(h.pushes.length,1);
 assert.equal(h.snapshot().tables.notifications.find(n=>n.id==='ai-live-probe:20261108:diagnostic')?.status,'sending');
 h.failDeliveredState=false;
 assert.equal(await h.run(),1,'the uncertain first receipt is not presented as verified delivery');
 assert.equal(h.apiCalls,6);assert.equal(h.pushes.length,2,'only the previously unstarted second probe is sent');
 assert.equal(h.snapshot().tables.notifications.find(n=>n.id==='ai-live-probe:20261108:diagnostic')?.status,'sending');
 h.checkPreserved();
});
