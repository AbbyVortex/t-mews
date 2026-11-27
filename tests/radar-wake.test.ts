import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dispatchRadarWake} from '../src/actions/radar-wake';

const now=1_800_000_000_000;
const episode='ab'.repeat(16);
const config={releaseId:70,host:'example.invalid',port:9,mac:'00:11:22:33:44:55',key:Buffer.from(Array.from({length:32},(_,i)=>i)).toString('base64')};
const env={OPERATION:'monitor',GITHUB_REF:'refs/heads/main',GITHUB_REPOSITORY:'AbbyVortex/t-mews',GITHUB_TOKEN:'fixture-token',KINOKO_RADAR_WAKE:JSON.stringify(config)};
const signal={version:1,id:'x:123',kind:'hint',observedAt:now-300_000,publishedAt:now-400_000,dueAt:null as number|null};
const body={version:1,state:'sleeping',at:now-600_000,watchActive:false,episode,signalId:null as string|null};
function fixture(){
 const f={signal:{...signal}, gate:{...body}, name:'KINOKO-RADAR',draft:true,tag:'kinoko-radar-private-gate',signal404:false,
  step:0, patchStatus:200, onRead:(_step:number)=>{}, afterPatch:()=>{}, packets:[] as Buffer[], requests:[] as string[]};
 const release=()=>({id:70,name:f.name,tag_name:f.tag,draft:f.draft,body:JSON.stringify(f.gate)});
 const fetcher:typeof fetch=async (request,options)=>{
  const path=new URL(String(request)).pathname;
  const method=options?.method??'GET';
  f.requests.push(method+' '+path);
  assert.equal(options?.redirect,'error');assert.equal(new Headers(options?.headers).get('Authorization'),'Bearer fixture-token');
  if(path.endsWith('/contents/radar-watch.json')){
   assert.ok(String(request).endsWith('?ref=monitor-state'));
   return f.signal404?new Response(null,{status:404}):Response.json(f.signal);
  }
  assert.equal(path,'/repos/AbbyVortex/t-mews/releases/70');
  if(method==='PATCH'){
   assert.equal(new Headers(options?.headers).get('If-Match'),'"revision"');
   if(f.patchStatus!==200)return new Response(null,{status:f.patchStatus});
   const change=JSON.parse(String(options?.body));
   assert.deepEqual(Object.keys(change),['name']);
   f.name=change.name;f.afterPatch();return Response.json(release());
  }
  assert.equal(method,'GET');f.onRead(++f.step);
  return Response.json(release(),{headers:{etag:'"revision"'}});
 };
 const options={fetcher,now:()=>now,resolveAddress:async(host:string)=>{assert.equal(host,config.host);return '192.0.2.7';},
  send:async(packet:Buffer,port:number,ip:string)=>{assert.equal(port,9);assert.equal(ip,'192.0.2.7');f.packets.push(Buffer.from(packet));}};
 return {f,options,run:()=>dispatchRadarWake(env,options)};
}

test('radar transport: only a successful main monitor can consume its isolated secret',async()=>{
 const {f,options}=fixture();
 for(const changes of [{OPERATION:'recover'},{OPERATION:'test'},{OPERATION:'check'},{GITHUB_REF:'refs/heads/other'},
  {GITHUB_REPOSITORY:'another/repo'},{KINOKO_RADAR_WAKE:''}]){
  assert.equal(await dispatchRadarWake({...env,...changes},options),false);
 }
 assert.deepEqual(f.requests,[]);
 const workflow=readFileSync(new URL('../.github/workflows/monitor.yml',import.meta.url),'utf8');
 assert.match(workflow,/if: success\(\).*github\.ref == 'refs\/heads\/main'.*inputs\.operation == 'monitor'/);
 assert.equal(workflow.match(/secrets\.KINOKO_RADAR_WAKE/g)?.length,1);
 const idle=fixture();idle.f.signal404=true;
 assert.equal(await idle.run(),false);assert.equal(idle.f.requests.length,1);
});

