-- =========================================================================
-- 013 — Herkomst afleiden uit de referrer
--
-- Bron en medium werden alleen ingevuld als er een click-ID of utm-parameters
-- in de URL stonden. Alles daarbuiten -- iemand die je via Google vindt zonder
-- op een advertentie te klikken, iemand die het adres intypt, iemand die uit
-- ChatGPT komt -- stond als "geen bron". Op 10 september was dat 83 van de
-- 104 pageviews. Dan kun je Ads en organisch niet naast elkaar leggen.
--
-- De referrer werd wél opgeslagen, dus de informatie was er. Deze migratie
-- leidt er een bron en medium uit af, op dezelfde manier als GA4 dat doet:
--
--   click-ID (gclid/gbraid/wbraid)   google / cpc      ook zonder utm's
--   google.nl, google.com, ...        google / organic
--   bing, duckduckgo, ecosia, ...     <naam> / organic
--   chatgpt.com, perplexity.ai, ...   <naam> / ai       AI-zoekmachines apart,
--                                                       want dat verkeer groeit
--   facebook, instagram, linkedin     <naam> / social
--   eigen domein                      niets             interne navigatie
--   leeg                              direct / none
--   overig                            <host> / referral
--
-- Een utm-waarde uit de URL wint altijd van de afleiding: wie zelf tagt, weet
-- het beter dan een gok op basis van de referrer.
-- =========================================================================

SET search_path = mi, public;

-- ---------- de afleiding ---------------------------------------------------

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
  ELSIF p_click_type = 'fbclid' THEN
    source := 'facebook'; medium := 'paid_social';  RETURN;
  END IF;

  host := lower(substring(COALESCE(p_referrer, '') from '^[a-z]+://([^/:?#]+)'));
  IF host IS NULL OR host = '' THEN
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
END $$;

GRANT EXECUTE ON FUNCTION mi.herkomst(text, text, text) TO service_role, authenticated;

-- ---------- de collector, met herkomst -----------------------------------
-- Volledige functie zoals in 011 en 012, met drie toevoegingen: v_src/v_med
-- worden één keer afgeleid, de sessie krijgt ze bij aanmaak, en een event
-- zonder eigen herkomst neemt die van zijn sessie over.

