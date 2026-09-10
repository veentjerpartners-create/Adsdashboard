# 01 — Inventarisatie bestaande systemen

Gebaseerd op inspectie van `C:\Users\Stijn\CP` op 2026-09-09. Alles hieronder is
teruggelezen uit code, niet aangenomen.

---

## 1. Google Ads repository — `CP\GoogleAds`

**Stack:** Python, `google-ads>=25.0.0`, pandas, jinja2, openpyxl. In
`requirements.txt` staan ook streamlit en plotly, maar er is geen dashboard-code.

**Authenticatie (herbruikbaar, werkt al):**
`google-ads.yaml` met `developer_token`, `client_id`, `client_secret`,
`refresh_token`, `login_customer_id` (MCC `9287874539`), `use_proto_plus: true`.
Alle scripts laden dit via `GoogleAdsClient.load_from_storage("google-ads.yaml")`.
Het bestand staat in `.gitignore`. Dit is de enige auth die de nieuwe applicatie
nodig heeft voor Google Ads — niets opnieuw op te zetten.

**Direct herbruikbare bouwstenen:**

| Bestand | Wat er in zit dat we hergebruiken |
|---|---|
| `test_connection.py` | GAQL op `customer_client` (`level <= 1`) → accountdiscovery onder de MCC. Dit wordt onze `sync_accounts`. |
| `bb_koppel_mcc.py` | Zelfde query met `level <= 2`, plus `customer_client_link` / `customer_manager_link`. Toont hoe de accountboom eruitziet. |
| `client_report.py` | GAQL-patronen voor `campaign` en `keyword_view` met `segments.date BETWEEN`, plus de `cost_micros / 1_000_000` helper. Basis voor onze metrics-connector. |
| `bb_conversies.py` | Volledig beheer van conversieacties: aanmaken (`WEBPAGE`, categorieën `SUBMIT_LEAD_FORM` / `PHONE_CALL_LEAD` / `CONTACT`), `customer_conversion_goal` biddable aan/uit, en labels teruglezen uit `tag_snippets`. Dit is exact de plumbing die we straks uitbreiden voor offline conversies. |
| `generate_refresh_token.py` | OAuth-flow, eenmalig al gedaan. |

**Structuur:** ~100 losse scripts, plat in de root, per klant geprefixt
(`bb_*` Boers & Breuer, `rbb_*` Rotterdamse Bouwbedrijf, `va_*`, `soul_*`,
`us_*` Urban Stars, `pby_*` Paraguay, `veentjer_*`). Geen shared package, geen
database, geen scheduler. Output is xlsx/docx/pdf/html per klant.

**Wat er niet is:** geen `ConversionUploadService` / offline conversies, geen
`click_view` (gclid) query, geen GA4, geen persistente opslag, geen incremental
sync, geen logging naar iets anders dan stdout.

---

## 2. Website-repositories

**Hosting:** statisch HTML op Vercel (`vercel.json` in ~14 projecten). Enkele
Next.js-sites (Verbaacta, Gimive, Veentjer Business Development).
→ Belangrijk gevolg: elke site kan een **first-party serverless endpoint**
krijgen op zijn eigen domein zonder nieuwe hosting.

**GA4 is overal aanwezig, per klant een eigen property:**

| Measurement ID | Project |
|---|---|
| `G-XNK3821MV5` | Boers & Breuer (`site/`) |
| `G-JJ0H71JQ4C` | Boers & Breuer (`SITE-DEPLOY/`) — tweede ID in hetzelfde project |
| `G-XT5KPYD28T` | Rotterdamse Bouwbedrijf B.V |
| `G-5Z6GGKXKPD` | Dakramennoord |
| `G-NE96NK8B6T` | nielswebsite-template — gedeeld over nielswebsite / Stoba / RBB-kopieën |
| `G-LNG5QZ04JH` | Veentjerbusinesssupport |
| `G-QD16DV9FDJ` + `G-BE6H3JSSQP` | website byl |
| `G-5GG6DXVD8K` | Stefwerkt |
| `G-W6JPQLL7R8` | Verbaacta |
| `G-XXXXXXXXXX` | placeholder in 157 bestanden — templates nooit ingevuld |

