-- ─────────────────────────────────────────────────────────────────────────────
--  Access log
--
--  Separate from `events` on purpose. `events` explains what happened to a
--  message — delivered, failed, snoozed — and is keyed by message and thread.
--  This answers a different question: who was here, from where, and what did
--  they change. One mailbox behind one password means "who" is really "which
--  sign-in", so every row carries the session it belongs to.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit (
  id          TEXT PRIMARY KEY,
  -- Short id minted at sign-in and carried in the session token, so the rows
  -- from one sign-in can be told apart from another's. Null for sign-in
  -- attempts that never got a session, and for sessions issued before this
  -- table existed.
  session_id  TEXT,
  -- sign-in | sign-in-failed | sign-in-blocked | sign-out | archive | send | …
  action      TEXT NOT NULL,
  detail      TEXT,
  ip          TEXT,
  country     TEXT,
  user_agent  TEXT,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_recent ON audit (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_session ON audit (session_id, created_at DESC);
