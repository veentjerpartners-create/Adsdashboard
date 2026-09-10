/**
 * POST /api/collect — het first-party event-endpoint.
 *
 * Dit bestand komt in de repo van elke klantwebsite, in een map `api/` naast
 * de site. Vercel maakt daar vanzelf een serverless function van.
 *
 * WAAROM OP HET KLANTDOMEIN EN NIET CENTRAAL
 *  - De bestaande CSP staat `connect-src 'self'` al toe, dus er hoeft niets
 *    aan de beveiligingsheaders te veranderen. Nagekeken in vercel.json van
 *    Boers & Breuer.
 *  - First-party: geen third-party-cookieproblemen, en niet geblokkeerd door
 *    blockers die www.google-analytics.com wel tegenhouden.
 *
 * BEWUST GEEN DEPENDENCIES
 * Geen @supabase/supabase-js, dus geen package.json en geen npm-install in een
 * statische site-repo. Gewone fetch naar PostgREST is genoeg. Alle logica --
 * bezoeker, sessie, event, terugwaarts koppelen -- zit in de databasefunctie
 * mi.collect(), zodat een wijziging daar niet tien sites hoeft te raken.
 *
 * ENVIRONMENT VARIABLES (in Vercel, niet in de code):
 *   MI_SUPABASE_URL   https://xnmbvezjwgbvrjcykuul.supabase.co
 *   MI_SUPABASE_KEY   de secret key -- server-side, komt nooit in de browser
 *   MI_COLLECTOR_KEY  de collector_key van deze website
 *   MI_ALLOWED_ORIGIN bijv. https://boersbreuer.nl
 */

const SUPABASE_URL = process.env.MI_SUPABASE_URL;
const SUPABASE_KEY = process.env.MI_SUPABASE_KEY;
const COLLECTOR_KEY = process.env.MI_COLLECTOR_KEY;
const ALLOWED_ORIGIN = process.env.MI_ALLOWED_ORIGIN || '';

const MAX_BYTES = 8 * 1024;

/** Simpele rate limit per instantie. Vercel draait meerdere instanties, dus dit
 *  is een rem, geen slot -- het echte slot is de validatie hieronder. */
const seen = new Map();
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 120;

function rateLimited(key) {
  const now = Date.now();
  const entry = seen.get(key);
  if (!entry || now - entry.start > WINDOW_MS) {
    seen.set(key, { start: now, count: 1 });
    if (seen.size > 5000) seen.clear();   // geheugen niet laten groeien
    return false;
  }
  entry.count += 1;
  return entry.count > MAX_PER_WINDOW;
}

/** Ziet dit eruit als een bot? Weggooien doen we niet -- dan kun je later niet
 *  verklaren waarom een cijfer afwijkt. We markeren het en filteren in de KPI's. */
function looksLikeBot(ua) {
  return /bot|crawl|spider|slurp|headless|lighthouse|preview|monitor|curl|wget/i
    .test(ua || '');
}

function originOk(req) {
  if (!ALLOWED_ORIGIN) return true;              // niet ingesteld = niet afdwingen
  const origin = req.headers.origin || '';
  if (!origin) return true;                      // sendBeacon stuurt niet altijd Origin
  return origin === ALLOWED_ORIGIN ||
         origin === ALLOWED_ORIGIN.replace('://', '://www.');
}

export default async function handler(req, res) {
  // Alleen POST: persoonsgegevens horen niet in een querystring, want die
  // belandt in access-logs en in de Referer-header.
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN || '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    res.setHeader('Access-Control-Max-Age', '86400');
    return res.status(204).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'alleen_post' });
  }
  if (!SUPABASE_URL || !SUPABASE_KEY || !COLLECTOR_KEY) {
    console.error('collect: environment variables ontbreken');
    return res.status(500).json({ ok: false, error: 'niet_geconfigureerd' });
  }
  if (!originOk(req)) {
    return res.status(403).json({ ok: false, error: 'origin_niet_toegestaan' });
  }

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'onbekend';
  if (rateLimited(ip)) {
    return res.status(429).json({ ok: false, error: 'te_veel_verzoeken' });
  }

  let body = req.body;
  try {
    if (typeof body === 'string') {
      if (body.length > MAX_BYTES) throw new Error('te groot');
      body = JSON.parse(body);
    }
  } catch {
    return res.status(400).json({ ok: false, error: 'ongeldige_json' });
  }
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ ok: false, error: 'lege_body' });
  }

  // De sleutel komt uit de omgeving, niet uit de body. Een bezoeker kan dus
  // geen events voor een andere website insturen.
  body.k = COLLECTOR_KEY;

  if (looksLikeBot(req.headers['user-agent'])) {
    body.meta = Object.assign({}, body.meta, { bot: true });
  }
  if (!body.cty && req.headers['x-vercel-ip-country']) {
    body.cty = req.headers['x-vercel-ip-country'];
  }

  try {
    const upstream = await fetch(`${SUPABASE_URL}/rest/v1/rpc/collect`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Profile': 'mi',          // de functie staat in schema mi
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
      },
      body: JSON.stringify({ p: body }),
    });

    const text = await upstream.text();
    if (!upstream.ok) {
      // Niet doorgeven aan de browser: een databasefout is niets voor een
      // bezoeker, en de melding kan interne namen bevatten.
      console.error('collect: supabase', upstream.status, text.slice(0, 500));
      return res.status(502).json({ ok: false, error: 'opslag_mislukt' });
    }

    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN || '*');
    // 204 zonder body: sendBeacon leest het antwoord toch niet, en zo blijft
    // het zo licht mogelijk voor de bezoeker.
    return res.status(204).end();
  } catch (err) {
    console.error('collect: onverwacht', err);
    return res.status(502).json({ ok: false, error: 'opslag_mislukt' });
  }
}
