-- ─────────────────────────────────────────────────────────────────────────────
--  Push notifications, and the icon the notification arrives under
--
--  The socket in mailbox.ts only reaches a tab that is open. Push reaches a
--  phone in a pocket, which is the whole reason either of these tables exists:
--  a home-screen install needs somewhere to register itself, and a home-screen
--  install needs an icon.
-- ─────────────────────────────────────────────────────────────────────────────

-- One row per installed app that has asked to be told about mail.
--
-- The endpoint is the address the push service gave us and is unique by
-- construction, so re-subscribing the same install updates its keys rather
-- than accumulating duplicates. `p256dh` and `auth` are that install's own
-- public key and shared secret: every payload is encrypted to them, which is
-- why Apple and Google carry ciphertext and never a subject line.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id              TEXT PRIMARY KEY,
  endpoint        TEXT NOT NULL UNIQUE,
  p256dh          TEXT NOT NULL,
  auth            TEXT NOT NULL,

  -- Which sign-in registered it. Signing out on a device revokes that
  -- device's subscription, so a phone you have signed out of stops
  -- announcing mail it can no longer open.
  session_id      TEXT,
  user_agent      TEXT,

  created_at      INTEGER NOT NULL,
  -- Cleared on every successful delivery. A push service that rejects an
  -- endpoint outright returns 404 or 410 and the row is deleted on the spot;
  -- this counts the softer failures, so an endpoint that has been failing for
  -- a long time can be retired without waiting for a verdict that never comes.
  last_success_at INTEGER,
  failure_count   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_push_session ON push_subscriptions (session_id);

-- The home-screen icon, when it is not the one Postbox ships.
--
-- Two rows at most, both 512x512 PNG: `any` is drawn as-is, `maskable` is
-- cropped by Android to whatever shape the launcher uses. They are produced in
-- the browser — a canvas can scale an image and render a letter, and a Worker
-- can do neither — so what arrives here is already the right size and format
-- and is served back byte for byte.
--
-- Bytes in D1, like attachments, and for the same reason: no object store to
-- provision means nothing else to pay for. Two icons cap out around 200 KB
-- against a 5 GB database.
CREATE TABLE IF NOT EXISTS app_icons (
  purpose    TEXT PRIMARY KEY CHECK (purpose IN ('any', 'maskable')),
  mime_type  TEXT NOT NULL DEFAULT 'image/png',
  bytes      BLOB NOT NULL,
  updated_at INTEGER NOT NULL
);
