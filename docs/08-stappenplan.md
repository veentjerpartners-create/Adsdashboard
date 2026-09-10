# 08 — Stappenplan: wat er precies moet gebeuren

Twee kolommen door dit hele document: **[JIJ]** is iets dat alleen jij kunt doen
(inloggen, toegang geven, een bedrag noemen). **[IK]** is code die ik schrijf.

Alles staat in de volgorde waarin het moet. Waar iets van jou een blokkade is
voor mij, staat dat erbij.

---

## BLOK A — Wat jij eerst regelt (± 1 uur, blokkeert de rest)

Deze zes dingen kan ik niet voor je doen, en zonder A1 t/m A3 kan ik niets
bouwen.

### A1. Supabase — het bestaande CMS-project · **blokkeert alles**

**Besloten 9 september 2026:** we gebruiken het bestaande **CMS**-project, geen
nieuw project. Ik had een apart project geadviseerd; Stijn kiest voor CMS.

Om dat veilig te doen staat **alles in het schema `mi`** in plaats van in
`public`. Dat vangt de risico's van een gedeeld project op:

| Risico van delen | Wat het schema `mi` ermee doet |
|---|---|
| Naamconflict (CMS heeft ook een tabel `client`) | Weg — `mi.client` en `public.client` bestaan naast elkaar |
| RLS-policies die elkaar in de weg zitten | Weg — onze policies raken alleen `mi.*` |
| Later toch willen scheiden | `pg_dump -n mi` en alles is eruit te halen |
| Gedeelde `auth.users` met 10 CMS-redacteuren | Toegang is opt-in: geen rij in `mi.app_user` → `mi.visible_clients()` geeft nul rijen |

**Twee dingen die blijven om in de gaten te houden:**

1. **Opslag is gedeeld.** Free-plan is 500 MB voor het hele project, CMS
   inbegrepen. `mi.lead_event` is de tabel die groeit. Bij ~20 miljoen events
   partitioneren of naar Pro.
2. **Back-ups zijn projectbreed.** Een restore van de CMS draait dit dashboard
   ook terug. Dat is een reden om `mi` los te dumpen als er echt geld in de
   cijfers zit.

**Wat ik van je nodig heb:** open het CMS-project → **Project Settings → API**
en **→ Database → Connection string → URI**, en zet in
`C:\Users\Stijn\CP\Leaddashboard\.env.local`:

```
SUPABASE_DB_SCHEMA=mi
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...
SUPABASE_DB_URL=postgresql://postgres:WACHTWOORD@db.xxxx.supabase.co:5432/postgres
```

`.env.local` staat in `.gitignore`. De `service_role` key geeft volledige
toegang tot de hele database, inclusief de CMS — die hoort nergens anders dan in
dat bestand en in de Railway/Vercel-omgeving.

**En één instelling:** na het draaien van 001, zet `mi` erbij bij
**Project Settings → API → Exposed schemas** (naast `public`). Zonder dat kan de
applicatie de tabellen niet lezen.

### A2. GA4 service account · blokkeert fase 5, niet eerder

Dit is het meeste klikwerk, dus begin er vroeg aan — maar het houdt de rest niet
tegen.

