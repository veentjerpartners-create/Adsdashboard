'use server';

import { revalidatePath } from 'next/cache';
import { syncAdsConversies, type SyncResultaat } from '@/lib/adsSync';

export type KnopStatus = { melding: string; fout: boolean } | null;

export async function syncKnop(_vorige: KnopStatus, _fd: FormData): Promise<KnopStatus> {
  let resultaat: SyncResultaat;
  try {
    resultaat = await syncAdsConversies();
  } catch (e) {
    return { fout: true, melding: `Mislukt: ${e instanceof Error ? e.message : String(e)}` };
  }

  revalidatePath('/leads');

  if (resultaat.fout) {
    return { fout: true, melding: `Mislukt: ${resultaat.fout}` };
  }

  const totaalUploaded = Object.values(resultaat.perAccount).reduce((n, a) => n + a.uploaded, 0);
  const totaalFailed = Object.values(resultaat.perAccount).reduce((n, a) => n + a.failed, 0);
  const delen = [
    resultaat.wachtrij.nieuw > 0 && `${resultaat.wachtrij.nieuw} nieuw in de wachtrij gezet`,
    totaalUploaded > 0 && `${totaalUploaded} geupload naar Ads`,
    totaalFailed > 0 && `${totaalFailed} afgekeurd (zie conversion_upload.last_error)`,
  ].filter(Boolean);

  return {
    fout: totaalFailed > 0 && totaalUploaded === 0,
    melding: delen.length ? delen.join(', ') + '.' : 'Niets nieuws om te uploaden.',
  };
}
