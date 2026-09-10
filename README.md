# Marketing Intelligence

Centrale data- en intelligence-laag boven de bestaande Google Ads-repo
(`CP\GoogleAds`) en de klantwebsites. Van advertentieklik tot marge, per lead.

Deze repo is verantwoordelijk voor: data-ingestion, het centrale datamodel,
lead-intelligence, attributie, winstgevendheid, het dashboard, het klantportaal
en de terugkoppeling van gewonnen deals naar Google Ads.

Niet verantwoordelijk voor: Google Ads-beheer (blijft `CP\GoogleAds`) en de
websites zelf inclusief hun tracking (blijven de website-repo's).

## Documentatie

Het volledige ontwerp staat in [`docs/`](docs/00-README.md). Begin daar.
Het stappenplan met wie-doet-wat is [`docs/08-stappenplan.md`](docs/08-stappenplan.md).

## Structuur

```
db/migrations/     SQL-migraties, in volgorde draaien
ingest/            Python — nachtelijke sync, draait op Railway
  core/            config, supabase-client, sync_run, retry, upsert
  connectors/      google_ads, ga4, crm, mail
  export/          offline conversies terug naar Google Ads
collect/           het first-party /api/collect endpoint (Vercel function)
app/               Next.js dashboard + klantportaal
web-snippet/       mi-collect.js — naar elke website-repo
docs/              het ontwerp
```

## Database: schema `mi` in het bestaande CMS-project

Deze applicatie deelt het Supabase-project met de CMS. Daarom staat **alles in
het schema `mi`**, niet in `public`. Gevolgen om te weten:

- Elke query en elke client gaat expliciet naar `mi`. In JavaScript:
  `createClient(url, key, { db: { schema: 'mi' } })`. In SQL:
  `SET search_path = mi, public;` bovenaan, of tabellen als `mi.lead` schrijven.
- `mi` moet aan bij **Project Settings → API → Exposed schemas**, anders kan de
  applicatie de tabellen niet lezen.
- `auth.users` is gedeeld met de CMS. Toegang tot dit dashboard is opt-in: wie
  geen rij in `mi.app_user` heeft, krijgt via `mi.visible_clients()` nul rijen.
  Een CMS-redacteur die inlogt ziet dus niets van dit dashboard.
- Wil je het later toch losknippen: `pg_dump -n mi` en je hebt alles.
- Let op de gedeelde opslag: `mi.lead_event` is de tabel die groeit. Bij het
  Free-plan (500 MB voor het hele project, CMS incl.) is dat de eerste die je in
  de gaten houdt.

## Aan de slag

1. `cp .env.example .env.local` en vullen. `.env.local` staat in `.gitignore`.
2. Migraties draaien in Supabase → SQL Editor, in volgorde:
   `001_core.sql`, `002_events_leads.sql`, `003_ads_ga4.sql`,
   `004_sales.sql`, `005_sync.sql`.
   **`006_rls_portal.sql` pas bij fase 4** — de kop van dat bestand legt uit waarom.
3. `mi` toevoegen bij Project Settings → API → Exposed schemas.
4. `pip install -r ingest/requirements.txt`

## Uitgangspunten

- **Nooit `DELETE` bij sync.** Alleen upsert op een natuurlijke sleutel, zodat
  een tweede run onschadelijk is.
- **Google Ads: rolling window van 14 dagen.** Conversies worden dagen later nog
  met terugwerkende kracht bijgeschreven; alleen gisteren ophalen houdt je
  cijfers structureel te laag.
- **`click_view` dagelijks, zonder uitzondering.** Google levert de koppeling
  gclid → campagne maar 90 dagen en maar één dag per query. Een gemiste dag is
  voorgoed weg.
- **GA4 is geen leadbron.** Alleen aggregaten, als cross-check. Waarom dat geen
  keuze maar een beperking is: `docs/02-architectuur.md` §1.
- **Geen PII naar GA4.** Contactgegevens blijven hier. Naar Google Ads gaat
  alleen client-side gehashte e-mail/telefoon, en alleen bij consent.
- **Onbekend is NULL, niet 0.** Een deal zonder marge heeft `gross_margin IS
  NULL` en komt in `v_gaps`, in plaats van als nul mee te tellen.
