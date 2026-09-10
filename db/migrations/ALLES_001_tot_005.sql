-- =========================================================================
-- ALLES IN ÉÉN: migraties 001 t/m 005 achter elkaar.
--
-- Plak dit hele bestand in de Supabase SQL Editor en klik Run.
-- Idempotent: twee keer draaien kan geen schade doen.
--
-- Raakt de CMS niet: alles komt in het nieuwe schema 'mi', 'public' blijft
-- ongemoeid.
--
-- NIET hierin opgenomen: 006_rls_portal.sql. Die hoort bij fase 4, als er
-- klantgebruikers komen. Nu draaien zou je eigen dashboard leegmaken.
-- =========================================================================



-- #########################################################################
-- 001_core.sql
-- #########################################################################

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
GRANT USAGE ON SCHEMA mi TO authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA mi
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA mi GRANT USAGE ON SEQUENCES TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA mi TO authenticated;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA mi TO authenticated;
-- 'anon' krijgt bewust niets: zonder inloggen valt hier niets te halen.


-- #########################################################################
-- 002_events_leads.sql
-- #########################################################################

-- Alle objecten in het schema 'mi', zodat dit project met de CMS kan
-- samenleven zonder naamconflicten. Zie 001_core.sql voor de uitleg.
SET search_path = mi, public;

-- =========================================================================
-- 002 — Events, bezoekers, leads
-- =========================================================================

-- ---------- event-registratie: nieuw type = 1 INSERT, geen migratie ------

CREATE TABLE IF NOT EXISTS event_type (
    code           text PRIMARY KEY,
    label          text NOT NULL,
    category       text NOT NULL CHECK (category IN
                   ('pageview','engagement','contact','lead','sales','system')),
    is_conversion  boolean NOT NULL DEFAULT false,
    is_identifying boolean NOT NULL DEFAULT false,  -- levert dit PII op?
    sort_order     int NOT NULL DEFAULT 100,
    icon           text
);

INSERT INTO event_type (code,label,category,is_conversion,is_identifying,sort_order) VALUES
 ('session_start',    'Sessie gestart',      'system',     false,false,10),
 ('ads_click',        'Google Ads klik',     'engagement', false,false,15),
 ('page_view',        'Paginaweergave',      'pageview',   false,false,20),
 ('scroll_depth',     'Scrolldiepte',        'engagement', false,false,25),
 ('cta_click',        'CTA-klik',            'engagement', false,false,30),
 ('faq_expand',       'FAQ geopend',         'engagement', false,false,32),
 ('calculator_start', 'Calculator gestart',  'engagement', false,false,34),
 ('calculator_result','Calculator resultaat','engagement', false,false,35),
 ('outbound_click',   'Uitgaande klik',      'engagement', false,false,36),
 ('contact_click',    'Contact-klik',        'contact',    false,false,40),
 ('phone_click',      'Telefoonklik',        'contact',    true, false,42),
 ('whatsapp_click',   'WhatsApp-klik',       'contact',    true, false,44),
 ('email_click',      'E-mailklik',          'contact',    true, false,46),
 ('form_start',       'Formulier gestart',   'lead',       false,false,50),
 ('form_submit',      'Formulier verstuurd', 'lead',       true, true, 52),
 ('quote_request',    'Offerteaanvraag',     'lead',       true, true, 54),
 ('inbound_call',     'Inkomend gesprek',    'lead',       true, true, 56),
 ('offer_created',    'Offerte opgesteld',   'sales',      false,false,60),
 ('offer_sent',       'Offerte verstuurd',   'sales',      false,false,62),
 ('offer_signed',     'Offerte getekend',    'sales',      true, false,64),
 ('deal_won',         'Deal gewonnen',       'sales',      true, false,66),
 ('deal_lost',        'Deal verloren',       'sales',      false,false,68)
ON CONFLICT (code) DO NOTHING;

-- ---------- pseudonieme bezoeker ----------------------------------------

