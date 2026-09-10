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

const URL = process.env.MI_SUPABASE_URL;
const KEY = process.env.MI_SUPABASE_KEY;
const SCHEMA = process.env.MI_DB_SCHEMA || 'mi';

export function db() {
  if (!URL || !KEY) {
    throw new Error(
      'MI_SUPABASE_URL en MI_SUPABASE_KEY ontbreken. Zet ze in .env.local ' +
      '(lokaal) of bij Environment Variables (Vercel).'
    );
  }
  return createClient(URL, KEY, {
    db: { schema: SCHEMA },
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
