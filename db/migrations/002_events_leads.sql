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
