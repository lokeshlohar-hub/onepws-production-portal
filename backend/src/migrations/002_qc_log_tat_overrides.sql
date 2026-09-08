-- ONEPWS Production Control Portal — Migration 002
-- Adds: qc_log (complete Pass+Reject+Partial QC history) and tat_overrides
-- (manual deadline overrides). Both tables were originally created directly
-- via psql on the sys160 production database and were never captured as
-- migration code; this file is a faithful snapshot of their live schema
-- (PostgreSQL 16, taken 2026-09-08) so a fresh environment can be rebuilt
-- from the repo alone.
--
-- NOTE: scripts/migrate.js currently only applies 001_init.sql — apply this
-- file explicitly (psql -f) or extend migrate.js to iterate the folder.

-- ---------------------------------------------------------------------------
-- qc_log — one row per QC decision, written unconditionally by
-- productionEngine.js::processQcDecision (alongside, not replacing, reject_log)
-- ---------------------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS qc_log_id_seq AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;

CREATE TABLE IF NOT EXISTS qc_log (
  id              INTEGER NOT NULL DEFAULT nextval('qc_log_id_seq'),
  ts              TIMESTAMPTZ NOT NULL DEFAULT now(),
  date            DATE NOT NULL DEFAULT CURRENT_DATE,
  project_id      VARCHAR(20),
  proj_sap        VARCHAR(50),
  customer        VARCHAR(200),
  item            VARCHAR(200),
  segment         VARCHAR(10),
  stage           VARCHAR(100),
  workstation     VARCHAR(100),
  approve_qty     INTEGER NOT NULL DEFAULT 0,
  reject_qty      INTEGER NOT NULL DEFAULT 0,
  qc_status       VARCHAR(20) NOT NULL,          -- 'Pass' | 'Reject' | 'Partial'
  category        VARCHAR(100),
  root_cause      TEXT,
  qc_person       VARCHAR(100),
  qc_instrument   VARCHAR(200),
  source_line_id  VARCHAR(20),
  CONSTRAINT qc_log_pkey PRIMARY KEY (id),
  CONSTRAINT qc_log_project_id_fkey FOREIGN KEY (project_id)
    REFERENCES projects(id) ON DELETE CASCADE
);
ALTER SEQUENCE qc_log_id_seq OWNED BY qc_log.id;

CREATE INDEX IF NOT EXISTS idx_qc_log_date    ON qc_log (date);
CREATE INDEX IF NOT EXISTS idx_qc_log_project ON qc_log (project_id);
CREATE INDEX IF NOT EXISTS idx_qc_log_status  ON qc_log (qc_status);

-- ---------------------------------------------------------------------------
-- tat_overrides — manual override of a segment's planned deadline.
-- revised_completion supersedes plan_wood/plan_ext for delay/OTD calcs
-- (see getEffectivePlanDate / effectivePlanDate).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tat_overrides (
  id                      VARCHAR(20) NOT NULL,
  project_id              VARCHAR(20) NOT NULL,
  segment                 VARCHAR(10) NOT NULL,
  original_received       DATE,
  original_plan           DATE,
  override_reason         TEXT NOT NULL,
  reason_category         VARCHAR(50) NOT NULL,
  revised_start_date      DATE NOT NULL,
  revised_completion      DATE NOT NULL,
  delay_days_added        INTEGER NOT NULL DEFAULT 0,
  responsibility_category  VARCHAR(50),
  notes                   TEXT NOT NULL DEFAULT '',
  created_by_name         VARCHAR(100),
  created_by              INTEGER,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tat_overrides_pkey PRIMARY KEY (id),
  CONSTRAINT tat_overrides_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id),
  CONSTRAINT tat_overrides_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_tov_project ON tat_overrides (project_id);
