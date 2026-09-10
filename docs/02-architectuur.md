# 02 — Architectuur

## 1. De belangrijkste conclusie eerst: GA4 kan de timeline niet leveren

Je wil per lead zien: advertentieklik → landingspagina → page view →
WhatsApp-klik → telefoonklik → form start → form submit → offerte → deal.
Dat is een **event-stream per individu**. GA4 kan dat niet aan ons teruggeven:

- De **GA4 Data API is een rapportage-API**, geen event-export. Je vraagt
  geaggregeerde rijen op (dimensie × metric). Er is geen dimensie die één
  bezoeker uniek en bruikbaar identificeert; `user_pseudo_id` bestaat alleen in
  de BigQuery-export, niet in de Data API.
- **`gclid` bestaat niet als GA4-dimensie.** Je kunt hem er als custom parameter
  in stoppen, maar dan zet je een advertentie-identifier in een systeem waar je
  hem niet per persoon uit kunt halen. Zinloos.
- **PII mag niet in GA4.** Naam, e-mail, telefoon: verboden volgens de
  Google-voorwaarden én onwenselijk volgens de AVG. Dus GA4 kan per definitie
  niet weten wie de lead is.
- **Cardinaliteit en `(other)`**: zodra je te veel unieke waarden per dimensie
  hebt, gooit GA4 rijen op één hoop onder `(other)`. Per-lead werken is
  onmogelijk.
- **Latency**: data is 24–48 uur niet definitief.
- **BigQuery-export** zou event-level rijen geven (`user_pseudo_id`,
  `ga_session_id`), maar dan nog: geen gclid, geen PII, één dataset per property
  × 10+ klanten, en het gratis quotum is beperkt. Veel complexiteit voor een
  half antwoord.

**Daarom:** we bouwen een **eigen first-party event-collector** en laten GA4
staan zoals hij is. GA4 blijft precies wat jij zelf al schreef dat hij is —
bron voor sessions, traffic, attributie op kanaalniveau en journeys als
cross-check. Onze eigen database is de bron voor de business-entities én voor de
lead-timeline.

Dit is géén tracking-herbouw. Beide bestaande tracking-bestanden sturen elk
event door precies één functie (`send()` / `lead()` bij BB, `track()` bij RBB).
We hangen daar één extra bestemming aan: een `navigator.sendBeacon` naar ons
eigen endpoint. Alle bestaande logica — dienstgroepen, click-ID-opslag,
ontdubbeling, consent-gating, enhanced conversions — blijft ongewijzigd staan.

---

## 2. Repository-indeling

**Aanbeveling: één nieuwe repository, `marketing-intelligence`.** Reden: de
Google Ads-repo is een verzameling losse, per-klant advies-scripts zonder
package-structuur, database of scheduler. Daar een multi-tenant applicatie in
bouwen levert alleen verstrengeling op. Verantwoordelijkheden blijven scherp:

| Repo | Blijft verantwoordelijk voor |
|---|---|
| `GoogleAds` (bestaand) | Ads-beheer, keyword research, campagne-opbouw, adviesrapporten. Onveranderd. |
| Website-repos (bestaand) | De websites en de website-tracking. Eén nieuw bestandje `mi-collect.js` + 3 regels in het bestaande tracking-bestand. |
| `marketing-intelligence` (nieuw) | Ingestion, centraal datamodel, lead-intelligence, attributie, winstgevendheid, dashboard, klantportaal, terugkoppeling naar Ads. |

Wat we uit `GoogleAds` overnemen doen we door **code te kopiëren naar een echte
module**, niet door te importeren over repo-grenzen: `google-ads.yaml` blijft de
credential-bron (via env var of gemount secret), en de GAQL-patronen uit
`client_report.py` / `test_connection.py` worden `connectors/google_ads/`.
Zo blijft de oude repo werken zoals hij werkt.

### Mappenstructuur

