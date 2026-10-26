-- =========================================================================
-- 017 — fbclid is organisch sociaal, geen advertentieklik
--
-- 013 telde elke fbclid als facebook / paid_social. Maar Meta plakt een
-- fbclid achter elke link waarop iemand in Facebook of Instagram klikt, ook
-- de link in de bio of in een story. Organische Instagram-bezoekers stonden
-- daardoor in het dashboard als Meta-advertentie.
--
-- Nu:
--   fbclid + referrer instagram.com    instagram / social
--   fbclid + referrer facebook.com     facebook / social
--   fbclid zonder (andere) referrer    meta / social
--
-- Meta-advertenties herken je voortaan aan hun utm's. Zet in Advertentie-
-- beheer bij elke advertentie als URL-parameters:
--   utm_source=meta&utm_medium=paid_social&utm_campaign={{campaign.name}}
-- utm's winnen in collect(), dus die blijven paid_social en tellen in het
-- dashboard als advertentie.
--
-- Alleen nieuwe bezoeken; bestaande rijen blijven zoals ze zijn.
-- =========================================================================

SET search_path = mi, public;

CREATE OR REPLACE FUNCTION mi.herkomst(
  p_referrer   text,
  p_url        text,
  p_click_type text,
  OUT source   text,
  OUT medium   text
)
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  host   text;
  eigen  text;
BEGIN
  -- Een advertentieklik is altijd betaald, ook als de utm's ontbreken.
  IF p_click_type IN ('gclid', 'gbraid', 'wbraid') THEN
    source := 'google';   medium := 'cpc';          RETURN;
  ELSIF p_click_type = 'msclkid' THEN
    source := 'bing';     medium := 'cpc';          RETURN;
  END IF;
  -- Een fbclid zegt alleen dat de klik uit Facebook of Instagram komt, niet
  -- dat het een advertentie was: Meta plakt hem achter elke uitgaande link.
  -- Betaald herkennen we aan de utm's in de advertentie-URL (die winnen in
  -- collect()); hier is een fbclid dus organisch sociaal verkeer.

  host := lower(substring(COALESCE(p_referrer, '') from '^[a-z]+://([^/:?#]+)'));
  IF host IS NULL OR host = '' THEN
    IF p_click_type = 'fbclid' THEN
      -- In-app-browser zonder referrer: wel Meta, niet welk van de twee.
      source := 'meta'; medium := 'social'; RETURN;
    END IF;
    source := 'direct'; medium := 'none'; RETURN;
  END IF;
  host := regexp_replace(host, '^(www|m|l|lm)\.', '');

  -- Interne navigatie: de vorige pagina was onze eigen site. Dan is er geen
  -- nieuwe herkomst; de aanroeper valt terug op de sessie.
  eigen := regexp_replace(
    lower(substring(COALESCE(p_url, '') from '^[a-z]+://([^/:?#]+)')),
    '^www\.', '');
  IF eigen IS NOT NULL AND eigen <> '' AND host = eigen THEN
    source := NULL; medium := NULL; RETURN;
  END IF;

  -- Zoekmachines. google.nl, google.com, google.co.uk: allemaal google.
  IF host ~ '^google\.' OR host = 'com.google.android.googlequicksearchbox' THEN
    source := 'google';     medium := 'organic';
  ELSIF host ~ '^bing\.'          THEN source := 'bing';       medium := 'organic';
  ELSIF host ~ '^duckduckgo\.'    THEN source := 'duckduckgo'; medium := 'organic';
  ELSIF host ~ '^ecosia\.'        THEN source := 'ecosia';     medium := 'organic';
  ELSIF host ~ '(^|\.)yahoo\.'    THEN source := 'yahoo';      medium := 'organic';
  ELSIF host ~ '^startpage\.'     THEN source := 'startpage';  medium := 'organic';
  ELSIF host ~ '^yandex\.'        THEN source := 'yandex';     medium := 'organic';
  ELSIF host ~ '^(search\.)?brave\.' THEN source := 'brave';   medium := 'organic';

  -- AI-zoekmachines. Apart gehouden van 'referral', want dit is de bron die
  -- de komende jaren groeit en die je in een klantgesprek wilt kunnen noemen.
  ELSIF host IN ('chatgpt.com', 'chat.openai.com', 'openai.com')
                                  THEN source := 'chatgpt';    medium := 'ai';
  ELSIF host ~ '^perplexity\.'    THEN source := 'perplexity'; medium := 'ai';
  ELSIF host IN ('copilot.microsoft.com', 'bing.com/chat')
                                  THEN source := 'copilot';    medium := 'ai';
  ELSIF host = 'gemini.google.com' THEN source := 'gemini';    medium := 'ai';
  ELSIF host = 'claude.ai'        THEN source := 'claude';     medium := 'ai';

  -- Sociaal.
  ELSIF host ~ '(^|\.)facebook\.com$' OR host = 'fb.com'
                                  THEN source := 'facebook';   medium := 'social';
  ELSIF host ~ '(^|\.)instagram\.com$' THEN source := 'instagram'; medium := 'social';
  ELSIF host ~ '(^|\.)linkedin\.com$'  THEN source := 'linkedin';  medium := 'social';
  ELSIF host IN ('x.com', 'twitter.com', 't.co')
                                  THEN source := 'x';          medium := 'social';
  ELSIF host ~ '(^|\.)youtube\.com$' OR host = 'youtu.be'
                                  THEN source := 'youtube';    medium := 'social';
  ELSIF host ~ '(^|\.)pinterest\.' THEN source := 'pinterest';  medium := 'social';
  ELSIF host ~ '(^|\.)tiktok\.com$' THEN source := 'tiktok';    medium := 'social';
  ELSIF host ~ '(^|\.)whatsapp\.com$' OR host = 'com.whatsapp'
                                  THEN source := 'whatsapp';   medium := 'social';

  -- Alles wat overblijft: een gewone verwijzing. De host als bron, zodat je
  -- ziet wíe er linkt.
  ELSE
    source := host; medium := 'referral';
  END IF;

  -- fbclid met een referrer die niet facebook/instagram is: toch Meta.
  IF p_click_type = 'fbclid' AND medium IS DISTINCT FROM 'social' THEN
    source := 'meta'; medium := 'social';
  END IF;
END $$;

GRANT EXECUTE ON FUNCTION mi.herkomst(text, text, text) TO service_role, authenticated;
