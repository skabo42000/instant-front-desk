BEGIN;
CREATE TABLE IF NOT EXISTS question_lists (
  business_id uuid NOT NULL REFERENCES businesses(business_id),
  version integer NOT NULL CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz,
  PRIMARY KEY (business_id, version)
);
ALTER TABLE question_lists ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON question_lists FROM PUBLIC;
ALTER TABLE eval_questions ADD COLUMN IF NOT EXISTS validation_errors jsonb NOT NULL DEFAULT '[]';
-- Legacy lists remain unapproved; migration never invents human review.
INSERT INTO question_lists (business_id, version)
  SELECT DISTINCT business_id, version FROM eval_questions ON CONFLICT DO NOTHING;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'questions_list_fk') THEN
    ALTER TABLE eval_questions ADD CONSTRAINT questions_list_fk
      FOREIGN KEY (business_id, version) REFERENCES question_lists(business_id, version);
  END IF;
END $$;
CREATE OR REPLACE FUNCTION check_approved_question_run() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Leave invalid ownership to the existing composite foreign key.
  IF NOT EXISTS (SELECT 1 FROM crawl_runs WHERE business_id=NEW.business_id AND id=NEW.crawl_run_id) THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM question_lists l WHERE l.business_id=NEW.business_id
      AND l.version=NEW.question_version AND l.approved_at IS NOT NULL)
    OR NOT EXISTS (SELECT 1 FROM eval_questions q WHERE q.business_id=NEW.business_id AND q.version=NEW.question_version)
    OR EXISTS (SELECT 1 FROM eval_questions q WHERE q.business_id=NEW.business_id
      AND q.version=NEW.question_version AND (q.approved_at IS NULL OR q.validation_errors <> '[]'::jsonb)) THEN
    RAISE EXCEPTION 'Question list must be approved before an eval run';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS approved_question_run ON eval_runs;
CREATE TRIGGER approved_question_run BEFORE INSERT OR UPDATE ON eval_runs
  FOR EACH ROW EXECUTE FUNCTION check_approved_question_run();
CREATE OR REPLACE FUNCTION check_run_question() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM eval_questions WHERE business_id=NEW.business_id AND id=NEW.question_id)
    OR NOT EXISTS (SELECT 1 FROM eval_runs WHERE business_id=NEW.business_id AND id=NEW.eval_run_id) THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM eval_questions q JOIN eval_runs r
      ON r.business_id=q.business_id AND r.question_version=q.version
      WHERE q.business_id=NEW.business_id AND q.id=NEW.question_id AND r.id=NEW.eval_run_id
        AND q.approved_at IS NOT NULL AND q.validation_errors='[]'::jsonb) THEN
    RAISE EXCEPTION 'Result question must belong to the approved run version';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS approved_result_question ON eval_results;
CREATE TRIGGER approved_result_question BEFORE INSERT OR UPDATE ON eval_results
  FOR EACH ROW EXECUTE FUNCTION check_run_question();
COMMIT;
