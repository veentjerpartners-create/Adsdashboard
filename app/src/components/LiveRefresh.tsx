'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Ververst de pagina op de achtergrond, zodat een binnenkomende lead vanzelf
 * verschijnt zonder dat iemand op F5 hoeft te drukken.
 *
 * router.refresh() haalt alleen de server component opnieuw op -- geen volle
 * page load, geen scroll-sprong, en de secret key blijft server-side zoals
 * lib/db.ts vereist. Er komt dus geen Supabase Realtime of anon key in de
 * browser bij kijken.
 *
 * Staat stil zodra het tabblad niet zichtbaar is, zodat een vergeten open
 * tabblad niet blijft doorpollen.
 */
export function LiveRefresh({ seconden = 20 }: { seconden?: number }) {
  const router = useRouter();
  const [bijgewerkt, setBijgewerkt] = useState<Date>();

  useEffect(() => {
    setBijgewerkt(new Date());
    const ververs = () => {
      if (document.visibilityState !== 'visible') return;
      router.refresh();
      setBijgewerkt(new Date());
    };
    const id = setInterval(ververs, seconden * 1000);
    document.addEventListener('visibilitychange', ververs);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', ververs);
    };
  }, [router, seconden]);

  return (
    <p className="live">
      <span className="stip aan" aria-hidden="true" />
      live
      {bijgewerkt && (
        <>
          {' '}&middot; bijgewerkt om{' '}
          {bijgewerkt.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
        </>
      )}
    </p>
  );
}
