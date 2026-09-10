# 05 — Ingestion pipeline

## 0. Gedeelde basis voor alle connectoren

Elke connector implementeert dezelfde interface en krijgt gratis:

- **`SyncRun`-contextmanager** — schrijft start/eind/status/rijen/warnings naar
  `sync_run`, en werkt bij succes `sync_cursor` bij. Faalt de job, dan blijft de
  cursor staan zodat de volgende run het gat opnieuw pakt.
- **Retry met exponentiële backoff + jitter** — 5 pogingen op `RESOURCE_EXHAUSTED`,
  `DEADLINE_EXCEEDED`, `INTERNAL`, HTTP 429/5xx. Nooit retryen op
  `AUTHENTICATION_ERROR` of `INVALID_ARGUMENT`: dat is een bug, geen hapering.
- **Idempotente upsert** op de natuurlijke sleutel (`ON CONFLICT … DO UPDATE`).
  Twee keer dezelfde dag ophalen mag nooit dubbele rijen geven.
- **Nooit `DELETE`.** Verdwenen data uit de bron laten we staan; we overschrijven
  alleen.
- **Structured logging** per run met `connector`, `scope`, `rows`, `duration`.
- **Freshness** komt uit `v_data_freshness` en staat in het dashboard.

Scheduler: `APScheduler`, precies het patroon van
`verbouwgroepnoord-main/main.py`. Draait op Railway in één container.

```
02:00  google_ads.accounts        (dagelijks)
02:10  google_ads.structure       (dagelijks)
02:20  google_ads.metrics         (rolling 14 dagen)
02:40  google_ads.clicks          (click_view, gisteren)   ← kritiek
03:00  ga4.traffic + ga4.events   (rolling 3 dagen)
03:30  attribution.resolve        (nieuwe/gewijzigde leads)
03:45  cost_allocation.recompute  (huidige + vorige maand)
04:00  ads_export.offline_conv    (won deals)
04:30  retention.cleanup          (wekelijks, zondag)
*/15   crm.teamleader             (waar geconfigureerd)
*/5    mail.formspree_parser      (fallback-sites)
```

---

## 1. Google Ads connector

**Auth:** hergebruikt `google-ads.yaml` uit de bestaande repo, in productie via
env vars (`GOOGLE_ADS_DEVELOPER_TOKEN` etc.) en
`GoogleAdsClient.load_from_dict()` — zoals `discover_mcc.py` al doet.

### 1a. `accounts` — hergebruik van `test_connection.py`

```sql
SELECT customer_client.id, customer_client.descriptive_name,
       customer_client.currency_code, customer_client.time_zone,
       customer_client.manager, customer_client.status, customer_client.level
FROM customer_client WHERE customer_client.level <= 2
```
op `customer_id = MCC (9287874539)` → upsert in `ads_account`. Nieuwe
klantaccounts verschijnen automatisch; koppelen aan een `client` doe je één keer
handmatig in Settings.

### 1b. `structure` — campagnes, adgroepen, zoekwoorden

Drie GAQL-queries per account op `campaign`, `ad_group`,
`ad_group_criterion` (`WHERE ad_group_criterion.type = 'KEYWORD'`), zonder
`segments.date` (dus geen metrics, alleen dimensies). Upsert op
`(ads_account_id, <id>)`.

### 1c. `metrics` — rolling window van 14 dagen

Uitbreiding van de query in `client_report.py`. Per account, per grein:

```sql
SELECT segments.date, campaign.id, ad_group.id,
       ad_group_criterion.criterion_id,
       metrics.impressions, metrics.clicks, metrics.cost_micros,
       metrics.conversions, metrics.conversions_value,
       metrics.all_conversions, metrics.interactions
FROM keyword_view
WHERE segments.date BETWEEN '{start}' AND '{end}'
```

**Waarom 14 dagen en niet alleen gisteren:** conversies en conversiewaarden
worden bij Google met terugwerkende kracht bijgeschreven (conversion lag,
modelled conversions, de 30-daagse lookback in `bb_conversies.py`). Alleen
gisteren ophalen betekent dat je cijfers van vorige week structureel te laag
blijven. De 14-daagse re-fetch overschrijft simpelweg wat er stond.

**Backfill:** dezelfde code, `mode='backfill'`, in blokken van 30 dagen,
achteruit tot de accountstartdatum. Loopt eenmalig, met dezelfde upsert, dus je
kunt hem zonder risico afbreken en herstarten.

