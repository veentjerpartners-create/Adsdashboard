# 07 — MVP-roadmap en implementatieplan

## Uitgangspunt

Eén ding vooropgesteld: **de `click_view`-job (gclid → campagne) moet als eerste
live.** Google bewaart die koppeling maar 90 dagen en je kunt hem nooit met
terugwerkende kracht ophalen. Elke week dat die job niet loopt is een week
waarvan je nooit meer weet welke campagne welke lead opleverde. Daarom staat een
kale sync-job vóór het dashboard in de planning, ook al levert hij op dag één
nog geen zichtbaar resultaat.

---

## Fasering

| Fase | Wat er werkt aan het eind | Indicatie |
|---|---|---|
| **0. Fundament** | Repo, Supabase, migraties, Google Ads-sync. Overzicht met echte spend/clicks per klant. Nog geen leads. | ~1 week |
| **1. Collector** | Eigen events + leads uit Boers & Breuer en RBB. `click_view` loopt. Echte timelines in de database. | ~1,5 week |
| **2. Leads-UI** | `/leads` + `/leads/[id]` met timeline, status, matching-audit, handmatige leadinvoer. | ~1,5 week |
| **3. Geld** | Offertes, deals, marge, kostenallocatie, `/attribution`. Winst per lead en per campagne. | ~1,5 week |
| **4. Klantportaal** | RLS, gebruikers, rollen, veldrechten, `/portal`, "bekijk als klant", share links. | ~1,5 week |
| **5. GA4 + kwaliteit** | GA4 Data API als cross-check, freshness-paneel, discrepantierapport. | ~1 week |
| **6. Terugkoppeling** | Offline conversies met marge als waarde terug naar Google Ads. | ~1 week |
| **7. Uitrol** | Overige sites: collector of mailparser. Event-namen gelijktrekken. Config-fouten opruimen. | doorlopend |

Fase 4 kan naar voren als je een klant snel wil laten meekijken. Het enige wat
per se eerder moet: de `client_id`-kolommen en RLS-policies uit fase 0 — die zijn
er dan al, want ze zitten in migratie 001. Tenancy achteraf inbouwen is een
herbouw; daarom staat het van het begin af aan in het schema.

---

## Implementatieplan in kleine stappen

Elke stap is een halve tot hele dag, met een controleerbaar eindresultaat.

### Fase 0 — Fundament

1. **Repo opzetten.** `marketing-intelligence/` met de mappenstructuur uit
   `02-architectuur.md`, `git init`, `.gitignore` (secrets, `google-ads.yaml`,
   `.env`), README.
   *Klaar als:* `pip install -r ingest/requirements.txt` en `npm i` in `app/` werken.
2. **Supabase-project + migratie 001** (toegang, klanten, registratie).
   *Klaar als:* de tabellen staan er en `mi_visible_clients()` werkt.
3. **Migraties 002–005** (events/leads, Ads/GA4, sales, sync-boekhouding).
   *Klaar als:* `event_type` is gevuld met de 21 startwaarden.
4. **`ingest/core`**: config uit env, Supabase-client, `SyncRun`-contextmanager,
   retry-decorator, generieke `upsert()`.
   *Klaar als:* een dummy-connector een `sync_run`-regel wegschrijft.
5. **Google Ads `accounts`-connector** — de query uit `test_connection.py`.
   *Klaar als:* alle accounts onder MCC 9287874539 in `ads_account` staan.
