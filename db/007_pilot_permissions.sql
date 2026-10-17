BEGIN;
-- Supabase may grant its API roles explicit default privileges. Revoking PUBLIC
-- alone does not revoke those grants. No browser role may invoke the server RPCs.
DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON businesses,crawl_runs,pages,chunks,eval_questions,eval_runs,eval_results,question_evidence,result_citations,model_requests,question_lists,rate_buckets,pilot_budget FROM %I',role_name);
      EXECUTE format('REVOKE ALL ON FUNCTION ifd_consume_rate(jsonb,integer),ifd_reserve_call(integer),ifd_stop_calls(),ifd_read(uuid,text,text,text,text,vector,integer) FROM %I',role_name);
    END IF;
  END LOOP;
END $$;
COMMIT;
