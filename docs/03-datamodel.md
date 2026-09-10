# 03 — Datamodel

Postgres (Supabase). Ontwerpregels:

- **Multi-tenant vanaf rij één.** Elke tabel met klantdata heeft `client_id` en
  RLS. Tenancy achteraf inbouwen kost een herbouw, dus we doen het meteen.
- **Nieuwe event-types zonder migratie.** `event_type` is een registratietabel,
  geen `ENUM`. Een nieuw event toevoegen is één `INSERT`.
- **Idempotent.** Elke geïmporteerde rij heeft een natuurlijke sleutel met een
  unique index, zodat `ON CONFLICT DO UPDATE` een tweede sync onschadelijk maakt.
- **Nooit `DELETE` bij sync.** Alleen upsert en soft-delete.
- **Bedragen** in `numeric(14,2)`, valuta expliciet. Google Ads `cost_micros`
  slaan we ruw op én afgeleid in euro's.

---

## 001 — Toegang, klanten, registratie

```sql
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------- toegang ----------
CREATE TABLE app_user (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    auth_uid    uuid UNIQUE NOT NULL,          -- Supabase auth.users.id
    email       text NOT NULL,
    full_name   text,
    role        text NOT NULL CHECK (role IN ('owner','agency','client')),
    is_active   boolean NOT NULL DEFAULT true,
    last_seen_at timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE client (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name        text NOT NULL,
    slug        text UNIQUE NOT NULL,
    status      text NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','paused','ended')),
    currency    text NOT NULL DEFAULT 'EUR',
    timezone    text NOT NULL DEFAULT 'Europe/Amsterdam',
    -- vaste fee die jij rekent; nooit in het klantportaal
    monthly_fee numeric(14,2),
    -- Standaard brutomarge van deze klant, in procenten. Nodig omdat je in de
    -- praktijk vaak alleen de orderwaarde van de klus terugkrijgt en niet de
    -- kostprijs. Hiermee leidt het systeem de marge af, gemarkeerd als schatting.
    default_margin_pct numeric(5,2),
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE user_client_access (
    user_id      uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    client_id    uuid NOT NULL REFERENCES client(id)   ON DELETE CASCADE,
    access_level text NOT NULL DEFAULT 'viewer'
                 CHECK (access_level IN ('viewer','editor')),
    invited_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, client_id)
);

-- Wat mag deze klant in zijn portaal zien?
CREATE TABLE client_portal_settings (
    client_id        uuid PRIMARY KEY REFERENCES client(id) ON DELETE CASCADE,
    portal_enabled   boolean NOT NULL DEFAULT false,
    show_spend       boolean NOT NULL DEFAULT true,
    show_revenue     boolean NOT NULL DEFAULT true,
    show_margin      boolean NOT NULL DEFAULT true,
    show_profit      boolean NOT NULL DEFAULT true,
    show_keywords    boolean NOT NULL DEFAULT true,
    show_search_terms boolean NOT NULL DEFAULT false,
    show_lead_contact boolean NOT NULL DEFAULT true,
    logo_url         text,
    accent_color     text
);

CREATE TABLE report_share (
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

CREATE TABLE audit_log (
    id        bigserial PRIMARY KEY,
    user_id   uuid REFERENCES app_user(id),
    client_id uuid REFERENCES client(id),
    action    text NOT NULL,        -- view_lead, export_leads, update_status, ...
    entity    text,
    entity_id text,
    ip        inet,
    at        timestamptz NOT NULL DEFAULT now()
);

-- ---------- registratie: wat hoort bij welke klant ----------
CREATE TABLE website (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id          uuid NOT NULL REFERENCES client(id) ON DELETE CASCADE,
    domain             text UNIQUE NOT NULL,          -- boersbreuer.nl
    label              text,
    ga4_property_id    text,                          -- 123456789 (Data API)
    ga4_measurement_id text,                          -- G-XNK3821MV5
    ads_conversion_id  text,                          -- AW-18441189967
    formspree_endpoint text,                          -- xeevldqj
    collector_key      text UNIQUE NOT NULL,          -- publieke sleutel in mi-collect.js
    collector_live_since timestamptz,
    timezone           text NOT NULL DEFAULT 'Europe/Amsterdam',
    is_active          boolean NOT NULL DEFAULT true,
    created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ads_account (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id       uuid REFERENCES client(id) ON DELETE SET NULL,
    customer_id     text UNIQUE NOT NULL,   -- 5442825521, zonder streepjes
    descriptive_name text,
    currency_code   text,
    time_zone       text,
    is_manager      boolean NOT NULL DEFAULT false,
    manager_customer_id text,               -- MCC 9287874539
    status          text,
    last_synced_at  timestamptz
);

CREATE TABLE crm_connection (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id   uuid NOT NULL REFERENCES client(id) ON DELETE CASCADE,
    kind        text NOT NULL CHECK (kind IN ('teamleader','csv','sheet','manual')),
    is_active   boolean NOT NULL DEFAULT true,
    config      jsonb NOT NULL DEFAULT '{}',   -- geen secrets: alleen verwijzingen
    last_synced_at timestamptz
);
```

