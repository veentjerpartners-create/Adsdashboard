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
