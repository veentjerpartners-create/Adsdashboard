-- =========================================================================
-- 010 — Zoektermen
--
-- Het verschil tussen een zoekwoord en een zoekterm: het zoekwoord is wat jij
-- inkoopt, de zoekterm is wat de bezoeker daadwerkelijk intypte. Daar zit het
-- geld en de verspilling. click_view geeft ons het zoekwoord niet terug (leeg
-- in v24), dus dit is de enige weg naar "waar kwam die klik vandaan".
--
-- Google toont zoektermen alleen als ze genoeg keer voorkwamen; zeldzame
-- termen worden om privacyredenen weggelaten. De som van de zoektermen is
-- daarom altijd LAGER dan het campagnetotaal. Dat is geen fout in onze
-- verwerking en we moeten het in het dashboard laten zien, niet verbergen.
-- =========================================================================

SET search_path = mi, public;

CREATE TABLE IF NOT EXISTS ads_search_term_daily (
    id             bigserial PRIMARY KEY,
    ads_account_id uuid NOT NULL REFERENCES ads_account(id) ON DELETE CASCADE,
    date           date NOT NULL,
    campaign_id    bigint NOT NULL,
    ad_group_id    bigint NOT NULL,
    search_term    text   NOT NULL,
    -- Op welk ingekocht zoekwoord matchte deze term?
    keyword_text   text,
    match_type     text,
    -- ADDED = toegevoegd als zoekwoord, EXCLUDED = uitgesloten,
    -- NONE = nog niets mee gedaan. Die laatste is je werkvoorraad.
    term_status    text,
    impressions    bigint NOT NULL DEFAULT 0,
    clicks         bigint NOT NULL DEFAULT 0,
    cost_micros    bigint NOT NULL DEFAULT 0,
    cost           numeric(14,2) GENERATED ALWAYS AS (cost_micros / 1000000.0) STORED,
    conversions    numeric(12,2) NOT NULL DEFAULT 0,
    synced_at      timestamptz NOT NULL DEFAULT now()
);

-- md5 op de zoekterm: een zoekterm kan lang zijn en een btree-index heeft een
-- maximum, terwijl de combinatie wel uniek moet blijven voor de upsert.
ALTER TABLE ads_search_term_daily
  ADD COLUMN IF NOT EXISTS term_key text
  GENERATED ALWAYS AS (md5(search_term)) STORED;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ads_search_term_grain_key'
      AND conrelid = 'mi.ads_search_term_daily'::regclass
  ) THEN
    ALTER TABLE ads_search_term_daily
      ADD CONSTRAINT ads_search_term_grain_key
      UNIQUE (ads_account_id, date, campaign_id, ad_group_id, term_key);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS ads_search_term_datum_idx
  ON ads_search_term_daily (date, ads_account_id);
CREATE INDEX IF NOT EXISTS ads_search_term_campagne_idx
  ON ads_search_term_daily (campaign_id, date);

GRANT SELECT, INSERT, UPDATE, DELETE ON ads_search_term_daily TO service_role;
GRANT SELECT ON ads_search_term_daily TO authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA mi TO service_role, authenticated;

SELECT conname FROM pg_constraint WHERE conname = 'ads_search_term_grain_key';
