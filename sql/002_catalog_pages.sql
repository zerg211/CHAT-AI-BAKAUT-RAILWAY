CREATE TABLE IF NOT EXISTS catalog_pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_url text UNIQUE NOT NULL,
  page_type text NOT NULL DEFAULT 'page',
  title text NOT NULL,
  content text NOT NULL,
  summary text,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  embedding vector(1536),
  search_tsv tsvector GENERATED ALWAYS AS (
    to_tsvector(
      'russian',
      coalesce(title, '') || ' ' ||
      coalesce(summary, '') || ' ' ||
      coalesce(content, '')
    )
  ) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS catalog_pages_search_tsv_idx ON catalog_pages USING gin(search_tsv);
CREATE INDEX IF NOT EXISTS catalog_pages_page_type_idx ON catalog_pages(page_type);
CREATE INDEX IF NOT EXISTS catalog_pages_updated_at_idx ON catalog_pages(updated_at DESC);
CREATE INDEX IF NOT EXISTS catalog_pages_embedding_idx ON catalog_pages USING ivfflat (embedding vector_cosine_ops) WITH (lists = 50);
