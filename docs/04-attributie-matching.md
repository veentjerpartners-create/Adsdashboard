# 04 — Attributie en lead-matching

## 1. Drie lagen van identiteit

| Laag | Wat | Waar vandaan | Levensduur |
|---|---|---|---|
| **`visitor_id`** | onze eigen pseudonieme bezoeker-id (UUIDv4) | door de browser gegenereerd, in `localStorage['mi_vid']` + first-party cookie `mi_vid` als backup | 180 dagen |
| **`session_id`** | onze eigen sessie | nieuw na 30 min inactiviteit, en altijd bij een nieuwe advertentieklik | sessie |
| **click-ID** | `gclid` / `wbraid` / `gbraid` / `msclkid` / `fbclid` + utm-set | uit de URL bij de klik, opgeslagen zoals BB dat nu al doet | 90 dagen |

Dat derde blok bestaat al: `localStorage['bb_click']` in
`Boers & Breuer/site/js/conversions.js` slaat exact
`{id, type, t, src, med, cmp, term}` op met een 90-dagen-TTL. We hernoemen de
key naar `mi_click` en laten de logica staan. Dit is de kern van "niet opnieuw
bouwen".

### De GA4-brug, twee kanten op, zonder PII

- **GA4 → wij:** we lezen het `_ga`-cookie
  (`GA1.1.<random>.<timestamp>`) en sturen `<random>.<timestamp>` als
  `ga_client_id` mee naar ons eigen endpoint. Daarmee kunnen we onze eigen
  cijfers naast GA4 leggen en verschillen verklaren.
- **Wij → GA4:** we sturen onze `visitor_id` als custom dimension `mi_vid` mee
  naar GA4. Dat is een door ons gegenereerd willekeurig nummer, geen
  persoonsgegeven in de zin van "naam/e-mail/telefoon", dus toegestaan als
  user-scoped custom dimension.

Wat er **nooit** naar GA4 gaat: naam, e-mail, telefoon, adres, offertebedrag met
een naam eraan, of onze `lead_id` gekoppeld aan contactgegevens. Het enige
kanaal waar contactgegevens de deur uit gaan is Google Ads enhanced conversions,
waar de tag ze **client-side SHA-256 hasht** en waar het onderdeel is van het
normale, consented leadproces.

---

## 2. De matching-ladder

Van hard naar zacht. Elke match schrijft een rij in `lead_identity` met
`method` en `confidence`, zodat je in de UI altijd kunt zien *waarom* een event
aan een lead hangt — en het kunt terugdraaien.

| # | Methode | Sleutel | Confidence | Automatisch? |
|---|---|---|---|---|
| **L1** | `exact_lead_id` — het formulier stuurt zelf `visitor_id`, `session_id` en een `event_uid` mee; de lead wordt door onze collector uit die submit gemaakt | `browser_lead_id` | **1.00** | ja |
| **L2** | `visitor_stitch` — alle eerdere events met dezelfde `visitor_id` binnen 90 dagen | `visitor_id` | **0.95** | ja |
| **L3** | `email_match` / `phone_match` — genormaliseerd e-mailadres of `+31…`-telefoonnummer, vergeleken op SHA-256 | `email_sha256`, `phone_sha256` | **0.90** | ja, maar alleen binnen dezelfde `client_id` |
| **L4** | `ga_client_bridge` — zelfde `ga_client_id`, andere `visitor_id` (localStorage gewist, cookie nog aanwezig of omgekeerd) | `ga_client_id` | **0.80** | ja |
| **L5** | `click_id_enrich` — de lead heeft een gclid; join op `ads_click` voor campagne/adgroep/zoekwoord | `click_id` | **0.90 voor de advertentie-attributie** | ja — maar koppelt **nooit** twee leads aan elkaar |
| **L6** | `probable_session` — geen `visitor_id` beschikbaar; zelfde klant, zelfde landingspagina, zelfde utm-set, binnen 30 minuten voor de lead | — | **≤ 0.60** | **nee**: `needs_review = true`, wordt in de UI voorgesteld en handmatig bevestigd |

**L5 is een belangrijk onderscheid.** Een `gclid` identificeert een *klik*, niet
een *persoon*. Twee leads met dezelfde gclid betekent dat één persoon twee
formulieren stuurde óf dat er iets mis is — nooit een reden om twee
lead-records samen te voegen. De gclid gebruiken we uitsluitend om de
campagne/adgroep/zoekwoord van de lead op te halen uit `ads_click`.

