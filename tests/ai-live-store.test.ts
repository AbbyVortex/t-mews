import test from 'node:test';
import assert from 'node:assert/strict';
import {GitHubLiveStore} from '../src/actions/ai-live-store';

const repo='AbbyVortex/t-mews';
const record=(id='x:123',status='claimed')=>({version:1,id,status,model:'gpt-6.1-sol',reasoning:'medium',createdAt:1794117600});
const file=(value:Record<string,any>,sha='old')=>Response.json({encoding:'base64',sha,content:Buffer.from(JSON.stringify(value)).toString('base64')});

test('per-post files use independent CAS and never access normal or legacy files',async()=>{
 const requests:{url:string;method:string;body:any}[]=[];
 const store=new GitHubLiveStore(repo,'github-secret',async(input,init)=>{
  const url=String(input),method=init?.method??'GET',body=init?.body?JSON.parse(String(init.body)):null;
  requests.push({url,method,body});
  assert.equal(init?.redirect,'error');assert.ok(init?.signal);
  assert.match(url,/\/contents\/ai-live\/posts\/(?:x-123|x-456)\.json(?:\?ref=monitor-state)?$/);
  assert.ok(!url.includes('/git/')&&!url.includes('state.json')&&!url.includes('ai-shadow'));
  const id=url.includes('x-123')?'x:123':'x:456';
  if(method==='GET')return file(record(id),'sha-'+id);
  assert.equal(body.branch,'monitor-state');
  assert.equal(body.sha,'sha-'+id);
  assert.equal(JSON.parse(Buffer.from(body.content,'base64').toString()).id,id);
  assert.ok(!Buffer.from(body.content,'base64').toString().includes('github-secret'));
  return Response.json({content:{sha:'new-'+id}});
 });
 await Promise.all([store.load('x:123'),store.load('x:456')]);
 await Promise.all([store.save('x:123',record('x:123','decided')),store.save('x:456',record('x:456','complete'))]);
 assert.equal(requests.length,4);
});

test('404 enables exactly that new file; probe IDs do not reuse the historical test key',async()=>{
 const calls:any[]=[];
 const store=new GitHubLiveStore(repo,'token',async(input,init)=>{
  calls.push({url:String(input),method:init?.method,body:init?.body?JSON.parse(String(init.body)):undefined});
  return init?.method==='GET'?new Response('',{status:404}):Response.json({content:{sha:'created'}});
 });
 const id='probe:live_20261108_disagreement';
 await assert.rejects(store.save(id,record(id)),/^Error: live_not_loaded$/);
 assert.equal(calls.length,0);assert.equal(await store.load(id),undefined);
 await store.save(id,record(id));await store.save(id,record(id));
 assert.equal(calls.length,2);assert.equal(calls[1].body.sha,undefined);
 assert.ok(calls[0].url.endsWith('/probe-live_20261108_disagreement.json?ref=monitor-state'));
});

test('identity and record validation happen before writing',async()=>{
 let calls=0;const store=new GitHubLiveStore(repo,'token',async()=>{calls++;return new Response('',{status:404});});
 for(const id of ['','../state','x:123/../../state','probe:../../state','test','x:abc','eval:123'])await assert.rejects(store.load(id),/^Error: invalid_live_id$/);
 assert.equal(calls,0);await store.load('x:123');
 for(const value of [record('x:456'),{...record(),version:2},{...record(),status:'sent'},null,[]])await assert.rejects(store.save('x:123',value as any),/^Error: invalid_live_record$/);
 assert.equal(calls,1);
});

test('conflicts never retry or overwrite, and require a fresh read before another save',async()=>{
 for(const status of [409,422]){
  let calls=0;
  const store=new GitHubLiveStore(repo,'private-token',async(_input,init)=>{
   calls++;
   if(init?.method==='GET')return file(record(),'current-'+calls);
   return new Response('private-token sensitive upstream body',{status});
  });
  await store.load('x:123');
  await assert.rejects(store.save('x:123',record('x:123','decided')),/^Error: live_store_conflict$/);
  await assert.rejects(store.save('x:123',record('x:123','decided')),/^Error: live_not_loaded$/);
  assert.equal(calls,2);
  await store.load('x:123');assert.equal(calls,3);
 }
});