---

## 002 — Events, bezoekers, leads

```sql
-- ---------- event-registratie: nieuw type = 1 INSERT ----------
CREATE TABLE event_type (
    code          text PRIMARY KEY,   -- page_view, whatsapp_click, ...
    label         text NOT NULL,
    category      text NOT NULL CHECK (category IN
                  ('pageview','engagement','contact','lead','sales','system')),
    is_conversion boolean NOT NULL DEFAULT false,
    is_identifying boolean NOT NULL DEFAULT false, -- levert dit PII op?
    sort_order    int NOT NULL DEFAULT 100,
    icon          text
);

INSERT INTO event_type (code,label,category,is_conversion,is_identifying,sort_order) VALUES
 ('session_start','Sessie gestart','system',false,false,10),
 ('ads_click','Google Ads klik','engagement',false,false,15),
 ('page_view','Paginaweergave','pageview',false,false,20),
 ('scroll_depth','Scrolldiepte','engagement',false,false,25),
 ('cta_click','CTA-klik','engagement',false,false,30),
 ('faq_expand','FAQ geopend','engagement',false,false,32),
 ('calculator_start','Calculator gestart','engagement',false,false,34),
 ('calculator_result','Calculator resultaat','engagement',false,false,35),
 ('contact_click','Contact-klik','contact',false,false,40),
 ('phone_click','Telefoonklik','contact',true,false,42),
 ('whatsapp_click','WhatsApp-klik','contact',true,false,44),
 ('email_click','E-mailklik','contact',true,false,46),
 ('form_start','Formulier gestart','lead',false,false,50),
 ('form_submit','Formulier verstuurd','lead',true,true,52),
 ('quote_request','Offerteaanvraag','lead',true,true,54),
 ('inbound_call','Inkomend gesprek','lead',true,true,56),
 ('offer_created','Offerte opgesteld','sales',false,false,60),
 ('offer_sent','Offerte verstuurd','sales',false,false,62),
 ('offer_signed','Offerte getekend','sales',true,false,64),
 ('deal_won','Deal gewonnen','sales',true,false,66),
 ('deal_lost','Deal verloren','sales',false,false,68);

-- ---------- pseudonieme bezoeker ----------
CREATE TABLE visitor (
    id             uuid PRIMARY KEY,           -- door de browser gegenereerd
    website_id     uuid NOT NULL REFERENCES website(id) ON DELETE CASCADE,
    client_id      uuid NOT NULL REFERENCES client(id)  ON DELETE CASCADE,
    ga_client_id   text,                        -- uit het _ga-cookie
    first_seen_at  timestamptz NOT NULL DEFAULT now(),
    last_seen_at   timestamptz NOT NULL DEFAULT now(),
    first_landing_page text,
    first_referrer text,
    first_source   text,
    first_medium   text,
    first_campaign text,
    first_click_id text,
    first_click_type text,
    consent_state  text,                        -- accepted | denied | unknown
    UNIQUE (website_id, id)
);
CREATE INDEX ON visitor (client_id, last_seen_at DESC);
CREATE INDEX ON visitor (ga_client_id) WHERE ga_client_id IS NOT NULL;

CREATE TABLE visit_session (
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
    click_type    text,      -- gclid | wbraid | gbraid | msclkid | fbclid
    device_type   text,      -- mobile | desktop | tablet
    country       text,
    event_count   int NOT NULL DEFAULT 0
);
CREATE INDEX ON visit_session (visitor_id, started_at);
CREATE INDEX ON visit_session (client_id, started_at DESC);

-- ---------- de lead ----------
CREATE SEQUENCE lead_public_ref_seq START 1000;

CREATE TABLE lead (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    public_ref    bigint NOT NULL UNIQUE DEFAULT nextval('lead_public_ref_seq'),
    client_id     uuid NOT NULL REFERENCES client(id)  ON DELETE CASCADE,
    website_id    uuid REFERENCES website(id)          ON DELETE SET NULL,

    -- contactgegevens (PII — blijft hier, gaat nooit naar GA4)
    name          text,
    email         text,
    email_norm    text,          -- lowercase, getrimd
    email_sha256  text,          -- voor matching en enhanced conversions
    phone         text,
    phone_e164    text,          -- +31612345678
    phone_sha256  text,
    company       text,
    city          text,

    -- marketingherkomst, vastgelegd op het moment van de lead
    lead_type     text NOT NULL DEFAULT 'form'
                  CHECK (lead_type IN ('form','phone','whatsapp','email','manual','import')),
    source        text,
    medium        text,
    campaign      text,
    ad_group      text,
    keyword       text,
    click_id      text,
    click_type    text,
    landing_page  text,
    referrer      text,
    device_type   text,
    subject       text,          -- gekozen dienst/onderwerp
    budget_band   text,

    -- pipeline
    status        text NOT NULL DEFAULT 'new'
                  CHECK (status IN ('new','contacted','qualified','offer_sent',
                                    'won','lost','disqualified')),
    status_changed_at timestamptz NOT NULL DEFAULT now(),
    lost_reason   text,
    owner_user_id uuid REFERENCES app_user(id),

    -- herkomst en kwaliteit van de koppeling
    first_visitor_id uuid REFERENCES visitor(id) ON DELETE SET NULL,
    first_seen_at    timestamptz,     -- eerste event van deze bezoeker
    created_at       timestamptz NOT NULL DEFAULT now(),
    ingest_source    text NOT NULL DEFAULT 'collector'
                     CHECK (ingest_source IN ('collector','mail','crm','manual','import')),
    external_id      text,
    dedupe_key       text,            -- lead_id uit de browser
    match_confidence numeric(3,2),     -- 0.00–1.00
    needs_review     boolean NOT NULL DEFAULT false,

    consent_marketing boolean,         -- mag deze lead naar Google Ads?
    internal_notes    text,            -- nooit in het portaal
    deleted_at        timestamptz
);
CREATE UNIQUE INDEX ON lead (client_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX ON lead (client_id, created_at DESC);
CREATE INDEX ON lead (client_id, status);
CREATE INDEX ON lead (email_sha256) WHERE email_sha256 IS NOT NULL;
CREATE INDEX ON lead (phone_sha256) WHERE phone_sha256 IS NOT NULL;
CREATE INDEX ON lead (click_id) WHERE click_id IS NOT NULL;

-- Elke sleutel waarmee we deze lead herkennen, met bewijslast.
CREATE TABLE lead_identity (
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
CREATE INDEX ON lead_identity (kind, value);

CREATE TABLE lead_status_history (
    id        bigserial PRIMARY KEY,
    lead_id   uuid NOT NULL REFERENCES lead(id) ON DELETE CASCADE,
    from_status text,
    to_status   text NOT NULL,
    changed_at  timestamptz NOT NULL DEFAULT now(),
    changed_by  uuid REFERENCES app_user(id),
    note        text
);

-- ---------- het event-model ----------
CREATE TABLE lead_event (
    id          bigserial PRIMARY KEY,
    client_id   uuid NOT NULL REFERENCES client(id)  ON DELETE CASCADE,
    website_id  uuid REFERENCES website(id)          ON DELETE SET NULL,
    lead_id     uuid REFERENCES lead(id)             ON DELETE SET NULL,
    visitor_id  uuid REFERENCES visitor(id)          ON DELETE SET NULL,
    session_id  uuid REFERENCES visit_session(id)    ON DELETE SET NULL,

    event_type  text NOT NULL REFERENCES event_type(code),
    occurred_at timestamptz NOT NULL,
    received_at timestamptz NOT NULL DEFAULT now(),

    page_url    text,
    page_path   text,
    page_title  text,
    page_type   text,          -- dienst | locatie | blog | contact
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
CREATE UNIQUE INDEX ON lead_event (dedupe_key);
CREATE INDEX ON lead_event (lead_id, occurred_at);
CREATE INDEX ON lead_event (visitor_id, occurred_at) WHERE lead_id IS NULL;
CREATE INDEX ON lead_event (client_id, occurred_at DESC);
CREATE INDEX ON lead_event (client_id, event_type, occurred_at DESC);
```

