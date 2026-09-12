import type {Item} from './types';

interface Zone {key: string; label: string; offset?: number; name?: string}
interface CalendarDate {year: number; month: number; day: number}
interface Clock {hour?: number; minute?: number; expression: string; index: number; reason?: string}
interface Context {text: string; label?: string; zoneText?: string}

const RESET = /\breset(?:s|ting)?\b/i;
const TECHNICAL_RESET = /\b(?:cache|password|database|session|connection|router|device|git|counter|branch) reset\b|\breset(?:ting)? (?:the |a |your )?(?:cache|password|database|session|connection|router|device|git|counter|branch)\b/i;
const QUALITY = /\b(?:fix(?:ed|es|ing)?|quality|deploy(?:ed|ing)?|meeting|benchmark|cache|maintenance)\b/i;
const DAY = 86400_000;

function resetTopic(text: string): boolean {
  return RESET.test(text) || (/(?:🍄|\bmushrooms?\b)/i.test(text)
    && /\b(?:giv\w*|grant\w*|land\w*|arriv\w*|distribut\w*|claim\w*|redeem\w*|available|expir\w*|credit\w*|receiv\w*)\b/i.test(text));
}

// Supported dates: today/tomorrow in an explicit source zone, or YYYY-MM-DD.
// PST/PDT are literal fixed offsets. PT/Pacific Time uses IANA DST rules.
// Missing dates/zones, ambiguous midnight language, DST folds and gaps are not guessed.
function zones(text: string): Zone[] {
  const found = new Map<string, Zone>();
  const pattern = /\b(?:America\/Los_Angeles|Asia\/Tokyo|Pacific(?:\s+(?:Standard|Daylight))?\s+Time|Japan\s+Standard\s+Time|PST|PDT|PT|JST|(?:UTC|GMT)(?:\s*[+−-]\s*\d{1,2}(?::?\d{2})?)?)\b/gi;
  for (const m of text.matchAll(pattern)) {
    const label = m[0], token = label.toUpperCase().replace(/\s+/g, '').replace('−', '-');
    let zone: Zone;
    if (['PT', 'PACIFICTIME', 'AMERICA/LOS_ANGELES'].includes(token)) zone = {key: 'America/Los_Angeles', label, name: 'America/Los_Angeles'};
    else {
      let offset: number;
      if (['PST', 'PACIFICSTANDARDTIME'].includes(token)) offset = -480;
      else if (['PDT', 'PACIFICDAYLIGHTTIME'].includes(token)) offset = -420;
      else if (['JST', 'JAPANSTANDARDTIME', 'ASIA/TOKYO'].includes(token)) offset = 540;
      else {
        const parts = /^(?:UTC|GMT)(?:([+-])(\d{1,2})(?::?(\d{2}))?)?$/.exec(token);
        if (!parts) continue;
        const hours = Number(parts[2] ?? 0), minutes = Number(parts[3] ?? 0);
        if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0)) return [{key: 'invalid', label}];
        offset = (hours * 60 + minutes) * (parts[1] === '-' ? -1 : 1);
      }
      zone = {key: `offset:${offset}`, label, offset};
    }
    found.set(zone.key, zone);
  }
  return [...found.values()];
}

