-- =========================================================================
-- SEED — de twee Microsoft Advertising-accounts (Bing), aan de klant gehangen
--
-- Nagekeken in Microsoft Advertising op 2026-09-11, klant-ID 255050696:
--   G1459T4P  "Stijn veentjer"          -> Boers & Breuer  (campagne BB | Search | NL | Renovatie & Aannemer)
--   G145HG9Z  "Rotterdamse Bouwbedrijf" -> Rotterdamse Bouwbedrijf (4 campagnes RBB | Search | NL | ...)
--
-- De accountnaam bij Microsoft zegt dus niets over de klant; daarom staat de
-- koppeling hier en niet in de connector. customer_id is het accountnummer
-- (G...), want dat staat ook in de CSV-exporten; het numerieke account-ID
-- (187305210 / 187305248) haalt de API-connector zelf op.
--
-- Idempotent: twee keer draaien kan geen schade doen.
-- =========================================================================

SET search_path = mi, public;

INSERT INTO ads_account (customer_id, descriptive_name, currency_code, time_zone,
                         is_manager, manager_customer_id, platform, client_id)
SELECT 'G1459T4P', 'Boers & Breuer (Bing)', 'EUR', 'Europe/Amsterdam',
       false, NULL, 'microsoft', c.id
FROM client c WHERE c.slug = 'boers-breuer'
ON CONFLICT (customer_id) DO UPDATE SET client_id = EXCLUDED.client_id,
                                        platform  = EXCLUDED.platform;

INSERT INTO ads_account (customer_id, descriptive_name, currency_code, time_zone,
                         is_manager, manager_customer_id, platform, client_id)
SELECT 'G145HG9Z', 'Rotterdamse Bouwbedrijf (Bing)', 'EUR', 'Europe/Amsterdam',
       false, NULL, 'microsoft', c.id
FROM client c WHERE c.slug = 'rotterdamse-bouwbedrijf'
ON CONFLICT (customer_id) DO UPDATE SET client_id = EXCLUDED.client_id,
                                        platform  = EXCLUDED.platform;

SELECT customer_id, descriptive_name, platform, client_id
FROM ads_account ORDER BY platform, descriptive_name;
