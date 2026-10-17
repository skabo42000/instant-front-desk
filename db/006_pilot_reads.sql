BEGIN;
-- Server credential only. There is no browser/public SQL execution endpoint.
CREATE OR REPLACE FUNCTION ifd_read(scope uuid, operation text, slug_value text DEFAULT NULL,
  model_value text DEFAULT NULL, pattern_value text DEFAULT NULL, query_vector vector(768) DEFAULT NULL,
  result_limit integer DEFAULT 8) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE result jsonb;
BEGIN
  IF result_limit IS NULL OR result_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'INVALID_READ_LIMIT'; END IF;
  IF operation='business' OR operation='find' OR operation='list' THEN
    SELECT coalesce(jsonb_agg(to_jsonb(b)),'[]'::jsonb) INTO result FROM (
      SELECT business_id AS "businessId",slug,name,source_url AS "sourceUrl",contact_url AS "contactUrl",phone,
        embedding_model AS "embeddingModel",embedding_dimensions AS "embeddingDimensions" FROM businesses
      WHERE (operation='list' OR (operation='business' AND business_id=scope) OR (operation='find' AND slug=slug_value))
      ORDER BY name,slug LIMIT 100
    ) b;
    RETURN result;
  END IF;
  IF scope IS NULL THEN RAISE EXCEPTION 'BUSINESS_SCOPE_REQUIRED'; END IF;
  IF operation='pages' THEN
    SELECT coalesce(jsonb_agg(to_jsonb(p)),'[]'::jsonb) INTO result FROM (
      SELECT url AS "pageUrl",clean_text AS text FROM pages WHERE business_id=scope ORDER BY url
    ) p; RETURN result;
  ELSIF operation='report' THEN
    SELECT report INTO result FROM eval_runs WHERE business_id=scope AND report IS NOT NULL ORDER BY started_at DESC,id DESC LIMIT 1;
    RETURN result;
  ELSIF operation NOT IN ('vector','pattern','heading','overview') THEN RAISE EXCEPTION 'INVALID_READ_OPERATION'; END IF;
  IF NOT EXISTS (SELECT FROM businesses WHERE business_id=scope AND embedding_model=model_value) THEN RAISE EXCEPTION 'EMBEDDING_SPACE_MISMATCH'; END IF;
  IF operation='vector' AND (query_vector IS NULL OR vector_dims(query_vector)<>768) THEN RAISE EXCEPTION 'INVALID_VECTOR'; END IF;
  IF operation IN ('pattern','heading') AND (pattern_value IS NULL OR length(pattern_value)>2000 OR result_limit>20) THEN RAISE EXCEPTION 'INVALID_PATTERN'; END IF;
  SELECT coalesce(jsonb_agg(to_jsonb(h)),'[]'::jsonb) INTO result FROM (
    SELECT c.business_id AS "businessId",c.id,p.url AS "pageUrl",c.heading,c.text,
      CASE WHEN operation='vector' THEN c.embedding <-> query_vector ELSE 0 END AS distance
    FROM chunks c JOIN pages p ON p.business_id=c.business_id AND p.id=c.page_id
    JOIN businesses b ON b.business_id=c.business_id
    WHERE c.business_id=scope AND c.embedding_model=model_value AND (
      operation='vector' OR (operation='pattern' AND (c.heading || ' ' || c.text) ~* pattern_value) OR
      (operation='heading' AND c.heading ~* pattern_value) OR
      (operation='overview' AND length(c.text)>=60 AND (p.url=b.source_url OR p.url=b.source_url || '/')))
    ORDER BY
      CASE WHEN operation='vector' THEN c.embedding <-> query_vector ELSE 0 END,
      CASE WHEN operation='pattern' THEN regexp_count(c.heading || ' ' || c.text,pattern_value,1,'i') ELSE 0 END DESC,
      CASE WHEN operation='pattern' THEN length(c.text) ELSE 0 END,
      CASE WHEN operation='heading' THEN p.url ELSE '' END,
      CASE WHEN operation IN ('heading','overview') THEN c.ordinal ELSE 0 END,c.id LIMIT result_limit
  ) h; RETURN result;
END $$;
REVOKE ALL ON FUNCTION ifd_read(uuid,text,text,text,text,vector,integer) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname='service_role') THEN
    GRANT EXECUTE ON FUNCTION ifd_read(uuid,text,text,text,text,vector,integer) TO service_role;
  END IF;
END $$;
COMMIT;