test('radar transport: one claimed signal emits an authenticated prefix and a complete WoL payload once',async()=>{
 const {f,run}=fixture();
 assert.equal(await run(),true);assert.equal(f.packets.length,1);
 const packet=f.packets[0], marker=Buffer.from('KINOKO1:b1049fdcfcd915e3effb4ef7f4e0fb56','ascii');
 const wol=Buffer.from('ff'.repeat(6)+'001122334455'.repeat(16),'hex');
 assert.deepEqual(packet,Buffer.concat([marker,wol]));
 assert.equal(f.name,'KINOKO-RADAR '+JSON.stringify({id:signal.id,episode,sentAt:now,phase:'claimed'}));
 assert.equal(await run(),false);assert.equal(f.packets.length,1);
 f.signal.id='x:456';assert.equal(await run(),false,'first wake in flight for same sleep');
 f.gate.episode='01'.repeat(16);f.signal.id=signal.id;
 assert.equal(await run(),false,'previous signal already claimed, even for a new sleep');
 assert.equal(f.requests.filter(r=>r.startsWith('PATCH')).length,1);
});

test('radar transport: awake, repeated hints while active, sleep after signal, stale and already consumed signals do not send',async()=>{
 const cases=[{state:'awake'},{watchActive:true},{at:signal.observedAt+1000},{signalId:signal.id}];
 for(const change of cases){
  const {f,run}=fixture();Object.assign(f.gate,change);
  assert.equal(await run(),false);assert.equal(f.requests.length,2);
 }
 const stale=fixture();stale.f.signal.observedAt-=1_800_001;stale.f.signal.publishedAt-=1_800_001;
 assert.equal(await stale.run(),false);assert.equal(stale.f.requests.length,1);
 const clock=fixture();clock.f.signal.dueAt=now+1_000;
 assert.equal(await clock.run(),false);assert.equal(clock.f.requests.length,1);
 clock.f.signal.observedAt-=86_400_000;clock.f.signal.publishedAt-=86_400_000;clock.f.signal.dueAt=now-30_000;
 assert.equal(await clock.run(),true,'known future rollout can mature while the PC sleeps');
 const staleDue=fixture();staleDue.f.signal.observedAt-=86_400_000;staleDue.f.signal.publishedAt-=86_400_000;staleDue.f.signal.dueAt=now-1_800_001;
 assert.equal(await staleDue.run(),false);
});

test('radar transport: fresh release announcements and a new exact due time can wake during an active watch',async()=>{
 for(const latest of [{kind:'announcement'},{dueAt:now-5000}]){
  const {f,run}=fixture();f.gate.watchActive=true;f.gate.signalId='x:122';Object.assign(f.signal,latest);
  assert.equal(await run(),true);assert.equal(await run(),false);assert.equal(f.packets.length,1);
 }
});

test('radar transport: gates revoked before, during or after claim suppress the real-world action',async()=>{
 for(const phase of ['wrong-draft','wrong-tag','conflict','patched-awake','final-episode','final-claim'] as const){
  const {f,run}=fixture();
  if(phase==='wrong-draft'||phase==='wrong-tag'){
   if(phase==='wrong-draft')f.draft=false;else f.tag='other';
   await assert.rejects(run(),/invalid_radar_release/);
  }else{
   if(phase==='conflict')f.patchStatus=412;
   if(phase==='patched-awake')f.afterPatch=()=>{f.gate.state='awake';};
   if(phase==='final-episode')f.onRead=step=>{if(step===2)f.gate.episode='cc'.repeat(16);};
   if(phase==='final-claim')f.onRead=step=>{if(step===2)f.name='KINOKO-RADAR';};
   assert.equal(await run(),false,phase);
  }
  assert.equal(f.packets.length,0,phase);
 }
});

test('radar transport: lost UDP acknowledgement is terminal for the claimed event',async()=>{
 const {f,options,run}=fixture();let attempts=0;
 await assert.rejects(dispatchRadarWake(env,{...options,send:async()=>{attempts++;throw Error('fixture send result unknown');}}));
 assert.equal(attempts,1);assert.equal(await run(),false);assert.equal(f.packets.length,0);
 assert.equal(f.requests.filter(r=>r.startsWith('PATCH')).length,1);
});
