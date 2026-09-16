'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { syncKnop, type KnopStatus } from '@/app/leads/ads-sync-actie';

/**
 * "Update de handel" -- leads met een gclid/gbraid/wbraid die nog niet naar
 * Google Ads zijn gestuurd, alsnog uploaden. Zelfde pad als de Python-cron
 * (ingest.run conversions), dus geen dubbele uploads ongeacht wie 'm draait.
 */
function VerstuurKnop() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="knop" disabled={pending}>
      {pending ? 'Bezig met updaten...' : 'Update Ads-conversies'}
    </button>
  );
}

export function AdsSyncKnop() {
  const [status, actie] = useFormState<KnopStatus, FormData>(syncKnop, null);
  return (
    <form action={actie} className="ads-sync">
      <VerstuurKnop />
      {status && (
        <span className={status.fout ? 'merkje aandacht' : 'stil'}>{status.melding}</span>
      )}
    </form>
  );
}
