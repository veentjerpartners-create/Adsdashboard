/**
 * Klantafbakening.
 *
 * Elke pagina werkt binnen een scope: alle klanten, of één. Nu nog een filter
 * omdat jij de enige gebruiker bent. Zodra klanten zelf inloggen (fase 4) komt
 * de scope uit hun sessie en handhaaft Row Level Security in Postgres hem --
 * dan is het geen filter meer maar een slot.
 *
 * Alle queries lopen hierlangs, zodat er straks maar één plek is die verandert.
 */
import { db } from './db';

export type Klant = {
  id: string;
  name: string;
  slug: string;
  default_margin_pct: number | null;
};

export type Scope = {
  klanten: Klant[];
  actief: Klant | null;
  /** De ads_account-ids binnen de scope; leeg betekent geen beperking. */
  accountIds: string[];
  clientIds: string[];
};

export async function scope(slug?: string): Promise<Scope> {
  const s = db();
  const [{ data: klanten }, { data: accounts }] = await Promise.all([
    s.from('client').select('id,name,slug,default_margin_pct').order('name'),
    s.from('ads_account').select('id,client_id,is_manager'),
  ]);

  const alle = (klanten ?? []) as Klant[];
  const actief = slug ? alle.find((k) => k.slug === slug) ?? null : null;
  const binnen = actief ? [actief.id] : alle.map((k) => k.id);

  const accountIds = (accounts ?? [])
    .filter((a) => !a.is_manager && a.client_id && binnen.includes(a.client_id as string))
    .map((a) => a.id as string);

  return { klanten: alle, actief, accountIds, clientIds: binnen };
}