```
marketing-intelligence/
├── db/migrations/            001_core.sql, 002_events.sql, ...
├── ingest/                   Python — draait op Railway
│   ├── core/                 config, supabase-client, sync_run, retry, upsert
│   ├── connectors/
│   │   ├── google_ads/       accounts, structure, metrics, clicks (click_view)
│   │   ├── ga4/              Data API — dagaggregaten
│   │   ├── crm/              teamleader (hergebruik), csv, manual
│   │   └── mail/             Formspree-mailparser (hergebruik outlook_scanner)
│   ├── export/               offline conversions terug naar Google Ads
│   └── scheduler.py          APScheduler, patroon uit verbouwgroepnoord/main.py
├── collect/                  het first-party endpoint (Vercel function)
├── app/                      Next.js dashboard + klantportaal
└── web-snippet/mi-collect.js  ~40 regels, naar elke website-repo
```

**Waarom Python voor ingestion en TypeScript voor de app:** de
`google-ads`-library is in de praktijk Python-first en je hebt er al werkende
auth en query's voor. Het dashboard wil routing, filters, formulieren en
rolgebaseerde toegang — dat is Next.js-terrein, en je sites staan al op Vercel.
Streamlit (staat in de oude `requirements.txt`) is prima voor een grafiek maar
ongeschikt voor een leaddetailpagina met bewerkbare status, klantlogin en RLS.

---

## 3. Datastromen

```
Google Ads API ──(dagelijks, rolling 14d + click_view dagelijks)──┐
GA4 Data API  ──(dagelijks, rolling 3d, alleen aggregaten)────────┤
Website        ──(realtime, sendBeacon)──► /api/collect ──────────┤
Formspree-mail ──(elke 5 min, fallback-sites)─────────────────────┼──► Postgres
Teamleader     ──(elke 15 min, waar aanwezig)─────────────────────┤    (Supabase)
Handmatige invoer (offers, deals, marge, telefonische leads)──────┘         │
                                                                            │
                          ┌─────────────────────────────────────────────────┤
                          ▼                                                 ▼
              Intern dashboard (alle klanten)               Klantportaal (één klant)
                          │
                          ▼
        Offline conversions ──► Google Ads (marge als conversiewaarde)
```

---

## 4. Toegangsmodel — jij in alles, elke klant alleen in zichzelf

Dit is een multi-tenant applicatie met twee publieksgroepen. De scheiding zit op
**drie lagen**, want één laag is nooit genoeg.

### Laag 1 — Identiteit en rollen

**Supabase Auth**, magic link per e-mail (geen wachtwoorden om te beheren,
geen wachtwoordreset-support). Twee tabellen bepalen wie wat mag:

- `app_user` — één rij per inlog, met `role`:
  - `owner` — jij. Ziet alles, alle klanten, alle instellingen.
  - `agency` — medewerker van jou. Alle klanten, geen instellingen/secrets.
  - `client` — klantgebruiker. Alleen de klanten waar hij expliciet aan hangt.
- `user_client_access` — `(user_id, client_id, access_level)`. Een klant heeft
  normaal één rij; een klant met meerdere BV's/websites krijgt meerdere rijen.
  `access_level` is `viewer` (alleen lezen) of `editor` (mag leadstatus en
  offertes bijwerken — nuttig als de klant zelf zijn pipeline bijhoudt).

De actieve tenant-scope komt uit een JWT-claim, niet uit een URL-parameter of
een dropdown-keuze die de browser kan vervalsen.

### Laag 2 — Row Level Security in Postgres (het echte slot)

Elke tabel met klantdata krijgt een `client_id` en RLS aan. Eén helper-functie,
overal hetzelfde patroon:

```sql
-- Welke klanten mag de ingelogde gebruiker zien?
CREATE OR REPLACE FUNCTION mi_visible_clients()
RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT c.id FROM client c
  WHERE EXISTS (
    SELECT 1 FROM app_user u
    WHERE u.auth_uid = auth.uid() AND u.role IN ('owner','agency')
  )
  UNION
  SELECT uca.client_id FROM user_client_access uca
  JOIN app_user u ON u.id = uca.user_id
  WHERE u.auth_uid = auth.uid();
$$;

ALTER TABLE lead ENABLE ROW LEVEL SECURITY;
CREATE POLICY lead_read ON lead FOR SELECT
  USING (client_id IN (SELECT mi_visible_clients()));
```

