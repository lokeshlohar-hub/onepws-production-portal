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
