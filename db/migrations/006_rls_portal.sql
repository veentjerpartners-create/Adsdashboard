-- Alle objecten in het schema 'mi', zodat dit project met de CMS kan
-- samenleven zonder naamconflicten. Zie 001_core.sql voor de uitleg.
SET search_path = mi, public;

-- =========================================================================
-- 006 — Row Level Security en portaal-views
--
-- NIET NU DRAAIEN. Dit hoort bij fase 4, als er klantgebruikers komen.
--
-- Waarom niet eerder: zodra RLS aanstaat, ziet een ingelogde gebruiker
-- alleen nog wat mi.visible_clients() teruggeeft. Staat er dan nog geen rij
-- voor jou in app_user, dan is je eigen dashboard leeg. De ingestion draait
-- met de service-role key en wordt hier nooit door geraakt.
--
-- Volgorde bij fase 4:
--   1. Log in op het dashboard, zodat er een auth.users-rij bestaat.
--   2. INSERT INTO app_user (auth_uid, email, role)
--      VALUES ('<jouw auth uid>', '<jouw e-mail>', 'owner');
--   3. Pas daarna dit bestand draaien.
--   4. Stap 4.2 uitvoeren: de negatieve test.
-- =========================================================================

-- ---------- tabellen met client_id: klantscheiding ----------------------

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'client','website','ads_account','crm_connection','client_portal_settings',
    'visitor','visit_session','lead','lead_event','offer','deal',
    'ad_cost_allocation','conversion_upload','report_share'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- client zelf: op id in plaats van client_id
DROP POLICY IF EXISTS client_sel ON client;
CREATE POLICY client_sel ON client FOR SELECT
  USING (id IN (SELECT mi.visible_clients()));

-- alle overige tabellen met een client_id-kolom
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'website','ads_account','crm_connection','client_portal_settings',
    'visitor','visit_session','lead','lead_event','offer','deal',
    'ad_cost_allocation','conversion_upload','report_share'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_sel', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR SELECT USING (client_id IN (SELECT mi.visible_clients()))',
      t || '_sel', t);
  END LOOP;
END $$;

-- Schrijven op leads, offertes en deals: alleen agency/owner, of een
-- klantgebruiker met access_level = 'editor'.
DROP POLICY IF EXISTS lead_upd ON lead;
CREATE POLICY lead_upd ON lead FOR UPDATE
  USING (client_id IN (SELECT mi.visible_clients())
         AND (mi.user_role() IN ('owner','agency')
              OR EXISTS (SELECT 1 FROM user_client_access uca
                           JOIN app_user u ON u.id = uca.user_id
                          WHERE u.auth_uid = auth.uid()
                            AND uca.client_id = lead.client_id
                            AND uca.access_level = 'editor')))
  WITH CHECK (client_id IN (SELECT mi.visible_clients()));

-- ---------- interne tabellen: nooit voor een klant ----------------------

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'ads_campaign','ads_ad_group','ads_keyword','ads_metrics_daily','ads_click',
    'ga4_traffic_daily','ga4_event_daily','lead_identity','lead_attribution',
    'sync_run','sync_cursor','audit_log','app_user','user_client_access'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_internal', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR SELECT USING (mi.user_role() IN (''owner'',''agency''))',
      t || '_internal', t);
  END LOOP;
END $$;

-- ---------- portaal-views: veldrechten in SQL ---------------------------
-- security_invoker = true, zodat de RLS van de onderliggende tabel blijft
-- gelden. De view is een kolomfilter, geen omweg om de rijfilter heen.

CREATE OR REPLACE VIEW v_portal_lead
WITH (security_invoker = true) AS
SELECT l.id,
       l.public_ref,
       l.client_id,
       w.domain AS website,
       CASE WHEN s.show_lead_contact THEN l.name  END AS name,
       CASE WHEN s.show_lead_contact THEN l.email END AS email,
       CASE WHEN s.show_lead_contact THEN l.phone END AS phone,
       l.created_at,
       l.status,
       l.lead_type,
       l.subject,
       l.source,
       l.medium,
       l.campaign,
       l.landing_page,
       CASE WHEN s.show_keywords THEN l.keyword  END AS keyword,
       CASE WHEN s.show_keywords THEN l.ad_group END AS ad_group
FROM lead l
JOIN client_portal_settings s ON s.client_id = l.client_id
LEFT JOIN website w ON w.id = l.website_id
WHERE l.deleted_at IS NULL AND s.portal_enabled;
-- Bewust NIET in deze view: internal_notes, match_confidence, needs_review,
-- click_id, email_sha256, phone_sha256, dedupe_key, owner_user_id,
-- first_visitor_id, consent_marketing, confirmed_by_mail.

CREATE OR REPLACE VIEW v_portal_timeline
WITH (security_invoker = true) AS
SELECT e.lead_id,
       e.client_id,
       e.event_type,
       t.label,
       t.category,
       t.icon,
       e.occurred_at,
       e.page_path,
       e.page_type,
       e.campaign
FROM lead_event e
JOIN event_type t ON t.code = e.event_type
JOIN client_portal_settings s ON s.client_id = e.client_id
WHERE e.lead_id IS NOT NULL AND s.portal_enabled;
-- Bewust NIET: metadata, visitor_id, session_id, click_id, dedupe_key.

CREATE OR REPLACE VIEW v_portal_economics
WITH (security_invoker = true) AS
SELECT v.lead_id,
       v.client_id,
       v.public_ref,
       v.lead_date,
       v.campaign,
       v.status,
       v.offer_value,
       CASE WHEN s.show_revenue THEN v.revenue          END AS revenue,
       CASE WHEN s.show_margin  THEN v.gross_margin     END AS gross_margin,
       CASE WHEN s.show_margin  THEN v.margin_source    END AS margin_source,
       CASE WHEN s.show_spend   THEN v.ad_cost          END AS ad_cost,
       CASE WHEN s.show_profit  THEN v.profit_after_ads END AS profit_after_ads
FROM v_lead_economics v
JOIN client_portal_settings s ON s.client_id = v.client_id
WHERE s.portal_enabled;