Gevolg: ook als er ooit een bug in de applicatiecode zit die `WHERE client_id`
vergeet, geeft de database nul rijen terug in plaats van de leads van een andere
klant. Dat is het verschil tussen een lelijke bug en een datalek.

De ingestion-services gebruiken de **service-role key** en omzeilen RLS bewust;
die key komt nooit in de browser en staat alleen in de Railway-omgeving.

### Laag 3 — Veldniveau: wat een klant wél en niet ziet

Niet alles wat in een lead staat is voor de klant bedoeld. Per klant instelbaar
in `client_portal_settings`:

| Blok | Klant standaard | Waarom |
|---|---|---|
| Leads + contactgegevens | ✅ zichtbaar | Het zijn zijn leads; hij belt ze zelf. |
| Timeline | ✅ zichtbaar | Dit is het verkoopargument: "kijk wat deze man deed voor hij belde". |
| Spend, clicks, CPL, campagnes | ✅ zichtbaar | Hij betaalt het mediabudget. |
| Omzet, marge, winst na advertentiekosten | ✅ zichtbaar, per klant uit te zetten | Het is zíjn omzet en marge — maar sommige klanten willen dit niet in een portaal, en soms voer jij een geschatte marge in die je niet wil laten zien. |
| Zoekwoorden en zoektermen | instelbaar | Sommige klanten gaan hiermee zelf sleutelen of stappen ermee naar een andere partij. |
| Interne notities | ❌ nooit | `lead.internal_notes` is een apart veld, buiten de portaal-selectie. |
| Matching-diagnostiek (confidence, methode) | ❌ nooit | Ruis voor de klant; wel zichtbaar voor jou. |
| Andere klanten, benchmarks, jouw fee | ❌ nooit | Aparte tabellen, nooit in de portaal-queries. |
| Instellingen, connectoren, API-keys, sync-logs | ❌ nooit | Alleen `owner`. |

Technisch: de portaal-pagina's lezen niet uit dezelfde queries als het interne
dashboard, maar uit een set **views** (`v_portal_lead`, `v_portal_campaign`,
`v_portal_kpi`) die per definitie alleen toegestane kolommen bevatten. Een
kolom die niet in de view zit kan niet per ongeluk in een API-response
belanden.

### Eén applicatie, twee gezichten

Niet twee apps bouwen. Één Next.js-app, rol-bewuste layout:

- `/` … `/settings` — intern. Klantwissel-selector, cross-client overzicht.
- `/portal` — klantportaal. Geen klantselector (of alleen zijn eigen BV's),
  eigen huisstijl-header, versimpelde navigatie: Overzicht, Leads, Campagnes,
  Offertes & deals.
- Eén server-side `getScope()` bepaalt uit de sessie: rol, toegestane
  `client_id`s, actieve klant, en welke velden mogen. Alle data-access loopt
  daardoorheen. Geen enkele query in de app zonder scope.

### Rapport delen zonder inlog

Voor maandrapportages: **share-link** met een token in
`report_share` (`token`, `client_id`, `period_start`, `period_end`,
`expires_at`, `revoked_at`, `view_count`). Read-only, één klant, één periode,
verloopt. Handig, maar bewust beperkt: geen leaddetail met persoonsgegevens
achter een link zonder inlog. PII vereist een echte login.

### Twee dingen om nu al te regelen (AVG)

1. **Verwerkersovereenkomst per klant.** Zodra jij de contactgegevens van
   *zijn* leads in *jouw* database opslaat, ben jij verwerker en hij
   verwerkingsverantwoordelijke. Dat moet op papier, en het is ook gewoon een
   professioneel argument bij de verkoop van dit dashboard.
2. **Audit-log.** `audit_log` (`user_id`, `action`, `entity`, `entity_id`,
   `client_id`, `at`, `ip`). Wie heeft welke lead bekeken, geëxporteerd of
   gewijzigd. Nodig zodra klanten meekijken, en het maakt een export van
   200 leads door een vertrekkende klantmedewerker zichtbaar.
