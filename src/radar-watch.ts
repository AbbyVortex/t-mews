import type {LiveResult} from './ai-live-classifier';
import {resetScheduledAt} from './reset-time';
import type {Item, Verdict} from './types';

export interface RadarSignal {
  version: 1;
  id: string;
  kind: 'hint' | 'announcement';
  publishedAt: number;
  observedAt: number;
  dueAt: number | null;
}

export function radarSignal(post: Item, machine: Verdict, detected: number, now: number, ai?: LiveResult): RadarSignal | null {
  if (post.kind === 'repost' || post.publishedAt === null || post.publishedAt > detected + 60) return null;
  if (machine.change === 'cancelled' || machine.change === 'denied') return null;
  const due = resetScheduledAt(post, machine.evidence);
  const dueAt = due !== null && due > now * 1000 ? due : null;
  if (!dueAt && (now - post.publishedAt > 3600 || machine.change === 'postponed' || machine.change === 'corrected')) return null;

  let kind: RadarSignal['kind'];
  if (ai) {
    if (!ai.startsResetWatch) return null;
    if (ai.category === 'announcement') kind = 'announcement';
    else if (ai.category === 'attention' && ai.allowanceScope === 'not_applicable') kind = 'hint';
    else return null;
  } else if (machine.display === 'announcement' && (machine.classification === 'RESET_ANNOUNCED' || machine.classification === 'BANKED_RESET')) {
    kind = 'announcement';
  } else if (machine.classification === 'RESET_HINT' || (dueAt && machine.change)) {
    kind = 'hint';
  } else return null;
  return {version: 1, id: post.id, kind, publishedAt: post.publishedAt * 1000, observedAt: detected * 1000, dueAt};
}

// Delayed AI decisions or a late RSS item must not replace a newer post.
export function saveRadarSignal(db: D1Database, signal: RadarSignal) {
  return db.prepare(`INSERT INTO state(key,value) VALUES('radarWatch',?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
    WHERE (json_extract(excluded.value,'$.publishedAt'),json_extract(excluded.value,'$.id'))
        > (json_extract(state.value,'$.publishedAt'),json_extract(state.value,'$.id'))`).bind(JSON.stringify(signal));
}