**Google Ads conversietag:** alleen Boers & Breuer is live —
`AW-18441189967` met drie labels (formulier / telefoon / WhatsApp).
`doesburgboers.nl` heeft het bestand met placeholders.

**Consent Mode v2** is geïmplementeerd (BB): `gtag('consent','default',...)`
gevoed uit `localStorage['cookie-consent']`, plus `url_passthrough` en
`ads_data_redaction`.

### 2.1 Drie tracking-implementaties, drie niveaus

**A. `Boers & Breuer Totaalbouw/site/js/conversions.js` — het volwassenste (~450 regels)**

Events: `cta_click`, `phone_click`, `phone_click_desktop`, `whatsapp_click`,
`form_start`, `generate_lead`, `job_form_start`, `job_application`,
`calculator_start`, `calculator_result`, `faq_expand`, `outbound_click`.

Parameters op elk event: `page_type` (dienst/locatie/blog), `service`, `city`,
`source_page`, en waar relevant `lead_id`, `budget_band`, `cta_label`.

Wat dit bestand al goed doet en wat we hergebruiken in plaats van herbouwen:

- **Click-ID persistentie.** `localStorage['bb_click']` =
  `{id, type, t, src, med, cmp, term}` met 90-dagen TTL, waarbij `type` een van
  `gclid | wbraid | gbraid | msclkid | fbclid` is. Dit is precies het model dat
  we nodig hebben; wij hernoemen het naar `mi_click` en laten de logica staan.
- **gclid en campagne in verborgen formuliervelden** (`#cf-klik-id`,
  `#cf-advertentie`, `#cf-bronpagina`), dus ze komen mee in de Formspree-mail.
- **Eigen `lead_id`** (`l<timestamp><random>` in sessionStorage) als
  ontdubbelsleutel — een refresh van de bedankpagina telt niet dubbel.
- **Enhanced conversions**, consent-gated: e-mail en `e164`-telefoon gaan via
  `gtag('set','user_data')` mee op de bedankpagina en worden daarna gewist.
- **Eén choke point:** alle events lopen via `send()` en `lead()`. Dat is de
  reden dat wij er met ~30 regels een tweede bestemming aan kunnen hangen.
- Zelf posten naar Formspree via `fetch` en daarna redirecten (omdat `_next`
  op het gratis plan niet werkt).

**B. `Rotterdamse Bouwbedrijf B.V/js/tracking.js`**

Events: `contact_phone`, `contact_email`, `contact_whatsapp`, `cta_click`,
`form_start`, `generate_lead`. Parameters: `form_id`, `cta_location`
(fab/footer/header/content), `page_type`, `site_language`. Ontdubbeling op
1,5 seconde. Conversie vuurt op `res.ok` van de fetch, niet op de bedankpagina.
Hardgecodeerde waardes (100/60/40/25 EUR).
Ook hier één choke point: `track()`.
**Mist:** gclid-opslag, `lead_id`, enhanced conversions.

**C. `doesburgboers.nl/site/js/conversions.js`** — minimale variant,
placeholders, vuurt op `/bedankt.html`.

### 2.2 Formulieren

**Alle sites gebruiken Formspree.** 13 verschillende endpoints; `xeevldqj`
komt in 276 bestanden voor. Projecten: Angelo Schilderwerk, AZD, Boers &
Breuer, Cafe Salud, Debetonexpert, doesburgboers, Gimive, nielswebsite, RBB,
Stoba, Veentjer BD, Veentjerbusinesssupport, Verbaacta, Vloerenman, website byl,
YS-Digitalmarketing.

**Gevolg: leads bestaan alleen als e-mail. Er is nergens een lead-database.**

---

## 3. Bestaand dashboard-patroon — `CP\DashboardStef\verbouwgroepnoord-main`

Dit is het belangrijkste hergebruik na de Google Ads-auth: een werkend,
bewezen patroon voor exact deze soort applicatie.