**De WhatsApp-klik uit jouw briefing zit hier precies in:** die rij krijgt
`lead_id = NULL` en `visitor_id = <vid>`. Zodra dezelfde `visitor_id` later een
formulier instuurt, wordt `lead_id` er achteraf op gezet (zie
`04-attributie-matching.md` §3). De index
`(visitor_id, occurred_at) WHERE lead_id IS NULL` bestaat precies voor die
update.

**Partitionering:** `lead_event` groeit het snelst. Bij >20M rijen
overzetten naar `PARTITION BY RANGE (occurred_at)` per maand. Nu nog niet nodig,
maar de kolomvolgorde en indexen zijn er al op voorbereid.

---

## 003 — Google Ads en GA4

```sql
CREATE TABLE ads_campaign (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    ads_account_id uuid NOT NULL REFERENCES ads_account(id) ON DELETE CASCADE,
    campaign_id   bigint NOT NULL,
    name          text,
    status        text,
    channel_type  text,      -- SEARCH | PMAX | DISPLAY | ...
    bidding_strategy text,
    budget_micros bigint,
    start_date    date,
    end_date      date,
    updated_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (ads_account_id, campaign_id)
);

CREATE TABLE ads_ad_group (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    ads_account_id uuid NOT NULL REFERENCES ads_account(id) ON DELETE CASCADE,
    campaign_id  bigint NOT NULL,
    ad_group_id  bigint NOT NULL,
    name         text,
    status       text,
    UNIQUE (ads_account_id, ad_group_id)
);

CREATE TABLE ads_keyword (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    ads_account_id uuid NOT NULL REFERENCES ads_account(id) ON DELETE CASCADE,
    ad_group_id   bigint NOT NULL,
    criterion_id  bigint NOT NULL,
    text          text,
    match_type    text,
    status        text,
    final_urls    text[],
    UNIQUE (ads_account_id, ad_group_id, criterion_id)
);

-- Eén feitentabel, één grein. keyword_id NULL = campagne/adgroep-niveau.
CREATE TABLE ads_metrics_daily (
    id             bigserial PRIMARY KEY,
    ads_account_id uuid NOT NULL REFERENCES ads_account(id) ON DELETE CASCADE,
    date           date NOT NULL,
    campaign_id    bigint NOT NULL,
    ad_group_id    bigint,
    criterion_id   bigint,
    impressions    bigint NOT NULL DEFAULT 0,
    clicks         bigint NOT NULL DEFAULT 0,
    cost_micros    bigint NOT NULL DEFAULT 0,
    cost           numeric(14,2) GENERATED ALWAYS AS (cost_micros / 1000000.0) STORED,
    conversions    numeric(12,2) NOT NULL DEFAULT 0,
    conversions_value numeric(14,2) NOT NULL DEFAULT 0,
    all_conversions numeric(12,2) NOT NULL DEFAULT 0,
    interactions   bigint NOT NULL DEFAULT 0,
    synced_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ON ads_metrics_daily
  (ads_account_id, date, campaign_id,
   COALESCE(ad_group_id,-1), COALESCE(criterion_id,-1));
CREATE INDEX ON ads_metrics_daily (date, ads_account_id);

-- click_view: de brug tussen een gclid en de campagne. Alleen 90 dagen
-- beschikbaar bij Google, dus dagelijks ophalen of voor altijd kwijt.
CREATE TABLE ads_click (
    click_id       text PRIMARY KEY,        -- de gclid
    ads_account_id uuid NOT NULL REFERENCES ads_account(id) ON DELETE CASCADE,
    click_date     date NOT NULL,
    campaign_id    bigint,
    ad_group_id    bigint,
    criterion_id   bigint,
    keyword_text   text,
    match_type     text,
    device         text,
    ad_network     text,
    landing_page   text,
    area_of_interest text,
    synced_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON ads_click (click_date);

-- GA4: uitsluitend aggregaten, expliciet niet de leadbron.
CREATE TABLE ga4_traffic_daily (
    id          bigserial PRIMARY KEY,
    website_id  uuid NOT NULL REFERENCES website(id) ON DELETE CASCADE,
    date        date NOT NULL,
    source      text NOT NULL DEFAULT '(none)',
    medium      text NOT NULL DEFAULT '(none)',
    campaign    text NOT NULL DEFAULT '(none)',
    landing_page text NOT NULL DEFAULT '(none)',
    device      text NOT NULL DEFAULT '(none)',
    sessions        bigint NOT NULL DEFAULT 0,
    engaged_sessions bigint NOT NULL DEFAULT 0,
    total_users     bigint NOT NULL DEFAULT 0,
    new_users       bigint NOT NULL DEFAULT 0,
    key_events      numeric(12,2) NOT NULL DEFAULT 0,
    avg_engagement_seconds numeric(10,2),
    is_other_row    boolean NOT NULL DEFAULT false,  -- GA4 (other)-bucket
    synced_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ON ga4_traffic_daily
  (website_id, date, source, medium, campaign, landing_page, device);

CREATE TABLE ga4_event_daily (
    id          bigserial PRIMARY KEY,
    website_id  uuid NOT NULL REFERENCES website(id) ON DELETE CASCADE,
    date        date NOT NULL,
    event_name  text NOT NULL,
    source      text NOT NULL DEFAULT '(none)',
    medium      text NOT NULL DEFAULT '(none)',
    campaign    text NOT NULL DEFAULT '(none)',
    event_count bigint NOT NULL DEFAULT 0,
    event_value numeric(14,2) NOT NULL DEFAULT 0,
    synced_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ON ga4_event_daily
  (website_id, date, event_name, source, medium, campaign);
```

