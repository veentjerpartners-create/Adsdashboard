-- =========================================================================
-- 015 — Het bericht van de aanvraag
--
-- Een lead was tot nu toe naam, e-mail, telefoon en een onderwerp. Maar wat
-- iemand wíl staat in het bericht, en dat ging niet mee. Dan moet je voor
-- elke aanvraag alsnog de Formspree-mail erbij pakken. Beide formulieren
-- hebben een veld 'bericht'; Rotterdamse Bouwbedrijf vraagt ook de plaats.
--
-- Alleen deze twee velden. Geen vrije dump van het hele formulier: wat we
-- opslaan moeten we ook kunnen verantwoorden.
-- =========================================================================

SET search_path = mi, public;

ALTER TABLE lead ADD COLUMN IF NOT EXISTS message text;
-- city bestond al (002), maar werd door de collector niet gevuld.

-- mi.collect() twee velden extra laten opslaan. Zelfde aanpak als 012: de
-- functietekst gericht aanpassen in plaats van 200 regels herhalen.
DO $$
DECLARE bron text;
BEGIN
  SELECT prosrc INTO bron FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'mi' AND p.proname = 'collect';

  IF bron LIKE '%v_lead->>''message''%' THEN
    RAISE NOTICE 'mi.collect() slaat het bericht al op';
    RETURN;
  END IF;

  IF bron NOT LIKE '%landing_page, referrer, device_type, subject,%'
     OR bron NOT LIKE '%NULLIF(p->>''dev'',''''), NULLIF(v_lead->>''subject'',''''),%' THEN
    RAISE EXCEPTION 'mi.collect() ziet er anders uit dan verwacht; draai eerst 013';
  END IF;

  bron := replace(bron,
    'landing_page, referrer, device_type, subject,',
    'landing_page, referrer, device_type, subject, city, message,');
  bron := replace(bron,
    'NULLIF(p->>''dev'',''''), NULLIF(v_lead->>''subject'',''''),',
    'NULLIF(p->>''dev'',''''), NULLIF(v_lead->>''subject'',''''), '
    'NULLIF(v_lead->>''city'',''''), NULLIF(left(v_lead->>''message'', 4000),''''),');

  EXECUTE 'CREATE OR REPLACE FUNCTION mi.collect(p jsonb) RETURNS jsonb '
          'LANGUAGE plpgsql AS ' || quote_literal(bron);
  RAISE NOTICE 'mi.collect() bijgewerkt';
END $$;

REVOKE ALL ON FUNCTION mi.collect(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION mi.collect(jsonb) TO service_role;

SELECT count(*) FILTER (WHERE message IS NOT NULL) AS met_bericht, count(*) AS leads FROM lead;