**Rate limits:** developer token met Basic access = 15.000 operations/dag.
Praktisch: `search_stream` in plaats van `search` (één stream per query in plaats
van paginering), maximaal 2 gelijktijdige requests per token, en per account
sequentieel. Bij 10 accounts × 4 query's × 14 dagen zit je ver onder het
plafond. `RESOURCE_EXHAUSTED` → backoff en de volgende nacht opnieuw.

### 1d. `clicks` — `click_view`, elke dag, geen uitstel

```sql
SELECT click_view.gclid, click_view.campaign_location_target,
       click_view.keyword, click_view.keyword_info.text,
       click_view.keyword_info.match_type,
       click_view.ad_group_ad, click_view.area_of_interest.city,
       campaign.id, ad_group.id, segments.date, segments.device,
       segments.ad_network_type
FROM click_view
WHERE segments.date = '{gisteren}'
```

Harde beperkingen van deze resource:
- alleen **één dag per query** (`=`, geen `BETWEEN`);
- alleen de **laatste 90 dagen**;
- niet alle klikken hebben een gclid (PMax, Display, en iOS-klikken die
  `wbraid`/`gbraid` gebruiken komen hier niet of anders terug).

Wat we ermee doen: upsert in `ads_click`. Daarna kan elke lead met een gclid
zijn campagne/adgroep/zoekwoord krijgen — ook maanden later, want wij hebben de
tabel dan wel.

---

## 2. GA4 Data API connector

**Nieuw te bouwen.** `google-analytics-data` (Python). Eén service account,
per property toegevoegd als *Viewer*; `website.ga4_property_id` vullen.

**Twee rapporten per website per dag:**

```python
# traffic
dimensions = [date, sessionSource, sessionMedium, sessionCampaignName,
              landingPagePlusQueryString, deviceCategory]
metrics    = [sessions, engagedSessions, totalUsers, newUsers, keyEvents,
              averageSessionDuration]

# events
dimensions = [date, eventName, sessionSource, sessionMedium, sessionCampaignName]
metrics    = [eventCount, eventValue]
```

**Rolling window van 3 dagen** — GA4-data is 24–48 uur niet definitief.

**Wat we expliciet niet doen:** geen poging tot user-level of event-level
extractie. GA4 is hier de cross-check op traffic en kanaalattributie, precies
zoals jij het zelf omschreef. Waarom het ook niet zou kunnen: zie
`02-architectuur.md` §1.

**Bekende valkuilen die we loggen in `sync_run.warnings`:**
- `(other)`-rij bij te hoge cardinaliteit → we zetten `is_other_row = true` en
  laten in het dashboard zien dat een deel van de traffic niet uitgesplitst kon
  worden. Verzwijgen zou de cijfers onbetrouwbaar maken zonder dat je het merkt.
- Sampling bij grote periodes → we halen per dag op, niet per maand, dus dit
  speelt in de praktijk niet.
- Quota: Standard property = 25.000 tokens/dag/property, 10 gelijktijdige
  requests. Bij 10 sites × 2 rapporten × 3 dagen is dat geen probleem.
- Property niet toegankelijk → `status='failed'` met een duidelijke melding in
  Settings, niet een stille nul.

**Discrepantierapport** (nuttige QA): GA4's `generate_lead`-count per dag naast
ons eigen aantal `form_submit`-events. Wijkt het meer dan ~10% af, dan is er iets
mis met de collector, met een adblocker-aandeel, of met consent. Dat wil je
weten voordat een klant het ziet.

---

## 3. De event-collector — het nieuwe hart

### 3a. Endpoint

`POST https://<klantdomein>/api/collect` — een Vercel serverless function in de
website-repo, of één centrale function met CORS per `collector_key`.

**Voorkeur: op het klantdomein zelf.** Redenen:
- de bestaande CSP staat `connect-src 'self'` al toe → **geen enkele
  CSP-wijziging nodig** (nagekeken in `Boers & Breuer/vercel.json`);
- first-party: geen third-party-cookie-problemen, en niet geblokkeerd door
  tracking-blockers die `google-analytics.com` wél blokkeren;
- de cookie `mi_vid` is `Secure; SameSite=Lax` op het eigen domein.

De function schrijft met de **service-role key** naar Supabase. Die key staat
alleen in de Vercel-omgevingsvariabelen, nooit in de bundel.

### 3b. Payload

