-- ONEPWS Production Control Portal — Migration 003
-- Adds: mail_outbox — the queue that lets the cloud-hosted backend send email
-- through the factory's internal mail server.
--
-- Why a queue at all: the portal's backend runs on Google Cloud Run, and the
-- mail server (192.168.100.5) is a private LAN address with no route from the
-- internet. So the backend renders the message and parks it here; a small
-- relay agent running on sys160 — which IS on that LAN — polls for pending
-- rows over HTTPS, delivers them via the internal mail server, and reports the
-- outcome back. Nothing has to be exposed to the internet in either direction.
--
-- Idempotent: safe to run repeatedly.

CREATE TABLE IF NOT EXISTS mail_outbox (
  id            TEXT PRIMARY KEY,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- pending -> sent | failed. 'pending' rows are what the agent claims.
  status        TEXT        NOT NULL DEFAULT 'pending',
  attempts      INTEGER     NOT NULL DEFAULT 0,
  -- Recipients as JSONB arrays of address strings.
  to_addrs      JSONB       NOT NULL DEFAULT '[]'::jsonb,
  cc_addrs      JSONB       NOT NULL DEFAULT '[]'::jsonb,
  subject       TEXT        NOT NULL DEFAULT '',
  -- Fully rendered at queue time so the agent stays dumb: it only delivers.
  body_html     TEXT        NOT NULL DEFAULT '',
  body_text     TEXT        NOT NULL DEFAULT '',
  pdf_name      TEXT,
  pdf_bytes     BYTEA,
  -- Traceability back to the project/handover this message belongs to.
  project_id    TEXT,
  proj_sap      TEXT,
  queued_by     TEXT,
  last_error    TEXT,
  last_attempt  TIMESTAMPTZ,
  sent_at       TIMESTAMPTZ
);

-- The agent's hot query: oldest pending first.
CREATE INDEX IF NOT EXISTS idx_mail_outbox_pending
  ON mail_outbox (status, created_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_mail_outbox_created ON mail_outbox (created_at DESC);
