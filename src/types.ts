export interface Source { name: string; url: string }
export interface Env { DB: D1Database; PUSHOVER_USER_KEY?: string; PUSHOVER_APP_TOKEN?: string; MONITOR_ENABLED: string; EXPERIMENT_END_AT?: string; SOURCES_JSON: string; SOURCE_BASELINE_KEY?: string }
export interface RelatedPost { relation: 'reply' | 'quote'; xStatusId: string; url: string; text?: string; author?: string; publishedAt?: number | null; provenance: 'feed' | 'saved' }
export interface Item { id: string; xStatusId: string | null; url: string | null; fingerprint: string; text: string; publishedAt: number | null; source: string; kind: 'post' | 'reply' | 'repost' | 'unknown'; related?: RelatedPost[] }
export type Classification = 'RESET_ANNOUNCED' | 'RESET_HINT' | 'BANKED_RESET' | 'LIMIT_CHANGE' | 'CANDIDATE' | 'IRRELEVANT';
export interface Verdict { classification: Classification; notify: boolean; reason: string; display?: 'announcement' | 'advisory' | 'limit'; change?: 'postponed' | 'cancelled' | 'corrected' | 'denied'; evidence?: string }
export type Fetcher = typeof fetch;