function localParts(epoch: number, zone: Zone) {
  if (zone.offset !== undefined) {
    const d = new Date(epoch + zone.offset * 60_000);
    return {year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes()};
  }
  const parts = new Intl.DateTimeFormat('en-CA', {timeZone: zone.name, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'}).formatToParts(epoch);
  const get = (name: string) => Number(parts.find(p => p.type === name)?.value);
  return {year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute')};
}

function dateFor(text: string, publishedAt: number | null, zone: Zone): CalendarDate | undefined {
  const explicit = [...text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)];
  const relative = [...text.matchAll(/\b(today|tomorrow)\b/gi)].map(m => m[1].toLowerCase());
  if (explicit.length > 1 || new Set(relative).size > 1 || (explicit.length && relative.length)) return undefined;
  if (explicit.length === 1) {
    const [, y, m, d] = explicit[0], year = Number(y), month = Number(m), day = Number(d);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) return undefined;
    return {year, month, day};
  }
  if (relative.length && publishedAt !== null && Number.isFinite(publishedAt)) {
    const local = localParts(publishedAt * 1000, zone);
    const date = new Date(Date.UTC(local.year, local.month - 1, local.day) + (relative[0] === 'tomorrow' ? DAY : 0));
    return {year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate()};
  }
  return undefined;
}

function clocks(text: string): Clock[] {
  const result: Clock[] = [];
  const pattern = /\b(?:midnight|noon|\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)|\d{1,2}:\d{2})\b/gi;
  for (const m of text.matchAll(pattern)) {
    const expression = m[0], index = m.index!;
    if (/(?:UTC|GMT)\s*[+−-]\s*$/i.test(text.slice(0, index))) continue;
    const token = expression.toLowerCase().replace(/[.\s]/g, '');
    if (token === 'midnight') {
      result.push({expression, index, reason: 'midnight は日付の境界が曖昧'});
      continue;
    }
    if (token === 'noon') {result.push({expression, index, hour: 12, minute: 0}); continue;}
    const parts = /^(\d{1,2})(?::(\d{2}))?(am|pm)?$/.exec(token);
    if (!parts) continue;
    let hour = Number(parts[1]); const minute = Number(parts[2] ?? 0), meridiem = parts[3];
    if (minute > 59 || (meridiem ? hour < 1 || hour > 12 : hour > 23)) result.push({expression, index, reason: '時刻表記が不正または曖昧'});
    else if (!meridiem && hour >= 1 && hour <= 12 && !parts[1].startsWith('0')) result.push({expression, index, reason: '午前・午後を確定できない'});
    else {
      if (meridiem) hour = hour % 12 + (meridiem === 'pm' ? 12 : 0);
      result.push({expression, index, hour, minute});
    }
  }
  for (const m of text.matchAll(/\b(?:at|by|around|before|after|until)\s+(\d{1,2})\b(?![:\d])/gi)) {
    const index = m.index! + m[0].lastIndexOf(m[1]);
    if (result.some(c => index >= c.index && index < c.index + c.expression.length)) continue;
    const hour = Number(m[1]);
    result.push(hour > 12 && hour < 24 ? {expression: m[1], index, hour, minute: 0} : {expression: m[1], index, reason: '午前・午後を確定できない'});
  }
  return result.sort((a, b) => a.index - b.index);
}

function clauses(text: string): string[] {
  return text.split(/(?<!\b[ap]\.m\.)(?<=[.!?;])\s+|\n+/i)
    .flatMap(s => s.split(/;|,\s*(?:and|but|however)\s+|\s+(?:and|but)\s+(?=(?:we|the|a|an|it)\b)/i))
    .map(s => s.trim()).filter(Boolean);
}

function resetClauses(text: string): string[] {
  return clauses(text).filter(s => resetTopic(s) && !TECHNICAL_RESET.test(s));
}

function timingSyntax(text: string): boolean {
  return clocks(text).length > 0
    || /\b(?:today|tomorrow|this|next)\s+(?:morning|afternoon|evening|night)\b|\btonight\b|\bin (?:\d+|a few|several) (?:hours?|minutes?)\b/i.test(text)
    || /\b(?:at|by|around|before|after|until)\s+(?!all\b|least\b|most\b|using\b|clicking\b|users?\b|accounts?\b)\S+/i.test(text);
}

function unrelatedClock(text: string): boolean {
  const clock = clocks(text)[0], reset = text.search(RESET);
  // A preceding engineering timestamp cannot become a later reset's timestamp.
  return !!clock && reset > clock.index && QUALITY.test(text.slice(0, clock.index));
}

function contexts(post: Item, evidence?: string): Context[] {
  const own: Context[] = resetClauses(post.text).filter(s => timingSyntax(s) && !unrelatedClock(s)).map(text => ({text}));
  const parts = clauses(post.text);
  for (let i = 1; i < parts.length; i++) {
    // An adjacent claim/redeem instruction expresses the distributed reset's deadline.
    if (resetTopic(parts[i - 1]) && !TECHNICAL_RESET.test(parts[i - 1])
      && /\b(?:claim|redeem|use)\s+(?:it|them|one|your reset)\b/i.test(parts[i])
      && /\b(?:before|by|until)\b/i.test(parts[i]) && timingSyntax(parts[i])) {
      own.push({text: parts[i], zoneText: parts[i - 1], label: '直前の本人によるリセット配布記述'});
    }
  }
  if (own.length) return own;
  // Only a short, time-bearing reply/quote can inherit an explicitly linked reset topic.
  // The parent's date or clock is never substituted for this author's own timing statement.
  if (post.text.length > 220 || !timingSyntax(post.text) || TECHNICAL_RESET.test(post.text)) return [];
  if (evidence && post.text.includes(evidence) && RESET.test(evidence)) return [{text: post.text}];
  const linked = (post.related ?? []).filter(r => (r.relation === 'reply' || r.relation === 'quote')
    && (r.provenance === 'feed' || r.provenance === 'saved') && r.text && r.url
    && resetClauses(r.text).length);
  if (linked.length !== 1) return [];
  const relation = linked[0], resetText = resetClauses(relation.text!).join('\n');
  // Reject a sentence that supplies an unrelated engineering time despite a linked reset.
  if (QUALITY.test(post.text)) return [];
  return [{text: post.text, zoneText: resetText, label: `${relation.relation === 'reply' ? '返信先' : '引用元'} ${relation.url} のリセット記述`}];
}

