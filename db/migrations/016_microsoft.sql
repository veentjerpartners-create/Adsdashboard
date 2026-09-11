-- =========================================================================
-- 016 — Microsoft Advertising (Bing) naast Google Ads
--
-- Bing draait als test naast Google. De klikken en leads kwamen al goed
-- binnen (013 herkent de msclkid als bing/cpc), maar de kostenkant niet:
-- ads_metrics_daily werd alleen door de Google Ads-connector gevuld, dus
-- kosten per aanvraag was voor Bing niet uit te rekenen.
--
-- Oplossing: dezelfde tabellen, één kolom erbij. Een Microsoft-account is
-- een rij in ads_account met platform = 'microsoft', en zijn campagnes en
-- dagcijfers staan gewoon in ads_campaign en ads_metrics_daily. Het
-- dashboard hoeft dan nergens twee bronnen op te tellen; de views uit 008
-- blijven kloppen.
--
-- Zolang Bing een test is worden de cijfers geïmporteerd uit de CSV die
-- Microsoft Advertising exporteert (python -m ingest.run microsoft). Een
-- API-connector komt pas als Bing blijft.
--
-- Gevolg voor de Google-connectors: die filteren nu op platform = 'google',
-- anders proberen ze een Microsoft-accountnummer bij Google op te vragen.
-- =========================================================================

SET search_path = mi, public;

ALTER TABLE ads_account
    ADD COLUMN IF NOT EXISTS platform text NOT NULL DEFAULT 'google'
        CHECK (platform IN ('google', 'microsoft'));

COMMENT ON COLUMN ads_account.platform IS
    'google = via de Google Ads API; microsoft = Microsoft Advertising, cijfers via CSV-import';

-- Microsoft-campagne-id's zijn ook getallen, maar overlappen mogelijk met
-- Google-id's. Dat is geen probleem: elke sleutel op campagne-niveau bevat
-- ads_account_id, dus de twee platformen kunnen elkaar niet raken.

SELECT customer_id, descriptive_name, platform, is_manager
FROM ads_account
ORDER BY platform, is_manager DESC, descriptive_name;
