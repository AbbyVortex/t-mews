import {runAction,type ActionMode,type Store} from './run';
import type {Snapshot} from './sqlite';
import {runShadow,shadowCandidates,type ShadowOptions,type ShadowSummary} from '../ai-shadow';

/** Conventional delivery and its final durable checkpoint always finish first. */
export async function runActionWithShadow(mode:ActionMode,store:Store,secrets:{user:string,token:string},
 fetcher:typeof fetch=fetch,now=Math.floor(Date.now()/1000),postId?:string,shadow?:ShadowOptions) {
 if(mode!=='monitor'||!shadow?.enabled)return runAction(mode,store,secrets,fetcher,now,postId);
 let before:Snapshot|undefined,after:Snapshot|undefined;
 const observed:Store={load:async init=>{const snapshot=await store.load(init);before=snapshot;return snapshot;},
  save:async snapshot=>{await store.save(snapshot);after=snapshot;}};
 const result=await runAction(mode,observed,secrets,fetcher,now,postId);
 let summary:ShadowSummary={status:'no_new_posts',attempted:0,classified:0};
 try {if(before&&after)summary=await runShadow(shadowCandidates(before,after),shadow,now);}
 catch {summary.status='shadow_error';}
 try {shadow.report?.(summary);} catch { /* Comparison reporting cannot fail a conventional run. */ }
 return result;
}
