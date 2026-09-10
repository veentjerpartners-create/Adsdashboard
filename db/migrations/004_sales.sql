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