test('ambiguous write response cannot leave a usable stale CAS token',async()=>{
 let calls=0;const store=new GitHubLiveStore(repo,'token',async(_input,init)=>{
  calls++;return init?.method==='GET'?file(record()):Response.json({message:'sensitive body'});
 });
 await store.load('x:123');
 await assert.rejects(store.save('x:123',record('x:123','decided')),/^Error: live_save_unknown$/);
 await assert.rejects(store.save('x:123',record('x:123','decided')),/^Error: live_not_loaded$/);
 assert.equal(calls,2);
});

test('request errors expose only fixed error codes',async()=>{
 for(const kind of ['network','read','write']){
  const store=new GitHubLiveStore(repo,'secret-token',async(_input,init)=>{
   if(kind==='network')throw Error('secret-token raw upstream error');
   if(kind==='write'&&init?.method==='GET')return file(record());
   return new Response('secret-token raw upstream error',{status:503});
  });
  if(kind==='write'){
   await store.load('x:123');await assert.rejects(store.save('x:123',record('x:123','decided')),/^Error: live_save_failed$/);
  }else await assert.rejects(store.load('x:123'),new RegExp('^Error: '+(kind==='network'?'live_store_network_error':'live_load_failed')+'$'));
 }
});

test('response envelope and decoded record sizes are bounded',async()=>{
 const cases=[
  new Response('{}',{headers:{'Content-Length':'300000'}}),
  new Response(' '.repeat(256001)),
  Response.json({encoding:'base64',sha:'sha',content:Buffer.from(' '.repeat(128001)).toString('base64')})
 ];
 for(const [i,response] of cases.entries()){
  const store=new GitHubLiveStore(repo,'token',async()=>response);
  await assert.rejects(store.load('x:123'),i===2?/^Error: live_store_size_limit$/:/^Error: invalid_live_file$/);
  await assert.rejects(store.save('x:123',record()),/^Error: live_not_loaded$/);
 }
 let calls=0;const store=new GitHubLiveStore(repo,'token',async()=>{calls++;return new Response('',{status:404});});
 await store.load('x:123');
 await assert.rejects(store.save('x:123',{...record(),input:'x'.repeat(128001)}),/^Error: live_store_size_limit$/);
 assert.equal(calls,1);
});

test('malformed saved records are never reset to new records',async()=>{
 for(const saved of [record('x:456'),{...record(),version:0},{...record(),status:'anything'}]){
  const store=new GitHubLiveStore(repo,'token',async()=>file(saved));
  await assert.rejects(store.load('x:123'),/^Error: invalid_live_record$/);
  await assert.rejects(store.save('x:123',record()),/^Error: live_not_loaded$/);
 }
 const store=new GitHubLiveStore(repo,'token',async()=>Response.json({encoding:'utf8',sha:'sha',content:'{}'}));
 await assert.rejects(store.load('x:123'),/^Error: invalid_live_file$/);
});

test('cancellation bounds a fetch that ignores abort and does not later authorize saving',async()=>{
 let finish!:(response:Response)=>void;
 const store=new GitHubLiveStore(repo,'token',async()=>new Promise<Response>(resolve=>{finish=resolve;}));
 const controller=new AbortController();
 const loading=store.load('x:123',controller.signal);controller.abort();
 await assert.rejects(loading,/^Error: live_store_timeout$/);
 finish(new Response('',{status:404}));await new Promise(resolve=>setTimeout(resolve,0));
 await assert.rejects(store.save('x:123',record()),/^Error: live_not_loaded$/);
});

test('operations for the same post cannot concurrently replace its CAS state',async()=>{
 let finish!:(response:Response)=>void;
 const store=new GitHubLiveStore(repo,'token',async()=>new Promise<Response>(resolve=>{finish=resolve;}));
 const loading=store.load('x:123');
 await assert.rejects(store.load('x:123'),/^Error: live_store_busy$/);
 finish(new Response('',{status:404}));await loading;
});
