import type {Snapshot} from './sqlite';
const branch='monitor-state';
export class GitHubStateStore {
 private sha:string|undefined;
 private previous='';
 constructor(private repo:string,private token:string,private fetcher:typeof fetch=fetch) {
  if(!/^[\w.-]+\/[\w.-]+$/.test(repo)||!token)throw new Error('GitHub repository/token missing');
 }
 private async api(path:string,method='GET',body?:unknown,allow404=false):Promise<any> {
  const r=await this.fetcher(`https://api.github.com/repos/${this.repo}${path}`,{method,headers:{Authorization:`Bearer ${this.token}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
  if(allow404&&r.status===404)return null;
  if(!r.ok)throw new Error(`GitHub state request failed (${r.status}); no automatic overwrite`);
  return r.json();
 }
 async load(initialize=false):Promise<Snapshot|undefined> {
  const repo=await this.api('');
  if(repo.private!==false)throw new Error('Only public repositories with standard runners are supported');
  let ref=await this.api(`/git/ref/heads/${branch}`,'GET',undefined,true);
  if(!ref) {
   if(!initialize)throw new Error('State branch missing; refusing to recreate baseline');
   const base=await this.api(`/git/ref/heads/${encodeURIComponent(repo.default_branch)}`);
   await this.api('/git/refs','POST',{ref:`refs/heads/${branch}`,sha:base.object.sha});
  }
  const file=await this.api(`/contents/state.json?ref=${branch}`,'GET',undefined,true);
  if(!file) {
   if(!initialize)throw new Error('State file missing; refusing to recreate baseline');
   return undefined;
  }
  if(file.encoding!=='base64')throw new Error('Unsupported or oversized state');
  this.sha=file.sha;this.previous=Buffer.from(file.content,'base64').toString('utf8');
  return JSON.parse(this.previous);
 }
 async save(snapshot:Snapshot):Promise<void> {
  const text=JSON.stringify(snapshot,null,2)+'\n';
  if(text===this.previous)return;
  if(Buffer.byteLength(text)>900_000)throw new Error('State size limit reached; no push sent');
  const result=await this.api('/contents/state.json','PUT',{message:'Update monitor state',branch,content:Buffer.from(text).toString('base64'),...(this.sha?{sha:this.sha}:{})});
  this.sha=result.content.sha;this.previous=text;
 }
}
