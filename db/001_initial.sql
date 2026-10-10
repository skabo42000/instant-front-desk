BEGIN;
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS businesses (
  business_id uuid NOT NULL PRIMARY KEY,
  id uuid NOT NULL,
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  source_url text NOT NULL,
  contact_url text,
  phone text,
  embedding_model text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (id = business_id),
  UNIQUE (business_id, id)
);
CREATE TABLE IF NOT EXISTS crawl_runs (
  business_id uuid NOT NULL REFERENCES businesses(business_id),
  id uuid NOT NULL,
  status text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  limits_json jsonb NOT NULL DEFAULT '{}',
  error_code text,
  UNIQUE (business_id, id)
);
CREATE TABLE IF NOT EXISTS pages (
  business_id uuid NOT NULL REFERENCES businesses(business_id),
  id uuid NOT NULL,
  crawl_run_id uuid NOT NULL,
  url text NOT NULL,
  title text NOT NULL,
  clean_text text NOT NULL,
  content_hash text NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, crawl_run_id) REFERENCES crawl_runs(business_id, id)
);
CREATE TABLE IF NOT EXISTS chunks (
  business_id uuid NOT NULL REFERENCES businesses(business_id),
  id uuid NOT NULL,
  page_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  heading text NOT NULL,
  text text NOT NULL,
  -- EMBEDDING_DIMENSIONS = 768; keep src/lib/db/client.ts in sync.
  embedding vector(768) NOT NULL,
  embedding_model text NOT NULL,
  content_hash text NOT NULL,
  UNIQUE (business_id, id),
  UNIQUE (business_id, page_id, ordinal),
  FOREIGN KEY (business_id, page_id) REFERENCES pages(business_id, id)
);
CREATE TABLE IF NOT EXISTS eval_questions (
  business_id uuid NOT NULL REFERENCES businesses(business_id),
  id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  kind text NOT NULL,
  question text NOT NULL,
  expected_behavior text NOT NULL,
  human_label text,
  approved_at timestamptz,
  UNIQUE (business_id, id)
);
CREATE TABLE IF NOT EXISTS eval_runs (
  business_id uuid NOT NULL REFERENCES businesses(business_id),
  id uuid NOT NULL,
  question_version integer NOT NULL,
  crawl_run_id uuid NOT NULL,
  answer_model text NOT NULL,
  judge_model text NOT NULL,
  prompt_version text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL,
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, crawl_run_id) REFERENCES crawl_runs(business_id, id)
);
CREATE TABLE IF NOT EXISTS eval_results (
  business_id uuid NOT NULL REFERENCES businesses(business_id),
  id uuid NOT NULL,
  eval_run_id uuid NOT NULL,
  question_id uuid NOT NULL,
  answer text NOT NULL,
  judge_verdict text,
  judge_reason text,
  human_verdict text,
  error_code text,
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, eval_run_id) REFERENCES eval_runs(business_id, id),
  FOREIGN KEY (business_id, question_id) REFERENCES eval_questions(business_id, id)
);
-- UUID arrays cannot enforce ownership; store evidence and citations as links.
CREATE TABLE IF NOT EXISTS question_evidence (
  business_id uuid NOT NULL REFERENCES businesses(business_id),
  id uuid NOT NULL,
  question_id uuid NOT NULL,
  chunk_id uuid NOT NULL,
  UNIQUE (business_id, id),
  UNIQUE (business_id, question_id, chunk_id),
  FOREIGN KEY (business_id, question_id) REFERENCES eval_questions(business_id, id),
  FOREIGN KEY (business_id, chunk_id) REFERENCES chunks(business_id, id)
);
CREATE TABLE IF NOT EXISTS result_citations (
  business_id uuid NOT NULL REFERENCES businesses(business_id),
  id uuid NOT NULL,
  result_id uuid NOT NULL,
  chunk_id uuid NOT NULL,
  UNIQUE (business_id, id),
  UNIQUE (business_id, result_id, chunk_id),
  FOREIGN KEY (business_id, result_id) REFERENCES eval_results(business_id, id),
  FOREIGN KEY (business_id, chunk_id) REFERENCES chunks(business_id, id)
);
CREATE TABLE IF NOT EXISTS model_requests (
  business_id uuid NOT NULL REFERENCES businesses(business_id),
  id uuid NOT NULL,
  eval_run_id uuid,
  purpose text NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  attempt integer NOT NULL CHECK (attempt > 0),
  status text NOT NULL,
  input_tokens integer,
  output_tokens integer,
  estimated_cost numeric,
  price_version text,
  latency_ms integer NOT NULL CHECK (latency_ms >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, eval_run_id) REFERENCES eval_runs(business_id, id)
);

-- No public policies: only the trusted local owner can use these tables.
ALTER TABLE businesses ENABLE ROW LEVEL SECURITY;
ALTER TABLE crawl_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE eval_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE eval_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE eval_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE question_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE result_citations ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON businesses, crawl_runs, pages, chunks, eval_questions, eval_runs,
  eval_results, question_evidence, result_citations, model_requests FROM PUBLIC;
COMMIT;
