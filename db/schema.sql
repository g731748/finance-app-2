-- Run this once against your Railway PostgreSQL database (see README).

CREATE TABLE IF NOT EXISTS transactions (
  id            SERIAL PRIMARY KEY,
  date          DATE NOT NULL,
  type          TEXT NOT NULL CHECK (type IN ('income', 'expense')),
  amount        NUMERIC(12, 2) NOT NULL,
  category      TEXT DEFAULT '',
  note          TEXT DEFAULT '',
  vat_eligible  BOOLEAN DEFAULT TRUE,
  source        TEXT DEFAULT 'manual', -- 'manual' | 'gmail' | 'bank'
  external_id   TEXT,                  -- Gmail message id / bank transaction id, for dedup
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- Prevents the same Gmail message or bank transaction from being imported twice.
CREATE UNIQUE INDEX IF NOT EXISTS transactions_external_id_idx
  ON transactions (source, external_id)
  WHERE external_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS transactions_date_idx ON transactions (date);

-- Stores the Gmail OAuth refresh token so the server can sync without you
-- logging in again every time. In a real multi-user product this would be
-- keyed per user; for personal use, one row is enough.
CREATE TABLE IF NOT EXISTS oauth_tokens (
  provider      TEXT PRIMARY KEY, -- 'gmail'
  refresh_token TEXT NOT NULL,
  updated_at    TIMESTAMPTZ DEFAULT now()
);
