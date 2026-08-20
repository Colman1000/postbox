-- ─────────────────────────────────────────────────────────────────────────────
--  Postbox schema
--
--  Times are stored as INTEGER unix-milliseconds so the Worker and the UI
--  agree without a date parser in the middle.
--  Address lists are stored as JSON arrays of {address, name} — SQLite has no
--  array type and a join table for recipients buys us nothing here.
-- ─────────────────────────────────────────────────────────────────────────────

-- One row per email, inbound or outbound, draft or sent.
CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  thread_id       TEXT NOT NULL,

  direction       TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  -- received | draft | scheduled | queued | sent | failed
  status          TEXT NOT NULL,
  -- inbox | sent | drafts | archive | trash | spam | scheduled
  folder          TEXT NOT NULL,

  -- RFC 5322 threading headers.
  rfc_message_id  TEXT,
  in_reply_to     TEXT,
  refs            TEXT,

  from_address    TEXT NOT NULL,
  from_name       TEXT,
  to_addresses    TEXT NOT NULL DEFAULT '[]',
  cc_addresses    TEXT NOT NULL DEFAULT '[]',
  bcc_addresses   TEXT NOT NULL DEFAULT '[]',
  reply_to        TEXT,

  subject         TEXT NOT NULL DEFAULT '',
  snippet         TEXT NOT NULL DEFAULT '',
  body_text       TEXT,
  body_html       TEXT,

  -- Inbound authentication verdicts, surfaced in the UI as a trust badge.
  spf             TEXT,
  dkim            TEXT,
  dmarc           TEXT,
  raw_size        INTEGER,

  is_read         INTEGER NOT NULL DEFAULT 0,
  is_starred      INTEGER NOT NULL DEFAULT 0,
  has_attachments INTEGER NOT NULL DEFAULT 0,

  scheduled_at    INTEGER,
  snoozed_until   INTEGER,
  sent_at         INTEGER,
  received_at     INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,

  -- Provider bookkeeping.
  provider_id     TEXT,
  error           TEXT
);

CREATE INDEX IF NOT EXISTS idx_messages_thread     ON messages (thread_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_folder     ON messages (folder, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_rfc_id     ON messages (rfc_message_id);
CREATE INDEX IF NOT EXISTS idx_messages_scheduled  ON messages (status, scheduled_at)
  WHERE status = 'scheduled';
CREATE INDEX IF NOT EXISTS idx_messages_snoozed    ON messages (snoozed_until)
  WHERE snoozed_until IS NOT NULL;

-- Materialised conversation summary. Kept in step with `messages` inside the
-- same D1 batch, so the list view is a single indexed read instead of a
-- GROUP BY over the whole mailbox.
CREATE TABLE IF NOT EXISTS threads (
  id              TEXT PRIMARY KEY,
  subject         TEXT NOT NULL DEFAULT '',
  snippet         TEXT NOT NULL DEFAULT '',
  participants    TEXT NOT NULL DEFAULT '[]',
  folder          TEXT NOT NULL DEFAULT 'inbox',
  message_count   INTEGER NOT NULL DEFAULT 0,
  unread_count    INTEGER NOT NULL DEFAULT 0,
  has_attachments INTEGER NOT NULL DEFAULT 0,
  is_starred      INTEGER NOT NULL DEFAULT 0,
  last_message_at INTEGER NOT NULL,
  snoozed_until   INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_threads_folder ON threads (folder, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_threads_starred ON threads (is_starred, last_message_at DESC);

-- Attachments live in D1 as BLOBs. That keeps the whole app inside one free
-- tier with no object store to provision; `MAX_ATTACHMENT_BYTES` in the Worker
-- caps what we accept so a single mail cannot eat the 5 GB allowance.
CREATE TABLE IF NOT EXISTS attachments (
  id           TEXT PRIMARY KEY,
  message_id   TEXT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  filename     TEXT NOT NULL,
  mime_type    TEXT NOT NULL DEFAULT 'application/octet-stream',
  size         INTEGER NOT NULL DEFAULT 0,
  content_id   TEXT,
  is_inline    INTEGER NOT NULL DEFAULT 0,
  content      BLOB,
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments (message_id);

-- Full-text search. Standalone (not an external-content table) and written by
-- the Worker in the same batch as the message, which keeps the write path
-- explicit and survives D1's lack of trigger introspection.
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5 (
  message_id UNINDEXED,
  thread_id  UNINDEXED,
  subject,
  body,
  participants,
  tokenize = 'porter unicode61'
);

-- User-defined labels, applied at conversation level like Gmail.
CREATE TABLE IF NOT EXISTS labels (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  tone       TEXT NOT NULL DEFAULT 'neutral',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS thread_labels (
  thread_id TEXT NOT NULL,
  label_id  TEXT NOT NULL REFERENCES labels (id) ON DELETE CASCADE,
  PRIMARY KEY (thread_id, label_id)
);

CREATE INDEX IF NOT EXISTS idx_thread_labels_label ON thread_labels (label_id);

-- Address book, accumulated from real correspondence rather than typed in.
CREATE TABLE IF NOT EXISTS contacts (
  address       TEXT PRIMARY KEY,
  name          TEXT,
  message_count INTEGER NOT NULL DEFAULT 0,
  is_favorite   INTEGER NOT NULL DEFAULT 0,
  last_seen_at  INTEGER NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_contacts_recent ON contacts (last_seen_at DESC);

-- Addresses you can send as. Seeded with DEFAULT_FROM at deploy time; any
-- address on the verified domain can be added from Settings.
CREATE TABLE IF NOT EXISTS identities (
  id            TEXT PRIMARY KEY,
  address       TEXT NOT NULL UNIQUE,
  name          TEXT,
  signature_html TEXT,
  is_default    INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

-- Reusable message bodies for Compose.
CREATE TABLE IF NOT EXISTS templates (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  subject    TEXT NOT NULL DEFAULT '',
  body       TEXT NOT NULL DEFAULT '',
  shortcut   TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Small singleton key/value store for UI preferences that must follow the
-- account rather than the browser.
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Delivery + activity log. Powers the Activity panel and makes a failed send
-- explainable after the fact.
CREATE TABLE IF NOT EXISTS events (
  id         TEXT PRIMARY KEY,
  type       TEXT NOT NULL,
  message_id TEXT,
  thread_id  TEXT,
  detail     TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_recent ON events (created_at DESC);
