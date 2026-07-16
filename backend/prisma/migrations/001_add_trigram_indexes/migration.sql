-- Create trigram extension for full-text search on Contact name/email
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- GIN trigram indexes for fast ILIKE / pattern matching searches
CREATE INDEX IF NOT EXISTS "idx_contact_name_trigram" ON "Contact" USING GIN (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "idx_contact_email_trigram" ON "Contact" USING GIN (email gin_trgm_ops);
