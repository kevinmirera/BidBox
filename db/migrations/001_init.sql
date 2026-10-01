-- Bid Box schema. Idempotent (IF NOT EXISTS) so `npm run migrate` can be re-run.

CREATE TABLE IF NOT EXISTS tenders (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref           text NOT NULL UNIQUE,            -- human id used by MCP tools, e.g. TND-2026-014
  title         text NOT NULL,
  status        text NOT NULL DEFAULT 'OPEN',
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  requirements  jsonb NOT NULL DEFAULT '{}'::jsonb,  -- mandatory/technical/financial/delivery
  criteria      jsonb NOT NULL DEFAULT '[]'::jsonb,  -- evaluation criteria (informational; never auto-scored)
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bids (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id     uuid NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
  ref           text NOT NULL,                   -- e.g. BID-008
  seq           integer NOT NULL,                -- submission order; drives sequential processing
  supplier_hint text,                            -- name on the submission envelope (untrusted)
  status        text NOT NULL DEFAULT 'RECEIVED',
  ingested      jsonb,                           -- last structured ingest result
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tender_id, ref),
  UNIQUE (tender_id, seq)
);

CREATE TABLE IF NOT EXISTS documents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id     uuid NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
  bid_id        uuid REFERENCES bids(id) ON DELETE CASCADE,   -- NULL = tender document
  name          text NOT NULL,                   -- e.g. Bid_008_Technical.pdf
  kind          text NOT NULL,                   -- technical | financial | compliance | tender | other
  parse_status  text NOT NULL DEFAULT 'OK',      -- OK | MALFORMED | EMPTY
  parse_error   text,
  pages         jsonb,                           -- [{page:int, text:string}] extracted text, per page
  size_bytes    integer NOT NULL DEFAULT 0,
  content_hash  text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tender_id, name)
);
CREATE INDEX IF NOT EXISTS documents_bid_idx ON documents (bid_id);

CREATE TABLE IF NOT EXISTS evidence (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id     uuid NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
  bid_id        uuid NOT NULL REFERENCES bids(id) ON DELETE CASCADE,
  document_id   uuid REFERENCES documents(id),
  field         text NOT NULL,                   -- e.g. total_price, ssd_capacity_gb
  value         jsonb,
  page          integer,
  section       text,
  excerpt       text,
  confidence    numeric NOT NULL DEFAULT 0,
  status        text NOT NULL DEFAULT 'EXTRACTED', -- EXTRACTED | VERIFIED | EVIDENCE_MISSING | CONTRADICTED
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS evidence_bid_idx ON evidence (bid_id);

-- A "finding" is an investigation row: something the calibration engine or
-- a check says deserves a closer look. It is never a rejection or a ranking.
CREATE TABLE IF NOT EXISTS investigations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id     uuid NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
  bid_id        uuid NOT NULL REFERENCES bids(id) ON DELETE CASCADE,
  kind          text NOT NULL,                   -- PRICE_DEVIATION, MISSING_DOCUMENT, ...
  severity      text NOT NULL DEFAULT 'medium',  -- info | low | medium | high
  description   text NOT NULL,
  trigger       jsonb NOT NULL DEFAULT '{}'::jsonb,   -- numbers that caused the flag
  evidence_ids  jsonb NOT NULL DEFAULT '[]'::jsonb,
  status        text NOT NULL DEFAULT 'OPEN',    -- OPEN | CONFIRMED | RESOLVED | EVIDENCE_MISSING | CONTRADICTED | NEEDS_HUMAN_REVIEW
  verification  jsonb,                           -- last verify_evidence result
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bid_id, kind)
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id     uuid NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
  provider      text NOT NULL,                   -- claude | openweights
  model         text NOT NULL,
  status        text NOT NULL DEFAULT 'RUNNING', -- RUNNING | AGENT_ANALYSIS_COMPLETE | FAILED
  graph_state   jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz
);

CREATE TABLE IF NOT EXISTS calibration_states (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id         uuid NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
  total_bids        integer NOT NULL,
  calibration_size  integer NOT NULL,
  ingested_in_set   integer NOT NULL,
  phase             text NOT NULL,               -- OBSERVING | CALIBRATING | PROVISIONAL | CALIBRATED
  reference         jsonb NOT NULL DEFAULT '{}'::jsonb,
  stability         numeric NOT NULL DEFAULT 0,
  version           integer NOT NULL DEFAULT 1,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tender_id)
);

CREATE TABLE IF NOT EXISTS evaluations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id             uuid NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
  run_id                uuid REFERENCES agent_runs(id),
  package               jsonb NOT NULL,
  review_status         text NOT NULL DEFAULT 'COMMITTEE_REVIEW_REQUIRED',
  award_decisions_made  integer NOT NULL DEFAULT 0 CHECK (award_decisions_made = 0),
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS human_approvals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id     uuid NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
  evaluation_id uuid REFERENCES evaluations(id),
  action        text NOT NULL,                   -- e.g. EXPORT_COMMITTEE_FILE, ACKNOWLEDGE_REVIEW
  status        text NOT NULL,                   -- PENDING | APPROVED | REJECTED
  approver      text,                            -- human identity; NULL while PENDING
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Append-only audit log. Hash-chained per run for tamper evidence.
CREATE TABLE IF NOT EXISTS tool_calls (
  id              bigserial PRIMARY KEY,
  run_id          text,                          -- agent run id (text: external clients may send any id)
  tender_id       text,
  bid_id          text,
  tool_name       text NOT NULL,
  input           jsonb,
  output          jsonb,
  status          text NOT NULL,                 -- SUCCESS | FLAGGED | ERROR
  error           text,
  actor           text,                          -- model/provider identity, e.g. claude:claude-sonnet-5-5
  human_approval  text,                          -- NONE_REQUIRED | PENDING | APPROVED ...
  started_at      timestamptz NOT NULL,
  duration_ms     integer NOT NULL,
  prev_hash       text,
  row_hash        text NOT NULL
);
CREATE INDEX IF NOT EXISTS tool_calls_run_idx ON tool_calls (run_id, id);
CREATE INDEX IF NOT EXISTS tool_calls_tender_idx ON tool_calls (tender_id, id);

CREATE OR REPLACE FUNCTION bidbox_forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only (% not allowed)', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tool_calls_immutable ON tool_calls;
CREATE TRIGGER tool_calls_immutable BEFORE UPDATE OR DELETE ON tool_calls
  FOR EACH ROW EXECUTE FUNCTION bidbox_forbid_mutation();

DROP TRIGGER IF EXISTS human_approvals_immutable ON human_approvals;
CREATE TRIGGER human_approvals_immutable BEFORE UPDATE OR DELETE ON human_approvals
  FOR EACH ROW EXECUTE FUNCTION bidbox_forbid_mutation();