```json
{
  "k":   "<collector_key van de website>",
  "vid": "3f2a…",             // visitor_id (uuid)
  "sid": "9c1b…",             // session_id (uuid)
  "uid": "e7d4…",             // event_uid (uuid) -> dedupe_key
  "t":   "whatsapp_click",    // event_type
  "ts":  1757416800000,
  "url": "https://boersbreuer.nl/dakkapel.html",
  "ttl": "Dakkapel plaatsen",
  "pt":  "dienst",
  "ref": "https://www.google.com/",
  "utm": {"source":"google","medium":"cpc","campaign":"daklekkage","term":"daklekkage reparatie"},
  "cid": {"type":"gclid","id":"EAIaIQ…"},
  "gac": "1234567890.1757000000",   // GA4 client_id uit _ga
  "cs":  "accepted",                 // consent state
  "meta": {"cta_location":"fab","service":"dakkapel","city":"waalwijk"},
  "lead": {                          // alleen bij form_submit
    "name":"Jan de Vries","email":"jan@email.nl","phone":"06-12345678",
    "subject":"dakkapel","message":"…","browser_lead_id":"l1757416800123"
  }
}
```

### 3c. De browser-kant: ~40 regels, geen herbouw

`web-snippet/mi-collect.js` doet drie dingen: `visitor_id`/`session_id`
beheren, de payload opbouwen, en `navigator.sendBeacon` afvuren (met een
`fetch(keepalive)`-fallback). Daarna hangen we hem aan het bestaande choke point:

```js
/* Boers & Breuer — in conversions.js, ná de bestaande definities */
var _send = send;
send = function (name, extra) { _send(name, extra); MI.event(name, extra); };
var _lead = lead;
lead = function (ev, label, group, channel, extra) {
  _lead(ev, label, group, channel, extra);
  MI.event(ev, extra);
};
```

```js
/* Rotterdamse Bouwbedrijf — in tracking.js, ná window.rbbTrack = track; */
window.rbbTrack = function (name, params) { track(name, params); MI.event(name, params); };
```

En bij de formulierverzending één extra, **niet-blokkerende** aanroep vlak voor
de bestaande `fetch` naar Formspree:

```js
MI.lead({ name: …, email: …, phone: …, subject: …, browser_lead_id: pending });
```

`MI.lead` gebruikt `sendBeacon`, dus hij kan de Formspree-post niet vertragen of
laten mislukken. **De e-mail naar de klant blijft de bestaande, bewezen weg.**
Onze collector is een extra afslag, geen vervanging. Gaat onze kant stuk, dan
komt de lead nog steeds gewoon binnen.

Extra events die we meteen meenemen omdat ze bijna gratis zijn:
`session_start`, `page_view` (met `page_type`), `scroll_depth` (50%/90%).

### 3d. Beveiliging en betrouwbaarheid van het endpoint

Alles wat een browser stuurt is onbetrouwbaar. Daarom:

- **`collector_key`** identificeert de website (publiek, dat is geen probleem),
  plus **origin-allowlist** tegen misbruik vanaf andere domeinen.
- **Rate limiting** per IP en per `visitor_id` (bijv. 120 events/min).
- **Whitelist-validatie**: `event_type` moet in `event_type` bestaan, anders
  `400`. Onbekende velden worden weggegooid, payload gecapt op 8 KB.
- **Botfilter**: `navigator.webdriver`, bekende bot-UA's, en een honeypotveld in
  het formulier → `ingest_source='collector'` maar `metadata.bot = true`, en
  uitgesloten uit de KPI's. Weggooien is verleidelijk maar dan kun je nooit
  controleren waarom een cijfer afwijkt.
- **Idempotentie**: `event_uid` → `UNIQUE INDEX` op `lead_event.dedupe_key`.
  `sendBeacon` kan dubbel afvuren bij een flakey verbinding; de tweede insert
  botst en wordt genegeerd.
- **Server-side timestamp** naast de client-timestamp (`occurred_at` vs
  `received_at`). Wijkt de clientklok meer dan een uur af, dan gebruiken we
  `received_at` voor de timeline. Anders staan er events in de toekomst.
- **PII alleen over HTTPS naar ons eigen endpoint**, nooit in een querystring
  (dus `POST`, geen `GET` met parameters — die belanden in access-logs).

### 3e. De mailparser — bij een gratis Formspree-plan geen fallback maar vangnet

**Beslist:** Formspree staat op het **gratis plan**. Dat betekent: geen webhooks,
geen submissions-API. De notificatiemail is de enige plek waar Formspree een
lead voor ons neerlegt. Dat heeft twee gevolgen.

**Gevolg 1 — de collector is niet optioneel meer.** Zonder collector is er geen
enkele weg om een lead geautomatiseerd in de database te krijgen behalve die
mail. De collector staat dus op het kritieke pad, niet in de marge.

