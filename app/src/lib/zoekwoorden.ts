/**
 * Alle zoekwoorden waar ooit voor betaald is.
 *
 * Dit is de lijst die naar de klant gaat: "hier heeft uw budget aan gehangen".
 * Standaard de hele historie die de backfill heeft opgehaald, en alleen dagen
 * waarop het zoekwoord geld kostte. Een zoekwoord dat alleen vertoond werd,
 * staat er niet in.
 *
 * Een zoekwoord kan in meerdere adgroepen staan (zelfde tekst, zelfde
 * matchtype). Voor de klant is dat één regel; de campagnes worden dan naast
 * elkaar genoemd.
 */
import { db, allesOphalen } from './db';
import type { Scope } from './scope';

export type Zoekwoord = {
  clientId: string;
  tekst: string;
  match: string;
  status: 'aan' | 'pauze' | 'weg';
  campagnes: string[];
  eersteDag: string;
  laatsteDag: string;
  impr: number;
  clicks: number;
  kosten: number;
  conversies: number;
};

function statusVan(s: string | null | undefined): Zoekwoord['status'] {
  if (s === 'ENABLED') return 'aan';
  if (s === 'PAUSED') return 'pauze';
  return 'weg';
}

export async function zoekwoorden(sc: Scope, start = '2000-01-01', eind = '2100-01-01'): Promise<Zoekwoord[]> {
  if (!sc.accountIds.length) return [];
  const s = db();

  const [dagen, keywords, campagnes, accounts] = await Promise.all([
    allesOphalen((van, tot) => s.from('v_keyword_daily')
      .select('ads_account_id,date,campaign_id,ad_group_id,criterion_id,impressions,clicks,cost,conversions')
      .in('ads_account_id', sc.accountIds).gt('cost_micros', 0)
      .gte('date', start).lte('date', eind)
      .order('date').range(van, tot)),
    allesOphalen((van, tot) => s.from('ads_keyword')
      .select('ads_account_id,ad_group_id,criterion_id,text,match_type,status')
      .in('ads_account_id', sc.accountIds).range(van, tot)),
    s.from('ads_campaign').select('ads_account_id,campaign_id,name').in('ads_account_id', sc.accountIds),
    s.from('ads_account').select('id,client_id').in('id', sc.accountIds),
  ]);

  const klantVanAccount = new Map(
    (accounts.data ?? []).map((a) => [a.id as string, a.client_id as string]));
  const campNaam = new Map(
    (campagnes.data ?? []).map((c) => [`${c.ads_account_id}/${c.campaign_id}`, c.name as string]));
  const kw = new Map(keywords.map((k) => [
    `${k.ads_account_id}/${k.ad_group_id}/${k.criterion_id}`, k]));

  const per = new Map<string, Zoekwoord>();
  for (const d of dagen) {
    const k = kw.get(`${d.ads_account_id}/${d.ad_group_id}/${d.criterion_id}`);
    // Zoekwoord dat de structuursync (nog) niet kent: wel de kosten laten
    // zien, anders klopt het totaal niet met wat de klant betaalde.
    const tekst = (k?.text as string) ?? `onbekend zoekwoord ${d.criterion_id}`;
    const match = ((k?.match_type as string) ?? 'onbekend').toLowerCase();
    const clientId = klantVanAccount.get(d.ads_account_id as string) ?? '';
    const sleutel = `${clientId}|${tekst}|${match}`;
    const camp = campNaam.get(`${d.ads_account_id}/${d.campaign_id}`) ?? '—';

    const v = per.get(sleutel) ?? {
      clientId, tekst, match, status: statusVan(k?.status as string),
      campagnes: [], eersteDag: d.date as string, laatsteDag: d.date as string,
      impr: 0, clicks: 0, kosten: 0, conversies: 0,
    };
    if (!v.campagnes.includes(camp)) v.campagnes.push(camp);
    // Eén actieve variant maakt het zoekwoord actief, ook al is een andere
    // adgroep gepauzeerd.
    if (statusVan(k?.status as string) === 'aan') v.status = 'aan';
    if (d.date < v.eersteDag) v.eersteDag = d.date as string;
    if (d.date > v.laatsteDag) v.laatsteDag = d.date as string;
    v.impr += d.impressions ?? 0;
    v.clicks += d.clicks ?? 0;
    v.kosten += Number(d.cost ?? 0);
    v.conversies += Number(d.conversions ?? 0);
    per.set(sleutel, v);
  }

  return [...per.values()].sort((a, b) => b.kosten - a.kosten || b.clicks - a.clicks);
}