---

## 004 — Offertes, deals, winstgevendheid

```sql
CREATE TABLE offer (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id     uuid NOT NULL REFERENCES client(id) ON DELETE CASCADE,
    lead_id       uuid REFERENCES lead(id) ON DELETE SET NULL,
    external_id   text,
    external_source text CHECK (external_source IN ('teamleader','csv','manual')),
    reference     text,                       -- offertenummer van de klant
    amount_excl_vat numeric(14,2) NOT NULL,
    currency      text NOT NULL DEFAULT 'EUR',
    cost_estimate numeric(14,2),              -- verwachte kosten
    margin_pct    numeric(5,2),               -- als er geen kostenregel is
    status        text NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','sent','accepted','refused','expired')),
    created_at    timestamptz NOT NULL DEFAULT now(),
    sent_at       timestamptz,
    signed_at     timestamptz,
    valid_until   date,
    metadata      jsonb NOT NULL DEFAULT '{}',
    UNIQUE (external_source, external_id)
);
CREATE INDEX ON offer (client_id, created_at DESC);
CREATE INDEX ON offer (lead_id);

CREATE TABLE offer_line (
    id          bigserial PRIMARY KEY,
    offer_id    uuid NOT NULL REFERENCES offer(id) ON DELETE CASCADE,
    description text NOT NULL,
    quantity    numeric(12,2) NOT NULL DEFAULT 1,
    unit_price  numeric(14,2),
    line_total  numeric(14,2) NOT NULL,
    cost_total  numeric(14,2),
    category    text
);

CREATE TABLE deal (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id     uuid NOT NULL REFERENCES client(id) ON DELETE CASCADE,
    lead_id       uuid REFERENCES lead(id)  ON DELETE SET NULL,
    offer_id      uuid REFERENCES offer(id) ON DELETE SET NULL,
    external_id   text,
    external_source text,
    status        text NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open','won','lost')),
    won_at        timestamptz,
    lost_at       timestamptz,
    lost_reason   text,
    -- Wat je in de praktijk krijgt: de orderwaarde van de klus.
    revenue       numeric(14,2) NOT NULL DEFAULT 0,   -- excl. btw
    -- Kostprijs áls je die hebt. Meestal niet.
    cost_of_sale  numeric(14,2),                      -- inkoop + arbeid
    -- Marge in procenten: per deal ingevuld, of overgenomen uit
    -- client.default_margin_pct. Zo kun je met alleen een orderwaarde toch
    -- een winstcijfer laten zien, zonder te doen alsof het een hard getal is.
    margin_pct    numeric(5,2),
    gross_margin  numeric(14,2) GENERATED ALWAYS AS (
                    CASE WHEN cost_of_sale IS NOT NULL THEN revenue - cost_of_sale
                         WHEN margin_pct   IS NOT NULL THEN revenue * margin_pct / 100
                         ELSE NULL END) STORED,
    currency      text NOT NULL DEFAULT 'EUR',
    -- actual      = kostprijs bekend
    -- client_input= percentage of bedrag door de eigenaar teruggekoppeld
    -- estimate    = client.default_margin_pct toegepast
    margin_source text CHECK (margin_source IN ('actual','estimate','client_input')),
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (external_source, external_id)
);
CREATE INDEX ON deal (client_id, won_at DESC);
CREATE INDEX ON deal (lead_id);

-- Welke advertentie krijgt de eer? Meerdere modellen naast elkaar.
CREATE TABLE lead_attribution (
    id            bigserial PRIMARY KEY,
    lead_id       uuid NOT NULL REFERENCES lead(id) ON DELETE CASCADE,
    model         text NOT NULL DEFAULT 'last_click'
                  CHECK (model IN ('last_click','first_click','linear')),
    ads_account_id uuid REFERENCES ads_account(id) ON DELETE SET NULL,
    campaign_id   bigint,
    ad_group_id   bigint,
    criterion_id  bigint,
    credit        numeric(5,4) NOT NULL DEFAULT 1.0,
    resolved_via  text NOT NULL CHECK (resolved_via IN
                  ('click_id','utm','ga4','landing_page','manual')),
    confidence    numeric(3,2) NOT NULL,
    resolved_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (lead_id, model, campaign_id, COALESCE(criterion_id,-1))
);

-- Hoe verdelen we de spend van een campagne over de leads die eruit kwamen?
CREATE TABLE ad_cost_allocation (
    id          bigserial PRIMARY KEY,
    client_id   uuid NOT NULL REFERENCES client(id) ON DELETE CASCADE,
    lead_id     uuid NOT NULL REFERENCES lead(id) ON DELETE CASCADE,
    period_start date NOT NULL,
    period_end   date NOT NULL,
    campaign_id  bigint,
    method      text NOT NULL CHECK (method IN
                ('per_lead_equal','per_click_cost','manual')),
    allocated_cost numeric(14,2) NOT NULL,
    computed_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (lead_id, period_start, period_end, method)
);

-- Terugkoppeling naar Google Ads, idempotent en herhaalbaar.
CREATE TABLE conversion_upload (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id     uuid NOT NULL REFERENCES client(id) ON DELETE CASCADE,
    lead_id       uuid REFERENCES lead(id) ON DELETE SET NULL,
    deal_id       uuid REFERENCES deal(id) ON DELETE SET NULL,
    ads_account_id uuid NOT NULL REFERENCES ads_account(id) ON DELETE CASCADE,
    conversion_action_rn text NOT NULL,   -- resource name van de UPLOAD_CLICKS-actie
    method        text NOT NULL CHECK (method IN ('click_id','enhanced_lead')),
    click_id      text,
    click_type    text,
    email_sha256  text,
    phone_sha256  text,
    order_id      text NOT NULL,          -- onze lead-ref; dedupe bij Google
    conversion_datetime text NOT NULL,    -- '2026-09-09 14:30:00+02:00'
    value         numeric(14,2),
    currency      text NOT NULL DEFAULT 'EUR',
    consent_ad_user_data text,
    consent_ad_personalization text,
    status        text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','uploaded','failed','skipped')),
    attempts      int NOT NULL DEFAULT 0,
    last_error    text,
    google_response jsonb,
    created_at    timestamptz NOT NULL DEFAULT now(),
    uploaded_at   timestamptz,
    UNIQUE (order_id, conversion_action_rn)
);
```

