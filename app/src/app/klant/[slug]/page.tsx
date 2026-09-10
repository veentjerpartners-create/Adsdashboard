import { notFound } from 'next/navigation';
import { config, periode } from '@/lib/db';
import { scope } from '@/lib/scope';
import { Setup } from '@/components/Setup';
import { Overzicht } from '@/components/Overzicht';

export const dynamic = 'force-dynamic';

type SP = Record<string, string | string[] | undefined>;

/**
 * Eén klant.
 *
 * Nu is dit een afbakening in de query. Zodra klanten zelf inloggen wordt het
 * dezelfde pagina, maar dan met de scope uit hun sessie en gehandhaafd door
 * Row Level Security -- dan kan de URL van een andere klant niets teruggeven.
 */
export default async function KlantPagina({
  params, searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<SP>;
}) {
  const { slug } = await params;
  const sp = await searchParams;

  const cfg = config();
  if (cfg.ontbreekt.length) return <Setup config={cfg} />;

  const s = await scope(slug);
  if (!s.actief) notFound();

  const { dagen, start, eind } = periode(sp);

  return (
    <Overzicht scope={s} dagen={dagen} start={start} eind={eind}
               basisUrl={`/klant/${slug}`} />
  );
}