**Gevolg 2 — de mail wordt onze controle, niet ons alternatief.** De collector
loopt in de browser en kan dus dingen missen: JavaScript uit, een adblocker die
`sendBeacon` blokkeert, een netwerk dat afbreekt tussen de Formspree-post en de
onze. Bij een betaald plan zou je dat met een webhook dichtzetten; dat kan nu
niet. Daarom draait de mailparser op **alle** sites mee, ook die met collector:

```
collector  → rijk maar niet gegarandeerd  (timeline, visitor_id, gclid, sessies)
Formspree-mail → arm maar gegarandeerd    (naam, e-mail, telefoon, onderwerp,
                                            bronpagina, klik-id, advertentie)
```

**Reconciliatie**, elke 5 minuten:

1. Parse de mail → naam, e-mail, telefoon, onderwerp, plus de drie hidden fields
   die er al in zitten: `bronpagina`, `klik-id` (`gclid EAIaIQ…`), `advertentie`
   (`google / cpc / daklekkage`).
2. Zoek een lead van dezelfde website met hetzelfde `email_sha256`, aangemaakt
   binnen 30 minuten rond de maildatum.
3. **Gevonden** → niets doen, behalve `lead.confirmed_by_mail = true` zetten.
   De collector was er eerst en heeft de rijke versie.
4. **Niet gevonden** → maak de lead aan met `ingest_source = 'mail'`. Deze lead
   heeft geen timeline maar wél attributie, want de gclid zat in de mail.
   Markeer hem `needs_review` zodat je ziet dát de collector hem miste.

Die vierde regel is meteen je **kwaliteitsmeter voor de collector**: het aantal
mail-only leads per week is precies het aantal leads dat je zonder de mailparser
kwijt was. Loopt dat op, dan is er iets stuk of blokkeert een adblocker meer dan
verwacht — en dat wil je weten voordat een klant het ziet.

**Wat de mailparser nodig heeft:** één mailbox die alle Formspree-notificaties
ontvangt. Twee opties, jouw keuze:
- de bestaande mailbox waar de notificaties nu al binnenkomen (dan lezen we mee
  met een filter op afzender `no-reply@formspree.io`);
- of een eigen adres dat je bij elk Formspree-formulier als tweede ontvanger
  invult — schoner, want dan raakt de parser nooit aan echte klantpost.

Hergebruik: `verbouwgroepnoord-main/services/outlook_scanner.py` (Microsoft
Graph, elke 5 minuten, met bijhouden welke berichten al verwerkt zijn). Werkt de
mailbox op Gmail in plaats van Microsoft 365, dan is het dezelfde structuur met
de Gmail API of gewoon IMAP.

**Overweging voor later:** zet je Formspree ooit op een betaald plan, dan
vervangt één webhook naar `/api/hooks/formspree` (met HMAC-verificatie) het hele
mailparsen. Tot die tijd is dit de eerlijke oplossing, en hij werkt.

---

## 4. Offers/deals connector

**Beslist: jij voert dit zelf in.** De eigenaar koppelt de klus terug — meestal
alleen de orderwaarde, soms de marge — en jij zet het in het systeem. Dat maakt
de handmatige invoer geen noodoplossing maar **de hoofdweg**, en dat verandert de
prioriteit: die invoer moet snel en prettig zijn, want jij bent degene die het
elke week doet.

**1. Handmatig in de UI (hoofdweg).** Vanaf de leadpagina, zonder navigeren:

- **Offerte toevoegen** — bedrag excl. btw, datum, status. Eén veld en een
  knop.
- **Deal gewonnen** — orderwaarde, en de marge op één van drie manieren:
  kostprijs (als je die hebt) → `margin_source = 'actual'`; marge­percentage dat
  de eigenaar noemde → `client_input`; of niets invullen, dan past het systeem
  `client.default_margin_pct` toe → `estimate`, zichtbaar gemarkeerd.

Dat laatste is de crux van jouw situatie. Je krijgt vaak alleen "die klus was
€ 24.500". Met een standaard­marge per klant wordt dat toch een winstcijfer,
maar het dashboard laat er altijd bij zien dat het een schatting is. Een
geschatte marge die zich voordoet als een hard getal is precies het soort
zelfbedrog dat dit dashboard moet afschaffen.

Praktisch nodig: **per klant één keer een standaard brutomarge afspreken**
(`client.default_margin_pct`). Voor een aannemer is 15–20% op een verbouwing
gebruikelijk, maar dat moet per klant van hem zelf komen, niet van mij.

**2. CSV/Sheet-import** — voor als je een lijst klussen in één keer wil
invoeren, bijvoorbeeld bij het opstarten van een klant met historie. Upload met
kolomherkenning; elke import krijgt een `sync_run`, zodat een verkeerde import
terug te vinden en te herstellen is.

