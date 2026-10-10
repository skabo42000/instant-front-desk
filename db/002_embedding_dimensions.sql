BEGIN;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS embedding_dimensions integer NOT NULL DEFAULT 768 CHECK (embedding_dimensions = 768);
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS embedding_dimensions integer NOT NULL DEFAULT 768 CHECK (embedding_dimensions = 768 AND vector_dims(embedding) = embedding_dimensions);
COMMIT;