---

## 005 — Sync-boekhouding

```sql
CREATE TABLE sync_run (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    connector   text NOT NULL,    -- google_ads.metrics, ga4.traffic, crm.teamleader
    scope       text NOT NULL,    -- customer_id / property_id / client slug
    mode        text NOT NULL CHECK (mode IN ('incremental','backfill','manual')),
    window_start date,
    window_end   date,
    status      text NOT NULL DEFAULT 'running'
                CHECK (status IN ('running','ok','partial','failed')),
    rows_read   int NOT NULL DEFAULT 0,
    rows_written int NOT NULL DEFAULT 0,
    warnings    jsonb NOT NULL DEFAULT '[]',
    error       text,
    started_at  timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz
);
CREATE INDEX ON sync_run (connector, scope, started_at DESC);

CREATE TABLE sync_cursor (
    connector   text NOT NULL,
    scope       text NOT NULL,
    last_complete_date date,
    last_ok_at  timestamptz,
    updated_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (connector, scope)
);

CREATE VIEW v_data_freshness AS
SELECT connector, scope, last_complete_date, last_ok_at,
       now() - last_ok_at AS age
FROM sync_cursor;
```

---

## 006 — RLS en portaal-views

```sql
CREATE OR REPLACE FUNCTION mi_role() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT role FROM app_user WHERE auth_uid = auth.uid() AND is_active;
$$;

CREATE OR REPLACE FUNCTION mi_visible_clients() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT id FROM client WHERE mi_role() IN ('owner','agency')
  UNION
  SELECT uca.client_id FROM user_client_access uca
    JOIN app_user u ON u.id = uca.user_id
   WHERE u.auth_uid = auth.uid() AND u.is_active;
$$;
```

