import {readBoundedJson} from '../ai-shadow';

export interface LiveRecordStore {
 load(id:string,signal?:AbortSignal):Promise<Record<string,any>|undefined>;
 save(id:string,record:Record<string,any>,signal?:AbortSignal):Promise<void>;
}

const recordLimit=128_000;
const envelopeLimit=256_000;
const requestMs=8000;
const validId=(id:string)=>/^x:\d{1,30}$/.test(id)||/^probe:[A-Za-z0-9_-]{1,100}$/.test(id);
function validate(id:string,value:any):Record<string,any> {
 if(!value||typeof value!=='object'||Array.isArray(value)||value.version!==1||value.id!==id
  ||!['claimed','decided','complete'].includes(value.status))throw Error('invalid_live_record');
 return value;
}

/** One permanent comparison record per post, independent of legacy and normal state files. */
export class GitHubLiveStore implements LiveRecordStore {
 private versions=new Map<string,{sha?:string;text?:string}>();
 private busy=new Set<string>();
 constructor(private repo:string,private token:string,private fetcher:typeof fetch=fetch) {}

 private async request<T>(id:string,signal:AbortSignal|undefined,operation:(signal:AbortSignal,path:string)=>Promise<T>):Promise<T> {
  if(!validId(id))throw Error('invalid_live_id');
  if(!/^[\w.-]+\/[\w.-]+$/.test(this.repo)||!this.token.trim())throw Error('live_store_config');
  if(this.busy.has(id))throw Error('live_store_busy');
  this.busy.add(id);
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),requestMs);
  const active=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
  const path=`https://api.github.com/repos/${this.repo}/contents/ai-live/posts/${id.replace(':','-')}.json`;
  let onAbort=()=>{};
  try {
   active.throwIfAborted();
   const aborted=new Promise<never>((_resolve,reject)=>{
    onAbort=()=>reject(Error('live_store_timeout'));active.addEventListener('abort',onAbort,{once:true});
   });
   return await Promise.race([operation(active,path),aborted]);
  }catch(error){
   const code=error instanceof Error?error.message:'';
   if(active.aborted)throw Error('live_store_timeout');
   throw Error(['invalid_live_file','invalid_live_record','live_store_size_limit','live_load_failed','live_save_failed','live_store_conflict','live_save_unknown'].includes(code)?code:'live_store_network_error');
  }finally{clearTimeout(timer);active.removeEventListener('abort',onAbort);this.busy.delete(id);}
 }

 private headers() {return {Authorization:`Bearer ${this.token}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'};}
 async load(id:string,signal?:AbortSignal):Promise<Record<string,any>|undefined> {
  if(!validId(id))throw Error('invalid_live_id');
  if(this.busy.has(id))throw Error('live_store_busy');
  this.versions.delete(id);
  return this.request(id,signal,async(active,path)=>{
   const response=await this.fetcher(path+'?ref=monitor-state',{headers:this.headers(),method:'GET',signal:active,redirect:'error'});
   active.throwIfAborted();
   if(response.status===404){void response.body?.cancel().catch(()=>{});this.versions.set(id,{});return undefined;}
   if(!response.ok){void response.body?.cancel().catch(()=>{});throw Error('live_load_failed');}
   let file:any;
   try{file=await readBoundedJson(response,envelopeLimit);}catch{throw Error('invalid_live_file');}
   if(file.encoding!=='base64'||typeof file.content!=='string'||typeof file.sha!=='string'||!file.sha.length)throw Error('invalid_live_file');
   const bytes=Buffer.from(file.content,'base64');
   if(bytes.length>recordLimit)throw Error('live_store_size_limit');
   let record:Record<string,any>;
   try{record=validate(id,JSON.parse(bytes.toString('utf8')));}catch{throw Error('invalid_live_record');}
   active.throwIfAborted();
   this.versions.set(id,{sha:file.sha,text:JSON.stringify(record,null,2)+'\n'});
   return record;
  });
 }

 async save(id:string,record:Record<string,any>,signal?:AbortSignal):Promise<void> {
  if(!validId(id))throw Error('invalid_live_id');
  if(!this.versions.has(id))throw Error('live_not_loaded');
  if(this.busy.has(id))throw Error('live_store_busy');
  let text:string;
  try{text=JSON.stringify(validate(id,record),null,2)+'\n';}catch{throw Error('invalid_live_record');}
  if(Buffer.byteLength(text)>recordLimit)throw Error('live_store_size_limit');
  const current=this.versions.get(id)!;
  if(current.text===text)return;
  try{
   await this.request(id,signal,async(active,path)=>{
    const response=await this.fetcher(path,{method:'PUT',headers:this.headers(),signal:active,redirect:'error',body:JSON.stringify({
     message:'Update production AI notification record',branch:'monitor-state',content:Buffer.from(text).toString('base64'),...(current.sha?{sha:current.sha}:{})
    })});
    if(!response.ok){void response.body?.cancel().catch(()=>{});throw Error(response.status===409||response.status===422?'live_store_conflict':'live_save_failed');}
    let result:any;
    try{result=await readBoundedJson(response,32_000);}catch{throw Error('live_save_unknown');}
    if(typeof result.content?.sha!=='string'||!result.content.sha.length)throw Error('live_save_unknown');
    active.throwIfAborted();
    this.versions.set(id,{sha:result.content.sha,text});
   });
  }catch(error){this.versions.delete(id);throw error;}
 }
}
