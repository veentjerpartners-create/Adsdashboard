-- =========================================================================
-- 014 — Offline conversies ook voor kliks zonder lead
--
-- conversion_upload kende alleen lead_id en deal_id. Maar het eerste dat we
-- terug willen sturen naar Google Ads zijn juist de contactpogingen zónder
-- naam: een WhatsApp-klik of telefoonklik uit een advertentie. Dat is een
-- lead_event, geen lead. Vandaar een derde verwijzing.
--
-- Waarom dit nodig is: de conversietag op de site werkt alleen als de
-- bezoeker cookies accepteert. Op 10 september kwamen drie WhatsApp-kliks uit
-- Ads binnen bij ons, en nul bij Google. Wij hebben de gclid en het tijdstip
-- zelf, dus we uploaden ze -- daar zijn geen cookies voor nodig.
-- =========================================================================

SET search_path = mi, public;

ALTER TABLE conversion_upload
  ADD COLUMN IF NOT EXISTS lead_event_id bigint REFERENCES lead_event(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS conv_upload_event_idx
  ON conversion_upload (lead_event_id) WHERE lead_event_id IS NOT NULL;

-- Snel kunnen zien of een event al in de wachtrij zit: order_id is 'ev-<id>'.
CREATE INDEX IF NOT EXISTS conv_upload_order_idx ON conversion_upload (order_id);

-- Wat er de laatste tijd naar Google ging, leesbaar voor het dashboard.
CREATE OR REPLACE VIEW v_conversion_upload AS
SELECT u.id, u.client_id, u.ads_account_id, u.lead_event_id, u.lead_id,
       e.event_type, e.occurred_at, e.campaign, e.page_path,
       u.conversion_action_rn, u.click_type, u.value, u.currency,
       u.consent_ad_user_data, u.status, u.skip_reason, u.attempts,
       u.last_error, u.created_at, u.uploaded_at
  FROM conversion_upload u
  LEFT JOIN lead_event e ON e.id = u.lead_event_id;

GRANT SELECT ON v_conversion_upload TO service_role, authenticated;

SELECT status, count(*) FROM conversion_upload GROUP BY 1;
