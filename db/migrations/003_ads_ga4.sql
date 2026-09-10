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
