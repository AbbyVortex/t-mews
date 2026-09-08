export interface Source { name: string; url: string }
export interface Env { DB: D1Database; PUSHOVER_USER_KEY?: string; PUSHOVER_APP_TOKEN?: string; MONITOR_ENABLED: string; EXPERIMENT_END_AT?: string; SOURCES_JSON: string }
export interface Item { id: string; xStatusId: string | null; url: string | null; fingerprint: string; text: string; publishedAt: number | null; source: string; kind: 'post' | 'reply' | 'repost' | 'unknown' }
export type Classification = 'RESET_ANNOUNCED' | 'RESET_HINT' | 'BANKED_RESET' | 'LIMIT_CHANGE' | 'CANDIDATE' | 'IRRELEVANT';
export interface Verdict { classification: Classification; notify: boolean; reason: string }
export type Fetcher = typeof fetch;
