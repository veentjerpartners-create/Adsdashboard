-- =========================================================================
-- 012 — Paginapad zonder querystring
--
-- De eerste echte bezoekers lieten dit zien:
--
--   page_path = /?utm_source=google&utm_medium=cpc&utm_campaign=aannemer-
--               renovatie&utm_term=bouwbedrijf%20rotterdam&gad_source=1&
--               gad_campaignid=24228769563&gbraid=0AAAABErguNj-2VuU...
--
-- Dat hoort gewoon "/" te zijn. Twee problemen met het oude gedrag:
--
--  1. De tijdlijn wordt onleesbaar. Je wilt zien dat iemand op de homepage
--     was, niet welke acht parameters Google eraan plakte.
--  2. Elke bezoeker krijgt een uniek pad, want de gbraid verschilt per klik.
--     Dan kun je nooit tellen hoe vaak een pagina bekeken is.
--
-- De volledige URL blijft in page_url staan, dus er gaat niets verloren -- de
-- utm-waarden zitten bovendien al in eigen kolommen.
-- =========================================================================

SET search_path = mi, public;

-- Bestaande rijen opschonen.
UPDATE lead_event
   SET page_path = NULLIF(regexp_replace(page_path, '[?#].*$', ''), '')
 WHERE page_path LIKE '%?%' OR page_path LIKE '%#%';

-- En voortaan meteen goed. Alleen deze ene regel verandert in mi.collect();
-- de rest van de functie blijft zoals hij in 011 stond.
CREATE OR REPLACE FUNCTION mi.pad(url text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT NULLIF(
    regexp_replace(
      regexp_replace(COALESCE(url, ''), '^https?://[^/]+', ''),
      '[?#].*$', ''),
    '');
$$;

GRANT EXECUTE ON FUNCTION mi.pad(text) TO service_role, authenticated;

-- mi.collect() laten wijzen naar de nieuwe helper.
DO $$
DECLARE bron text;
BEGIN
  SELECT prosrc INTO bron FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'mi' AND p.proname = 'collect';

  IF bron LIKE '%mi.pad(p->>''url'')%' THEN
    RAISE NOTICE 'mi.collect() gebruikt mi.pad() al';
  ELSE
    EXECUTE 'CREATE OR REPLACE FUNCTION mi.collect(p jsonb) RETURNS jsonb '
            'LANGUAGE plpgsql AS ' || quote_literal(
      replace(bron,
        'NULLIF(regexp_replace(COALESCE(p->>''url'',''''), ''^https?://[^/]+'', ''''), '''')',
        'mi.pad(p->>''url'')'));
    RAISE NOTICE 'mi.collect() bijgewerkt';
  END IF;
END $$;

-- Controle: geen enkel pad mag nog een vraagteken bevatten.
SELECT count(*) FILTER (WHERE page_path LIKE '%?%') AS paden_met_querystring,
       count(*) AS totaal
FROM lead_event;
