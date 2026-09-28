import type {Snapshot} from './sqlite';

export interface PublicRssStatus {
 version:1;
 lastRssSuccessAt:number|null;
 lastRssAttemptAt:number|null;
 sourceState:'online'|'offline'|'unknown';
 error:string|null;
}
const timestamp=(value:unknown):number|null=>typeof value==='number'&&Number.isSafeInteger(value)&&value>0?value:null;
const errorCode=(value:unknown):string|null=>typeof value==='string'&&/^(http_[1-5]\d\d|unsafe_xml|invalid_xml|not_rss_or_atom|source_notice|empty_or_oversized_feed|no_tibo_items|empty_body|feed_too_large|fetch_or_parse_failed)$/.test(value)?value:null;

// This projection contains only public RSS health. It never copies arbitrary state,
// posts, credentials, local sessions or upstream response bodies.
export function publicRssStatus(snapshot:Pick<Snapshot,'tables'>):PublicRssStatus {
 const health=snapshot.tables.source_health??[];
 const successes=health.map(h=>timestamp(h.last_success_at)).filter((n):n is number=>n!==null);
 const attempts=health.flatMap(h=>[timestamp(h.last_success_at),timestamp(h.last_failure_at)]).filter((n):n is number=>n!==null);
 const lastRssSuccessAt=successes.length?Math.max(...successes):null;
 const lastRssAttemptAt=attempts.length?Math.max(...attempts):null;
 const online=lastRssAttemptAt!==null&&health.some(h=>h.state==='online'&&timestamp(h.last_success_at)===lastRssAttemptAt);
 const failure=lastRssAttemptAt===null?undefined:health.find(h=>h.state==='offline'&&timestamp(h.last_failure_at)===lastRssAttemptAt);
 return {version:1,lastRssSuccessAt,lastRssAttemptAt,sourceState:online?'online':failure?'offline':'unknown',error:online?null:errorCode(failure?.error)};
}
