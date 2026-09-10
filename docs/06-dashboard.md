# 06 — Dashboardstructuur

**Stack:** Next.js (App Router) + TypeScript + Tailwind op Vercel, Supabase
(Postgres + Auth), data-access uitsluitend server-side.

Waarom niet Streamlit (staat in de oude `requirements.txt`): prima voor een
grafiek, ongeschikt voor een leaddetailpagina met bewerkbare status, deep links,
klantlogin en RLS. Waarom Next.js: je sites staan al op Vercel, de collector is
daar een serverless function, en rolgebaseerde server-side rendering is precies
wat een klantportaal nodig heeft.

---

## 1. Eén app, twee gezichten

Alle data-access loopt via één server-side functie:

```ts
// Geen enkele query in de app zonder dit.
const scope = await getScope();
// → { role, clientIds, activeClientId, fields: { showMargin, showKeywords, ... } }
```

- **Intern** (`owner` / `agency`): `/`, `/clients`, `/campaigns`, `/leads`,
  `/offers`, `/deals`, `/attribution`, `/settings`. Klantselector in de header,
  cross-client overzichten.
- **Portaal** (`client`): `/portal`, `/portal/leads`, `/portal/leads/[id]`,
  `/portal/campaigns`, `/portal/sales`. Geen klantselector (of alleen de eigen
  BV's), logo en accentkleur uit `client_portal_settings`, versimpelde
  navigatie. Leest uitsluitend uit `v_portal_*`-views.

RLS in Postgres is de tweede laag: ook bij een bug in `getScope()` geeft de
database nul rijen van een andere klant. Zie `02-architectuur.md` §4.

---

## 2. Overview `/`

**KPI-rij** (elke tegel met vergelijking t.o.v. de vorige periode):

Spend · Leads · CPL · Qualified leads · Offers · Offer value · Deals ·
Revenue · Gross margin · Ad cost · **Profit after advertising** · ROAS ·
Margin / spend

**Funnel** — één horizontale balk, van links naar rechts smaller:
Impressions → Clicks → Sessions → Leads → Qualified → Offers → Deals.
Bij elke stap het conversiepercentage en de drop-off. Dit is de visualisatie die
je vraag "wat gebeurt er tussen klik en omzet" in één oogopslag beantwoordt.

**Trend** — spend en leads op één as, CPL als lijn, per dag/week/maand.

**Per klant** — tabel met dezelfde kolommen als de KPI-rij, sorteerbaar op
winst. Dit is jouw belangrijkste werkscherm: welke klant kost je geld en welke
verdient.

**Niet-toegewezen** — een expliciet blok met spend die aan geen enkele lead
gekoppeld kon worden, met de reden (PMax zonder gclid, campagne zonder leads,
collector nog niet live). Anders lijkt alles winstgevender dan het is.

**Filters** (als URL-searchparams, zodat een view te bookmarken en te delen is):
periode (met presets + vergelijkingsperiode), klant, website, Google Ads-account,
campagne, source/medium, lead-status, lead-type.

---

## 3. Clients `/clients` en `/clients/[id]`

Overzicht: naam, status, spend, leads, CPL, deals, omzet, marge, winst,
data-versheid, portaal aan/uit.

Detail: KPI's + funnel voor deze klant, campagnetabel, recente leads,
websites met hun GA4-property en collector-status, en een **datakwaliteitsblok**
(laatste sync per connector, ontbrekende `ga4_property_id`, leads zonder
attributie, offertes zonder lead).

---

## 4. Campaigns `/campaigns` en `/campaigns/[id]`

Overzicht: campagne, klant, status, kanaaltype, impressions, clicks, CTR, CPC,
spend, **leads**, CPL, qualified, offers, deals, omzet, marge, winst, ROAS.

Detail: dagelijkse metrics, adgroepen, zoekwoorden (met leads en marge per
zoekwoord — daar zit het geld), en **de leads die uit deze campagne kwamen** als
klikbare lijst. Die join is precies wat je nu niet hebt.

---

## 5. Leads `/leads`

Kolommen: datum · ref (#1842) · naam · klant · website · lead type · source ·
campagne · status · offertewaarde · marge · winst · confidence-badge.

- Sorteerbaar op elke kolom, filters uit de header, full-text zoeken op
  naam/e-mail/telefoon.
- **Opgeslagen views** ("nieuwe leads deze week", "qualified zonder offerte",
  "won zonder marge ingevuld").
- Snelle statuswijziging inline, zonder de pagina te verlaten.
- CSV-export (met een `audit_log`-regel — bij klantgebruikers wil je weten wie
  wat exporteert).
- Rijen zijn volledig klikbaar en met het toetsenbord te doorlopen.

---

## 6. Lead detail `/leads/[id]` — het hart van de applicatie

**Blok 1 — Kop**
Naam, e-mail, telefoon (klik-om-te-bellen / WhatsApp), status als dropdown met
historie, klant, website, aanmaakdatum, lead-type, eigenaar.

**Blok 2 — Marketing attributie**
Source · medium · campagne · adgroep · zoekwoord · click-ID (afgekort, met
copy) · utm_source/medium/campaign/term · landingspagina · device · eerste
bezoek · aantal sessies voor conversie · tijd tussen eerste klik en lead.
Plus een **confidence-badge** met een popover *"hoe weten we dit"*: de methode
uit `lead_identity` (bijv. "gclid gematcht op click_view, 0.95"). Alleen intern
zichtbaar — een klant hoeft de matching-diagnostiek niet te zien.

**Blok 3 — Timeline**
Verticale tijdlijn, gegroepeerd per sessie, met per sessie een kop
(datum, bron/campagne, landingspagina, duur, aantal events). Per event:
icoon uit `event_type.icon`, label, tijdstip, pagina, en de relevante metadata
uitgeklapt (`cta_location`, `service`, `city`, `budget_band`).

Precies het voorbeeld uit je briefing:

```
┌ Sessie 1 · 3 sep 14:02 · Google Ads / daklekkage · /daklekkage/
│  14:02  Google Ads klik      gclid EAIaIQ… · zoekwoord "daklekkage reparatie"
│  14:02  Landingspagina       /daklekkage/
│  14:04  Paginaweergave       /dakrenovatie.html
│  14:06  WhatsApp-klik        fab                    ← anoniem, achteraf gekoppeld
└
┌ Sessie 2 · 6 sep 09:41 · direct
│  09:41  Paginaweergave       /contact.html
│  09:42  Formulier gestart
│  09:44  Formulier verstuurd  → lead #1842 aangemaakt
└
┌ Verkoop
│  7 sep   Offerte opgesteld   € 24.500
│  9 sep   Offerte verstuurd
│  18 sep  Offerte getekend    → deal gewonnen · marge € 4.410
└
```

Events van vóór de identificatie krijgen zichtbaar het label *"anoniem,
achteraf gekoppeld via visitor_id"*. Je ziet altijd wat feit is en wat
reconstructie is.

**Blok 4 — Offertes en deals**
Per offerte: bedrag, status, datum verstuurd, geldig tot, getekend op, marge.
Toevoegen/bewerken inline. Deal: omzet, kosten, brutomarge, `margin_source`
(werkelijk / schatting / opgave klant) — dat laatste veld is belangrijk, zodat
een geschatte marge nooit als hard cijfer wordt gelezen.

**Blok 5 — Winstgevendheid**
Toegewezen advertentiekosten · omzet · brutomarge · **winst na
advertentiekosten** · ROAS voor deze lead, met de allocatiemethode benoemd
(`per_lead_equal` / `per_click_cost`), zodat het cijfer navolgbaar is.

**Blok 6 — Notities en activiteit**
Interne notities (nooit in het portaal) + statushistorie + wie wat wanneer wijzigde.

---

## 7. Offers `/offers` en Deals `/deals`

Pipelines met bedragen, ouderdom, conversieratio's (offerte → getekend),
gemiddelde doorlooptijd, en een wachtrij **"offertes zonder lead"** en
**"gewonnen deals zonder marge"** — de twee gaten die je winstcijfer stilletjes
vervuilen.

---

## 8. Attribution / profitability `/attribution`

De volledige keten per campagne, adgroep en zoekwoord:

```
spend → clicks → sessions → leads → qualified → offers → deals
      → revenue → gross margin → profit after advertising
```

Plus: cost per qualified lead, cost per deal, marge per euro advertentiegeld,
en een lijst *"zoekwoorden die leads leveren maar geen marge"* — de meest
bruikbare optimalisatielijst die je uit dit systeem kunt halen, en de reden dat
we de marge als conversiewaarde terugsturen naar Google.

Modelvergelijking: last click naast first click, zodat je bij lange
doorlooptijden (verbouwingen) ziet of je merk- of generieke campagnes onderwaardeert.

---

## 9. Settings `/settings` — alleen `owner`

- **Klanten & websites**: domein, GA4-property-id, measurement-id, Ads
  customer-id, Formspree-endpoint, collector-key en -status.
- **Gebruikers**: uitnodigen, rol, per klant toegang, `access_level`.
- **Portaal per klant**: de schakelaars uit `client_portal_settings`
  (marge/winst/zoekwoorden/contactgegevens aan of uit), logo, accentkleur, plus
  een **"bekijk als klant"**-knop. Die knop is essentieel: je wil met eigen ogen
  zien wat een klant ziet voordat je hem uitnodigt.
- **Event types**: de registratietabel beheren — nieuw event = één regel, geen
  migratie, geen deploy.
- **Connectoren**: status, laatste run, freshness, foutmeldingen, handmatige
  backfill starten.
- **Conversion uploads**: log met status, waarde, foutmeldingen, opnieuw proberen.
- **Share links**: aanmaken, intrekken, aantal keer bekeken.

---

## 10. Klantportaal `/portal`

Wat de klant ziet (standaard, per klant bij te stellen):

- **Overzicht**: spend, leads, CPL, offertes, deals, omzet, marge, winst na
  advertentiekosten, ROAS — plus de funnel en de trend. Geen andere klanten,
  geen benchmarks, geen fee.
- **Leads**: zijn eigen leads met contactgegevens en timeline. Als
  `access_level = 'editor'`: status bijwerken en offertebedrag/marge invullen.
  Dat is meteen de goedkoopste manier om aan echte margecijfers te komen — de
  klant vult ze zelf in omdat hij er zelf een dashboard voor terugkrijgt.
- **Campagnes**: campagne, spend, clicks, leads, CPL, deals, marge. Zoekwoorden
  alleen als `show_keywords` aan staat.
- **Offertes & deals**: zijn eigen pipeline.

Wat de klant nooit ziet: andere klanten, interne notities,
matching-diagnostiek, `click_id`, sync-logs, instellingen, jouw fee, en de
tabellen zonder `client_id` (`ads_metrics_daily`, `ads_click`, `audit_log`).

---

## 11. Vormgeving en gedrag

- Getallen rechts uitgelijnd, tabular figures, EUR met duizendtalscheiding.
  Negatieve winst in rood, en niet alleen in rood — ook met een teken, voor
  kleurenblindheid.
- **Elke KPI-tegel is doorklikbaar** naar de onderliggende rijen. Een cijfer dat
  je niet kunt uitpluizen ga je niet vertrouwen.
- **Lege staten met een reden**: niet "geen data" maar "de collector staat nog
  niet op deze site" of "GA4-property-id ontbreekt in Settings" — met een link
  naar de plek waar je het oplost.
- **Freshness zichtbaar** in de header: "Ads t/m gisteren 02:41 · GA4 t/m
  2 dagen · leads live".
- Datumbereik en filters in de URL, dus deelbaar en te bookmarken.
