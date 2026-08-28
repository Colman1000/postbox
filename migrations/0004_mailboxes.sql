-- ─────────────────────────────────────────────────────────────────────────────
--  Mailboxes
--
--  A catch-all rule means every address on the domain already arrives here, all
--  of it in one inbox. That is the right default and a poor filing cabinet:
--  `billing@` and `press@` and the address you gave one supplier read as one
--  undifferentiated pile.
--
--  A mailbox names one of those addresses and gives it a place in the sidebar.
--  It is a view, not a folder — mail addressed to `billing@` still lands in the
--  Inbox and is archived, starred and searched exactly as before. Nothing is
--  moved and nothing is hidden; the mailbox only offers a second way in.
-- ─────────────────────────────────────────────────────────────────────────────

-- One row per address the user has decided is worth its own entry.
--
-- `name` is what the sidebar shows — "Billing" reads better than
-- "billing@example.com" in a 200-pixel column — and is optional, because the
-- address is a perfectly good name for itself.
CREATE TABLE IF NOT EXISTS mailboxes (
  id         TEXT PRIMARY KEY,
  -- Full address, lowercased. UNIQUE: one entry per address, so adding the
  -- same mailbox twice renames the first rather than splitting its mail.
  address    TEXT NOT NULL UNIQUE,
  name       TEXT,
  created_at INTEGER NOT NULL
);

-- Which of *our* addresses each message touched: the address an inbound
-- message was delivered to (envelope recipient, To and Cc alike), or the
-- address an outbound message was sent from.
--
-- This is what makes a mailbox instant in both directions. Membership is
-- derived from it rather than stored per mailbox, so defining `billing@`
-- today shows every message it has ever received — there is no backfill step
-- at creation and no cleanup at deletion, because a mailbox owns no rows.
--
-- The envelope recipient matters on its own: a message that reached
-- `billing@` as a Bcc names it nowhere in its headers, and matching on To and
-- Cc alone would silently miss it.
CREATE TABLE IF NOT EXISTS message_addresses (
  message_id TEXT NOT NULL,
  thread_id  TEXT NOT NULL,
  address    TEXT NOT NULL,
  PRIMARY KEY (message_id, address)
);

-- The lookup a mailbox listing makes: every conversation that reached one
-- address. Covering, so the listing never touches the table itself.
CREATE INDEX IF NOT EXISTS idx_message_addresses_address
  ON message_addresses (address, thread_id);
-- The lookup a permanent delete makes.
CREATE INDEX IF NOT EXISTS idx_message_addresses_thread
  ON message_addresses (thread_id);

-- Existing mail, indexed the same way the Worker will index the next message.
-- Without this a mailbox defined after upgrading would start empty and slowly
-- fill, which is the one thing the derived-membership design exists to avoid.
INSERT OR IGNORE INTO message_addresses (message_id, thread_id, address)
SELECT m.id, m.thread_id, lower(json_extract(entry.value, '$.address'))
  FROM messages m, json_each(m.to_addresses) entry
 WHERE m.direction = 'inbound'
   AND json_extract(entry.value, '$.address') IS NOT NULL;

INSERT OR IGNORE INTO message_addresses (message_id, thread_id, address)
SELECT m.id, m.thread_id, lower(json_extract(entry.value, '$.address'))
  FROM messages m, json_each(m.cc_addresses) entry
 WHERE m.direction = 'inbound'
   AND json_extract(entry.value, '$.address') IS NOT NULL;

INSERT OR IGNORE INTO message_addresses (message_id, thread_id, address)
SELECT m.id, m.thread_id, lower(m.from_address)
  FROM messages m
 WHERE m.direction = 'outbound'
   AND m.from_address IS NOT NULL
   AND m.from_address != '';
