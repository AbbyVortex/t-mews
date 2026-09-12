import {classify} from '../classifier';
import {readState} from '../monitor';
import {alertMessage, jst, notify, titles} from '../pushover';
import type {Env, Fetcher, Item} from '../types';

/** Operator-selected recovery of one recent, never-attempted alert. No feed polling or backlog replay. */
export async function recoverAlert(env: Env, postId: string | undefined, now: number, fetcher: Fetcher) {
  if (!postId || !/^x:\d+$/.test(postId)) throw new Error('Recovery requires one X post ID');
  const state = await readState(env.DB);
  if (!Number.isFinite(state.baselineAt) || state.baselineAt > now) throw new Error('Valid existing baseline required');
  const row = await env.DB.prepare('SELECT * FROM posts WHERE id=?').bind(postId).first<any>();
  if (!row) throw new Error('Recovery post is not in the existing state');
  const attempted = await env.DB.prepare('SELECT status FROM notifications WHERE id=? OR post_id=? LIMIT 1')
    .bind(`post:${postId}`, postId).first<{status: string}>();
  if (attempted) {
    if (attempted.status === 'sent') return {mode: 'recover', postId, status: 'already_sent'};
    throw new Error('Previous delivery attempt exists; refusing to resend');
  }
  if (row.baseline !== 0 || row.notified !== 0 || row.notification_status !== 'not_relevant'
    || !['IRRELEVANT', 'CANDIDATE'].includes(row.classification) || row.kind === 'repost'
    || !Number.isFinite(row.published_at) || row.published_at <= state.baselineAt
    || row.published_at < now - 86400 || row.published_at > now
    || row.x_status_id !== postId.slice(2) || row.canonical_url !== `https://x.com/thsottiaux/status/${postId.slice(2)}`) {
    throw new Error('Post is not eligible for recent missed-alert recovery');
  }
  const verdict = classify(row.text);
  if (!verdict.notify) throw new Error('Current classifier does not approve this alert');
  const post: Item = {id: row.id, xStatusId: row.x_status_id, url: row.canonical_url, fingerprint: row.fingerprint,
    text: row.text, publishedAt: row.published_at, source: row.source, kind: row.kind};
  await env.DB.batch([
    env.DB.prepare('UPDATE posts SET classification=?,reason=? WHERE id=?').bind(verdict.classification, verdict.reason, postId),
    env.DB.prepare('INSERT OR IGNORE INTO events VALUES(?,?,?,?)').bind(`recovery:${postId}`, 'alert_recovery_requested', now,
      JSON.stringify({postId, previousClassification: row.classification, classification: verdict.classification}))
  ]);
  const note = `分類修正により遅れてお知らせしています。\n通知処理: ${jst(now)}（投稿から${Math.floor((now - row.published_at) / 60)}分後）\n`;
  // The caller's safeFetch persists this classification and notify's sending claim before delivery.
  await notify(env, `post:${postId}`, 'alert', titles[verdict.classification]!,
    alertMessage(post, verdict.classification, row.detection_latency_seconds, note), now, fetcher, post, verdict.classification);
  const delivery = await env.DB.prepare('SELECT status FROM notifications WHERE id=?').bind(`post:${postId}`).first<{status: string}>();
  if (delivery?.status !== 'sent') throw new Error('Recovery delivery failed or uncertain; no automatic resend');
  return {mode: 'recover', postId, status: 'sent'};
}
