-- =========================================================================
-- 001 — Toegang, klanten, registratie
--
-- Draaien: Supabase -> SQL Editor -> plakken -> Run.
-- Idempotent: elke stap gebruikt IF NOT EXISTS, dus twee keer draaien mag.
-- =========================================================================

-- -------------------------------------------------------------------------
-- EIGEN SCHEMA
--
-- Dit project deelt de database met de CMS. Alles van marketing-intelligence
-- staat daarom in het schema 'mi' in plaats van in 'public'. Dat betekent:
--   * geen naamconflicten, ook niet als de CMS ooit een tabel 'client' krijgt;
--   * 'pg_dump -n mi' haalt dit er in één keer uit als je het later toch wil
--     verhuizen naar een eigen project;
--   * de CMS kan 'public' blijven gebruiken zonder dat wij in de weg zitten.
--
-- gen_random_uuid() zit sinds Postgres 13 in de kern, dus pgcrypto is niet
-- nodig.
--
-- NA HET DRAAIEN VAN DEZE MIGRATIE: zet 'mi' bij
-- Project Settings -> API -> Exposed schemas, naast 'public'.
-- Zonder die instelling kan de applicatie deze tabellen niet lezen.
-- -------------------------------------------------------------------------

CREATE SCHEMA IF NOT EXISTS mi;
SET search_path = mi, public;

-- ---------- toegang ------------------------------------------------------

