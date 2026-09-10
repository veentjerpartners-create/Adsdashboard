# Marketing Intelligence — ontwerpdocumenten

Ontwerp voor een centrale marketing-intelligence-laag boven je bestaande Google
Ads-repo en klantwebsites. Nog geen implementatie: dit is het plan dat op jouw
akkoord wacht.

| Document | Inhoud |
|---|---|
| [01-inventarisatie.md](01-inventarisatie.md) | Wat er al is: Google Ads-repo, tracking per site, bestaand dashboard-patroon, beschikbare identifiers, en de negen echte gaten |
| [02-architectuur.md](02-architectuur.md) | Waarom GA4 de timeline niet kan leveren, repo-indeling, datastromen, en het toegangsmodel (jij in alles, klant alleen in zichzelf) |
| [03-datamodel.md](03-datamodel.md) | Volledig Postgres-schema in vijf migraties, inclusief RLS en portaal-views |
| [04-attributie-matching.md](04-attributie-matching.md) | Identiteitslagen, de matching-ladder L1–L6, terugwaarts stitchen, kostenallocatie, privacy |
| [05-ingestion.md](05-ingestion.md) | Vier connectoren + de terugkoppeling naar Google Ads, met rate limits en valkuilen |
| [06-dashboard.md](06-dashboard.md) | Alle pagina's, de leaddetailpagina in detail, en het klantportaal |
| [07-roadmap.md](07-roadmap.md) | Fasering, 48 implementatiestappen, risico's, en tien open vragen voor jou |

---

## Hoe vers is de data? — per bron

Dit is bewust geen "alles realtime". Elke bron heeft zijn eigen ritme, en dat
ritme wordt bepaald door wat de bron toestaat, niet door wat wij zouden willen.

| Bron | Frequentie | Latency | Live? |
|---|---|---|---|
| **Website-events** (page views, WhatsApp-klikken, telefoonklikken, form start) | continu, per event | **1–3 seconden** | ✅ **live** — `sendBeacon` naar ons eigen endpoint |
| **Leads** (formulierinzending) | continu, per inzending | **1–3 seconden** | ✅ **live** |
| **Lead-timeline** | direct bij elk event; terugwaarts stitchen op het moment van de inzending | seconden | ✅ **live** |
| **Leadstatus, offertes, deals, marge** (handmatig of via portaal) | bij invoer | direct | ✅ **live** |
| **Google Ads: spend, clicks, impressions, conversies** | 1× per nacht, 02:20 | **tot 26 uur** | ❌ dagelijks |
| **Google Ads: gclid → campagne (`click_view`)** | 1× per nacht, 02:40 | tot 26 uur | ❌ dagelijks |
| **Google Ads: campagne/adgroep/zoekwoord-structuur** | 1× per nacht, 02:10 | tot 26 uur | ❌ dagelijks |
| **GA4 aggregaten** (sessions, traffic, kanalen) | 1× per nacht, 03:00 | **24–48 uur** (GA4-data is niet eerder definitief) | ❌ dagelijks |
| **Attributie** (welke campagne bij welke lead) | 1× per nacht, 03:30 — plus direct bij een nieuwe lead als de gclid al bekend is | seconden tot 26 uur | deels live |
| **Kostenallocatie / winst per lead** | 1× per nacht, 03:45 | tot 26 uur | ❌ dagelijks (hangt af van spend) |
| **Teamleader** (offertes, deals, facturen) | elke 15 minuten | ≤ 15 min | bijna live |
| **Formspree-mailparser** (sites zonder collector) | elke 5 minuten | ≤ 5 min | bijna live |
| **Offline conversies terug naar Google Ads** | 1× per nacht, 04:00 | zichtbaar in Ads na enkele uren; effect op bieden na dagen | ❌ dagelijks |

### Waarom Ads en GA4 niet vaker

- **Google Ads kán vaker**, maar het heeft geen zin: conversies en
  conversiewaarden worden dagen later nog met terugwerkende kracht bijgeschreven.
  Daarom halen we elke nacht de **laatste 14 dagen** opnieuw op en overschrijven
  we wat er stond. Vaker dan dagelijks levert alleen API-verbruik op, geen betere
  cijfers. Als je wél intraday spend wil (bijv. een budget-alarm), is een extra
  run om 12:00 en 18:00 op alleen vandaag prima te doen — zeg het en ik zet hem
  erbij.
- **GA4 is 24 tot 48 uur niet definitief.** Wat je vandaag opvraagt over
  gisteren verandert morgen nog. Daarom een rolling window van 3 dagen. Ook
  Google's eigen interface laat je hier niet omheen.

### Wat dat betekent op het scherm

In de header van het dashboard staat altijd letterlijk hoe oud elk cijfer is:

```
Leads: live  ·  Ads: t/m gisteren, gesynct 02:41  ·  GA4: t/m 7 sep  ·  Teamleader: 6 min geleden
```

Dus: **een lead die vanmiddag binnenkomt zie je binnen enkele seconden, met zijn
volledige timeline.** De advertentiekosten van die lead — en dus de winst na
advertentiekosten — staan er de volgende ochtend bij. Dat is geen tekortkoming
van dit systeem maar van de Google Ads API; iedereen die iets anders belooft,
rondt af.

Alle sync-runs worden weggeschreven in `sync_run` en `sync_cursor`, en zijn
zichtbaar in Settings met status, aantal rijen en foutmeldingen. Een mislukte
nacht is dus zichtbaar en met één klik opnieuw te starten — geen stille nullen.