- **Supabase (Postgres)** via `database/connection.py`, SQL-migraties in
  `database/migrations/001_initial.sql` en `002_outlook_afas.sql`.
- **Python sync-services** + `APScheduler` (`main.py`: Teamleader elke 15 min,
  Outlook elke 5 min), gedeployed op **Railway** via Dockerfile.
- **Vercel serverless endpoints** in `dashboard/api/*.js`, inclusief een
  webhook-receiver (`webhook-klippa.js`).
- **Idempotente upserts** via een externe id: `select().eq('teamleader_id', x)`
  → update of insert. Precies het patroon dat wij overal nodig hebben.
- **`services/teamleader.py` (15 KB)** — complete Teamleader Focus OAuth-client
  met token-refresh en `deals.list/info`, `quotations.list/info`,
  `invoices.list`, `contacts.info`, `companies.info`. Dit is een kant-en-klare
  bron voor offers/deals/omzet.
- Schema modelleert al `projects`, `quotations` + `quotation_lines`,
  `invoices`, `receipts` + `receipt_lines`, `categories`, met
  `lifecycle_status`. Goed precedent, maar het is projectadministratie voor één
  klant — niet multi-tenant lead-attributie.
- `services/outlook_scanner.py` — Microsoft Graph inbox-scanner. Herbruikbaar
  als **e-mailparser voor Formspree-mails** bij sites die we niet aanraken.

**Ook aanwezig:** `CP\META` — een Meta Ads API-package (`metaads/api.py`,
`insights.py`, `audit.py`). Relevant als tweede advertentiekanaal in fase 6+.

---

## 4. Beschikbare identifiers vandaag

| Identifier | Waar | Status |
|---|---|---|
| `gclid` / `wbraid` / `gbraid` | BB: localStorage 90 dagen + hidden field | alleen BB |
| `msclkid`, `fbclid` | BB: zelfde opslag | alleen BB |
| `utm_source/medium/campaign/term` | BB: opgeslagen bij de klik | alleen BB |
| Landingspagina | impliciet in `source_page` | deels |
| Eigen `lead_id` | BB sessionStorage | alleen BB |
| E-mail / telefoon | in de Formspree-mail; genormaliseerd naar e164 voor enhanced conversions | wel aanwezig, niet in een database |
| GA4 `client_id` (`_ga`-cookie) | bestaat in de browser | wordt nergens uitgelezen |
| GA4 `session_id` | bestaat in GA4 | niet beschikbaar voor ons |
| Eigen anonieme visitor-id | — | bestaat niet |

---

## 5. Wat er ontbreekt — de echte gaten

1. **Geen lead-database.** Leads zijn e-mails. Zonder database geen
   leadpagina, geen timeline, geen status, geen offers, geen marge.
2. **Geen first-party event-collector.** Alle events gaan uitsluitend naar GA4.
   Zie `02-architectuur.md` §1: de timeline die je wil is uit GA4
   principieel niet te halen.
3. **Geen stabiele anonieme id in ons bezit.** Zonder eigen `visitor_id` kan een
   WhatsApp-klik van vóór het formulier nooit aan de lead worden gehangen.
4. **Geen GA4 Data API-integratie** in welke repo dan ook.
5. **Geen offline conversion upload** naar Google Ads.
6. **Geen klantregistratie**: nergens staat welke klant bij welk domein, welke
   GA4-property, welk Ads customer-id en welk Formspree-endpoint hoort.
7. **Tracking-inconsistentie**: `phone_click` vs `contact_phone`,
   `whatsapp_click` vs `contact_whatsapp`; alleen BB slaat gclid op; alleen BB
   heeft een `lead_id`.
8. **Geen bron voor offers/deals/marge** behalve Teamleader bij VerbouwgroepNoord.
9. **Configuratiefouten**: placeholder-`G-XXXXXXXXXX` in 157 bestanden, twee
   GA4-ID's in het BB-project, één template-ID gedeeld over meerdere sites.
