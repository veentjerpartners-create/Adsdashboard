import { config, periode } from '@/lib/db';
import { scope } from '@/lib/scope';
import { zoekwoorden } from '@/lib/zoekwoorden';

export const dynamic = 'force-dynamic';

/**
 * Dezelfde lijst als de pagina, maar als CSV voor de klant. Puntkomma als
 * scheider en komma als decimaalteken, zodat een Nederlandse Excel hem in
 * een keer goed opent.
 */
export async function GET(req: Request) {
  if (config().ontbreekt.length) return new Response('Niet geconfigureerd', { status: 500 });

  const q = new URL(req.url).searchParams;
  const slug = q.get('klant') || undefined;
  const { start, eind } = periode({ d: q.get('d') ?? 'alles' });
  const sc = await scope(slug);
  const rijen = await zoekwoorden(sc, start, eind);
  const naamVanKlant = new Map(sc.klanten.map((k) => [k.id, k.name]));

  const cel = (v: string | number) => {
    const t = typeof v === 'number' ? String(v).replace('.', ',') : v;
    return /[;"\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const kop = ['Klant', 'Zoekwoord', 'Matchtype', 'Status', 'Campagne', 'Eerste dag',
               'Laatste dag', 'Vertoningen', 'Klikken', 'Conversies', 'Kosten'];
  const status = { aan: 'actief', pauze: 'gepauzeerd', weg: 'verwijderd' } as const;
  const regels = rijen.map((r) => [
    naamVanKlant.get(r.clientId) ?? '', r.tekst, r.match, status[r.status],
    r.campagnes.join(' / '), r.eersteDag, r.laatsteDag,
    r.impr, r.clicks, Math.round(r.conversies * 100) / 100, Math.round(r.kosten * 100) / 100,
  ].map(cel).join(';'));

  const bestand = `zoekwoorden-${sc.actief?.slug ?? 'alle-klanten'}.csv`;
  // BOM zodat Excel de UTF-8 herkent (anders worden de euro's en trema's vreemde tekens).
  return new Response('﻿' + [kop.join(';'), ...regels].join('\r\n'), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${bestand}"`,
    },
  });
}
