import type {Item, RelatedPost, Verdict} from './types';

export interface PostAnalysis {related?: RelatedPost[]; verdict?: Verdict}

/** Resolve only source-declared status IDs, never proximity or an inferred conversation. */
export async function resolveRelated(items: Item[], db: D1Database): Promise<Item[]> {
 const ids=[...new Set(items.flatMap(p=>(p.related??[]).map(r=>r.xStatusId)))];
 if(!ids.length)return items;
 const saved=await db.prepare('SELECT x_status_id,canonical_url,text,published_at FROM posts WHERE x_status_id IN (SELECT value FROM json_each(?))')
  .bind(JSON.stringify(ids)).all<any>();
 return items.map(post=>({...post,related:post.related?.map(related=>{
  const matches=(id:string|null,url:string|null)=>id===related.xStatusId&&(url===related.url||related.url===`https://x.com/i/status/${id}`);
  const current=items.find(p=>matches(p.xStatusId,p.url));
  if(current)return {...related,url:current.url!,text:related.text??current.text,author:'thsottiaux',publishedAt:related.publishedAt??current.publishedAt,provenance:'feed' as const};
  const row=saved.results.find(p=>matches(p.x_status_id,p.canonical_url));
  return row?{...related,url:row.canonical_url,text:related.text??row.text,author:'thsottiaux',publishedAt:related.publishedAt??row.published_at,provenance:related.text?related.provenance:'saved' as const}:related;
 })}));
}

export function saveAnalysis(db:D1Database,post:Item,verdict:Verdict,now:number):D1PreparedStatement {
 return db.prepare('INSERT OR IGNORE INTO events VALUES(?,?,?,?)').bind(`analysis:${post.id}`,'post_analysis',now,
  JSON.stringify({related:post.related,verdict} satisfies PostAnalysis));
}

export async function readAnalysis(db:D1Database,id:string):Promise<PostAnalysis> {
 const row=await db.prepare('SELECT details FROM events WHERE id=?').bind(`analysis:${id}`).first<{details:string}>();
 if(!row)return {};
 try{return JSON.parse(row.details) as PostAnalysis;}catch{return {};}
}
