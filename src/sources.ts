import { XMLParser, XMLValidator } from 'fast-xml-parser';
import he from 'he';
import type { Item, RelatedPost, Source, Fetcher } from './types';
const array = (x: any): any[] => x == null ? [] : Array.isArray(x) ? x : [x];
const value = (x: any): string => typeof x === 'string' ? x : x?.['#text'] ?? '';
export function plain(s: string): string {
 return he.decode(s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,'').replace(/<br\s*\/?\s*>|<\/p>/gi,'\n').replace(/<[^>]*>/g,'')).replace(/\r/g,'').replace(/[ \t]+/g,' ').replace(/\n{3,}/g,'\n\n').trim();
}
async function hash(s: string) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)))].map(x=>x.toString(16).padStart(2,'0')).join(''); }
function statusReference(raw: string, source: Source): Pick<RelatedPost,'xStatusId'|'url'|'author'> | undefined {
 try {
  const u=new URL(he.decode(raw));
  const hosts=new Set(['x.com','www.x.com','twitter.com','www.twitter.com','fxtwitter.com','fixupx.com',new URL(source.url).hostname]);
  const match=u.pathname.match(/^\/([\w]+)\/status\/(\d+)\/?$/);
  if(u.protocol!=='https:' || !hosts.has(u.hostname) || !match) return;
  const author=match[1].toLowerCase()==='i' ? undefined : match[1];
  return {xStatusId:match[2],url:`https://x.com/${author??'i'}/status/${match[2]}`,...(author?{author}:{})};
 } catch { return; }
}
function relatedPosts(row: any, content: string, source: Source, namespaces: any): RelatedPost[] {
 const related: RelatedPost[]=[];
 // FxTwitter represents quoted posts as a blockquote containing the original status link.
 // Ordinary body links and neighboring feed items are not evidence of a relationship.
 for(const quote of content.matchAll(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote\s*>/gi)) {
  const refs=[...quote[1].matchAll(/<a\b[^>]*\s+href\s*=\s*(["'])(.*?)\1[^>]*>/gi)]
   .map(link=>statusReference(link[2],source)).filter((ref): ref is NonNullable<typeof ref>=>!!ref);
  const ids=new Set(refs.map(ref=>ref.xStatusId));
  if(ids.size!==1) continue;
  const ref=refs[0], text=plain(quote[1]);
  related.push({...ref,relation:'quote',...(text?{text}:{}),provenance:'feed'});
 }
 // Atom Threading (RFC 4685) supplies an explicit parent identifier; its namespace
 // prefix is arbitrary. RSS without this metadata cannot establish a reply parent.
 const scope={...namespaces,...row};
 for(const key of Object.keys(row).filter(key=>key.endsWith(':in-reply-to'))) for(const parent of array(row[key])) {
  const prefix=key.slice(0,-':in-reply-to'.length);
  if((parent?.[`@_xmlns:${prefix}`]??scope[`@_xmlns:${prefix}`])!=='http://purl.org/syndication/thread/1.0') continue;
  const href=statusReference(parent?.['@_href']??'',source);
  const ref=statusReference(parent?.['@_ref']??'',source);
  if(href&&ref&&href.xStatusId!==ref.xStatusId) continue;
  const target=href??ref;
  if(target) related.push({...target,relation:'reply',provenance:'feed'});
 }
 return related.filter((ref,index)=>related.findIndex(other=>other.relation===ref.relation&&other.xStatusId===ref.xStatusId)===index);
}
export async function parseFeed(xml: string, source: Source): Promise<Item[]> {
 if (xml.length > 1_000_000 || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('unsafe_xml');
 if (XMLValidator.validate(xml.trim()) !== true) throw new Error('invalid_xml');
 const doc = new XMLParser({ignoreAttributes:false,parseTagValue:false,processEntities:true}).parse(xml.trim());
 const feed = doc.rss?.channel ?? doc.feed;
 if (!feed) throw new Error('not_rss_or_atom');
 if (/not yet whitelist|access denied|verify you are|captcha/i.test(value(feed.title))) throw new Error('source_notice');
 const rows = array(feed.item ?? feed.entry);
 if (!rows.length || rows.length > 200) throw new Error('empty_or_oversized_feed');
 const items: Item[] = [];
 for (const row of rows) {
  const link = array(row.link).find(x=>typeof x==='string' || x['@_rel'] === 'alternate' || !x['@_rel']);
  const rawUrl = typeof link === 'string' ? link : link?.['@_href'] ?? value(row.guid) ?? value(row.id);
  let url: string | null = null, xStatusId: string | null = null;
  try { const u=new URL(rawUrl || value(row.guid) || value(row.id)); const m=u.pathname.match(/^\/([^/]+)\/status\/(\d+)/); if(m) { if(m[1].toLowerCase()!=='thsottiaux') continue; xStatusId=m[2];url=`https://x.com/thsottiaux/status/${xStatusId}`; } else if(u.protocol==='https:') url=u.href.split('#')[0].split('?')[0]; } catch {}
  const author = plain(value(row['dc:creator']) || value(row.author?.name));
  if (author && /@/.test(author) && !/@thsottiaux\b/i.test(author)) continue;
  if (!xStatusId && !/thsottiaux/i.test(author+' '+value(feed.title)+' '+value(feed.link))) continue;
  const title=plain(value(row.title));
  const content=value(row['content:encoded']) || value(row.content) || value(row.description) || value(row.summary) || title;
  const text=plain(content.replace(/<blockquote\b[^>]*>[\s\S]*?<\/blockquote>/gi,''));
  const related=relatedPosts(row,content,source,{...doc.rss,...feed});
  if ((!text&&!related.length) || /RSS reader not yet whitelist/i.test(text)) continue;
  const date=Date.parse(value(row.pubDate) || value(row.published) || value(row.updated));
  const publishedAt=Number.isFinite(date) ? Math.floor(date/1000) : null;
  const fingerprint=await hash(text.toLowerCase().replace(/\s+/g,' ').trim()+'|'+(publishedAt??''));
  const kind = /^(RT |R[Tt] by |Reposted)/.test(title) ? 'repost' : related.some(ref=>ref.relation==='reply') || /^(R to |Replying to |@\w+)/.test(title) ? 'reply' : xStatusId ? 'post' : 'unknown';
  items.push({id:xStatusId ? `x:${xStatusId}` : url ? `url:${await hash(url)}` : `hash:${fingerprint}`,xStatusId,url,fingerprint,text,publishedAt,source:source.name,kind,...(related.length?{related}:{})});
 }
 if (!items.length) throw new Error('no_tibo_items');
 return items;
}
export function sources(json: string): Source[] {
 const parsed=JSON.parse(json) as Source[];
 if (!Array.isArray(parsed) || !parsed.length || parsed.length>5) throw new Error('invalid_source_config');
 const seen=new Set<string>();
 for(const s of parsed) { const u=new URL(s.url); if(u.protocol!=='https:' || !s.name || seen.has(s.name)) throw new Error('invalid_source_config'); seen.add(s.name); }
 return parsed;
}
export async function fetchSource(source: Source, fetcher: Fetcher = fetch): Promise<Item[]> {
 const r = await fetcher(source.url,{headers:{Accept:'application/rss+xml, application/atom+xml, application/xml, text/xml','User-Agent':'T-MEWS/0.1 public RSS experiment'},signal:AbortSignal.timeout(8000)});
 if (!r.ok) throw new Error(`http_${r.status}`);
 if (!r.body) throw new Error('empty_body');
 const reader=r.body.getReader(); const decoder=new TextDecoder(); let xml='',bytes=0;
 try { for (;;) { const {done,value}=await reader.read(); if(done)break;bytes+=value.length;if(bytes>1_000_000)throw new Error('feed_too_large');xml+=decoder.decode(value,{stream:true}); } xml+=decoder.decode(); } finally { await reader.cancel(); }
 return parseFeed(xml,source);
}
