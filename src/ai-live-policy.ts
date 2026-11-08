import type {Item,Verdict} from './types';
import {alertMessage,alertTitle} from './pushover';
import type {LiveResult} from './ai-live-classifier';

export interface LiveNotificationPlan {kind:'normal'|'diagnostic'|'fallback';mismatch:boolean;priority:-1|0|1}
type EffectiveCategory='announcement'|'attention'|'limit_change'|'none';
function machineCategory(verdict:Verdict):EffectiveCategory {
 if(!verdict.notify)return 'none';
 if(verdict.change||verdict.display==='advisory')return 'attention';
 if(verdict.display==='announcement'||['RESET_ANNOUNCED','BANKED_RESET'].includes(verdict.classification))return 'announcement';
 if(verdict.display==='limit'||verdict.classification==='LIMIT_CHANGE')return 'limit_change';
 return 'attention';
}
const aiCategory=(result:LiveResult):EffectiveCategory=>result.category==='chatter'||result.category==='unrelated'?'none':result.category;
export const isCriticalMachine=(verdict:Verdict):boolean=>['announcement','limit_change'].includes(machineCategory(verdict));

/** Compare effective notification meanings while retaining both original labels for display. */
export function planLiveNotification(machine:Verdict,result:LiveResult|undefined,earlySent:boolean,unavailable?:string):LiveNotificationPlan|undefined {
 const conventional=machineCategory(machine);
 if(!result){
  if(earlySent||!machine.notify)return;
  return {kind:'fallback',mismatch:false,priority:conventional==='announcement'&&machine.classification==='RESET_ANNOUNCED'?1:0};
 }
 const ai=aiCategory(result),mismatch=conventional!==ai;
 if(earlySent)return isCriticalMachine(machine)&&mismatch?{kind:'diagnostic',mismatch:true,priority:-1}:undefined;
 if(ai==='none')return mismatch?{kind:'diagnostic',mismatch:true,priority:-1}:undefined;
 return {kind:'normal',mismatch,priority:ai==='announcement'?1:0};
}

const clip=(text:string,limit:number)=>[...text].length<=limit?text:[...text].slice(0,Math.max(0,limit-1)).join('')+'…';
const aiLabels:Record<LiveResult['category'],string>={announcement:'💣実施予告・配布 (announcement)',attention:'🍄関連注意 (attention)',limit_change:'📈利用枠・プラン変更 (limit_change)',chatter:'雑談・通知価値なし (chatter)',unrelated:'無関係 (unrelated)'};
const machineEmoji:Record<EffectiveCategory,string>={announcement:'💣',attention:'🍄',limit_change:'📈',none:'—'};
const safeUnavailable=(reason?:string)=>reason&&/^(missing_key|invalid_model|invalid_reasoning|unauthorized|quota_or_rate_limit|upstream_error|model_or_request_error|http_error|bad_json|refused|incomplete|timeout|network_error|ledger_unavailable|result_unavailable|interrupted|disabled)$/.test(reason)?reason:'unavailable';

export function formatLiveNotification(post:Item,machine:Verdict,result:LiveResult|undefined,plan:LiveNotificationPlan,latency:number|null,unavailable?:string):{title:string,message:string} {
 const conventional=machineCategory(machine);
 let title:string;
 if(plan.kind==='diagnostic')title='🔎 判定不一致';
 else if(plan.kind==='fallback')title=alertTitle(machine)+' [AI unavailable]';
 else {
  title=result?.category==='announcement'?'💣 実施予告・配布':result?.category==='limit_change'?'📈 利用枠・プラン変更':'🍄 関連注意報';
  if(conventional==='none')title=(result?.category==='announcement'?'💣':result?.category==='limit_change'?'📈':'🍄')+' AIが発見！';
  if(plan.mismatch)title+=' [判定不一致]';
 }
 const comparison=[`🛠機械: ${machineEmoji[conventional]} ${machine.classification}`,
  result?`🤖AI: ${aiLabels[result.category]}`:`🤖AI: 未判定 (AI unavailable: ${safeUnavailable(unavailable)})`,
  result?`理由: ${clip(result.rationale,240)}`:'AI未判定のため機械式で通知。',
  ...(result?.uncertainty?[`不確実性: ${clip(result.uncertainty,240)}`]:[]),
 ].join('\n');
 // Reuse the established Japanese clock conversion and original post evidence below the comparison.
 const details=alertMessage(post,machine.classification,latency,'',machine).split('\n').slice(1).join('\n');
 const url=post.url?'\n'+clip(post.url,250):'';
 const message=clip(comparison+'\n\n'+details,1024-[...url].length)+url;
 return {title:clip(title,250),message};
}