Voor elke tabel met `client_id` — `lead`, `lead_event`, `visitor`,
`visit_session`, `offer`, `deal`, `ad_cost_allocation`, `website`,
`ads_account`, `conversion_upload`:

```sql
ALTER TABLE lead ENABLE ROW LEVEL SECURITY;
CREATE POLICY lead_sel ON lead FOR SELECT
  USING (client_id IN (SELECT mi_visible_clients()) AND deleted_at IS NULL);
CREATE POLICY lead_upd ON lead FOR UPDATE
  USING (client_id IN (SELECT mi_visible_clients()))
  WITH CHECK (client_id IN (SELECT mi_visible_clients()));
```

Tabellen zonder `client_id` die een klant nooit mag zien —
`ads_metrics_daily`, `ads_click`, `sync_run`, `sync_cursor`, `audit_log`,
`app_user`, `client_portal_settings` — krijgen een policy die alleen
`owner`/`agency` toelaat, en worden voor het portaal ontsloten via de views
hieronder.

**Portaal-views: alleen toegestane kolommen, veldrechten in SQL.**

```sql
CREATE VIEW v_portal_lead
WITH (security_invoker = true) AS
SELECT l.id, l.public_ref, l.client_id, w.domain AS website,
       CASE WHEN s.show_lead_contact THEN l.name  END AS name,
       CASE WHEN s.show_lead_contact THEN l.email END AS email,
       CASE WHEN s.show_lead_contact THEN l.phone END AS phone,
       l.created_at, l.status, l.lead_type, l.subject,
       l.source, l.medium, l.campaign, l.landing_page,
       CASE WHEN s.show_keywords THEN l.keyword   END AS keyword,
       CASE WHEN s.show_keywords THEN l.ad_group  END AS ad_group
FROM lead l
JOIN client_portal_settings s ON s.client_id = l.client_id
LEFT JOIN website w ON w.id = l.website_id
WHERE l.deleted_at IS NULL AND s.portal_enabled;
```

