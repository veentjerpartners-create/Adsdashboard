/**
 * Herkomst in gewone taal.
 *
 * Bron en medium komen uit de collector (utm's, click-ID of referrer, zie
 * migratie 013). Hier wordt dat één keer vertaald naar wat je in het dashboard
 * leest, zodat "Google Ads" op het overzicht hetzelfde betekent als op de
 * leadpagina en in de factuur die je eruit trekt.
 */

/** Kwam dit bezoek via een betaalde advertentie (Google Ads, Bing, betaald sociaal)? */
export function viaAdvertentie(medium: string | null | undefined): boolean {
  const m = (medium ?? '').toLowerCase();
  return m === 'cpc' || m === 'ppc' || m === 'paid_social';
}

/**
 * Het advertentieplatform: 'google', 'bing' of 'anders' voor een betaalde klik,
 * null voor alles wat geen advertentie was. Bing wordt door de collector als
 * 'bing' opgeslagen; 'microsoft' vangen we op voor het geval iemand zelf tagt.
 */
export function adsPlatform(
  source: string | null | undefined, medium: string | null | undefined,
): 'google' | 'bing' | 'anders' | null {
  if (!viaAdvertentie(medium)) return null;
  const b = (source ?? '').toLowerCase();
  if (b === 'google' || !b) return 'google';
  if (b === 'bing' || b === 'microsoft') return 'bing';
  return 'anders';
}

export const PLATFORM_NAAM = {
  google: 'Google Ads',
  bing: 'Microsoft Ads (Bing)',
} as const;

/** Bron en medium in gewone taal, op één hoop per soort verkeer. */
export function herkomstNaam(source: string | null | undefined, medium: string | null | undefined): string {
  const m = (medium ?? '').toLowerCase();
  const b = (source ?? '').toLowerCase();
  const p = adsPlatform(source, medium);
  if (p === 'google' || p === 'bing') return PLATFORM_NAAM[p];
  if (p === 'anders') return `Advertenties via ${b}`;
  if (m === 'organic') return b === 'google' ? 'Google, onbetaald' : `${b}, onbetaald`;
  if (m === 'ai') return `AI-zoekmachine (${b})`;
  if (m === 'social') return `Sociaal (${b})`;
  if (m === 'referral') return `Verwijzing van ${b}`;
  if (m === 'email') return 'E-mail';
  if (b === 'direct' || (!b && !m)) return b ? 'Rechtstreeks' : 'Onbekend';
  return [b, m].filter(Boolean).join(' / ');
}
