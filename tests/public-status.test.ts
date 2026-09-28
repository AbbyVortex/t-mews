import {test} from 'node:test';
import assert from 'node:assert/strict';
import {LocalD1} from '../src/actions/sqlite';
import {publicRssStatus} from '../src/actions/public-status';
import {runAction,type Store} from '../src/actions/run';
import type {Snapshot} from '../src/actions/sqlite';

test('public RSS status is a strict projection and remains unchanged without acquisition',()=>{
 const tables={source_health:[{source:'private-looking-input',state:'online',last_success_at:100,last_failure_at:90,error:'secret'}],state:[{key:'token',value:'secret'}],posts:[{secret:'secret'}]};
 const expected={version:1,lastRssSuccessAt:100,lastRssAttemptAt:100,sourceState:'online',error:null};
 assert.deepEqual(publicRssStatus({tables}),expected);
 assert.deepEqual(publicRssStatus({tables}),expected);
 tables.source_health[0]={...tables.source_health[0],state:'offline',last_failure_at:120,error:'http_503'};
 assert.deepEqual(publicRssStatus({tables}),{...expected,lastRssAttemptAt:120,sourceState:'offline',error:'http_503'});
 tables.source_health[0].error='secret from upstream';
 assert.equal(publicRssStatus({tables}).error,null);
 assert.deepEqual(publicRssStatus({tables:{source_health:[{last_success_at:NaN,last_failure_at:-1}]}}),{version:1,lastRssSuccessAt:null,lastRssAttemptAt:null,sourceState:'unknown',error:null});
});

test('old snapshots load and derive public status; supplied public fields are not trusted',()=>{
 const db=new LocalD1();
 const old=db.snapshot();delete old.publicStatus;db.close();
 const restored=new LocalD1({...old,publicStatus:{version:1,lastRssSuccessAt:999,lastRssAttemptAt:999,sourceState:'online',error:'secret'}});
 assert.equal(restored.snapshot().publicStatus?.lastRssSuccessAt,null);
 assert.equal(restored.snapshot().publicStatus?.error,null);
 restored.close();
});

test('each successful RSS fetch advances status within five minutes; failure and non-RSS test do not',async()=>{
 let state:Snapshot|undefined;
 const store:Store={load:async()=>structuredClone(state),save:async s=>{state=structuredClone(s);}};
 const secrets={user:'u'.repeat(30),token:'t'.repeat(30)};
 let failed=false;
 const fetcher=(async(input:any)=>String(input).includes('pushover')?Response.json({status:1}):failed?new Response('',{status:503}):new Response('<rss><channel><title>@thsottiaux</title><item><link>https://x.com/thsottiaux/status/1</link><description>ordinary update</description></item></channel></rss>')) as typeof fetch;
 await runAction('test',store,secrets,fetcher,1000);
 assert.equal(state!.publicStatus!.lastRssSuccessAt,null);
 await runAction('monitor',store,secrets,fetcher,1000);
 await runAction('monitor',store,secrets,fetcher,1060);
 assert.equal(state!.publicStatus!.lastRssSuccessAt,1060);
 failed=true;await runAction('monitor',store,secrets,fetcher,1120);
 assert.deepEqual(state!.publicStatus,{version:1,lastRssSuccessAt:1060,lastRssAttemptAt:1120,sourceState:'offline',error:'http_503'});
 await runAction('test',store,secrets,fetcher,1180);
 assert.equal(state!.publicStatus!.lastRssAttemptAt,1120);
 assert.equal(state!.publicStatus!.lastRssSuccessAt,1060);
});
