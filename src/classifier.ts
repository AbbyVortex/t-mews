import type { Verdict } from './types';
export function classify(text: string): Verdict {
 const t = text.toLowerCase().replace(/[’‘]/g, "'");
 const result = (classification: Verdict['classification'], reason: string): Verdict => ({classification, notify: !['CANDIDATE','IRRELEVANT'].includes(classification), reason});
 const reset = /\breset(?:s|ting)?\b/.test(t);
 const context = /\b(codex|chatgpt\s*work|usage|limits?|quota|allowance|subscriptions?|paid plans?)\b/.test(t) || (reset && /\b(?:all|global) reset\b.{0,30}\beveryone\b/.test(t));
 const technicalReset = /\b(reset(?:ting)? (?:the )?(?:password|branch|cache|database|connection|counter|git|session|repository)|git reset)\b/.test(t);
 const banked = /\bbanked resets?\b/.test(t) || (reset && /\b(grants?|eligib\w*|expir\w*|compensat\w*|promotion\w*|distribut\w*)\b/.test(t) && context);
 if (banked && /\b(giv\w*|grant\w*|receiv\w*|distribut\w*|roll\w*|availab\w*|eligib\w*|expir\w*|chang\w*|compensat\w*|promotion\w*|claim\w*|paid|subscribers?|everyone|users?|get)\b/.test(t)) return result('BANKED_RESET','banked reset distribution or material rules');
 if (technicalReset && !/\b(usage limits?|quota|allowance)\b/.test(t)) return result('IRRELEVANT','technical reset unrelated to allowance');
 const forward = /\b(soon|tomorrow|tonight|today|later|around|in a while|who says|next|this (?:morning|evening|week)|at \d|on (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|\d{4}-\d{2}-\d{2})\b|👀/.test(t);
 const denial = /\b(won't|will not|not going to|no plans to|can't|cannot|don't|do not)\b/.test(t) && !/who says/.test(t);
 const explicit = /\b(reset(?:ting)? (?:the |your |all |everyone's )?(?:usage(?: limits?)?|limits?|quotas?|allowances?)|(?:i'll|i will|we'll|we will) reset|(?:limits?|usage|quota|allowance).{0,35}(?:will(?: be)?|are being|is being) reset|global reset (?:of )?(?:the )?usage|all reset for everyone)\b/.test(t);
 if (reset && context && explicit && !denial && !/\b(if|might|maybe|could|can you|will you|would you)\b|\?/.test(t)) return result('RESET_ANNOUNCED','explicit usage reset statement');
 if (reset && forward && !denial && (context || /who says|in a while/.test(t))) return result('RESET_HINT','forward-looking reset hint');
 const allowance = /\b(usage limits?|quota|allowance|usage consumption|rate limits?)\b/.test(t) || (/\busage\b/.test(t) && /\b(subscription|weekly|5[ -]hour|five[ -]hour)\b/.test(t));
 const change = /\b(increas\w*|decreas\w*|doubl\w*|tripl\w*|reduc\w*|rais\w*|lower\w*|chang\w*|boost\w*|more|less|fewer)\b|\d+\s*%/.test(t);
 if (allowance && change && /\b(codex|chatgpt|paid|plan|subscription|weekly|5[ -]hour|five[ -]hour)\b/.test(t) && !denial) return result('LIMIT_CHANGE','material allowance or consumption change');
 if ((reset && (context || banked)) || (context && forward && /\b(limits?|quota|allowance)\b/.test(t))) return result('CANDIDATE','possible usage signal below push threshold');
 return result('IRRELEVANT','no usage reset or material allowance signal');
}
