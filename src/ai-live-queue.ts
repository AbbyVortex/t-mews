export interface LiveQueueEntry {id:string;queuedAt:number;fallback?:{code:string;at:number}}
export const LIVE_QUEUE_KEY='aiLiveQueue';
export function parseLiveQueue(value:unknown):LiveQueueEntry[] {
 if(value===undefined)return [];
 if(!Array.isArray(value)||value.some(e=>!e||typeof e.id!=='string'||!Number.isSafeInteger(e.queuedAt))||new Set(value.map(e=>e.id)).size!==value.length)throw Error('invalid_live_queue');
 return structuredClone(value);
}
export async function readLiveQueue(db:D1Database):Promise<LiveQueueEntry[]> {
 const row=await db.prepare('SELECT value FROM state WHERE key=?').bind(LIVE_QUEUE_KEY).first<{value:string}>();
 return parseLiveQueue(row?JSON.parse(row.value):undefined);
}
export const writeLiveQueue=(db:D1Database,queue:LiveQueueEntry[])=>db.prepare('INSERT INTO state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(LIVE_QUEUE_KEY,JSON.stringify(queue));
