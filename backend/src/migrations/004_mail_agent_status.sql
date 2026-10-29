-- ONEPWS Production Control Portal — Migration 004
-- Adds: mail_agent_status — when the sys160 mail relay agent last reached the
-- portal.
--
-- Why: in October the agent kept running against a dead portal address for a
-- week and nobody could tell, because nothing recorded whether it was actually
-- getting through. The agent's authenticated requests now stamp this single
-- row (throttled to once a minute), and /api/handover-log/mail-status reports
-- it so the portal can warn admins when mail is piling up.
--
-- Idempotent: safe to run repeatedly.

CREATE TABLE IF NOT EXISTS mail_agent_status (
  -- Exactly one row: there is one relay.
  id            SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_seen     TIMESTAMPTZ,
  agent_version TEXT,
  agent_host    TEXT
);

INSERT INTO mail_agent_status (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