CREATE TABLE IF NOT EXISTS app_user (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    auth_uid     uuid UNIQUE NOT NULL,          -- verwijst naar auth.users.id
    email        text NOT NULL,
    full_name    text,
    role         text NOT NULL CHECK (role IN ('owner','agency','client')),
    is_active    boolean NOT NULL DEFAULT true,
    last_seen_at timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS client (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name        text NOT NULL,
    slug        text UNIQUE NOT NULL,
    status      text NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','paused','ended')),
    currency    text NOT NULL DEFAULT 'EUR',
    timezone    text NOT NULL DEFAULT 'Europe/Amsterdam',

    -- Vaste fee die jij rekent. Nooit in het klantportaal.
    monthly_fee numeric(14,2),

    -- Standaard brutomarge in procenten. Nodig omdat je in de praktijk vaak
    -- alleen de orderwaarde van een klus terugkrijgt en niet de kostprijs.
    -- Hiermee leidt het systeem de marge af, gemarkeerd als schatting.
    default_margin_pct numeric(5,2),

    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_client_access (
    user_id      uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    client_id    uuid NOT NULL REFERENCES client(id)   ON DELETE CASCADE,
    access_level text NOT NULL DEFAULT 'viewer'
                 CHECK (access_level IN ('viewer','editor')),
    invited_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, client_id)
);

-- Wat mag deze klant in zijn portaal zien?
CREATE TABLE IF NOT EXISTS client_portal_settings (
    client_id         uuid PRIMARY KEY REFERENCES client(id) ON DELETE CASCADE,
    portal_enabled    boolean NOT NULL DEFAULT false,
    show_spend        boolean NOT NULL DEFAULT true,
    show_revenue      boolean NOT NULL DEFAULT true,
    show_margin       boolean NOT NULL DEFAULT true,
    show_profit       boolean NOT NULL DEFAULT true,
    show_keywords     boolean NOT NULL DEFAULT true,
    show_search_terms boolean NOT NULL DEFAULT false,
    show_lead_contact boolean NOT NULL DEFAULT true,
    logo_url          text,
    accent_color      text
);

CREATE TABLE IF NOT EXISTS report_share (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id    uuid NOT NULL REFERENCES client(id) ON DELETE CASCADE,
    token        text UNIQUE NOT NULL,
    period_start date NOT NULL,
    period_end   date NOT NULL,
    created_by   uuid REFERENCES app_user(id),
    expires_at   timestamptz NOT NULL,
    revoked_at   timestamptz,
    view_count   int NOT NULL DEFAULT 0,
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_log (
    id        bigserial PRIMARY KEY,
    user_id   uuid REFERENCES app_user(id),
    client_id uuid REFERENCES client(id),
    action    text NOT NULL,     -- view_lead, export_leads, update_status, ...
    entity    text,
    entity_id text,
    ip        inet,
    at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_log_at_idx ON audit_log (at DESC);

-- ---------- registratie: wat hoort bij welke klant ----------------------

CREATE TABLE IF NOT EXISTS website (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id            uuid NOT NULL REFERENCES client(id) ON DELETE CASCADE,
    domain               text UNIQUE NOT NULL,   -- boersbreuer.nl
    label                text,
    ga4_property_id      text,                   -- 123456789 (Data API)
    ga4_measurement_id   text,                   -- G-XNK3821MV5
    ads_conversion_id    text,                   -- AW-18441189967
    formspree_endpoint   text,                   -- xeevldqj
    collector_key        text UNIQUE NOT NULL,   -- publieke sleutel in mi-collect.js
    collector_live_since timestamptz,
    timezone             text NOT NULL DEFAULT 'Europe/Amsterdam',
    is_active            boolean NOT NULL DEFAULT true,
    created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS website_client_idx ON website (client_id);

CREATE TABLE IF NOT EXISTS ads_account (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id           uuid REFERENCES client(id) ON DELETE SET NULL,
    customer_id         text UNIQUE NOT NULL,    -- 5442825521, zonder streepjes
    descriptive_name    text,
    currency_code       text,
    time_zone           text,                    -- nodig voor offline conversies
    is_manager          boolean NOT NULL DEFAULT false,
    manager_customer_id text,                    -- MCC 9287874539
    status              text,
    last_synced_at      timestamptz
);
CREATE INDEX IF NOT EXISTS ads_account_client_idx ON ads_account (client_id);

CREATE TABLE IF NOT EXISTS crm_connection (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id      uuid NOT NULL REFERENCES client(id) ON DELETE CASCADE,
    kind           text NOT NULL CHECK (kind IN ('teamleader','csv','sheet','manual')),
    is_active      boolean NOT NULL DEFAULT true,
    config         jsonb NOT NULL DEFAULT '{}',  -- verwijzingen, geen secrets
    last_synced_at timestamptz
);

-- ---------- helpers voor RLS (policies staan in 006) --------------------

-- Ook deze functies staan in 'mi'. search_path staat vast op mi, public:
-- bij SECURITY DEFINER is een variabel zoekpad een bekende manier om een
-- functie met verhoogde rechten om de tuin te leiden.

CREATE OR REPLACE FUNCTION mi.user_role() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = mi, public AS $$
  SELECT role FROM app_user WHERE auth_uid = auth.uid() AND is_active;
$$;

-- Iemand die inlogt maar geen rij in mi.app_user heeft, krijgt hier niets
-- terug. Dat is precies wat we willen nu de CMS dezelfde auth.users deelt:
-- een CMS-redacteur ziet nul rijen, tenzij hij hier expliciet is toegelaten.
CREATE OR REPLACE FUNCTION mi.visible_clients() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = mi, public AS $$
  SELECT id FROM client WHERE mi.user_role() IN ('owner','agency')
  UNION
  SELECT uca.client_id
    FROM user_client_access uca
    JOIN app_user u ON u.id = uca.user_id
   WHERE u.auth_uid = auth.uid() AND u.is_active;
$$;

-- Alleen de rollen die de applicatie gebruikt mogen dit schema zien.
-- service_role is de ingestion (secret key), authenticated is een ingelogde
-- gebruiker van het dashboard. Beide hebben rechten nodig; RLS bepaalt daarna
-- welke RIJEN een gebruiker ziet. service_role omzeilt RLS bewust.
GRANT USAGE ON SCHEMA mi TO authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA mi
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA mi
  GRANT USAGE, SELECT ON SEQUENCES TO authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA mi
  GRANT EXECUTE ON FUNCTIONS TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES    IN SCHEMA mi TO authenticated, service_role;
GRANT USAGE, SELECT                  ON ALL SEQUENCES IN SCHEMA mi TO authenticated, service_role;
GRANT EXECUTE                        ON ALL FUNCTIONS IN SCHEMA mi TO authenticated, service_role;
-- 'anon' krijgt bewust niets: zonder inloggen valt hier niets te halen.
