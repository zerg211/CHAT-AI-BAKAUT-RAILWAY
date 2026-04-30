CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS conversation_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed', 'expired')),
  visitor_id text,
  page_url text,
  user_agent text,
  need_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  history_summary text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_heartbeat_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz
);

CREATE INDEX IF NOT EXISTS conversation_sessions_status_idx ON conversation_sessions(status);
CREATE INDEX IF NOT EXISTS conversation_sessions_updated_at_idx ON conversation_sessions(updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
  content text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS messages_session_created_idx ON messages(session_id, created_at);

CREATE TABLE IF NOT EXISTS catalog_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text NOT NULL CHECK (type IN ('site_crawl', 'csv_import')),
  location text NOT NULL,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
  stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE TABLE IF NOT EXISTS products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_id text UNIQUE,
  slug text,
  source_url text UNIQUE,
  name text NOT NULL,
  brand text,
  category text,
  price numeric(14, 2),
  currency text DEFAULT 'RUB',
  image_url text,
  description text,
  specs jsonb NOT NULL DEFAULT '{}'::jsonb,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_priority integer NOT NULL DEFAULT 50,
  embedding vector(1536),
  search_tsv tsvector GENERATED ALWAYS AS (
    to_tsvector(
      'russian',
      coalesce(name, '') || ' ' ||
      coalesce(brand, '') || ' ' ||
      coalesce(category, '') || ' ' ||
      coalesce(description, '') || ' ' ||
      coalesce(specs::text, '')
    )
  ) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS products_search_tsv_idx ON products USING gin(search_tsv);
CREATE INDEX IF NOT EXISTS products_category_idx ON products(category);
CREATE INDEX IF NOT EXISTS products_updated_at_idx ON products(updated_at DESC);
CREATE INDEX IF NOT EXISTS products_embedding_idx ON products USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

CREATE TABLE IF NOT EXISTS product_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  attribute text NOT NULL,
  value text NOT NULL,
  unit text,
  source_type text NOT NULL CHECK (source_type IN ('site', 'csv', 'web', 'manual')),
  source_url text,
  confidence numeric(3, 2) NOT NULL DEFAULT 0.70,
  observed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS product_facts_product_attr_idx ON product_facts(product_id, attribute);
CREATE UNIQUE INDEX IF NOT EXISTS product_facts_unique_source_idx
  ON product_facts(product_id, attribute, value, coalesce(unit, ''), source_type, coalesce(source_url, ''));

CREATE TABLE IF NOT EXISTS data_conflicts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  attribute text NOT NULL,
  values jsonb NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'ignored')),
  resolution jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  UNIQUE(product_id, attribute, status)
);

CREATE INDEX IF NOT EXISTS data_conflicts_status_idx ON data_conflicts(status);

CREATE TABLE IF NOT EXISTS web_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conflict_id uuid REFERENCES data_conflicts(id) ON DELETE SET NULL,
  product_id uuid REFERENCES products(id) ON DELETE SET NULL,
  query text NOT NULL,
  source_url text,
  title text,
  snippet text,
  verdict jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid REFERENCES conversation_sessions(id) ON DELETE SET NULL,
  name text NOT NULL,
  phone text,
  email text,
  question text,
  status text NOT NULL DEFAULT 'pending_email' CHECK (status IN ('pending_email', 'sent_email', 'email_failed')),
  email_provider_response jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);

CREATE INDEX IF NOT EXISTS leads_status_created_idx ON leads(status, created_at DESC);
