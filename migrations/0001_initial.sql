CREATE TABLE posts (
 id TEXT PRIMARY KEY, x_status_id TEXT UNIQUE, canonical_url TEXT UNIQUE,
 fingerprint TEXT NOT NULL, published_at INTEGER, detected_at INTEGER NOT NULL,
 text TEXT NOT NULL, source TEXT NOT NULL, kind TEXT NOT NULL,
 classification TEXT NOT NULL, reason TEXT NOT NULL, baseline INTEGER NOT NULL DEFAULT 0,
 notified INTEGER NOT NULL DEFAULT 0, notification_status TEXT NOT NULL,
 detection_latency_seconds INTEGER
);
CREATE INDEX posts_detected ON posts(detected_at);
CREATE INDEX posts_fingerprint ON posts(fingerprint);
CREATE TABLE source_health (
 source TEXT PRIMARY KEY, state TEXT NOT NULL, last_success_at INTEGER, last_failure_at INTEGER,
 offline_since INTEGER, failure_episodes INTEGER NOT NULL DEFAULT 0, error TEXT
);
CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE events (id TEXT PRIMARY KEY, event_type TEXT NOT NULL, created_at INTEGER NOT NULL, details TEXT NOT NULL);
CREATE INDEX events_created ON events(created_at);
CREATE TABLE notifications (
 id TEXT PRIMARY KEY, post_id TEXT, kind TEXT NOT NULL, created_at INTEGER NOT NULL,
 status TEXT NOT NULL, sent_at INTEGER
);
CREATE INDEX notifications_created ON notifications(created_at);