function instant(date: CalendarDate, clock: Clock, zone: Zone): number[] {
  const wall = Date.UTC(date.year, date.month - 1, date.day, clock.hour!, clock.minute!);
  if (zone.offset !== undefined) return [wall - zone.offset * 60_000];
  const offsets = new Set<number>();
  // Sampling both sides of the local day discovers both offsets around DST transitions.
  for (let hours = -36; hours <= 36; hours += 3) {
    const sample = wall + hours * 3600_000, p = localParts(sample, zone);
    offsets.add(Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - sample);
  }
  const matches: number[] = [];
  for (const offset of offsets) {
    const epoch = wall - offset, p = localParts(epoch, zone);
    if (p.year === date.year && p.month === date.month && p.day === date.day && p.hour === clock.hour && p.minute === clock.minute) matches.push(epoch);
  }
  return matches;
}

function render(context: Context, publishedAt: number | null): string[] {
  const times = clocks(context.text);
  const prefix = times.length ? context.text.slice(0, times[0].index) : context.text;
  const deadline = /\b(?:by|before|until|no later than)\b[^.!?;]*$/i.test(prefix);
  const label = deadline ? 'リセット期限' : 'リセット予定';
  const characters = [...context.text.replace(/\s+/g, ' ').trim()];
  const original = characters.length <= 180 ? characters.join('') : characters.slice(0, 85).join('') + ' … ' + characters.slice(-85).join('');
  const output = [`${label}（原文${context.label ? '・本人の記述' : ''}）: ${original}`];
  let reason = !times.length ? '時刻表現はあるが対応範囲外' : times.length !== 1 ? '複数の時刻があり対応を確定できない' : times[0].reason;
  const ownZones = zones(context.text), inherited = !ownZones.length && context.zoneText ? zones(context.zoneText) : [];
  const candidates = ownZones.length ? ownZones : inherited;
  if (!reason && candidates.length !== 1) reason = candidates.length ? 'タイムゾーンの対応を確定できない' : 'タイムゾーンの明示なし';
  if (!reason && candidates[0].key === 'invalid') reason = 'タイムゾーン表記を解釈できない';
  const zone = candidates[0];
  const date = !reason && zone ? dateFor(context.text, publishedAt, zone) : undefined;
  if (!reason && !date) reason = '日付を確定できない';
  let converted: string | undefined;
  if (!reason && date) {
    const matches = instant(date, times[0], zone);
    if (matches.length !== 1) reason = matches.length ? '夏時間の切り替えで時刻が重複する' : '夏時間の切り替えで存在しない時刻';
    else {
      const p = localParts(matches[0], {key: 'JST', label: 'JST', offset: 540}), pad = (n: number) => String(n).padStart(2, '0');
      converted = `${p.year}/${pad(p.month)}/${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)} JST`;
      if (/\b(?:around|about|approximately)\b/i.test(prefix)) converted += ' 頃';
      if (/\bafter\b/i.test(prefix)) converted += ' より後';
    }
  }
  output.push(`${label}（日本時間）: ${converted ?? `未確定（${reason ?? '解釈できない'}）`}`);
  if (context.label) output.push(`関連付けの根拠: ${context.label}${inherited.length ? `（時区を参照: ${inherited.map(z => z.label).join(' / ')}）` : ''}`);
  else if (converted) output.push(`時区の根拠: 原文の ${zone.label}`);
  return output;
}

/** Adds timing information only; it neither classifies a post nor changes its notification threshold. */
export function resetTiming(post: Item, evidence?: string): string[] {
  try {
    if (post.kind === 'repost' || typeof post.text !== 'string') return [];
    return contexts(post, evidence).slice(0, 2).flatMap(context => {
      try {return render(context, post.publishedAt);}
      catch {return [`リセット時刻（原文）: ${context.text}`, 'リセット時刻（日本時間）: 未確定（時刻を解釈できない）'];}
    });
  } catch {return [];}
}