**3. Teamleader Focus** — de client uit `verbouwgroepnoord-main` staat klaar,
maar bouwen we pas als een klant het écht gebruikt. Voor VerbouwgroepNoord is
het er al; voor de rest is het werk zonder opbrengst. Naar fase 7 dus, niet
fase 3.

**Koppelen aan een lead:** e-mail → `email_sha256`, anders telefoon →
`phone_sha256`, anders naam + klant (fuzzy, voorstellen). Wat niet matcht komt in
een wachtrij *"offertes zonder lead"* in de UI — nooit stil laten vallen, want
een niet-gekoppelde deal is een gat in je winstcijfer.

---

## 5. Terugkoppeling naar Google Ads (reverse ingestion)

Het einddoel uit je briefing: niet "42 leads" maar "campagne X leverde 5 klanten
met € 12.600 marge op", en die marge terug in het biedsysteem.

### 5a. Eenmalige voorbereiding per Ads-account

Een nieuwe conversieactie van het type **`UPLOAD_CLICKS`** aanmaken, bijv.
"Deal gewonnen (marge)", categorie `PURCHASE` of `QUALIFIED_LEAD`,
`counting_type = ONE_PER_CLICK`, met `value_settings` die de meegestuurde waarde
gebruikt. `bb_conversies.py` kan al conversieacties aanmaken en labels
teruglezen — dit is een uitbreiding van bestaande, werkende code, geen nieuw
onderzoek.

Belangrijk: zet deze actie eerst op **secundair** (niet biddable). Laat een
maand data binnenkomen, controleer of de aantallen kloppen, en zet hem daarna
pas als biedsignaal aan. Anders laat je Smart Bidding sturen op cijfers die je
nog niet vertrouwt.

### 5b. Nachtelijke exportjob

Voor elke `deal` met `status = 'won'` waarvoor nog geen
`conversion_upload` bestaat:

```
methode A — click_id (voorkeur)
  gclid/wbraid/gbraid bekend en < 90 dagen oud
  → ConversionUploadService.upload_click_conversions
    { gclid, conversion_action, conversion_date_time, conversion_value,
      currency_code, order_id }

methode B — enhanced conversions for leads (als er geen click-ID is)
  → zelfde service, zonder gclid, met user_identifiers:
    { hashed_email: sha256(email_norm) } en/of
    { hashed_phone_number: sha256(e164) }
  Vereist: "Enhanced conversions for leads" aan in het account
  én de customer data terms geaccepteerd.
```

**Wat we als `conversion_value` sturen: de brutomarge, niet de omzet.** Dat is
het hele punt. Google gaat dan bieden op winst in plaats van op omzet of op
formulieren. Je kunt beide naast elkaar uploaden naar twee conversieacties
("Deal omzet" en "Deal marge") en in Ads kiezen welke stuurt.

### 5c. Valkuilen die we in de code afvangen

- **`conversion_date_time` moet een tijdzone-offset hebben** in het formaat
  `yyyy-MM-dd HH:mm:ss+|-HH:mm`, in de tijdzone van het **Ads-account**
  (`ads_account.time_zone`), niet die van je server. Dit is de meest
  voorkomende oorzaak van afgewezen uploads.
- **De conversietijd moet ná de kliktijd liggen** en binnen het
  click-through-lookbackvenster van de conversieactie. Een deal die 6 maanden na
  de klik wordt gewonnen, met een lookback van 30 dagen, wordt geweigerd. We
  zetten het lookbackvenster van de upload-actie daarom op het maximum (90 dagen)
  en markeren oudere deals als `status='skipped'` met reden — zichtbaar, niet
  stil verloren.
- **`order_id`** = onze `lead.public_ref`. Daarmee kan Google dubbele uploads
  ontdubbelen én kun je later een conversie **aanpassen of terugtrekken**
  (`ConversionAdjustmentUploadService`) als een deal terugdraait. Zonder
  `order_id` kan dat niet.
- **`partial_failure = true`** en per rij de fout wegschrijven in
  `conversion_upload.last_error`. Eén foute rij mag de batch niet slopen.
- **Consent meesturen**: het `consent`-veld (`ad_user_data`,
  `ad_personalization`) vullen uit `lead.consent_marketing`. Leads zonder
  consent worden niet geüpload — harde filter.
- **Eventual consistency**: een geüploade conversie is pas na enkele uren
  zichtbaar in Ads en werkt pas na dagen door in het bieden. Niet paniekeren op
  dag één; wel monitoren via `conversions` in `ads_metrics_daily`.
- **Batchgrootte** maximaal 2.000 conversies per request.