CREATE TABLE IF NOT EXISTS visitor (
    id                 uuid PRIMARY KEY,   -- door de browser gegenereerd
    website_id         uuid NOT NULL REFERENCES website(id) ON DELETE CASCADE,
    client_id          uuid NOT NULL REFERENCES client(id)  ON DELETE CASCADE,
    ga_client_id       text,               -- uit het _ga-cookie
    first_seen_at      timestamptz NOT NULL DEFAULT now(),
    last_seen_at       timestamptz NOT NULL DEFAULT now(),
    first_landing_page text,
    first_referrer     text,
    first_source       text,
    first_medium       text,
    first_campaign     text,
    first_click_id     text,
    first_click_type   text,
    consent_state      text                -- accepted | denied | unknown
);
CREATE INDEX IF NOT EXISTS visitor_client_seen_idx ON visitor (client_id, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS visitor_gacid_idx ON visitor (ga_client_id) WHERE ga_client_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS visit_session (
    id            uuid PRIMARY KEY,
    visitor_id    uuid NOT NULL REFERENCES visitor(id) ON DELETE CASCADE,
    website_id    uuid NOT NULL REFERENCES website(id) ON DELETE CASCADE,
    client_id     uuid NOT NULL REFERENCES client(id)  ON DELETE CASCADE,
    started_at    timestamptz NOT NULL,
    last_event_at timestamptz NOT NULL,
    landing_page  text,
    referrer      text,
    source        text,
    medium        text,
    campaign      text,
    term          text,
    content       text,
    click_id      text,
    click_type    text,    -- gclid | wbraid | gbraid | msclkid | fbclid
    device_type   text,    -- mobile | desktop | tablet
    country       text,
    event_count   int NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS session_visitor_idx ON visit_session (visitor_id, started_at);
CREATE INDEX IF NOT EXISTS session_client_idx  ON visit_session (client_id, started_at DESC);

-- ---------- de lead ------------------------------------------------------

CREATE SEQUENCE IF NOT EXISTS lead_public_ref_seq START 1000;

CREATE TABLE IF NOT EXISTS lead (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    public_ref  bigint NOT NULL UNIQUE DEFAULT nextval('lead_public_ref_seq'),
    client_id   uuid NOT NULL REFERENCES client(id) ON DELETE CASCADE,
    website_id  uuid REFERENCES website(id)         ON DELETE SET NULL,

    -- contactgegevens (PII — blijft hier, gaat nooit naar GA4)
    name         text,
    email        text,
    email_norm   text,      -- lowercase, getrimd
    email_sha256 text,      -- matching + enhanced conversions
    phone        text,
    phone_e164   text,      -- +31612345678
    phone_sha256 text,
    company      text,
    city         text,

    -- marketingherkomst, vastgelegd op het moment van de lead
    lead_type    text NOT NULL DEFAULT 'form'
                 CHECK (lead_type IN ('form','phone','whatsapp','email','manual','import')),
    source       text,
    medium       text,
    campaign     text,
    ad_group     text,
    keyword      text,
    click_id     text,
    click_type   text,
    landing_page text,
    referrer     text,
    device_type  text,
    subject      text,      -- gekozen dienst/onderwerp
    budget_band  text,

    -- pipeline
    status            text NOT NULL DEFAULT 'new'
                      CHECK (status IN ('new','contacted','qualified','offer_sent',
                                        'won','lost','disqualified')),
    status_changed_at timestamptz NOT NULL DEFAULT now(),
    lost_reason       text,
    owner_user_id     uuid REFERENCES app_user(id),

    -- herkomst en kwaliteit van de koppeling
    first_visitor_id  uuid REFERENCES visitor(id) ON DELETE SET NULL,
    first_seen_at     timestamptz,   -- eerste event van deze bezoeker
    created_at        timestamptz NOT NULL DEFAULT now(),
    ingest_source     text NOT NULL DEFAULT 'collector'
                      CHECK (ingest_source IN ('collector','mail','crm','manual','import')),
    external_id       text,
    dedupe_key        text,          -- lead_id uit de browser
    match_confidence  numeric(3,2),
    needs_review      boolean NOT NULL DEFAULT false,
    -- Formspree is gratis, dus de mail is de enige gegarandeerde bron.
    -- true = de mailparser heeft deze lead teruggezien; false = alleen de
    -- collector zag hem, of alleen de mail (dan is ingest_source 'mail').
    confirmed_by_mail boolean NOT NULL DEFAULT false,

    consent_marketing boolean,       -- mag deze lead naar Google Ads?
    internal_notes    text,          -- nooit in het portaal
    deleted_at        timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS lead_dedupe_idx ON lead (client_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS lead_client_created_idx ON lead (client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS lead_client_status_idx  ON lead (client_id, status);
CREATE INDEX IF NOT EXISTS lead_email_hash_idx ON lead (email_sha256) WHERE email_sha256 IS NOT NULL;
CREATE INDEX IF NOT EXISTS lead_phone_hash_idx ON lead (phone_sha256) WHERE phone_sha256 IS NOT NULL;
CREATE INDEX IF NOT EXISTS lead_click_idx      ON lead (click_id)     WHERE click_id     IS NOT NULL;

-- Elke sleutel waarmee we deze lead herkennen, met bewijslast.
CREATE TABLE IF NOT EXISTS lead_identity (
    id         bigserial PRIMARY KEY,
    lead_id    uuid NOT NULL REFERENCES lead(id) ON DELETE CASCADE,
    kind       text NOT NULL CHECK (kind IN
               ('visitor_id','ga_client_id','email_sha256','phone_sha256',
                'click_id','external_id','browser_lead_id')),
    value      text NOT NULL,
    confidence numeric(3,2) NOT NULL,
    method     text NOT NULL,   -- exact_lead_id, visitor_stitch, email_match, ...
    matched_at timestamptz NOT NULL DEFAULT now(),
    matched_by uuid REFERENCES app_user(id),
    UNIQUE (kind, value, lead_id)
);
CREATE INDEX IF NOT EXISTS lead_identity_lookup_idx ON lead_identity (kind, value);

CREATE TABLE IF NOT EXISTS lead_status_history (
    id          bigserial PRIMARY KEY,
    lead_id     uuid NOT NULL REFERENCES lead(id) ON DELETE CASCADE,
    from_status text,
    to_status   text NOT NULL,
    changed_at  timestamptz NOT NULL DEFAULT now(),
    changed_by  uuid REFERENCES app_user(id),
    note        text
);
CREATE INDEX IF NOT EXISTS lead_status_hist_idx ON lead_status_history (lead_id, changed_at);

-- ---------- het event-model ---------------------------------------------

CREATE TABLE IF NOT EXISTS lead_event (
    id          bigserial PRIMARY KEY,
    client_id   uuid NOT NULL REFERENCES client(id)  ON DELETE CASCADE,
    website_id  uuid REFERENCES website(id)          ON DELETE SET NULL,
    lead_id     uuid REFERENCES lead(id)             ON DELETE SET NULL,
    visitor_id  uuid REFERENCES visitor(id)          ON DELETE SET NULL,
    session_id  uuid REFERENCES visit_session(id)    ON DELETE SET NULL,

    event_type  text NOT NULL REFERENCES event_type(code),
    occurred_at timestamptz NOT NULL,   -- klok van de browser
    received_at timestamptz NOT NULL DEFAULT now(),  -- onze klok

    page_url    text,
    page_path   text,
    page_title  text,
    page_type   text,       -- dienst | locatie | blog | contact
    referrer    text,
    source      text,
    medium      text,
    campaign    text,
    term        text,
    content     text,
    click_id    text,
    click_type  text,

    value       numeric(14,2),
    currency    text,
    metadata    jsonb NOT NULL DEFAULT '{}',

    ingest_source text NOT NULL DEFAULT 'collector'
                  CHECK (ingest_source IN ('collector','ga4','ads','crm','mail','manual')),
    dedupe_key  text NOT NULL          -- event_uid uit de browser
);
CREATE UNIQUE INDEX IF NOT EXISTS lead_event_dedupe_idx ON lead_event (dedupe_key);
CREATE INDEX IF NOT EXISTS lead_event_lead_idx ON lead_event (lead_id, occurred_at);
-- Deze index bestaat voor het terugwaarts stitchen: alle losse events van een
-- bezoeker die later een formulier instuurt.
CREATE INDEX IF NOT EXISTS lead_event_stitch_idx ON lead_event (visitor_id, occurred_at)
  WHERE lead_id IS NULL;
CREATE INDEX IF NOT EXISTS lead_event_client_idx ON lead_event (client_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS lead_event_client_type_idx ON lead_event (client_id, event_type, occurred_at DESC);


-- #########################################################################
-- 003_ads_ga4.sql
-- #########################################################################

-- Alle objecten in het schema 'mi', zodat dit project met de CMS kan
-- samenleven zonder naamconflicten. Zie 001_core.sql voor de uitleg.
SET search_path = mi, public;

-- =========================================================================
-- 003 — Google Ads en GA4
-- =========================================================================

CREATE TABLE IF NOT EXISTS ads_campaign (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    ads_account_id   uuid NOT NULL REFERENCES ads_account(id) ON DELETE CASCADE,
    campaign_id      bigint NOT NULL,
    name             text,
    status           text,
    channel_type     text,      -- SEARCH | PERFORMANCE_MAX | DISPLAY | ...
    bidding_strategy text,
    budget_micros    bigint,
    start_date       date,
    end_date         date,
    updated_at       timestamptz NOT NULL DEFAULT now(),
    UNIQUE (ads_account_id, campaign_id)
);

CREATE TABLE IF NOT EXISTS ads_ad_group (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    ads_account_id uuid NOT NULL REFERENCES ads_account(id) ON DELETE CASCADE,
    campaign_id    bigint NOT NULL,
    ad_group_id    bigint NOT NULL,
    name           text,
    status         text,
    updated_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (ads_account_id, ad_group_id)
);

CREATE TABLE IF NOT EXISTS ads_keyword (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    ads_account_id uuid NOT NULL REFERENCES ads_account(id) ON DELETE CASCADE,
    ad_group_id    bigint NOT NULL,
    criterion_id   bigint NOT NULL,
    text           text,
    match_type     text,
    status         text,
    final_urls     text[],
    updated_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (ads_account_id, ad_group_id, criterion_id)
);

-- Eén feitentabel, één grein. criterion_id NULL = campagne/adgroep-niveau.
CREATE TABLE IF NOT EXISTS ads_metrics_daily (
    id                bigserial PRIMARY KEY,
    ads_account_id    uuid NOT NULL REFERENCES ads_account(id) ON DELETE CASCADE,
    date              date NOT NULL,
    campaign_id       bigint NOT NULL,
    ad_group_id       bigint,
    criterion_id      bigint,
    impressions       bigint NOT NULL DEFAULT 0,
    clicks            bigint NOT NULL DEFAULT 0,
    cost_micros       bigint NOT NULL DEFAULT 0,
    cost              numeric(14,2) GENERATED ALWAYS AS (cost_micros / 1000000.0) STORED,
    conversions       numeric(12,2) NOT NULL DEFAULT 0,
    conversions_value numeric(14,2) NOT NULL DEFAULT 0,
    all_conversions   numeric(12,2) NOT NULL DEFAULT 0,
    interactions      bigint NOT NULL DEFAULT 0,
    synced_at         timestamptz NOT NULL DEFAULT now()
);
-- Expressie-index omdat NULL in een gewone UNIQUE niet met zichzelf botst:
-- zonder COALESCE zou dezelfde campagnerij elke nacht opnieuw ingevoegd worden.
CREATE UNIQUE INDEX IF NOT EXISTS ads_metrics_grain_idx ON ads_metrics_daily
  (ads_account_id, date, campaign_id,
   COALESCE(ad_group_id, -1), COALESCE(criterion_id, -1));
CREATE INDEX IF NOT EXISTS ads_metrics_date_idx ON ads_metrics_daily (date, ads_account_id);

-- click_view: de brug tussen een gclid en zijn campagne.
-- LET OP: Google levert dit maar over de laatste 90 dagen, en maar één dag per
-- query. Draait deze sync een dag niet, dan is die dag voorgoed weg.
CREATE TABLE IF NOT EXISTS ads_click (
    click_id         text PRIMARY KEY,        -- de gclid
    ads_account_id   uuid NOT NULL REFERENCES ads_account(id) ON DELETE CASCADE,
    click_date       date NOT NULL,
    campaign_id      bigint,
    ad_group_id      bigint,
    criterion_id     bigint,
    keyword_text     text,
    match_type       text,
    device           text,
    ad_network       text,
    landing_page     text,
    area_of_interest text,
    synced_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ads_click_date_idx ON ads_click (click_date);

-- ---------- GA4: uitsluitend aggregaten, expliciet niet de leadbron ------

CREATE TABLE IF NOT EXISTS ga4_traffic_daily (
    id                     bigserial PRIMARY KEY,
    website_id             uuid NOT NULL REFERENCES website(id) ON DELETE CASCADE,
    date                   date NOT NULL,
    source                 text NOT NULL DEFAULT '(none)',
    medium                 text NOT NULL DEFAULT '(none)',
    campaign               text NOT NULL DEFAULT '(none)',
    landing_page           text NOT NULL DEFAULT '(none)',
    device                 text NOT NULL DEFAULT '(none)',
    sessions               bigint NOT NULL DEFAULT 0,
    engaged_sessions       bigint NOT NULL DEFAULT 0,
    total_users            bigint NOT NULL DEFAULT 0,
    new_users              bigint NOT NULL DEFAULT 0,
    key_events             numeric(12,2) NOT NULL DEFAULT 0,
    avg_engagement_seconds numeric(10,2),
    -- GA4 gooit rijen op één hoop bij te hoge cardinaliteit. Dat verzwijgen
    -- zou de cijfers onbetrouwbaar maken zonder dat je het merkt.
    is_other_row           boolean NOT NULL DEFAULT false,
    synced_at              timestamptz NOT NULL DEFAULT now(),
    UNIQUE (website_id, date, source, medium, campaign, landing_page, device)
);
CREATE INDEX IF NOT EXISTS ga4_traffic_date_idx ON ga4_traffic_daily (date, website_id);

CREATE TABLE IF NOT EXISTS ga4_event_daily (
    id          bigserial PRIMARY KEY,
    website_id  uuid NOT NULL REFERENCES website(id) ON DELETE CASCADE,
    date        date NOT NULL,
    event_name  text NOT NULL,
    source      text NOT NULL DEFAULT '(none)',
    medium      text NOT NULL DEFAULT '(none)',
    campaign    text NOT NULL DEFAULT '(none)',
    event_count bigint NOT NULL DEFAULT 0,
    event_value numeric(14,2) NOT NULL DEFAULT 0,
    synced_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (website_id, date, event_name, source, medium, campaign)
);


-- #########################################################################
-- 004_sales.sql
-- #########################################################################

-- Alle objecten in het schema 'mi', zodat dit project met de CMS kan
-- samenleven zonder naamconflicten. Zie 001_core.sql voor de uitleg.
SET search_path = mi, public;

-- =========================================================================
-- 004 — Offertes, deals, winstgevendheid, terugkoppeling naar Google Ads
-- =========================================================================

CREATE TABLE IF NOT EXISTS offer (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id       uuid NOT NULL REFERENCES client(id) ON DELETE CASCADE,
    lead_id         uuid REFERENCES lead(id) ON DELETE SET NULL,
    external_id     text,
    external_source text CHECK (external_source IN ('teamleader','csv','manual')),
    reference       text,                      -- offertenummer van de klant
    amount_excl_vat numeric(14,2) NOT NULL,
    currency        text NOT NULL DEFAULT 'EUR',
    cost_estimate   numeric(14,2),
    margin_pct      numeric(5,2),
    status          text NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','sent','accepted','refused','expired')),
    created_at      timestamptz NOT NULL DEFAULT now(),
    sent_at         timestamptz,
    signed_at       timestamptz,
    valid_until     date,
    metadata        jsonb NOT NULL DEFAULT '{}',
    UNIQUE (external_source, external_id)
);
CREATE INDEX IF NOT EXISTS offer_client_idx ON offer (client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS offer_lead_idx   ON offer (lead_id);

CREATE TABLE IF NOT EXISTS offer_line (
    id          bigserial PRIMARY KEY,
    offer_id    uuid NOT NULL REFERENCES offer(id) ON DELETE CASCADE,
    description text NOT NULL,
    quantity    numeric(12,2) NOT NULL DEFAULT 1,
    unit_price  numeric(14,2),
    line_total  numeric(14,2) NOT NULL,
    cost_total  numeric(14,2),
    category    text
);

CREATE TABLE IF NOT EXISTS deal (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id       uuid NOT NULL REFERENCES client(id) ON DELETE CASCADE,
    lead_id         uuid REFERENCES lead(id)  ON DELETE SET NULL,
    offer_id        uuid REFERENCES offer(id) ON DELETE SET NULL,
    external_id     text,
    external_source text,
    status          text NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open','won','lost')),
    won_at          timestamptz,
    lost_at         timestamptz,
    lost_reason     text,

    -- Wat je in de praktijk krijgt: de orderwaarde van de klus.
    revenue      numeric(14,2) NOT NULL DEFAULT 0,   -- excl. btw
    -- Kostprijs áls je die hebt. Meestal niet.
    cost_of_sale numeric(14,2),
    -- Marge in procenten: per deal ingevuld, of overgenomen uit
    -- client.default_margin_pct. Zo levert een kale orderwaarde toch een
    -- winstcijfer op, zonder te doen alsof het een hard getal is.
    margin_pct   numeric(5,2),
    -- Bewust NULL als we niets weten: dan is de deal vindbaar in de wachtrij
    -- "gewonnen deals zonder marge" in plaats van stilletjes als 0 te tellen.
    gross_margin numeric(14,2) GENERATED ALWAYS AS (
                   CASE WHEN cost_of_sale IS NOT NULL THEN revenue - cost_of_sale
                        WHEN margin_pct   IS NOT NULL THEN revenue * margin_pct / 100
                        ELSE NULL END) STORED,
    currency     text NOT NULL DEFAULT 'EUR',
    -- actual       = kostprijs bekend
    -- client_input = percentage of bedrag door de eigenaar teruggekoppeld
    -- estimate     = client.default_margin_pct toegepast
    margin_source text CHECK (margin_source IN ('actual','estimate','client_input')),

    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (external_source, external_id)
);
CREATE INDEX IF NOT EXISTS deal_client_idx ON deal (client_id, won_at DESC);
CREATE INDEX IF NOT EXISTS deal_lead_idx   ON deal (lead_id);

-- ---------- attributie en kostenallocatie -------------------------------

CREATE TABLE IF NOT EXISTS lead_attribution (
    id             bigserial PRIMARY KEY,
    lead_id        uuid NOT NULL REFERENCES lead(id) ON DELETE CASCADE,
    model          text NOT NULL DEFAULT 'last_click'
                   CHECK (model IN ('last_click','first_click','linear')),
    ads_account_id uuid REFERENCES ads_account(id) ON DELETE SET NULL,
    campaign_id    bigint,
    ad_group_id    bigint,
    criterion_id   bigint,
    credit         numeric(5,4) NOT NULL DEFAULT 1.0,
    resolved_via   text NOT NULL CHECK (resolved_via IN
                   ('click_id','utm','ga4','landing_page','manual')),
    confidence     numeric(3,2) NOT NULL,
    resolved_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS lead_attr_idx ON lead_attribution
  (lead_id, model, COALESCE(campaign_id, -1), COALESCE(criterion_id, -1));

CREATE TABLE IF NOT EXISTS ad_cost_allocation (
    id             bigserial PRIMARY KEY,
    client_id      uuid NOT NULL REFERENCES client(id) ON DELETE CASCADE,
    lead_id        uuid NOT NULL REFERENCES lead(id)   ON DELETE CASCADE,
    period_start   date NOT NULL,
    period_end     date NOT NULL,
    campaign_id    bigint,
    method         text NOT NULL CHECK (method IN
                   ('per_lead_equal','per_click_cost','manual')),
    allocated_cost numeric(14,2) NOT NULL,
    computed_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (lead_id, period_start, period_end, method)
);

-- ---------- terugkoppeling naar Google Ads ------------------------------

CREATE TABLE IF NOT EXISTS conversion_upload (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id            uuid NOT NULL REFERENCES client(id) ON DELETE CASCADE,
    lead_id              uuid REFERENCES lead(id) ON DELETE SET NULL,
    deal_id              uuid REFERENCES deal(id) ON DELETE SET NULL,
    ads_account_id       uuid NOT NULL REFERENCES ads_account(id) ON DELETE CASCADE,
    conversion_action_rn text NOT NULL,   -- resource name van de UPLOAD_CLICKS-actie
    method               text NOT NULL CHECK (method IN ('click_id','enhanced_lead')),
    click_id             text,
    click_type           text,
    email_sha256         text,
    phone_sha256         text,
    -- Onze lead-ref. Google ontdubbelt hierop, en het maakt terugtrekken van
    -- een conversie mogelijk als een deal alsnog afketst.
    order_id             text NOT NULL,
    -- Formaat 'yyyy-MM-dd HH:mm:ss+HH:mm', in de tijdzone van het ADS-ACCOUNT,
    -- niet die van de server. Meest voorkomende oorzaak van afgewezen uploads.
    conversion_datetime  text NOT NULL,
    value                numeric(14,2),
    currency             text NOT NULL DEFAULT 'EUR',
    consent_ad_user_data       text,
    consent_ad_personalization text,
    status               text NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','uploaded','failed','skipped')),
    skip_reason          text,
    attempts             int NOT NULL DEFAULT 0,
    last_error           text,
    google_response      jsonb,
    created_at           timestamptz NOT NULL DEFAULT now(),
    uploaded_at          timestamptz,
    UNIQUE (order_id, conversion_action_rn)
);
CREATE INDEX IF NOT EXISTS conv_upload_status_idx ON conversion_upload (status, created_at);


-- #########################################################################
-- 005_sync.sql
-- #########################################################################

-- Alle objecten in het schema 'mi', zodat dit project met de CMS kan
-- samenleven zonder naamconflicten. Zie 001_core.sql voor de uitleg.
SET search_path = mi, public;

-- =========================================================================
-- 005 — Sync-boekhouding en afgeleide cijfers
-- =========================================================================

CREATE TABLE IF NOT EXISTS sync_run (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    connector    text NOT NULL,   -- google_ads.metrics, ga4.traffic, mail.formspree
    scope        text NOT NULL,   -- customer_id / property_id / client slug
    mode         text NOT NULL CHECK (mode IN ('incremental','backfill','manual')),
    window_start date,
    window_end   date,
    status       text NOT NULL DEFAULT 'running'
                 CHECK (status IN ('running','ok','partial','failed')),
    rows_read    int NOT NULL DEFAULT 0,
    rows_written int NOT NULL DEFAULT 0,
    warnings     jsonb NOT NULL DEFAULT '[]',
    error        text,
    started_at   timestamptz NOT NULL DEFAULT now(),
    finished_at  timestamptz
);
CREATE INDEX IF NOT EXISTS sync_run_idx ON sync_run (connector, scope, started_at DESC);

CREATE TABLE IF NOT EXISTS sync_cursor (
    connector          text NOT NULL,
    scope              text NOT NULL,
    last_complete_date date,
    last_ok_at         timestamptz,
    updated_at         timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (connector, scope)
);

CREATE OR REPLACE VIEW v_data_freshness AS
SELECT connector,
       scope,
       last_complete_date,
       last_ok_at,
       now() - last_ok_at AS age
FROM sync_cursor;

-- -------------------------------------------------------------------------
-- Economie per lead. gross_margin is bewust NULL als de marge onbekend is,
-- dus profit_after_ads is dat dan ook — geen verzonnen nul.
-- -------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_lead_economics AS
SELECT l.id            AS lead_id,
       l.client_id,
       l.public_ref,
       l.created_at::date AS lead_date,
       l.campaign,
       l.status,
       o.amount_excl_vat  AS offer_value,
       d.revenue,
       d.gross_margin,
       d.margin_source,
       COALESCE(a.allocated_cost, 0)                    AS ad_cost,
       d.gross_margin - COALESCE(a.allocated_cost, 0)   AS profit_after_ads,
       CASE WHEN COALESCE(a.allocated_cost, 0) > 0
            THEN d.revenue / a.allocated_cost END       AS roas
FROM lead l
LEFT JOIN offer o ON o.lead_id = l.id AND o.status IN ('sent','accepted')
LEFT JOIN deal  d ON d.lead_id = l.id AND d.status = 'won'
LEFT JOIN ad_cost_allocation a
       ON a.lead_id = l.id AND a.method = 'per_lead_equal'
WHERE l.deleted_at IS NULL;

-- De twee wachtrijen die je winstcijfer stil vervuilen.
CREATE OR REPLACE VIEW v_gaps AS
SELECT 'deal_zonder_marge' AS gap, d.client_id, d.id AS entity_id,
       d.won_at AS at, d.revenue AS amount
  FROM deal d
 WHERE d.status = 'won' AND d.gross_margin IS NULL
UNION ALL
SELECT 'offerte_zonder_lead', o.client_id, o.id, o.created_at, o.amount_excl_vat
  FROM offer o
 WHERE o.lead_id IS NULL
UNION ALL
SELECT 'lead_zonder_attributie', l.client_id, l.id, l.created_at, NULL
  FROM lead l
 WHERE l.deleted_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM lead_attribution la WHERE la.lead_id = l.id);

-- Rechten ook voor de tabellen uit 002 t/m 005 (ALTER DEFAULT PRIVILEGES uit

-- 001 dekt alleen wat daarna is aangemaakt door dezelfde rol; dit is de

-- vangnet-regel zodat je nooit op een vergeten grant vastloopt).

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA mi TO authenticated;

GRANT USAGE ON ALL SEQUENCES IN SCHEMA mi TO authenticated;
