import {enrichParent} from './shadow-context';
import {readBoundedJson,within,type ShadowCandidate,type ShadowRelated} from './ai-shadow';

const validTime=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;

/** Fill only the explicitly identified parent/quotes; never infer a conversation link. */
export async function enrichLiveContext(candidate:ShadowCandidate,fetcher:typeof fetch,signal:AbortSignal):Promise<ShadowCandidate> {
 const result=await enrichParent(candidate,fetcher,signal);
 result.related=result.related.slice(0,2);
 const quoteIndexes=result.related.map((reference,index)=>reference.relation==='quote'?index:-1).filter(index=>index>=0);
 if(!quoteIndexes.length)return result;
 const phase=new AbortController(),phaseTimer=setTimeout(()=>phase.abort(),8000);
 const phaseSignal=AbortSignal.any([signal,phase.signal]);
 const statuses:string[]=[];
 try {
  for(const index of quoteIndexes){
   const reference=result.related[index],id=reference.id?.match(/^x:(\d{2,20})$/)?.[1];
   const label=id?`x:${id}`:'unknown';
   if(reference.text?.trim()){statuses.push(`${label}=present`);continue;}
   if(!id){statuses.push(`${label}=unavailable`);continue;}
   if(reference.id===candidate.id){statuses.push(`${label}=identity_mismatch`);continue;}
   if(phaseSignal.aborted){statuses.push(`${label}=timeout`);continue;}
   const request=new AbortController(),requestTimer=setTimeout(()=>request.abort(),4000);
   const requestSignal=AbortSignal.any([phaseSignal,request.signal]);
   try {
    const quote=await within(requestSignal,async()=>{
     const response=await fetcher(`https://api.fxtwitter.com/2/status/${id}`,{headers:{Accept:'application/json','User-Agent':'T-MEWS/0.1 public live context'},signal:requestSignal,redirect:'error'});
     if(!response.ok){void response.body?.cancel().catch(()=>{});throw Error('unavailable');}
     const data=await readBoundedJson(response,64000);
     if(data?.code!==200||data.status?.type!=='status')throw Error('unavailable');
     if(data.status.id!==id)throw Error('identity_mismatch');
     return data.status;
    });
    const author=quote.author?.screen_name;
    if(typeof author!=='string'||!/^\w{1,80}$/.test(author)
     ||(reference.author&&author.toLowerCase()!==reference.author.replace(/^@/,'').toLowerCase())
     ||(validTime(quote.created_timestamp)&&validTime(candidate.publishedAt)&&quote.created_timestamp>candidate.publishedAt))throw Error('identity_mismatch');
    if(typeof quote.text!=='string'||!quote.text.trim())throw Error('unavailable');
    const evidence:ShadowRelated={...reference,relation:'quote',id:`x:${id}`,url:`https://x.com/${author}/status/${id}`,
     author,text:quote.text.slice(0,500),publishedAt:validTime(quote.created_timestamp)?quote.created_timestamp:null,source:'fxtwitter-api-v2'};
    result.related[index]=evidence;statuses.push(`${label}=fetched`);
   }catch(error){
    const code=error instanceof Error?error.message:'';
    statuses.push(`${label}=${requestSignal.aborted?'timeout':['unavailable','identity_mismatch'].includes(code)?code:'error'}`);
   }finally{clearTimeout(requestTimer);}
  }
 }finally{phase.abort();clearTimeout(phaseTimer);}
 result.parentStatus=(result.parentStatus??'not_provided')+';quote:'+statuses.join(',');
 return result;
}