CREATE OR REPLACE FUNCTION mi.collect(p jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  w            record;
  h            record;
  v_vid        uuid;
  v_sid        uuid;
  v_uid        text;
  v_type       text;
  v_occurred   timestamptz;
  v_now        timestamptz := now();
  v_lead       jsonb;
  v_lead_id    uuid;
  v_email      text;
  v_phone      text;
  v_email_h    text;
  v_phone_h    text;
  v_browser_id text;
  v_gestitcht  int := 0;
  v_nieuw      boolean := false;
  v_src        text;
  v_med        text;
  v_ses_src    text;
  v_ses_med    text;
BEGIN
  SELECT id, client_id, domain, collector_live_since INTO w
  FROM website
  WHERE collector_key = p->>'k' AND is_active;

  IF w.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'onbekende_sleutel');
  END IF;

  v_type := p->>'t';
  IF NOT EXISTS (SELECT 1 FROM event_type WHERE code = v_type) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'onbekend_event_type',
                              'event_type', v_type);
  END IF;

  v_vid := NULLIF(p->>'vid', '')::uuid;
  v_sid := NULLIF(p->>'sid', '')::uuid;
  v_uid := NULLIF(p->>'uid', '');
  IF v_vid IS NULL OR v_sid IS NULL OR v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'vid_sid_uid_verplicht');
  END IF;

  v_occurred := to_timestamp((p->>'ts')::bigint / 1000.0);
  IF v_occurred IS NULL
     OR v_occurred > v_now + interval '1 hour'
     OR v_occurred < v_now - interval '30 days' THEN
    v_occurred := v_now;
  END IF;

  -- Herkomst: utm's uit de URL winnen, daarna de click-ID, daarna de referrer.
  -- Bij interne navigatie geeft herkomst() NULL terug; dan blijft v_src leeg
  -- en valt het event verderop terug op zijn sessie.
  SELECT * INTO h FROM mi.herkomst(
    NULLIF(p->>'ref',''), p->>'url', NULLIF(p#>>'{cid,type}',''));
  v_src := COALESCE(NULLIF(p#>>'{utm,source}',''), h.source);
  v_med := COALESCE(NULLIF(p#>>'{utm,medium}',''), h.medium);

  INSERT INTO visitor (
    id, website_id, client_id, ga_client_id, first_seen_at, last_seen_at,
    first_landing_page, first_referrer, first_source, first_medium,
    first_campaign, first_click_id, first_click_type, consent_state
  ) VALUES (
    v_vid, w.id, w.client_id, NULLIF(p->>'gac',''), v_occurred, v_occurred,
    p->>'url', NULLIF(p->>'ref',''),
    COALESCE(v_src, 'direct'), COALESCE(v_med, 'none'),
    NULLIF(p#>>'{utm,campaign}',''),
    NULLIF(p#>>'{cid,id}',''), NULLIF(p#>>'{cid,type}',''),
    NULLIF(p->>'cs','')
  )
  ON CONFLICT (id) DO UPDATE SET
    last_seen_at  = GREATEST(visitor.last_seen_at, EXCLUDED.last_seen_at),
    ga_client_id  = COALESCE(visitor.ga_client_id, EXCLUDED.ga_client_id),
    consent_state = COALESCE(EXCLUDED.consent_state, visitor.consent_state);

  INSERT INTO visit_session (
    id, visitor_id, website_id, client_id, started_at, last_event_at,
    landing_page, referrer, source, medium, campaign, term, content,
    click_id, click_type, device_type, country, event_count
  ) VALUES (
    v_sid, v_vid, w.id, w.client_id, v_occurred, v_occurred,
    p->>'url', NULLIF(p->>'ref',''),
    COALESCE(v_src, 'direct'), COALESCE(v_med, 'none'),
    NULLIF(p#>>'{utm,campaign}',''), NULLIF(p#>>'{utm,term}',''),
    NULLIF(p#>>'{utm,content}',''),
    NULLIF(p#>>'{cid,id}',''), NULLIF(p#>>'{cid,type}',''),
    NULLIF(p->>'dev',''), NULLIF(p->>'cty',''), 1
  )
  ON CONFLICT (id) DO UPDATE SET
    last_event_at = GREATEST(visit_session.last_event_at, EXCLUDED.last_event_at),
    event_count   = visit_session.event_count + 1
  RETURNING source, medium INTO v_ses_src, v_ses_med;

  INSERT INTO lead_event (
    client_id, website_id, visitor_id, session_id, event_type,
    occurred_at, received_at, page_url, page_path, page_title, page_type,
    referrer, source, medium, campaign, term, content,
    click_id, click_type, metadata, ingest_source, dedupe_key
  ) VALUES (
    w.client_id, w.id, v_vid, v_sid, v_type,
    v_occurred, v_now, p->>'url',
    mi.pad(p->>'url'),
    NULLIF(p->>'ttl',''), NULLIF(p->>'pt',''),
    NULLIF(p->>'ref',''),
    COALESCE(v_src, v_ses_src), COALESCE(v_med, v_ses_med),
    NULLIF(p#>>'{utm,campaign}',''), NULLIF(p#>>'{utm,term}',''),
    NULLIF(p#>>'{utm,content}',''),
    NULLIF(p#>>'{cid,id}',''), NULLIF(p#>>'{cid,type}',''),
    COALESCE(p->'meta', '{}'::jsonb), 'collector', v_uid
  )
  ON CONFLICT (dedupe_key) DO NOTHING;

  IF w.collector_live_since IS NULL THEN
    UPDATE website SET collector_live_since = v_now
     WHERE id = w.id AND collector_live_since IS NULL;
  END IF;

  v_lead := p->'lead';
  IF v_lead IS NOT NULL AND jsonb_typeof(v_lead) = 'object' THEN
    v_email      := mi.norm_email(v_lead->>'email');
    v_phone      := mi.e164_nl(v_lead->>'phone');
    v_email_h    := mi.hash_id(v_email);
    v_phone_h    := mi.hash_id(v_phone);
    v_browser_id := NULLIF(v_lead->>'browser_lead_id', '');

    SELECT id INTO v_lead_id FROM lead
    WHERE client_id = w.client_id AND dedupe_key = v_browser_id
      AND v_browser_id IS NOT NULL;

    IF v_lead_id IS NULL AND v_email_h IS NOT NULL THEN
      SELECT id INTO v_lead_id FROM lead
      WHERE client_id = w.client_id AND email_sha256 = v_email_h
        AND created_at > v_now - interval '30 minutes'
        AND deleted_at IS NULL
      ORDER BY created_at DESC LIMIT 1;
    END IF;

    IF v_lead_id IS NULL THEN
      INSERT INTO lead (
        client_id, website_id, name, email, email_norm, email_sha256,
        phone, phone_e164, phone_sha256, lead_type,
        source, medium, campaign, click_id, click_type,
        landing_page, referrer, device_type, subject,
        first_visitor_id, first_seen_at, created_at,
        ingest_source, dedupe_key, match_confidence, consent_marketing
      )
      SELECT
        w.client_id, w.id, NULLIF(v_lead->>'name',''), v_lead->>'email',
        v_email, v_email_h,
        NULLIF(v_lead->>'phone',''), v_phone, v_phone_h,
        COALESCE(NULLIF(v_lead->>'lead_type',''), 'form'),
        vis.first_source, vis.first_medium, vis.first_campaign,
        vis.first_click_id, vis.first_click_type,
        vis.first_landing_page, vis.first_referrer,
        NULLIF(p->>'dev',''), NULLIF(v_lead->>'subject',''),
        v_vid, vis.first_seen_at, v_now,
        'collector', v_browser_id, 1.00,
        (vis.consent_state = 'accepted')
      FROM visitor vis WHERE vis.id = v_vid
      RETURNING id INTO v_lead_id;
      v_nieuw := true;
    END IF;

    UPDATE lead_event
       SET lead_id = v_lead_id
     WHERE visitor_id = v_vid
       AND lead_id IS NULL
       AND client_id = w.client_id
       AND occurred_at >= v_now - interval '90 days';
    GET DIAGNOSTICS v_gestitcht = ROW_COUNT;

    INSERT INTO lead_identity (lead_id, kind, value, confidence, method)
    VALUES (v_lead_id, 'visitor_id', v_vid::text, 0.95, 'visitor_stitch')
    ON CONFLICT DO NOTHING;

    IF v_browser_id IS NOT NULL THEN
      INSERT INTO lead_identity (lead_id, kind, value, confidence, method)
      VALUES (v_lead_id, 'browser_lead_id', v_browser_id, 1.00, 'exact_lead_id')
      ON CONFLICT DO NOTHING;
    END IF;
    IF v_email_h IS NOT NULL THEN
      INSERT INTO lead_identity (lead_id, kind, value, confidence, method)
      VALUES (v_lead_id, 'email_sha256', v_email_h, 0.90, 'email_match')
      ON CONFLICT DO NOTHING;
    END IF;
    IF v_phone_h IS NOT NULL THEN
      INSERT INTO lead_identity (lead_id, kind, value, confidence, method)
      VALUES (v_lead_id, 'phone_sha256', v_phone_h, 0.90, 'phone_match')
      ON CONFLICT DO NOTHING;
    END IF;

    IF v_nieuw THEN
      INSERT INTO lead_status_history (lead_id, from_status, to_status, note)
      VALUES (v_lead_id, NULL, 'new', 'aangemaakt door de collector');
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'client_id', w.client_id,
    'lead_id', v_lead_id,
    'nieuwe_lead', v_nieuw,
    'gekoppelde_events', v_gestitcht
  );
END $$;

REVOKE ALL ON FUNCTION mi.collect(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION mi.collect(jsonb) TO service_role;

-- ---------- bestaande rijen alsnog labelen ---------------------------------
-- Eerst de sessies en bezoekers (die hebben hun eigen referrer), dan de
-- events: een event met interne referrer neemt de bron van zijn sessie.

UPDATE visit_session s
   SET source = COALESCE((mi.herkomst(s.referrer, s.landing_page, s.click_type)).source, 'direct'),
       medium = COALESCE((mi.herkomst(s.referrer, s.landing_page, s.click_type)).medium, 'none')
 WHERE s.source IS NULL;

UPDATE visitor v
   SET first_source = COALESCE((mi.herkomst(v.first_referrer, v.first_landing_page, v.first_click_type)).source, 'direct'),
       first_medium = COALESCE((mi.herkomst(v.first_referrer, v.first_landing_page, v.first_click_type)).medium, 'none')
 WHERE v.first_source IS NULL;

UPDATE lead_event e
   SET source = COALESCE((mi.herkomst(e.referrer, e.page_url, e.click_type)).source, s.source),
       medium = COALESCE((mi.herkomst(e.referrer, e.page_url, e.click_type)).medium, s.medium)
  FROM visit_session s
 WHERE s.id = e.session_id
   AND e.source IS NULL;

UPDATE lead l
   SET source = COALESCE((mi.herkomst(l.referrer, l.landing_page, l.click_type)).source, 'direct'),
       medium = COALESCE((mi.herkomst(l.referrer, l.landing_page, l.click_type)).medium, 'none')
 WHERE l.source IS NULL;

-- ---------- controle -------------------------------------------------------

SELECT * FROM mi.herkomst('https://www.google.nl/', 'https://boersbreuer.nl/', NULL)
UNION ALL SELECT * FROM mi.herkomst('https://chatgpt.com/', 'https://boersbreuer.nl/', NULL)
UNION ALL SELECT * FROM mi.herkomst('', 'https://boersbreuer.nl/', NULL)
UNION ALL SELECT * FROM mi.herkomst('https://boersbreuer.nl/contact.html', 'https://boersbreuer.nl/', NULL)
UNION ALL SELECT * FROM mi.herkomst('', 'https://boersbreuer.nl/?gclid=x', 'gclid');

SELECT source, medium, count(*) AS sessies
  FROM visit_session GROUP BY 1, 2 ORDER BY 3 DESC;