Merk op wat er níet in staat: `internal_notes`, `match_confidence`,
`needs_review`, `click_id`, `email_sha256`, `dedupe_key`, `owner_user_id`.
`security_invoker = true` zorgt dat de RLS van de onderliggende `lead`-tabel
alsnog geldt — de view is een kolomfilter, niet een omweg om de rijfilter heen.

Analoog: `v_portal_campaign` (spend/clicks/leads/CPL, met `show_spend`),
`v_portal_kpi` (omzet/marge/winst achter `show_revenue` / `show_margin` /
`show_profit`), `v_portal_timeline` (event_type, tijdstip, pagina — zonder
`metadata`, zonder `visitor_id`).

---

## Berekende kern-KPI's

```sql
CREATE VIEW v_lead_economics AS
SELECT l.id AS lead_id, l.client_id, l.created_at::date AS lead_date,
       l.campaign, l.status,
       o.amount_excl_vat            AS offer_value,
       d.revenue                    AS revenue,
       d.gross_margin               AS gross_margin,
       COALESCE(a.allocated_cost,0) AS ad_cost,
       d.gross_margin - COALESCE(a.allocated_cost,0) AS profit_after_ads,
       CASE WHEN COALESCE(a.allocated_cost,0) > 0
            THEN d.revenue / a.allocated_cost END    AS roas
FROM lead l
LEFT JOIN offer o ON o.lead_id = l.id AND o.status IN ('sent','accepted')
LEFT JOIN deal  d ON d.lead_id = l.id AND d.status = 'won'
LEFT JOIN ad_cost_allocation a ON a.lead_id = l.id AND a.method = 'per_lead_equal';
```

Per klant/periode wordt dat opgeteld tot: **Spend, Leads, CPL, Qualified,
Offers, Offer value, Deals, Revenue, Gross margin, Ad cost, Profit after
advertising, ROAS, Margin/Spend.** Bij >100k leads gaan de dagaggregaten naar
materialized views met een nachtelijke refresh; tot die tijd is een gewone view
snel genoeg.
