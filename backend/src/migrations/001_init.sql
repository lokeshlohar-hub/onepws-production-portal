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
