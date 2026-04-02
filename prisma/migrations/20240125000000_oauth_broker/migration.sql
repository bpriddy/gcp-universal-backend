-- ── OAuth broker tables ───────────────────────────────────────────────────
-- Supports server-side OAuth flow for headless clients (e.g. Agentspace MCP).
-- The broker acts as an OAuth 2.0 Authorization Server, proxying Google identity
-- while issuing GUB JWTs.  Client-side flows (POST /auth/google/exchange) are
-- unaffected and do not use these tables.

-- Registered OAuth clients (e.g. the Agentspace MCP agent)
CREATE TABLE oauth_clients (
  id                UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  client_id         TEXT        NOT NULL UNIQUE,       -- public identifier sent in requests
  client_secret_hash TEXT       NOT NULL,              -- SHA-256 of the plaintext secret
  name              TEXT        NOT NULL,              -- human label, e.g. "Agentspace MCP"
  redirect_uris     TEXT[]      NOT NULL,              -- allowed redirect URIs (exact match)
  is_active         BOOLEAN     NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Short-lived state records bridging /authorize → Google → /callback
-- State = record ID (UUID), expires in 10 minutes
CREATE TABLE oauth_pending_auths (
  id            UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,  -- = state param
  client_id     TEXT        NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  redirect_uri  TEXT        NOT NULL,
  client_state  TEXT,                                  -- original ?state= from the client
  expires_at    TIMESTAMPTZ NOT NULL DEFAULT now() + INTERVAL '10 minutes',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_oauth_pending_auths_expires_at ON oauth_pending_auths (expires_at);

-- Short-lived auth codes issued after successful Google callback
-- Exchanged for GUB tokens at POST /auth/google/broker/token; single-use, 5 min TTL
CREATE TABLE oauth_auth_codes (
  id            UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  code_hash     TEXT        NOT NULL UNIQUE,           -- SHA-256 of the plaintext code
  client_id     TEXT        NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  user_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri  TEXT        NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL DEFAULT now() + INTERVAL '5 minutes',
  used_at       TIMESTAMPTZ,                           -- set on first use; replay = reject
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_oauth_auth_codes_expires_at ON oauth_auth_codes (expires_at);

-- updated_at trigger for oauth_clients
CREATE OR REPLACE FUNCTION set_oauth_clients_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

CREATE TRIGGER trg_oauth_clients_updated_at
  BEFORE UPDATE ON oauth_clients
  FOR EACH ROW EXECUTE FUNCTION set_oauth_clients_updated_at();
