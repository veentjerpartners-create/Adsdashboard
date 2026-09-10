import { config, periode } from '@/lib/db';
import { scope } from '@/lib/scope';
import { Setup } from '@/components/Setup';
import { Overzicht } from '@/components/Overzicht';

export const dynamic = 'force-dynamic';

type SP = Record<string, string | string[] | undefined>;

export default async function AlleKlanten({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const cfg = config();
  if (cfg.ontbreekt.length) return <Setup config={cfg} />;

  const { dagen, start, eind } = periode(sp);
  const s = await scope();

  return <Overzicht scope={s} dagen={dagen} start={start} eind={eind} basisUrl="/" />;
}