1. [console.cloud.google.com](https://console.cloud.google.com) → je bestaande
   project `google-ads-tooling` (die heb je al voor de Ads-API).
2. **APIs & Services → Library** → zoek *Google Analytics Data API* → **Enable**.
3. **APIs & Services → Credentials → Create credentials → Service account**.
   Naam: `mi-ga4-reader`. Geen rollen nodig.
4. Klik het service account open → **Keys → Add key → JSON** → download.
   Zet dat bestand in `C:\Users\Stijn\CP\Leaddashboard\secrets\ga4.json`.
5. Kopieer het e-mailadres van het service account (eindigt op
   `.iam.gserviceaccount.com`).
6. Nu per klant in [analytics.google.com](https://analytics.google.com):
   **Admin → Property access management → +** → dat e-mailadres → rol
   **Viewer**. En schrijf tegelijk het **property-ID** op: **Admin → Property
   details**, een getal van 9 cijfers (dus niet de `G-`-code).

**Lever mij aan:** een lijstje `domein → property-ID`. Bijvoorbeeld:

```
boersbreuer.nl        → 123456789
rotterdamsebouwbedrijf.nl → 234567890
```

### A3. Twee GA4-vragen die data vervuilen · **blokkeert de registratie**

- **Boers & Breuer heeft twee measurement-ID's:** `G-XNK3821MV5` in `site/` en
  `G-JJ0H71JQ4C` in `SITE-DEPLOY/`. Welke map staat live op boersbreuer.nl?
  Kijk desnoods in de paginabron van de echte site.
- **`G-NE96NK8B6T`** staat via de nielswebsite-template in meerdere klantsites
  tegelijk. Meten die nu echt allemaal in één GA4-property? Zo ja, dan lopen de
  cijfers van die klanten door elkaar en moet elk een eigen property krijgen.
  Controleer in GA4 → **Admin → Data streams** hoeveel domeinen er onder die
  property hangen.

### A4. De Formspree-mailbox · blokkeert het vangnet (fase 1)

Formspree staat op het gratis plan, dus de notificatiemail is de enige
gegarandeerde bron. Ik moet weten:

- **welke mailbox** de Formspree-notificaties ontvangt;
- of dat **Microsoft 365** is (dan hergebruik ik de bestaande Graph-scanner uit
  `verbouwgroepnoord-main`) of **Gmail** (dan wordt het de Gmail API).

Mijn advies: maak een apart adres, bijvoorbeeld `leads@jouwdomein.nl`, en zet dat
bij elk Formspree-formulier als extra ontvanger. Dan raakt de parser nooit aan
echte klantpost, en je kunt hem zonder zorgen alles laten lezen.

### A5. Standaard brutomarge per klant · blokkeert fase 3

Je krijgt vaak alleen "die klus was € 24.500". Om daar een winstcijfer van te
maken heb ik per klant één percentage nodig, van de eigenaar zelf — niet van mij.

Vraag het zo: *"Wat houd je gemiddeld over aan een klus, voordat je eigen
overhead eraf gaat?"* Bij aannemers is 15–20% gebruikelijk, maar dat verschilt
per bedrijf en per soort werk.

Eén regel per klant is genoeg om te starten:

```
Boers & Breuer          18%
Rotterdamse Bouwbedrijf 15%
```

Weet je het van een klant niet, dan laat ik het veld leeg. Dan zie je bij die
klant omzet en leads, maar geen winst — en een zichtbare melding waarom. Beter
dan een verzonnen getal.

### A6. Vercel-toegang · blokkeert stap 1.2

Ik moet bij de projecten van de websites kunnen om de collector-function toe te
voegen en een environment-variabele te zetten. Jij deployt zelf, of je geeft mij
toegang tot het Vercel-team. Zeg wat je liever hebt; het maakt voor de code niets
uit.

---

## BLOK B — Fase 0: fundament (± 1 week)

Aan het eind van dit blok zie je op één scherm de echte spend van al je klanten.
Nog geen leads.

| # | Wie | Wat | Klaar als |
|---|---|---|---|
| 0.1 | IK | Repo `marketing-intelligence/` opzetten: mappenstructuur, `.gitignore` (secrets, `google-ads.yaml`, `.env`), `requirements.txt`, `package.json`, README | `pip install` en `npm i` werken |
| 0.2 | IK | Migratie 001 — toegang, klanten, registratie (`app_user`, `client`, `website`, `ads_account`, RLS-helpers) | tabellen staan in Supabase, `mi_visible_clients()` werkt |
| 0.3 | IK | Migraties 002–005 — events/leads, Ads/GA4, sales, sync-boekhouding | `event_type` gevuld met de 21 startwaarden |
| 0.4 | IK | `ingest/core`: config uit env, Supabase-client, `SyncRun`-contextmanager, retry met backoff, generieke `upsert()` | een dummy-connector schrijft een `sync_run`-regel weg |
| 0.5 | IK | Google Ads `accounts`-connector (de query uit je `test_connection.py`) | alle accounts onder MCC 9287874539 staan in `ads_account` |
| 0.6 | **JIJ + IK** | **Registratie vullen.** Ik maak een invoerscript; jij zegt per klant: naam, domein, welk Ads-account, welk GA4-property-ID (uit A2), standaard­marge (uit A5) | elke actieve klant heeft een rij met domein en gekoppeld Ads-account |
| 0.7 | IK | `structure`-connector: campagnes, adgroepen, zoekwoorden | de campagnes van je klanten staan in de database |
| 0.8 | IK | `metrics`-connector: rolling 14 dagen + backfill in blokken van 30 dagen | — |
| 0.9 | **JIJ + IK** | **Validatie.** Ik query de spend per campagne uit de database, jij vergelijkt met de Google Ads-interface over dezelfde periode, voor twee accounts en twee periodes | de cijfers kloppen tot op de cent, of we weten waarom niet |
| 0.10 | IK | `clicks`-connector (`click_view`) + APScheduler | — |
| 0.11 | **JIJ** | Railway-project aanmaken, repo koppelen, environment-variabelen zetten (ik lever de lijst) | de scheduler draait en `ads_click` vult elke ochtend |
| 0.12 | IK | Next.js-app + Supabase Auth (alleen jouw login) + pagina `/` met de KPI-rij op Ads-data | je ziet de spend van al je klanten op één scherm |

**Stap 0.9 is niet optioneel.** Als de spend in de database niet exact
overeenkomt met wat Google zegt, is elk cijfer dat we erbovenop bouwen
onbetrouwbaar. Dit is het moment om dat te ontdekken, niet in fase 3.

**Vanaf stap 0.10 loopt de klok niet meer tegen je.** Google bewaart de koppeling
tussen een gclid en zijn campagne maar 90 dagen. Elke dag dat die job niet draait
is een dag die je nooit terugkrijgt.

---

## BLOK C — Fase 1: de collector (± 1,5 week)

Aan het eind heb je echte leads met echte timelines voor Boers & Breuer en
Rotterdamse Bouwbedrijf.

| # | Wie | Wat | Klaar als |
|---|---|---|---|
| 1.1 | IK | `/api/collect`: validatie, `collector_key`, origin-check, rate limit, botfilter, upsert van `visitor`/`visit_session`/`lead_event`, dedupe op `event_uid` | een `curl`-POST geeft een rij; dezelfde POST nog eens geeft er géén tweede |
| 1.2 | **JIJ + IK** | Function deployen op boersbreuer.nl + de Supabase-key als environment-variabele in Vercel zetten | het endpoint antwoordt op het echte domein |
| 1.3 | IK | `mi-collect.js`: `visitor_id`, `session_id`, click-ID (hergebruik van je `bb_click`-logica), `_ga`-cookie uitlezen, `sendBeacon` | op een testpagina komen `session_start` en `page_view` binnen |
| 1.4 | IK | Uitrol Boers & Breuer: snippet toevoegen, `send()` en `lead()` hooken, `MI.lead(...)` bij de submit | — |
| 1.5 | **JIJ** | **Echte testaanvraag doen op boersbreuer.nl.** Vul het formulier in met je eigen gegevens | ① de lead staat in de database mét timeline, **én** ② de Formspree-mail komt normaal aan bij Joeri |
| 1.6 | IK | Matching-ladder L1–L5, terugwaarts stitchen, `lead_identity` | een WhatsApp-klik van 3 dagen eerder hangt na een inzending aan de lead, met auditregel |
| 1.7 | IK | Attributie-resolver: gclid → `ads_click` → campagne/adgroep/zoekwoord | een testlead heeft campagne én zoekwoord |
| 1.8 | IK | Mailparser + reconciliatie (zie A4) | een lead die de collector mist, verschijnt binnen 5 minuten alsnog, gemarkeerd `needs_review` |
| 1.9 | IK | Uitrol Rotterdamse Bouwbedrijf (`rbbTrack` hooken) | — |

**Stap 1.5 punt ② is het belangrijkste acceptatiecriterium van dit hele
project.** De bestaande leadstroom mag geen seconde risico lopen. Daarom is onze
aanroep niet-blokkerend en gaat de Formspree-post ongewijzigd eerst.

Doe die test op een rustig moment en waarschuw Joeri dat er een testaanvraag
aankomt — anders belt hij je eigen testadres na.

---

## BLOK D — Fase 2: de leadpagina (± 1,5 week)

| # | Wie | Wat |
|---|---|---|
| 2.1 | IK | `/leads`: tabel, filters, sortering, zoeken, opgeslagen views, CSV-export |
| 2.2 | IK | `/leads/[id]` blok 1–3: kop, marketing­attributie met confidence-popover, timeline gegroepeerd per sessie |
| 2.3 | IK | Statusworkflow (`new` → `contacted` → `qualified` → `offer_sent` → `won`/`lost`) + historie + interne notities |
| 2.4 | IK | Handmatige leadinvoer voor telefonische leads, met kandidaat-voorstellen uit L6 |
| 2.5 | IK | Wachtrij `needs_review`: onzekere matches en mail-only leads bevestigen of afwijzen |
| 2.6 | **JIJ** | Een week ermee werken en zeggen wat er mist. Dit is jouw dagelijkse scherm, dus jouw oordeel telt hier zwaarder dan mijn ontwerp |

---

## BLOK E — Fase 3: het geld (± 1,5 week)

Dit blok is bij jou belangrijker dan in het oorspronkelijke plan, omdat jij de
offertes en deals zelf invoert.

| # | Wie | Wat |
|---|---|---|
| 3.1 | IK | `offer` en `deal` met **snelle invoer vanaf de leadpagina** — offertebedrag in één veld, "deal gewonnen" met orderwaarde en optioneel margepercentage |
| 3.2 | IK | Margelogica: kostprijs → `actual`; percentage van de eigenaar → `client_input`; niets ingevuld → `client.default_margin_pct` als `estimate`, zichtbaar gemarkeerd |
| 3.3 | IK | `ad_cost_allocation` (`per_lead_equal` eerst) + `v_lead_economics` |
| 3.4 | IK | Lead-detail blok 4–5: offertes/deals en winstgevendheid |
| 3.5 | IK | `/offers`, `/deals` met de twee wachtrijen: "offertes zonder lead" en "gewonnen deals zonder marge" |
| 3.6 | IK | `/attribution`: spend → leads → deals → marge → winst per campagne, adgroep en zoekwoord |
| 3.7 | IK | Overview afmaken: funnel, trend, per-klant-tabel, en het aparte blok "niet-toegewezen advertentiekosten" |
| 3.8 | **JIJ** | De klussen van de afgelopen maanden invoeren waarvan je de cijfers nog hebt. Zonder historie zegt de winstgevendheid nog niets |

---

## BLOK F — Fase 4: het klantportaal (± 1 week)

Korter dan eerst gepland: omdat jij de marge invoert, hoeven klanten alleen te
kijken, niet in te vullen. Dat scheelt een invoer-UI en een hoop rechtencontrole.

| # | Wie | Wat | Klaar als |
|---|---|---|---|
| 4.1 | IK | RLS-policies op alle tabellen met `client_id`, plus policies voor de interne-only tabellen | — |
| 4.2 | IK | **Negatieve test**: een testgebruiker met toegang tot klant A probeert met een handgeschreven query bij klant B | het resultaat is nul rijen. Dit test ik expliciet, niet impliciet |
| 4.3 | IK | `app_user`, `user_client_access`, `client_portal_settings`, uitnodigen via magic link |
| 4.4 | IK | `getScope()` + rol-bewuste routing; `v_portal_*`-views met alleen toegestane kolommen |
| 4.5 | IK | `/portal`: overzicht, leads met timeline, campagnes, offertes & deals |
| 4.6 | IK | "Bekijk als klant"-knop in Settings + audit-log op lezen/exporteren/wijzigen |
| 4.7 | **JIJ** | **Zelf door de "bekijk als klant"-knop kijken** en per klant beslissen: marge zichtbaar of niet, zoekwoorden zichtbaar of niet |
| 4.8 | **JIJ** | Verwerkersovereenkomst opstellen (jij wordt verwerker van zijn leadgegevens). Eén keer maken, per klant ondertekenen — en het is een verkoopargument |
| 4.9 | **JIJ + IK** | Eerste klant uitnodigen. Mijn advies: Boers & Breuer — daar is de tracking het volwassenst en het Ads-account is live |

---

## BLOK G — Fase 5: GA4 en datakwaliteit (± 1 week)

| # | Wie | Wat |
|---|---|---|
| 5.1 | IK | GA4 Data API-connector: traffic + events, rolling 3 dagen (heeft A2 nodig) |
| 5.2 | IK | Freshness-paneel en connectorstatus in Settings |
| 5.3 | IK | Discrepantierapport: GA4's `generate_lead` naast onze `form_submit`, per klant per week |
| 5.4 | IK | Datakwaliteitsblok per klant: leads zonder attributie, deals zonder marge, ontbrekende property-ID's, mail-only leads |

Stap 5.3 is je alarm: wijkt het meer dan ~10% af, dan mist de collector iets of
blokkeert een adblocker meer dan verwacht.

---

## BLOK H — Fase 6: terugkoppeling naar Google Ads (± 1 week)

Hier komt het einddoel binnen: Google laten bieden op marge in plaats van op
formulieren.

| # | Wie | Wat |
|---|---|---|
| 6.1 | IK | `UPLOAD_CLICKS`-conversieactie per account aanmaken (uitbreiding van je `bb_conversies.py`), **op secundair** |
| 6.2 | IK | Exportjob: click-ID-methode, `order_id` voor ontdubbeling, tijdzone-offset uit `ads_account.time_zone`, `partial_failure`, harde consent-filter |
| 6.3 | IK | Enhanced conversions for leads als terugvaloptie voor leads zonder gclid |
| 6.4 | **JIJ** | In Google Ads de customer data terms accepteren en "enhanced conversions for leads" aanzetten — dat kan alleen een accountbeheerder |
| 6.5 | IK | `conversion_upload`-log in de UI met retry-knop |
| 6.6 | **JIJ + IK** | **Een maand wachten.** Cijfers controleren, dan pas de conversieactie op biddable zetten |

Stap 6.6 is bewust traag. Smart Bidding laten sturen op offline conversies die je
nog niet vertrouwt, is de snelste manier om een goed werkende campagne te
verpesten.

---

## BLOK I — Fase 7: uitrol en opruimen (doorlopend)

| # | Wie | Wat |
|---|---|---|
| 7.1 | IK | Collector uitrollen over de overige sites, in volgorde van adverteerbudget |
| 7.2 | IK | Event-namen gelijktrekken in de collector-mapping (`contact_phone` → `phone_click`), **niet** in de sites — zo blijft je GA4-historie intact |
| 7.3 | IK | Configuratiefouten opruimen: 157 bestanden met `G-XXXXXXXXXX`, de dubbele BB-ID's, de gedeelde template-ID |
| 7.4 | IK | Teamleader-connector, als een klant het echt gebruikt |
| 7.5 | IK | Meta Ads als tweede kanaal (`CP\META` hergebruiken) |

---

## Wat je vandaag kunt doen

1. **A1** — Supabase-project aanmaken en de drie keys in `.env.local` zetten.
   Daarna kan ik beginnen.
2. **A3** — uitzoeken welke GA4-ID live staat op boersbreuer.nl, en of die
   template-property meerdere sites meet.
3. **A4** — beslissen welke mailbox de Formspree-mails krijgt.

**A2** (GA4 service account) en **A5** (marge per klant) mag je er ondertussen
bij pakken; die houden mij niet tegen tot fase 3 en 5.

Zodra A1 er is, start ik met stap 0.1.
