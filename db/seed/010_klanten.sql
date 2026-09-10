-- =========================================================================
-- SEED — de twee klanten met een live Google Ads-account
--
-- Gevonden op 2026-09-09 onder MCC 9287874539 (Veentjer):
--   5442825521  Boers & Breuer Totaalbouw   EUR  Europe/Amsterdam
--   7779088776  Rotterdamse Bouwbedrijf     EUR  Europe/Amsterdam
--
-- Alle overige waarden zijn uit de repo's teruggelezen, niet verzonnen:
--   boersbreuer.nl          G-XNK3821MV5 (100x in site/, de map die vercel.json
--                           deployt) + AW-18441189967 + formspree xbdbzdeo
--   rotterdamsebouwbedrijf.nl  G-XT5KPYD28T (28x) + formspree xykrzrye
--
-- GA4 property-ID's doorgegeven 2026-09-09:
--   boersbreuer.nl             552875366
--   rotterdamsebouwbedrijf.nl  552678280
--
-- NOG LEEG, bewust:
--   default_margin_pct   -> wacht op stap A5 (per klant, van de eigenaar zelf)
--
-- Idempotent: twee keer draaien kan geen schade doen.
-- =========================================================================

SET search_path = mi, public;

-- ---------- klanten ------------------------------------------------------

INSERT INTO client (name, slug, status, currency, timezone)
VALUES
  ('Boers & Breuer Totaalbouw', 'boers-breuer',           'active', 'EUR', 'Europe/Amsterdam'),
  ('Rotterdamse Bouwbedrijf',   'rotterdamse-bouwbedrijf','active', 'EUR', 'Europe/Amsterdam')
ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name;

-- Portaal staat uit tot fase 4. De schakelaars staan al goed voor later.
INSERT INTO client_portal_settings (client_id, portal_enabled)
SELECT id, false FROM client WHERE slug IN ('boers-breuer','rotterdamse-bouwbedrijf')
ON CONFLICT (client_id) DO NOTHING;

-- ---------- websites -----------------------------------------------------
-- collector_key is de publieke sleutel die straks in mi-collect.js staat.
-- Publiek mag: hij identificeert de site, hij geeft geen toegang tot data.

INSERT INTO website (client_id, domain, label, ga4_measurement_id,
                     ga4_property_id, ads_conversion_id, formspree_endpoint,
                     collector_key)
SELECT c.id, 'boersbreuer.nl', 'Boers & Breuer',
       'G-XNK3821MV5', '552875366', 'AW-18441189967', 'xbdbzdeo',
       replace(gen_random_uuid()::text, '-', '')
FROM client c WHERE c.slug = 'boers-breuer'
ON CONFLICT (domain) DO UPDATE SET
  ga4_measurement_id = EXCLUDED.ga4_measurement_id,
  ga4_property_id    = EXCLUDED.ga4_property_id,
  ads_conversion_id  = EXCLUDED.ads_conversion_id,
  formspree_endpoint = EXCLUDED.formspree_endpoint;

INSERT INTO website (client_id, domain, label, ga4_measurement_id,
                     ga4_property_id, formspree_endpoint, collector_key)
SELECT c.id, 'rotterdamsebouwbedrijf.nl', 'Rotterdamse Bouwbedrijf',
       'G-XT5KPYD28T', '552678280', 'xykrzrye',
       replace(gen_random_uuid()::text, '-', '')
FROM client c WHERE c.slug = 'rotterdamse-bouwbedrijf'
ON CONFLICT (domain) DO UPDATE SET
  ga4_measurement_id = EXCLUDED.ga4_measurement_id,
  ga4_property_id    = EXCLUDED.ga4_property_id,
  formspree_endpoint = EXCLUDED.formspree_endpoint;

-- ---------- Google Ads-accounts -----------------------------------------
-- De sync vult naam, valuta, tijdzone en status bij; hier leggen we alleen
-- vast welk account bij welke klant hoort. Dat blijft een bewuste keuze.

INSERT INTO ads_account (customer_id, descriptive_name, currency_code, time_zone,
                         is_manager, manager_customer_id, client_id)
VALUES ('9287874539', 'Veentjer', 'EUR', 'Europe/Amsterdam', true, NULL, NULL)
ON CONFLICT (customer_id) DO UPDATE SET is_manager = true;

INSERT INTO ads_account (customer_id, descriptive_name, currency_code, time_zone,
                         is_manager, manager_customer_id, client_id)
SELECT '5442825521', 'Boers & Breuer Totaalbouw', 'EUR', 'Europe/Amsterdam',
       false, '9287874539', c.id
FROM client c WHERE c.slug = 'boers-breuer'
ON CONFLICT (customer_id) DO UPDATE SET client_id = EXCLUDED.client_id;

INSERT INTO ads_account (customer_id, descriptive_name, currency_code, time_zone,
                         is_manager, manager_customer_id, client_id)
SELECT '7779088776', 'Rotterdamse Bouwbedrijf', 'EUR', 'Europe/Amsterdam',
       false, '9287874539', c.id
FROM client c WHERE c.slug = 'rotterdamse-bouwbedrijf'
ON CONFLICT (customer_id) DO UPDATE SET client_id = EXCLUDED.client_id;

-- ---------- controle -----------------------------------------------------

SELECT c.name AS klant,
       w.domain,
       w.ga4_measurement_id,
       w.ga4_property_id,
       c.default_margin_pct   AS marge_nog_leeg,
       a.customer_id          AS ads_account,
       w.collector_key
FROM client c
LEFT JOIN website     w ON w.client_id = c.id
LEFT JOIN ads_account a ON a.client_id = c.id
ORDER BY c.name;