**L6 gebruiken we alleen in de overgangsperiode** en voor leads die via de
Formspree-mailparser binnenkomen bij sites waar de collector nog niet staat.
Zodra de collector live is op een site, komt L1/L2 altijd eerst en verdwijnt L6
in de praktijk.

---

## 3. Terugwaarts stitchen — de WhatsApp-klik uit je briefing

Het scenario: iemand klikt op een advertentie, leest twee pagina's, klikt op
WhatsApp (we weten *niet* wie hij is), komt drie dagen later terug en vult het
formulier in (nu weten we het wél).

```sql
-- 1. Bij een form_submit: maak of vind de lead (L1).
-- 2. Hang alle losse events van deze bezoeker eraan:
UPDATE lead_event
   SET lead_id = :lead_id
 WHERE visitor_id = :visitor_id
   AND lead_id IS NULL
   AND client_id = :client_id
   AND occurred_at >= now() - interval '90 days';

-- 3. Leg vast dat en hoe dit gebeurd is:
INSERT INTO lead_identity (lead_id, kind, value, confidence, method)
VALUES (:lead_id, 'visitor_id', :visitor_id, 0.95, 'visitor_stitch')
ON CONFLICT DO NOTHING;
```

Regels die dit veilig houden:

- **Alleen terugwaarts, nooit vooruit over een andere identiteit heen.** Een
  event dat al een `lead_id` heeft wordt nooit overschreven door een stitch.
- **Nooit over `client_id`-grenzen.** Dezelfde persoon die bij twee van jouw
  klanten een offerte aanvraagt zijn twee leads, punt.
- **Venster = de click-ID-TTL (90 dagen).** Ouder dan dat is geen betrouwbare
  attributie meer en Google kent de gclid dan ook niet meer.
- **Omkeerbaar.** `lead_identity` is de audittrail; een verkeerde stitch is één
  `DELETE` + `UPDATE … SET lead_id = NULL` waard.
- **Zichtbaar in de UI.** Events van vóór de identificatie krijgen in de
  timeline het label *"anoniem, achteraf gekoppeld via visitor_id"*. Je ziet dus
  altijd het verschil tussen "dit weten we zeker" en "dit hebben we
  gereconstrueerd".

Voor een lead die via een **telefoongesprek** binnenkomt (geen formulier, geen
`visitor_id`): je maakt hem handmatig aan, en de UI stelt op basis van L6
kandidaten voor — "3 anonieme bezoekers klikten in de afgelopen 2 uur op je
telefoonnummer, was het een van deze?" — met campagne en landingspagina erbij.
Jij of de klant bevestigt. Dat is eerlijker dan automatisch gokken en het maakt
het telefoonkanaal alsnog attribueerbaar.

---

## 4. Attributie van lead naar campagne

Per lead bepalen we in deze volgorde:

1. **`click_id`** aanwezig → join `ads_click` op de gclid → campagne, adgroep,
   zoekwoord, device, match type. Beste bron. `resolved_via = 'click_id'`,
   confidence 0.95.
2. **utm-parameters** aanwezig maar geen gclid (bijv. iOS met `gbraid`, of
   handmatige utm-tagging) → match `utm_campaign` op `ads_campaign.name`.
   `resolved_via = 'utm'`, confidence 0.80. Adgroep en zoekwoord blijven leeg —
   liever leeg dan verzonnen.
3. **Alleen referrer/landingspagina** → kanaalgroep (`google / organic`,
   `direct`, `referral`). `resolved_via = 'landing_page'`, confidence 0.50.
   Deze leads horen niet bij een campagne en mogen de CPL van een campagne dus
   niet vervuilen.
4. **Handmatig** → `resolved_via = 'manual'`, confidence 1.00.

Modellen naast elkaar in `lead_attribution`: `last_click` (standaard, en het
enige model dat Google Ads accepteert bij offline conversies), `first_click`
(interessant bij lange doorlooptijden zoals verbouwingen), `linear` (later).

### Waarom `click_view` dagelijks moet lopen, vanaf dag één

De Google Ads-resource `click_view` levert de gclid → campagne-koppeling, maar:

- hij is **alleen over de laatste 90 dagen** op te vragen;
- je kunt hem **maar één dag per query** opvragen (`segments.date = '…'`, geen
  `BETWEEN`);
