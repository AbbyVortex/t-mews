import type {Snapshot} from './actions/sqlite';
import {classify} from './classifier';
import type {RelatedPost} from './types';
import {within,readBoundedJson,type ShadowCandidate,type ShadowEvidence,type ShadowRelated} from './ai-shadow';

const TOPIC=/\b(?:banked|resets?|resetting)\b|🍄/i;
const BANKED=/\bbanked\b/i;
const WINDOW=72*60*60;
const validTime=(n:unknown):n is number=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0;
function ownPost(p:Record<string,any>):boolean {
 const match=typeof p.canonical_url==='string'?p.canonical_url.match(/^https:\/\/(?:x\.com|twitter\.com)\/thsottiaux\/status\/(\d{1,20})\/?$/i):null;
 return !!match&&p.id===`x:${match[1]}`&&p.kind!=='repost'&&typeof p.text==='string';
}

/** Recent history is background evidence, never an inferred reply relationship. */
export function candidateFromSnapshot(snapshot:Snapshot,id:string):ShadowCandidate|undefined {
 const p=snapshot.tables.posts.find(p=>p.id===id);
 if(!p||!ownPost(p)||p.baseline!==0)return;
 const row=snapshot.tables.events.find(e=>e.id===`analysis:${p.id}`&&e.event_type==='post_analysis');
 let analysis:any={};try {analysis=row?JSON.parse(row.details):{};} catch { /* Missing evidence stays missing. */ }
 const refs:RelatedPost[]=Array.isArray(analysis?.related)?analysis.related:[];
 const related:ShadowRelated[]=refs.filter(r=>r&&['reply','quote'].includes(r.relation)).slice(0,2).map(r=>({
  relation:r.relation,...(typeof r.text==='string'?{text:r.text.slice(0,500)}:{}),
  ...(typeof r.author==='string'?{author:r.author.slice(0,80)}:{}),
  ...(typeof r.xStatusId==='string'?{id:`x:${r.xStatusId}`}:{ }),
  ...(typeof r.url==='string'?{url:r.url}:{}),publishedAt:validTime(r.publishedAt)?r.publishedAt:null,
  source:r.provenance==='saved'?'saved':'feed',
 }));
 const verdict=analysis?.verdict??classify(p.text,refs);
 const publishedAt=validTime(p.published_at)?p.published_at:null;
 const recentContext:ShadowEvidence[]=publishedAt===null?[]:snapshot.tables.posts
  .filter(h=>h.id!==id&&ownPost(h)&&validTime(h.published_at)&&h.published_at<publishedAt&&h.published_at>=publishedAt-WINDOW&&TOPIC.test(h.text))
  .sort((a,b)=>Number(BANKED.test(p.text)&&BANKED.test(b.text))-Number(BANKED.test(p.text)&&BANKED.test(a.text))
   ||Number(b.kind==='post')-Number(a.kind==='post')||b.published_at-a.published_at||String(a.id).localeCompare(String(b.id)))
  .slice(0,4).sort((a,b)=>a.published_at-b.published_at||String(a.id).localeCompare(String(b.id)))
  .map(h=>({id:h.id,url:h.canonical_url,text:h.text.slice(0,700),publishedAt:h.published_at,author:'thsottiaux',source:'saved-history'}));
 return {id:p.id,url:p.canonical_url,text:p.text.slice(0,4000),related,publishedAt,
  kind:p.kind,discoveredAt:validTime(p.detected_at)?p.detected_at:undefined,recentContext,
  rule:{classification:p.classification,notify:verdict.notify,display:verdict.display??null}};
}

function priority(p:ShadowCandidate):number {
 if(TOPIC.test(p.text)||p.related.some(r=>typeof r.text==='string'&&TOPIC.test(r.text)))return 0;
 if(p.kind==='post')return 1;
 if(p.related.some(r=>r.relation==='reply'&&r.text?.trim()))return 2;
 return 3;
}
export function prioritizeCandidates(candidates:ShadowCandidate[]):ShadowCandidate[] {
 return [...candidates].sort((a,b)=>priority(a)-priority(b)
  ||(a.discoveredAt??a.publishedAt??0)-(b.discoveredAt??b.publishedAt??0)
  ||(a.publishedAt??0)-(b.publishedAt??0)||a.id.localeCompare(b.id));
}
export function shadowCandidates(before:Snapshot,after:Snapshot):ShadowCandidate[] {
 const old=new Set(before.tables.posts.map(p=>p.id));
 return prioritizeCandidates(after.tables.posts.filter(p=>!old.has(p.id)).map(p=>candidateFromSnapshot(after,p.id))
  .filter((p):p is ShadowCandidate=>!!p));
}