6. **Registratie vullen.** Handmatig (SQL of een simpel scriptje): `client`,
   `website` (domein + GA4-ID's uit `01-inventarisatie.md` §2), koppeling
   `ads_account.client_id`.
   *Klaar als:* elke actieve klant een rij heeft met domein en measurement-id.
7. **`structure`-connector** (campagnes, adgroepen, zoekwoorden).
8. **`metrics`-connector** met rolling 14 dagen + backfill in blokken van 30 dagen.
   *Klaar als:* een SQL-query dezelfde spend per campagne geeft als de Google
   Ads-interface over dezelfde periode. Dit is de eerste harde validatie —
   vergelijk minstens twee accounts en twee periodes.
9. **`clicks`-connector (`click_view`)** + scheduler op Railway.
   *Klaar als:* `ads_click` elke ochtend de gclids van gisteren bevat.
   **Vanaf hier loopt de klok niet meer tegen je.**
10. **Next.js-app + Supabase Auth**, alleen jouw login, één pagina `/` met de
    KPI-rij op Ads-data.
    *Klaar als:* je op één scherm de spend van al je klanten ziet.

### Fase 1 — De collector

11. **`/api/collect`** als Vercel function: validatie, `collector_key`,
    origin-check, rate limit, botfilter, upsert van `visitor` / `visit_session` /
    `lead_event`, dedupe op `event_uid`.
    *Klaar als:* een `curl`-POST een rij in `lead_event` oplevert en een tweede
    identieke POST niet.
12. **`web-snippet/mi-collect.js`**: `visitor_id`, `session_id`, click-ID
    (hergebruik van de `bb_click`-logica), `_ga`-cookie uitlezen, `sendBeacon`.
    *Klaar als:* op een testpagina `session_start` en `page_view` binnenkomen.
13. **Uitrol Boers & Breuer**: het snippet toevoegen, `send()` en `lead()`
    hooken, `MI.lead(...)` bij de submit.
    *Klaar als:* een echte testaanvraag een lead + gestitchte events oplevert
    **en** de Formspree-mail nog steeds normaal aankomt. Dat tweede is de
    belangrijkste check van dit hele project — de bestaande leadstroom mag geen
    seconde risico lopen.
14. **Matching-ladder** L1–L5 + terugwaarts stitchen + `lead_identity`.
    *Klaar als:* een WhatsApp-klik van drie dagen eerder na een formulierinzending
    aan de lead hangt, met een auditregel erbij.
15. **Attributie-resolver**: gclid → `ads_click` → campagne/adgroep/zoekwoord,
    anders utm, anders landingspagina.
    *Klaar als:* een testlead campagne én zoekwoord heeft.
16. **Uitrol RBB** (`rbbTrack` hooken).
17. **Formspree-mailparser** voor één site, als bewijs dat de fallback werkt
    (hergebruik `outlook_scanner.py`).

### Fase 2 — Leads-UI

18. `/leads` met tabel, filters, sortering, zoeken, opgeslagen views, CSV-export.
19. `/leads/[id]` blok 1–3: kop, attributie (met confidence-popover), timeline
    gegroepeerd per sessie.
20. Statusworkflow + `lead_status_history` + interne notities.
21. Handmatige leadinvoer + kandidaat-voorstellen (L6) voor telefonische leads.
22. Wachtrij `needs_review` met bevestigen/afwijzen van een voorgestelde match.

### Fase 3 — Geld

23. `offer` / `offer_line` / `deal` inclusief UI om ze bij een lead te zetten.
24. Teamleader-connector overnemen uit `verbouwgroepnoord-main` (voor de klanten
    die het gebruiken) + matching op e-mail/telefoonhash + wachtrij "offertes
    zonder lead".
25. `ad_cost_allocation` (`per_lead_equal` eerst, `per_click_cost` daarna) +
    `v_lead_economics`.
26. Lead-detail blok 4–5 (offertes/deals en winstgevendheid).
27. `/offers`, `/deals`, `/attribution`.
28. Overview afmaken: funnel, trend, per-klant-tabel, blok "niet-toegewezen
    advertentiekosten".

### Fase 4 — Klantportaal

29. **RLS-policies** op alle tabellen met `client_id` + policies voor de
    interne-only tabellen.
    *Klaar als:* een testgebruiker met toegang tot klant A met een
    handgeschreven query nul rijen van klant B krijgt. Dit test je expliciet,
    niet impliciet.
30. `app_user`, `user_client_access`, `client_portal_settings`, uitnodigingen via
    magic link.
31. `getScope()` + rol-bewuste routing en navigatie.
32. `v_portal_*`-views met `security_invoker` + veldrechten.
33. `/portal`: overzicht, leads, leaddetail, campagnes, verkoop.
34. **"Bekijk als klant"** in Settings + `audit_log` op lezen/exporteren/wijzigen.
35. `report_share` met verlopende read-only links (zonder PII-detail).

### Fase 5 — GA4 en datakwaliteit

36. GA4 Data API-connector (traffic + events, rolling 3 dagen), service account
    op alle properties.
37. Freshness-paneel + connectorstatus in Settings.
38. Discrepantierapport: GA4 `generate_lead` naast onze `form_submit`.
39. Datakwaliteitsblok per klant (leads zonder attributie, deals zonder marge,
    ontbrekende property-ID's).

### Fase 6 — Terugkoppeling naar Google Ads

40. `UPLOAD_CLICKS`-conversieactie aanmaken per account (uitbreiding van
    `bb_conversies.py`), **op secundair**.
41. Exportjob: click-ID-methode, `order_id`, tijdzone-offset uit
    `ads_account.time_zone`, `partial_failure`, consent-filter.
42. Enhanced-conversions-for-leads-methode als terugvaloptie (gehashte e-mail/telefoon).
43. `conversion_upload`-log in de UI + retry-knop.
44. Na een maand data: de conversieactie op biddable zetten en de marge laten
    sturen. Niet eerder.

### Fase 7 — Uitrol en opruimen

45. Collector uitrollen over de overige sites, of mailparser waar dat sneller is.
46. Event-namen gelijktrekken (`contact_phone` → `phone_click`,
    `contact_whatsapp` → `whatsapp_click`) — in de mapping van de collector, niet
    door de sites te herschrijven, zodat de historie in GA4 intact blijft.
47. Configuratiefouten opruimen: 157 bestanden met `G-XXXXXXXXXX`, twee GA4-ID's
    in het BB-project, `G-NE96NK8B6T` gedeeld over meerdere sites.
48. Meta Ads als tweede kanaal (`CP\META` hergebruiken) — zelfde
    `ads_metrics_daily`-model met een `platform`-kolom.

---

## Wat er mis kan gaan, en wat we ertegen doen

| Risico | Maatregel |
|---|---|
| De collector breekt de bestaande leadstroom | `sendBeacon` is niet-blokkerend, de Formspree-`fetch` blijft ongewijzigd en gaat eerst. Uitrol per site, met een echte testaanvraag als acceptatiecriterium. |
| Adblockers blokkeren de collector | First-party endpoint op het klantdomein, geen "analytics"/"track" in de padnaam, geen third-party script. Aandeel meten via het discrepantierapport tegen GA4. |
| gclid-historie loopt weg | `click_view`-job in fase 0, stap 9 — vóór het dashboard. |
| Klant ziet data van een andere klant | RLS in Postgres als tweede laag, expliciete negatieve test (stap 29), portaal-views met alleen toegestane kolommen. |
| Marge-cijfers ontbreken | `margin_source` maakt schatting en werkelijk cijfer onderscheidbaar; klant met `access_level='editor'` vult ze zelf in; "deals zonder marge" is een zichtbare wachtrij. |
| Smart Bidding gaat sturen op verkeerde offline conversies | Conversieactie eerst secundair, minimaal een maand valideren (stap 44). |
| Cijfers wijken af van de Google Ads-interface | Rolling 14-daagse re-fetch, en een expliciete validatiestap (stap 8) tegen twee accounts en twee periodes. |
| Ongekoppelde spend maakt de winst te mooi | Apart blok "niet-toegewezen advertentiekosten", nooit uitsmeren. |

---

## Beslist (9 september 2026)

1. **Formspree staat op het gratis plan.** Geen webhooks, geen submissions-API.
   Gevolgen, uitgewerkt in `05-ingestion.md` §3e:
   - de collector is niet optioneel meer maar het kritieke pad;
   - de mailparser draait op **alle** sites mee als vangnet en controle, niet
     alleen op sites zonder collector;
   - het aantal "mail-only" leads per week is meteen je kwaliteitsmeter voor de
     collector.
   - **Nog nodig van jou:** welke mailbox ontvangt de Formspree-notificaties, en
     is dat Microsoft 365 of Gmail?
2. **Jij voert offertes en deals zelf in.** De eigenaar koppelt de klus terug,
   meestal alleen de orderwaarde. Gevolgen:
   - handmatige invoer is de hoofdweg, dus die moet snel zijn (fase 3 wordt
     belangrijker, Teamleader schuift naar fase 7);
   - `deal.margin_pct` en `client.default_margin_pct` toegevoegd aan het schema,
     zodat een orderwaarde zónder kostprijs alsnog een winstcijfer geeft —
     zichtbaar gemarkeerd als schatting via `margin_source`;
   - het klantportaal hoeft geen invoerfunctie te hebben; `access_level =
     'viewer'` is voor alle klanten genoeg. Dat vereenvoudigt fase 4.
   - **Nog nodig van jou:** per klant een standaard brutomarge­percentage.

## Open vragen — hier heb ik jouw antwoord nog voor nodig

3. **GA4-toegang.** Ik heb per website het **property-ID** nodig (het cijfer, niet
   de `G-`-code) en een service account met Viewer-rechten op elke property.
   Dat moet jij in de Google-interface doen.
5. **Boers & Breuer heeft twee GA4-ID's** — `G-XNK3821MV5` in `site/` en
   `G-JJ0H71JQ4C` in `SITE-DEPLOY/`. Welke is live?
6. **`G-NE96NK8B6T`** staat in de nielswebsite-template en daardoor in meerdere
   klantsites tegelijk. Zijn dat aparte properties die per ongeluk hetzelfde ID
   kregen, of meten die sites echt in één property? Dit vervuilt nu de data van
   die klanten.
7. **Eén Supabase-project voor alle klanten** (multi-tenant met RLS), of per klant
   een aparte database? Mijn advies is nadrukkelijk één project: cross-client
   overzichten zijn dan mogelijk, en RLS + portaal-views geven de scheiding. Per
   klant een database maakt jouw overzichtspagina onmogelijk.
8. **Klantportaal per klant aan of uit** — begin je met één klant als proef?
   Ik zou Boers & Breuer nemen: daar is de tracking het volwassenst en het
   Ads-account is live.
9. **Bewaartermijnen.** 14 maanden voor anonieme events is mijn voorstel (gelijk
   aan GA4). Voor lead-PII: zolang de klantrelatie duurt? Dat wil je per klant
   in de verwerkersovereenkomst vastleggen.
10. **Welke KPI's mag een klant standaard zien?** Mijn voorstel staat in
    `02-architectuur.md` §4 (marge en winst wél, zoektermen niet, interne
    notities nooit) — maar dit is jouw commerciële afweging, niet de mijne.
