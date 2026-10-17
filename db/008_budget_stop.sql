BEGIN;
-- Preserve a stop even before the first reservation, including concurrent startup.
CREATE OR REPLACE FUNCTION ifd_stop_calls() RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO pilot_budget(id,call_limit,stopped) VALUES ('pilot',1,true)
  ON CONFLICT (id) DO UPDATE SET stopped=true;
$$;
REVOKE ALL ON FUNCTION ifd_stop_calls() FROM PUBLIC;
DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION ifd_stop_calls() FROM %I',role_name);
    END IF;
  END LOOP;
END $$;
COMMIT;
