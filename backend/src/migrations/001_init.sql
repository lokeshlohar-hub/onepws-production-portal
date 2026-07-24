-- ONEPWS Production Control Portal — Phase 1 schema
-- Covers: Users & Auth, Projects, BOM lines (with stage/QC tracking), Reject Log, Stage Log.
-- Everything else (Maintenance, Calibration, Tool Inventory, DMS, Reports config, Audit)
-- still runs in-memory on the frontend for now and will get its own migration in a later phase.

-- Sequences for generating human-readable IDs (avoids collisions that a
-- COUNT(*)-based scheme would risk once rows get deleted)
CREATE SEQUENCE IF NOT EXISTS project_id_seq START 1;
CREATE SEQUENCE IF NOT EXISTS bom_line_id_seq START 1;

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  username      VARCHAR(50) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  full_name     VARCHAR(100) NOT NULL,
  role          VARCHAR(20) NOT NULL CHECK (role IN ('superadmin','admin','viewer')),
  department    VARCHAR(50),
  active        BOOLEAN NOT NULL DEFAULT true,
  permissions   JSONB,                 -- same shape the frontend already uses (module -> action -> bool, with .subs for sectioned modules)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login    TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS projects (
  id            VARCHAR(20) PRIMARY KEY,        -- e.g. 'PRJ-0001'
  sap           VARCHAR(50) UNIQUE NOT NULL,    -- e.g. 'CD-25-26-10175'
  type          VARCHAR(20),
  category      VARCHAR(20),
  customer      VARCHAR(200),
  pm            VARCHAR(100),
  eng           VARCHAR(100),
  po            VARCHAR(100),
  has_wood      BOOLEAN NOT NULL DEFAULT false,
  has_ext       BOOLEAN NOT NULL DEFAULT false,
  rec_wood      DATE, plan_wood DATE, act_wood DATE, dly_wood INT, wood_status VARCHAR(20),
  rec_ext       DATE, plan_ext  DATE, act_ext  DATE, dly_ext  INT, ext_status  VARCHAR(20),
  progress      INT NOT NULL DEFAULT 0,
  remarks       TEXT DEFAULT '',
  certifications JSONB DEFAULT '[]',
  stages        JSONB DEFAULT '[]',    -- project-level milestone stages (unchanged shape from the frontend)
  docs          JSONB DEFAULT '[]',
  history       JSONB DEFAULT '[]',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    INT REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS bom_lines (
  line_id                 VARCHAR(20) PRIMARY KEY,   -- e.g. 'BL-00001'
  project_id              VARCHAR(20) NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  item                    VARCHAR(200) NOT NULL,
  seg                     VARCHAR(10),               -- 'wood' | 'ext'
  l NUMERIC, w NUMERIC, t NUMERIC, profile VARCHAR(50),
  uom                     VARCHAR(10),
  qty                     INT NOT NULL,
  original_qty            INT NOT NULL,
  color_finish            VARCHAR(100) DEFAULT '',
  special_chars           JSONB DEFAULT '[]',
  components_per_board    INT,
  edge_meters_per_comp    NUMERIC,
  board_qty               INT,
  components_released     INT NOT NULL DEFAULT 0,
  route                   JSONB NOT NULL DEFAULT '[]',   -- ordered array of stage names
  stage_data              JSONB NOT NULL DEFAULT '{}',   -- {stageName: {completed,qcQueue,qcApproved,qcRejected,rework,scrap,history:[...]}}
  is_rework               BOOLEAN NOT NULL DEFAULT false,
  rework_of_line_id       VARCHAR(20),
  rework_source_stage     VARCHAR(100),
  rework_reason           TEXT,
  rework_date             DATE,
  rework_generation       INT NOT NULL DEFAULT 0,
  spawned_rework_line_ids JSONB DEFAULT '[]',
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bom_lines_project ON bom_lines(project_id);
CREATE INDEX IF NOT EXISTS idx_bom_lines_item ON bom_lines(item);

CREATE TABLE IF NOT EXISTS reject_log (
  id                      SERIAL PRIMARY KEY,
  ts                      TIMESTAMPTZ NOT NULL DEFAULT now(),
  date                    DATE NOT NULL DEFAULT CURRENT_DATE,
  project_id              VARCHAR(20) REFERENCES projects(id) ON DELETE CASCADE,
  proj_sap                VARCHAR(50),
  item                    VARCHAR(200),
  stage                   VARCHAR(100),
  workstation             VARCHAR(100),
  qty                     INT NOT NULL,
  category                VARCHAR(100),
  disposition             VARCHAR(20),          -- 'rework' | 'scrap'
  qc_person               VARCHAR(100),
  qc_instrument           VARCHAR(200),
  qc_instrument_due_date  DATE,
  root_cause              TEXT,
  source_line_id          VARCHAR(20),
  rework_line_id          VARCHAR(20),
  status                  VARCHAR(20) DEFAULT 'Closed'
);
CREATE INDEX IF NOT EXISTS idx_reject_log_project ON reject_log(project_id);

CREATE TABLE IF NOT EXISTS stage_log (
  id            SERIAL PRIMARY KEY,
  ts            TIMESTAMPTZ NOT NULL DEFAULT now(),
  project_id    VARCHAR(20) REFERENCES projects(id) ON DELETE CASCADE,
  project_sap   VARCHAR(50),
  stage         VARCHAR(100),
  workstation   VARCHAR(100),
  operator      VARCHAR(100),
  app_user      VARCHAR(100),
  remark        TEXT
);
CREATE INDEX IF NOT EXISTS idx_stage_log_project ON stage_log(project_id);

-- Calibration Instruments — Phase 2: the first module moved off the
-- frontend-only in-memory store noted in the header comment above.
CREATE SEQUENCE IF NOT EXISTS calib_id_seq START 1;
CREATE TABLE IF NOT EXISTS calibration_instruments (
  id                VARCHAR(20) PRIMARY KEY,
  tag_no            VARCHAR(100) NOT NULL,
  name              VARCHAR(200) NOT NULL,
  make              VARCHAR(100),
  instrument_range  VARCHAR(100),
  least_count       VARCHAR(50),
  department        VARCHAR(50) NOT NULL,
  owner             VARCHAR(100),
  frequency_months  INT NOT NULL DEFAULT 12,
  last_cal_date     DATE,
  next_due_date     DATE,
  agency            VARCHAR(200),
  cert_no           VARCHAR(100),
  status            VARCHAR(20) NOT NULL DEFAULT 'Active',
  remarks           TEXT,
  history           JSONB NOT NULL DEFAULT '[]',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_calib_tag_no ON calibration_instruments(tag_no);

-- Maintenance: Breakdown Log + Why-Why RCA — Phase 3
CREATE TABLE IF NOT EXISTS breakdown_log (
  id                     VARCHAR(30) PRIMARY KEY,
  segment                VARCHAR(20) NOT NULL,
  machine_id             VARCHAR(50),
  machine_name           VARCHAR(200),
  breakdown_date         DATE,
  start_time             VARCHAR(10),
  problem                TEXT,
  category               VARCHAR(100),
  priority               VARCHAR(20),
  technician_id          VARCHAR(50),
  technician_name        VARCHAR(100),
  repair_start           VARCHAR(10),
  repair_end             VARCHAR(10),
  spare_parts_used       TEXT,
  corrective_action      TEXT,
  restoration_confirmed  BOOLEAN DEFAULT false,
  status_after_repair    VARCHAR(30),
  downtime_hours         NUMERIC DEFAULT 0,
  why_why_id             VARCHAR(30),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by             VARCHAR(100)
);
CREATE INDEX IF NOT EXISTS idx_breakdown_date ON breakdown_log(breakdown_date);
CREATE INDEX IF NOT EXISTS idx_breakdown_machine ON breakdown_log(machine_id);

CREATE TABLE IF NOT EXISTS why_why_log (
  id                  VARCHAR(30) PRIMARY KEY,
  breakdown_id        VARCHAR(30),
  segment             VARCHAR(20),
  machine_name        VARCHAR(200),
  breakdown_date      DATE,
  downtime_hours      NUMERIC DEFAULT 0,
  why1 TEXT, why2 TEXT, why3 TEXT, why4 TEXT, why5 TEXT,
  root_cause          TEXT,
  immediate_action    TEXT,
  preventive_action   TEXT,
  responsible_person  VARCHAR(100),
  target_date         DATE,
  closure_remarks     TEXT,
  status              VARCHAR(20) NOT NULL DEFAULT 'Open',
  closed_at           TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_whywhy_breakdown ON why_why_log(breakdown_id);

-- Tool Inventory & Tool Issue Log — Phase 4
CREATE TABLE IF NOT EXISTS tool_inventory (
  id                 VARCHAR(20) PRIMARY KEY,
  tool_code          VARCHAR(100) NOT NULL,
  name               VARCHAR(200) NOT NULL,
  category           VARCHAR(100),
  compatible_machine VARCHAR(50),
  specification      TEXT,
  qty_available      INT NOT NULL DEFAULT 0,
  min_stock          INT NOT NULL DEFAULT 0,
  supplier           VARCHAR(200),
  purchase_date      DATE,
  cost               NUMERIC DEFAULT 0,
  status             VARCHAR(20) NOT NULL DEFAULT 'Active',
  remarks            TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tool_code ON tool_inventory(tool_code);

CREATE TABLE IF NOT EXISTS tool_issue_log (
  id                       VARCHAR(20) PRIMARY KEY,
  tool_id                  VARCHAR(20) REFERENCES tool_inventory(id) ON DELETE CASCADE,
  tool_name                VARCHAR(200),
  qty_issued               INT NOT NULL,
  machine                  VARCHAR(50),
  operator                 VARCHAR(100),
  project_id               VARCHAR(20),
  project_sap              VARCHAR(50),
  issue_date               DATE,
  issue_location           VARCHAR(200),
  status                   VARCHAR(20) NOT NULL DEFAULT 'Active',
  components_processed     INT,
  production_hours_used    NUMERIC,
  discard_date             DATE,
  discard_reason           TEXT,
  total_usage_days         INT,
  entered_by               VARCHAR(100),
  ts                       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tool_issue_tool ON tool_issue_log(tool_id);

-- Daily Capacity & Helper Count — Phase 4. One row per (date, workstation).
-- Fed from two sources: manual Daily Capacity Entry (sets the value directly)
-- and automatic stage-completion updates (increments the value) — both go
-- through the same upsert-style endpoints so history is never overwritten,
-- only ever added to for a given day, matching the existing in-memory
-- behavior this replaces.
CREATE TABLE IF NOT EXISTS daily_capacity (
  cap_date        DATE NOT NULL,
  workstation_id  VARCHAR(50) NOT NULL,
  achieved_qty    INT NOT NULL DEFAULT 0,
  helper_count    INT NOT NULL DEFAULT 0,
  source_log      JSONB NOT NULL DEFAULT '[]',
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (cap_date, workstation_id)
);
CREATE INDEX IF NOT EXISTS idx_daily_cap_date ON daily_capacity(cap_date);

-- Admin Panel master data — Phase 5. Generic key-value store: every
-- admin-managed list (Production Stages, TAT Rules, PMs, Engineers, Product
-- Types, Categories, BOM Components, BOM Routing, Cycle Time, Machine Master,
-- Delay/Rejection Categories, Special Characteristics, Certifications,
-- Operators, Technicians, QC Inspectors, Breakdown Categories, Utility
-- Equipment, Hand Tools, Document Departments/Origins, and Dimensional
-- Capability settings) is stored as one JSON value per key, since these are
-- admin-configured master data rather than high-volume transactional
-- records — a normalized table per list would be significant added
-- complexity for no real benefit here.
CREATE TABLE IF NOT EXISTS admin_config (
  config_key    VARCHAR(100) PRIMARY KEY,
  config_value  JSONB NOT NULL DEFAULT '[]',
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by    VARCHAR(100)
);

-- Optional photo evidence for a QC rejection — Phase 6. Stored as a base64
-- data URL (client-side resized/compressed before upload, so this stays a
-- reasonable size) rather than a separate file-storage service, since this
-- app has no existing file-upload infrastructure and one JSONB/TEXT column
-- is the simplest correct fit for an optional single image per rejection.
ALTER TABLE reject_log ADD COLUMN IF NOT EXISTS photo_data TEXT;
