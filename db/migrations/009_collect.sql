-- =========================================================================
-- 009 — mi.collect(): het hart van de event-collector
--
-- WAAROM DIT IN DE DATABASE STAAT EN NIET IN JAVASCRIPT
-- Het endpoint op elke klantwebsite blijft hierdoor dom: valideren, doorsturen,
-- klaar. Geen npm-pakketten in een statische site-repo, geen logica die je bij
-- elke wijziging op tien sites opnieuw moet deployen. En bezoeker, sessie,
-- event en het terugwaarts koppelen gebeuren in één transactie, dus je kunt
-- nooit een event hebben zonder sessie.
--
-- Idempotent, ook bij herhaald aanroepen: alles hangt aan dedupe-sleutels die
-- de browser meestuurt.
-- =========================================================================

SET search_path = mi, public;

-- ---------- normalisatie -------------------------------------------------
-- Eén plek voor e-mail en telefoon, zodat de collector, de mailparser en de
-- handmatige invoer straks gegarandeerd hetzelfde resultaat geven. Anders
-- matcht "Jan@Email.nl " niet met "jan@email.nl" en mis je de koppeling.

CREATE OR REPLACE FUNCTION mi.norm_email(p text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT NULLIF(lower(btrim(p)), '');
$$;

CREATE OR REPLACE FUNCTION mi.e164_nl(p text) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE d text;
BEGIN
  d := regexp_replace(COALESCE(p, ''), '\D', '', 'g');
  IF d = '' THEN RETURN NULL; END IF;
  -- 0031… en 31… en 06… allemaal naar +31…
  IF left(d, 4) = '0031' THEN d := substr(d, 5);
  ELSIF left(d, 2) = '31' AND length(d) >= 11 THEN d := substr(d, 3);
  ELSIF left(d, 1) = '0' THEN d := substr(d, 2);
  END IF;
  RETURN CASE WHEN length(d) >= 8 THEN '+31' || d ELSE NULL END;
END $$;

-- sha256() zit sinds Postgres 11 in de kern; pgcrypto is niet nodig.
CREATE OR REPLACE FUNCTION mi.hash_id(p text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p IS NULL OR p = '' THEN NULL
              ELSE encode(sha256(convert_to(p, 'UTF8')), 'hex') END;
$$;

-- ---------- de collector -------------------------------------------------

CREATE OR REPLACE FUNCTION mi.collect(p jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  w            record;
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
BEGIN
  -- 1. Welke website is dit? De collector_key is publiek en identificeert
  --    alleen; hij geeft geen toegang tot data.
  SELECT id, client_id, domain INTO w
  FROM website
  WHERE collector_key = p->>'k' AND is_active;

  IF w.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'onbekende_sleutel');
  END IF;

  -- 2. Event-type moet bestaan. Een nieuw type toevoegen is één INSERT in
  --    mi.event_type; onbekende types weigeren we, anders vervuilt de timeline.
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

  -- 3. Tijdstip. De browserklok mag ver mis staan; dan is onze eigen klok
  --    betrouwbaarder dan een event dat in de toekomst in de timeline springt.
  v_occurred := to_timestamp((p->>'ts')::bigint / 1000.0);
  IF v_occurred IS NULL
     OR v_occurred > v_now + interval '1 hour'
     OR v_occurred < v_now - interval '30 days' THEN
    v_occurred := v_now;
  END IF;

  -- 4. Bezoeker. Alleen bij de eerste keer leggen we de herkomst vast:
  --    daarna zou een direct bezoek de oorspronkelijke campagne wissen.
  INSERT INTO visitor (
    id, website_id, client_id, ga_client_id, first_seen_at, last_seen_at,
    first_landing_page, first_referrer, first_source, first_medium,
    first_campaign, first_click_id, first_click_type, consent_state
  ) VALUES (
    v_vid, w.id, w.client_id, NULLIF(p->>'gac',''), v_occurred, v_occurred,
    p->>'url', NULLIF(p->>'ref',''),
    NULLIF(p#>>'{utm,source}',''), NULLIF(p#>>'{utm,medium}',''),
    NULLIF(p#>>'{utm,campaign}',''),
    NULLIF(p#>>'{cid,id}',''), NULLIF(p#>>'{cid,type}',''),
    NULLIF(p->>'cs','')
  )
  ON CONFLICT (id) DO UPDATE SET
    last_seen_at  = GREATEST(visitor.last_seen_at, EXCLUDED.last_seen_at),
    ga_client_id  = COALESCE(visitor.ga_client_id, EXCLUDED.ga_client_id),
    consent_state = COALESCE(EXCLUDED.consent_state, visitor.consent_state);

  -- 5. Sessie.
  INSERT INTO visit_session (
    id, visitor_id, website_id, client_id, started_at, last_event_at,
    landing_page, referrer, source, medium, campaign, term, content,
    click_id, click_type, device_type, country, event_count
  ) VALUES (
    v_sid, v_vid, w.id, w.client_id, v_occurred, v_occurred,
    p->>'url', NULLIF(p->>'ref',''),
    NULLIF(p#>>'{utm,source}',''), NULLIF(p#>>'{utm,medium}',''),
    NULLIF(p#>>'{utm,campaign}',''), NULLIF(p#>>'{utm,term}',''),
    NULLIF(p#>>'{utm,content}',''),
    NULLIF(p#>>'{cid,id}',''), NULLIF(p#>>'{cid,type}',''),
    NULLIF(p->>'dev',''), NULLIF(p->>'cty',''), 1
  )
  ON CONFLICT (id) DO UPDATE SET
    last_event_at = GREATEST(visit_session.last_event_at, EXCLUDED.last_event_at),
    event_count   = visit_session.event_count + 1;

  -- 6. Het event zelf. dedupe_key is uniek, dus een sendBeacon die twee keer
  --    aankomt levert geen tweede rij op.
  INSERT INTO lead_event (
    client_id, website_id, visitor_id, session_id, event_type,
    occurred_at, received_at, page_url, page_path, page_title, page_type,
    referrer, source, medium, campaign, term, content,
    click_id, click_type, metadata, ingest_source, dedupe_key
  ) VALUES (
    w.client_id, w.id, v_vid, v_sid, v_type,
    v_occurred, v_now, p->>'url',
    NULLIF(regexp_replace(COALESCE(p->>'url',''), '^https?://[^/]+', ''), ''),
    NULLIF(p->>'ttl',''), NULLIF(p->>'pt',''),
    NULLIF(p->>'ref',''),
    NULLIF(p#>>'{utm,source}',''), NULLIF(p#>>'{utm,medium}',''),
    NULLIF(p#>>'{utm,campaign}',''), NULLIF(p#>>'{utm,term}',''),
    NULLIF(p#>>'{utm,content}',''),
    NULLIF(p#>>'{cid,id}',''), NULLIF(p#>>'{cid,type}',''),
    COALESCE(p->'meta', '{}'::jsonb), 'collector', v_uid
  )
  ON CONFLICT (dedupe_key) DO NOTHING;

  -- 7. Is dit een lead? Dan de persoonsgegevens vastleggen en terugwaarts
  --    koppelen. Alles hierboven gebeurt ook zonder lead -- een WhatsApp-klik
  --    van een anonieme bezoeker hoort gewoon in de tijdlijn.
  v_lead := p->'lead';
  IF v_lead IS NOT NULL AND jsonb_typeof(v_lead) = 'object' THEN
    v_email      := mi.norm_email(v_lead->>'email');
    v_phone      := mi.e164_nl(v_lead->>'phone');
    v_email_h    := mi.hash_id(v_email);
    v_phone_h    := mi.hash_id(v_phone);
    v_browser_id := NULLIF(v_lead->>'browser_lead_id', '');

    -- L1: bestaat deze inzending al? (refresh van de bedankpagina)
    SELECT id INTO v_lead_id FROM lead
    WHERE client_id = w.client_id AND dedupe_key = v_browser_id
      AND v_browser_id IS NOT NULL;

    -- L3: zelfde persoon, zelfde klant, binnen een half uur? Dan is dit
    -- dezelfde aanvraag die langs een tweede weg binnenkwam.
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
        -- Herkomst uit de EERSTE sessie van deze bezoeker, niet uit deze:
        -- iemand die via Google Ads binnenkwam en drie dagen later direct
        -- terugkomt om het formulier in te vullen, is een Ads-lead.
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

    -- L2: alles wat deze bezoeker eerder deed alsnog aan de lead hangen.
    -- Alleen terugwaarts, nooit over een bestaande koppeling heen, en nooit
    -- verder terug dan het 90-dagenvenster van de click-ID.
    UPDATE lead_event
       SET lead_id = v_lead_id
     WHERE visitor_id = v_vid
       AND lead_id IS NULL
       AND client_id = w.client_id
       AND occurred_at >= v_now - interval '90 days';
    GET DIAGNOSTICS v_gestitcht = ROW_COUNT;

    -- Vastleggen hoe we hieraan komen, zodat het navolgbaar en omkeerbaar is.
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

-- Alleen de server mag dit aanroepen. Het endpoint op de website gebruikt de
-- secret key, die nooit in de browser terechtkomt.
REVOKE ALL ON FUNCTION mi.collect(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION mi.collect(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION mi.norm_email(text), mi.e164_nl(text), mi.hash_id(text)
  TO service_role, authenticated;

-- ---------- controle -----------------------------------------------------

SELECT mi.e164_nl('06-12345678')        AS telefoon,
       mi.norm_email('  Jan@Email.NL ') AS email,
       left(mi.hash_id('jan@email.nl'), 16) || '...' AS hash;
