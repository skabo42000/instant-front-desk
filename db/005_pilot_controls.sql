BEGIN;
-- Operational counters contain hashed identities only, never business content.
-- business_id is NULL only for a global browser counter or the global provider budget.
CREATE TABLE IF NOT EXISTS rate_buckets (
  key_hash text PRIMARY KEY CHECK (key_hash ~ '^[a-f0-9]{64}$'),
  business_id uuid REFERENCES businesses(business_id),
  hits integer NOT NULL CHECK (hits >= 0),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS rate_buckets_expiry ON rate_buckets(expires_at);
CREATE TABLE IF NOT EXISTS pilot_budget (
  id text PRIMARY KEY CHECK (id = 'pilot'),
  business_id uuid REFERENCES businesses(business_id),
  used integer NOT NULL DEFAULT 0 CHECK (used >= 0),
  call_limit integer NOT NULL CHECK (call_limit BETWEEN 1 AND 300),
  stopped boolean NOT NULL DEFAULT false
);
ALTER TABLE rate_buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE pilot_budget ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON rate_buckets,pilot_budget FROM PUBLIC;

CREATE OR REPLACE FUNCTION ifd_consume_rate(entries jsonb, window_ms integer) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE item jsonb; bucket rate_buckets%ROWTYPE; stamp timestamptz := clock_timestamp();
BEGIN
  IF entries IS NULL OR window_ms IS NULL OR jsonb_typeof(entries) <> 'array' OR jsonb_array_length(entries) NOT BETWEEN 1 AND 10
    OR window_ms NOT BETWEEN 1000 AND 3600000 THEN RAISE EXCEPTION 'INVALID_RATE_INPUT'; END IF;
  -- A short global transaction lock makes all counters reserve together, including absent rows.
  -- Suitable for a small controlled pilot; measure lock contention before scaling.
  PERFORM pg_advisory_xact_lock(482019551::bigint);
  DELETE FROM rate_buckets WHERE expires_at <= stamp;
  IF (SELECT count(*) FROM rate_buckets) + jsonb_array_length(entries) > 10000 THEN RETURN false; END IF;
  IF (SELECT count(DISTINCT e->>'key') FROM jsonb_array_elements(entries) e) <> jsonb_array_length(entries)
    THEN RAISE EXCEPTION 'DUPLICATE_RATE_KEY'; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(entries) LOOP
    IF item->>'key' IS NULL OR item->>'key' !~ '^[a-f0-9]{64}$' OR item->>'limit' IS NULL OR
      (item->>'limit')::integer NOT BETWEEN 1 AND 10000 THEN RAISE EXCEPTION 'INVALID_RATE_INPUT'; END IF;
    SELECT * INTO bucket FROM rate_buckets WHERE key_hash=item->>'key';
    IF FOUND AND bucket.business_id IS DISTINCT FROM (item->>'businessId')::uuid THEN RAISE EXCEPTION 'RATE_SCOPE_MISMATCH'; END IF;
    IF FOUND AND bucket.hits >= (item->>'limit')::integer THEN RETURN false; END IF;
  END LOOP;
  FOR item IN SELECT value FROM jsonb_array_elements(entries) LOOP
    INSERT INTO rate_buckets (key_hash,business_id,hits,expires_at)
      VALUES (item->>'key',(item->>'businessId')::uuid,1,stamp + window_ms * interval '1 millisecond')
      ON CONFLICT (key_hash) DO UPDATE SET hits=rate_buckets.hits+1;
  END LOOP;
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION ifd_reserve_call(max_calls integer) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE budget pilot_budget%ROWTYPE;
BEGIN
  IF max_calls IS NULL OR max_calls NOT BETWEEN 1 AND 300 THEN RAISE EXCEPTION 'INVALID_BUDGET'; END IF;
  INSERT INTO pilot_budget(id,call_limit) VALUES ('pilot',max_calls) ON CONFLICT DO NOTHING;
  SELECT * INTO budget FROM pilot_budget WHERE id='pilot' FOR UPDATE;
  -- A restart or changed environment can lower a budget, never replenish or raise it.
  UPDATE pilot_budget SET call_limit=LEAST(call_limit,max_calls) WHERE id='pilot';
  IF budget.stopped OR budget.used >= LEAST(budget.call_limit,max_calls) THEN RETURN false; END IF;
  UPDATE pilot_budget SET used=used+1 WHERE id='pilot'; RETURN true;
END $$;
CREATE OR REPLACE FUNCTION ifd_stop_calls() RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE pilot_budget SET stopped=true WHERE id='pilot';
$$;
REVOKE ALL ON FUNCTION ifd_consume_rate(jsonb,integer), ifd_reserve_call(integer), ifd_stop_calls() FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname='service_role') THEN
    GRANT EXECUTE ON FUNCTION ifd_consume_rate(jsonb,integer), ifd_reserve_call(integer), ifd_stop_calls() TO service_role;
  END IF;
END $$;
COMMIT;