- er is geen enkele manier om hem later terug te halen.

Elke dag dat deze job niet loopt is een dag waarvan je nooit meer weet welke
campagne welke lead opleverde. Daarom staat dit in fase 1 van de roadmap en niet
in fase 4, ook al is het dashboard er dan nog niet.

---

## 5. Kostenallocatie: van spend naar winst per lead

Google Ads geeft spend per campagne per dag. Wij willen winst per lead. Twee
methodes, beide in `ad_cost_allocation`:

**`per_click_cost`** (nauwkeurigst, alleen mét gclid): de werkelijke kosten van
de klik zijn niet per gclid opvraagbaar, dus we gebruiken de gemiddelde CPC van
de betreffende adgroep op die dag. Dan is de "kost" van deze lead de som van de
CPC's van alle klikken die deze bezoeker deed.

**`per_lead_equal`** (standaard, altijd toepasbaar): de spend van campagne X in
periode P wordt gelijk verdeeld over alle leads die in periode P aan campagne X
zijn geattribueerd.

```
allocated_cost(lead) = spend(campagne, periode) / aantal_leads(campagne, periode)
profit_after_ads     = gross_margin(deal) - allocated_cost(lead)
```

Belangrijk en eerlijk te vermelden in het dashboard: de niet-geattribueerde
spend (campagnes zonder leads, PMax zonder gclid) wordt **niet** stilletjes over
de rest uitgesmeerd. Die staat apart als *"niet toegewezen advertentiekosten"*.
Anders lijkt elke lead winstgevender dan hij is, en dat is precies het soort
zelfbedrog dat je met dit dashboard wil afschaffen.

---

## 6. Privacy en dataminimalisatie

**Wat waar staat:**

| Data | Onze DB | GA4 | Google Ads |
|---|---|---|---|
| Naam | ✅ | ❌ | ❌ |
| E-mail | ✅ plaintext + SHA-256 | ❌ | alleen SHA-256 (enhanced conversions) |
| Telefoon | ✅ plaintext + e164 + SHA-256 | ❌ | alleen SHA-256 |
| `visitor_id` | ✅ | ✅ als `mi_vid` (pseudonieme custom dimension) | ❌ |
| `gclid` | ✅ | ❌ | ✅ (is van hen) |
| Offertebedrag / marge | ✅ | ❌ | alleen als conversiewaarde, zonder identiteit |
| IP-adres | ❌ niet opgeslagen | geanonimiseerd | ❌ |

**Concrete maatregelen:**

- **Geen fingerprinting.** Geen matching op IP + user-agent + schermformaat.
  Alleen identifiers die de bezoeker via consent/cookies bij zich draagt of
  zelf heeft ingevuld.
- **Consent leidt.** `visitor.consent_state` volgt de bestaande
  `localStorage['cookie-consent']`. Zonder consent: de collector ontvangt het
  event mét `visitor_id` (noodzakelijk voor de dienst die de klant zelf
  aanvraagt en voor fraudepreventie) maar **zonder** doorzetten naar Google en
  **zonder** enhanced-conversion-gegevens. Een lead zonder
  `consent_marketing = true` wordt **nooit** als offline conversie geüpload —
  dat is een harde `WHERE`-clausule in de exportjob, geen instelling.
- **Bewaartermijn.** `lead_event` van bezoekers die nooit lead werden: 14
  maanden, dan verwijderen (matcht de GA4-standaard). Lead-PII: zolang de
  klantrelatie duurt, daarna volgens de afspraak met die klant. Nachtelijke
  `retention`-job, met een `sync_run`-regel zodat het aantoonbaar gebeurt.
- **Recht op verwijdering.** Één functie `mi_erase_lead(lead_id)` die PII wist
  (`name`, `email`, `phone` → NULL, hashes → NULL), de events anonimiseert
  (`lead_id` → NULL) en `deleted_at` zet — maar de geaggregeerde cijfers intact
  laat, zodat een AVG-verzoek je rapportage niet omgooit.
- **`email_norm` en de hashes** worden alleen gebruikt voor matching en voor
  enhanced conversions. Ze staan niet in de portaal-views.
- **Verwerkersovereenkomst per klant** — jij bent verwerker van de
  leadgegevens, de klant is verwerkingsverantwoordelijke. Zie
  `02-architectuur.md` §4.
