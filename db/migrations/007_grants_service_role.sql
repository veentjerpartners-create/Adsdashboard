-- =========================================================================
-- 007 — Rechten voor service_role
--
-- In 001 kreeg alleen 'authenticated' rechten op de tabellen. De ingestion
-- gebruikt de secret key en werkt daarmee als 'service_role', die dus
-- 'permission denied for table ...' kreeg.
--
-- ALTER DEFAULT PRIVILEGES staat er ook bij, zodat tabellen die we later
-- toevoegen dit niet opnieuw nodig hebben.
--
-- Idempotent: twee keer draaien kan geen schade doen.
-- =========================================================================

SET search_path = mi, public;

GRANT USAGE ON SCHEMA mi TO service_role, authenticated;

-- Bestaande objecten (ALL TABLES dekt ook de views).
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES    IN SCHEMA mi TO service_role;
GRANT USAGE, SELECT                  ON ALL SEQUENCES IN SCHEMA mi TO service_role;
GRANT EXECUTE                        ON ALL FUNCTIONS IN SCHEMA mi TO service_role, authenticated;
GRANT USAGE, SELECT                  ON ALL SEQUENCES IN SCHEMA mi TO authenticated;

-- Alles wat hierna wordt aangemaakt.
ALTER DEFAULT PRIVILEGES IN SCHEMA mi
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA mi
  GRANT USAGE, SELECT ON SEQUENCES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA mi
  GRANT EXECUTE ON FUNCTIONS TO service_role, authenticated;

-- 'anon' krijgt bewust niets: zonder inloggen valt hier niets te halen.

SELECT grantee, count(*) AS tabellen
FROM information_schema.role_table_grants
WHERE table_schema = 'mi' AND privilege_type = 'SELECT'
GROUP BY grantee ORDER BY grantee;