/** At most the target and its explicitly declared parent; never walks a conversation. */
export async function enrichParent(candidate:ShadowCandidate,fetcher:typeof fetch,signal:AbortSignal):Promise<ShadowCandidate> {
 const result=structuredClone(candidate);
 if(candidate.kind!=='reply')return {...result,parentStatus:'not_applicable'};
 if(candidate.related.some(r=>r.relation==='reply'&&r.text?.trim()))return {...result,parentStatus:'present'};
 const ownId=candidate.id.match(/^x:(\d{2,20})$/)?.[1];
 if(!ownId)return {...result,parentStatus:'unavailable'};
 const entire=new AbortController(),wholeTimer=setTimeout(()=>entire.abort(),8000);
 const whole=AbortSignal.any([signal,entire.signal]);
 let timedOut=false;
 const get=async(id:string)=>{
  const request=new AbortController(),timer=setTimeout(()=>{timedOut=true;request.abort();},4000);
  const requestSignal=AbortSignal.any([whole,request.signal]);
  try {return await within(requestSignal,async()=>{
   const response=await fetcher(`https://api.fxtwitter.com/2/status/${id}`,{headers:{Accept:'application/json','User-Agent':'T-MEWS/0.1 public shadow context'},signal:requestSignal,redirect:'error'});
   if(!response.ok){void response.body?.cancel().catch(()=>{});throw new Error('unavailable');}
   const data=await readBoundedJson(response,64000);
   if(data?.code!==200||data.status?.type!=='status')throw new Error('unavailable');
   if(data.status.id!==id)throw new Error('identity_mismatch');
   return data.status;
  });} finally {clearTimeout(timer);}
 };
 try {
  const known=candidate.related.find(r=>r.relation==='reply'&&/^x:\d{2,20}$/.test(r.id??''));
  let parentId=known?.id?.slice(2),parentAuthor=known?.author;
  if(!parentId){
   const own=await get(ownId);
   if(own.author?.screen_name?.toLowerCase()!=='thsottiaux')throw new Error('identity_mismatch');
   const reply=own.replying_to;
   if(!reply||typeof reply.status!=='string'||!/^\d{2,20}$/.test(reply.status))throw new Error('unavailable');
   parentId=reply.status;parentAuthor=reply.screen_name;
  }
  if(!parentId||parentId===ownId)throw new Error('identity_mismatch');
  const parent=await get(parentId);
  const author=parent.author?.screen_name;
  if(typeof author!=='string'||!/^\w{1,80}$/.test(author)
   ||(parentAuthor&&author.toLowerCase()!==parentAuthor.toLowerCase())
   ||(validTime(parent.created_timestamp)&&validTime(candidate.publishedAt)&&parent.created_timestamp>candidate.publishedAt))throw new Error('identity_mismatch');
  if(typeof parent.text!=='string'||!parent.text.trim())throw new Error('unavailable');
  const evidence:ShadowRelated={relation:'reply',id:`x:${parentId}`,url:`https://x.com/${author}/status/${parentId}`,
   text:parent.text.slice(0,500),author,publishedAt:validTime(parent.created_timestamp)?parent.created_timestamp:null,source:'fxtwitter-api-v2'};
  result.related=[evidence,...result.related.filter(r=>r.relation!=='reply')].slice(0,2);
  result.parentStatus='fetched';
 } catch(error) {
  const code=error instanceof Error?error.message:'';
  result.parentStatus=whole.aborted||timedOut?'timeout':['unavailable','identity_mismatch'].includes(code)?code:'error';
 } finally {entire.abort();clearTimeout(wholeTimer);}
 return result;
}
