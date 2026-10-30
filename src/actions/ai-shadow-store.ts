import {readBoundedJson,validateShadowState,type ShadowState,type ShadowStore} from '../ai-shadow';

/** Separate file/CAS; never writes the conventional state.json or creates a branch. */
export class GitHubShadowStore implements ShadowStore {
 private sha:string|undefined;
 private loaded=false;
 constructor(private repo:string,private token:string,private fetcher:typeof fetch=fetch) {}
 private async api(method:string,signal:AbortSignal,body?:unknown):Promise<Response> {
  if(!/^[\w.-]+\/[\w.-]+$/.test(this.repo)||!this.token)throw new Error('shadow_store_config');
  const path=`https://api.github.com/repos/${this.repo}/contents/ai-shadow.json`;
  return this.fetcher(path+(method==='GET'?'?ref=monitor-state':''),{method,
   headers:{Authorization:`Bearer ${this.token}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'},
   body:body===undefined?undefined:JSON.stringify(body),signal,redirect:'error'});
 }
 async load(signal:AbortSignal):Promise<ShadowState|undefined> {
  const r=await this.api('GET',signal);
  if(r.status===404){void r.body?.cancel().catch(()=>{});this.sha=undefined;this.loaded=true;return undefined;}
  if(!r.ok){void r.body?.cancel().catch(()=>{});throw new Error('shadow_load_failed');}
  const file=await readBoundedJson(r,400000);
  if(file.encoding!=='base64'||typeof file.content!=='string'||typeof file.sha!=='string')throw new Error('invalid_shadow_file');
  const bytes=Buffer.from(file.content,'base64');
  if(bytes.length>256000)throw new Error('shadow_size_limit');
  const state=validateShadowState(JSON.parse(bytes.toString('utf8')));
  this.sha=file.sha;this.loaded=true;return state;
 }
 async save(state:ShadowState,signal:AbortSignal):Promise<void> {
  if(!this.loaded)throw new Error('shadow_not_loaded');
  const text=JSON.stringify(validateShadowState(state),null,2)+'\n';
  if(Buffer.byteLength(text)>256000)throw new Error('shadow_size_limit');
  const r=await this.api('PUT',signal,{message:'Update optional AI shadow comparison',branch:'monitor-state',
   content:Buffer.from(text).toString('base64'),...(this.sha?{sha:this.sha}:{})});
  if(!r.ok){void r.body?.cancel().catch(()=>{});throw new Error('shadow_save_failed');}
  const result=await readBoundedJson(r,32000);
  if(typeof result.content?.sha!=='string')throw new Error('shadow_save_unknown');
  this.sha=result.content.sha;
 }
}
