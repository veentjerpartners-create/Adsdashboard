-- =========================================================================
-- 008 — Grein van ads_metrics_daily bruikbaar maken voor upsert
--
-- WAAROM
-- In 003 stond de sleutel van ads_metrics_daily als expressie-index:
--   UNIQUE (ads_account_id, date, campaign_id,
--           COALESCE(ad_group_id,-1), COALESCE(criterion_id,-1))
-- Dat is correct Postgres, maar PostgREST kan er niets mee: een upsert via de
-- API wil kolomnamen, geen expressie. Zonder oplossing zou elke nachtelijke
-- run dezelfde rijen opnieuw invoegen in plaats van bijwerken -- en dan tel je
-- de spend elke nacht dubbel.
--
-- OPLOSSING
-- -1 in plaats van NULL voor "niet van toepassing op dit niveau", zodat een
-- gewone UNIQUE-constraint volstaat. NULL en NULL botsen in Postgres namelijk
-- niet met elkaar, -1 en -1 wel.
--
-- Zelfde ingreep op lead_attribution, om dezelfde reden.
--
-- Er staat nog geen data in deze tabellen, dus dit is een schone ingreep.
-- Idempotent.
-- =========================================================================

SET search_path = mi, public;

-- ---------- ads_metrics_daily -------------------------------------------

DROP INDEX IF EXISTS mi.ads_metrics_grain_idx;

UPDATE ads_metrics_daily SET ad_group_id  = -1 WHERE ad_group_id  IS NULL;
UPDATE ads_metrics_daily SET criterion_id = -1 WHERE criterion_id IS NULL;

ALTER TABLE ads_metrics_daily
  ALTER COLUMN ad_group_id  SET DEFAULT -1,
  ALTER COLUMN criterion_id SET DEFAULT -1;
ALTER TABLE ads_metrics_daily
  ALTER COLUMN ad_group_id  SET NOT NULL,
  ALTER COLUMN criterion_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ads_metrics_grain_key'
      AND conrelid = 'mi.ads_metrics_daily'::regclass
  ) THEN
    ALTER TABLE ads_metrics_daily
      ADD CONSTRAINT ads_metrics_grain_key
      UNIQUE (ads_account_id, date, campaign_id, ad_group_id, criterion_id);
  END IF;
END $$;

COMMENT ON COLUMN ads_metrics_daily.ad_group_id IS
  '-1 = niet van toepassing (campagneniveau)';
COMMENT ON COLUMN ads_metrics_daily.criterion_id IS
  '-1 = niet van toepassing (campagne- of adgroepniveau)';

-- ---------- lead_attribution --------------------------------------------

DROP INDEX IF EXISTS mi.lead_attr_idx;

UPDATE lead_attribution SET campaign_id  = -1 WHERE campaign_id  IS NULL;
UPDATE lead_attribution SET criterion_id = -1 WHERE criterion_id IS NULL;

ALTER TABLE lead_attribution
  ALTER COLUMN campaign_id  SET DEFAULT -1,
  ALTER COLUMN criterion_id SET DEFAULT -1;
ALTER TABLE lead_attribution
  ALTER COLUMN campaign_id  SET NOT NULL,
  ALTER COLUMN criterion_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'lead_attr_key'
      AND conrelid = 'mi.lead_attribution'::regclass
  ) THEN
    ALTER TABLE lead_attribution
      ADD CONSTRAINT lead_attr_key
      UNIQUE (lead_id, model, campaign_id, criterion_id);
  END IF;
END $$;

-- ---------- twee views tegen dubbeltellen -------------------------------
-- ads_metrics_daily bevat twee greinen naast elkaar: campagneniveau
-- (ad_group_id = -1 en criterion_id = -1) en zoekwoordniveau. Wie die zonder
-- filter bij elkaar optelt, telt de spend twee keer. Gebruik deze views in
-- plaats van de tabel, dan kan dat niet gebeuren.

CREATE OR REPLACE VIEW v_campaign_daily AS
SELECT ads_account_id, date, campaign_id,
       impressions, clicks, cost_micros, cost,
       conversions, conversions_value, all_conversions, interactions, synced_at
FROM ads_metrics_daily
WHERE ad_group_id = -1 AND criterion_id = -1;

CREATE OR REPLACE VIEW v_keyword_daily AS
SELECT ads_account_id, date, campaign_id, ad_group_id, criterion_id,
       impressions, clicks, cost_micros, cost,
       conversions, conversions_value, all_conversions, interactions, synced_at
FROM ads_metrics_daily
WHERE criterion_id <> -1;

GRANT SELECT ON v_campaign_daily, v_keyword_daily TO service_role, authenticated;

SELECT conname, pg_get_constraintdef(oid) AS definitie
FROM pg_constraint
WHERE conname IN ('ads_metrics_grain_key','lead_attr_key');
