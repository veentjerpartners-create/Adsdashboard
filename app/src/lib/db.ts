/**
 * Databasetoegang, uitsluitend server-side.
 *
 * Alles staat in het schema `mi`, want deze database wordt gedeeld met de CMS.
 * De secret key komt nooit in de browser: elke pagina hier is een server
 * component, en de data is al opgehaald voordat de HTML verstuurd wordt.
 *
 * Zodra klanten meekijken (fase 4) gaat dit om naar de sessie van de ingelogde
 * gebruiker, en doet RLS in Postgres het echte werk. Tot die tijd ben jij de
 * enige gebruiker.
 */
import { createClient } from '@supabase/supabase-js';

/**
 * Twee namen per variabele.
 *
 * De MI_-namen horen bij dit dashboard. De kale namen staan in de
 * .env.example van de Python-sync, en Vercel neemt die automatisch over bij
 * het importeren van de repo -- dan is het onnodig dat het dashboard er niet
 * mee overweg kan.
 */
function env(...namen: string[]): string | undefined {
  for (const n of namen) {
    const v = process.env[n];
    if (v) return v;
  }
  return undefined;
}

export type Config = {
  url?: string;
  key?: string;
  schema: string;
  ontbreekt: { naam: string; uitleg: string }[];
};

export function config(): Config {
  const url = env('MI_SUPABASE_URL', 'SUPABASE_URL');
  const key = env('MI_SUPABASE_KEY', 'SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY');
  const schema = env('MI_DB_SCHEMA', 'SUPABASE_DB_SCHEMA') || 'mi';

  const ontbreekt: Config['ontbreekt'] = [];
  if (!url) {
    ontbreekt.push({
      naam: 'MI_SUPABASE_URL',
      uitleg: 'De project-URL, iets als https://xxxx.supabase.co — Supabase → Settings → Data API',
    });
  }
  if (!key) {
    ontbreekt.push({
      naam: 'MI_SUPABASE_KEY',
      uitleg: 'De secret key — Supabase → Settings → API Keys. Nooit de publishable key.',
    });
  }
  return { url, key, schema, ontbreekt };
}

export function db() {
  const c = config();
  if (!c.url || !c.key) {
    // Zou niet mogen gebeuren: elke pagina controleert config() eerst en toont
    // dan een uitleg in plaats van een foutscherm.
    throw new Error(`Ontbrekende configuratie: ${c.ontbreekt.map((o) => o.naam).join(', ')}`);
  }
  return createClient(c.url, c.key, {
    db: { schema: c.schema },
    auth: { persistSession: false },
  });
}

/** Datumbereik uit de URL, met een bruikbare standaard. */
export function periode(sp: Record<string, string | string[] | undefined>) {
  const dagen = Number(Array.isArray(sp.d) ? sp.d[0] : sp.d) || 30;
  const eind = new Date();
  eind.setUTCDate(eind.getUTCDate() - 1);          // gisteren: vandaag is niet af
  const start = new Date(eind);
  start.setUTCDate(start.getUTCDate() - (dagen - 1));
  return {
    dagen,
    start: start.toISOString().slice(0, 10),
    eind: eind.toISOString().slice(0, 10),
  };
}
