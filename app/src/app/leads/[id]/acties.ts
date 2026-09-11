'use server';

/**
 * Handmatig koppelen: "die WhatsApp-klik van dinsdag, dat was Herman".
 *
 * Een bezoeker die op zijn telefoon op WhatsApp klikte en drie dagen later
 * op de laptop het formulier invulde, zijn voor de collector twee mensen. De
 * eigenaar weet vaak wél dat het dezelfde was -- hij heeft het gesprek
 * gevoerd. Hier legt hij dat vast, en dan hangt het hele voortraject
 * (advertentieklik, campagne, pagina's) alsnog aan de lead.
 *
 * Dezelfde regels als de automatische stitch in mi.collect(): alleen
 * terugwaarts, nooit over een bestaande koppeling heen, nooit over een
 * klantgrens, niet verder terug dan 90 dagen. En omkeerbaar: lead_identity is
 * de audittrail, en 'ontkoppel' draait het precies terug.
 */
import { revalidatePath } from 'next/cache';
import { db } from '@/lib/db';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const METHODE = 'manual_stitch';

function lees(fd: FormData, naam: string): string {
  const v = fd.get(naam);
  if (typeof v !== 'string' || !UUID.test(v)) throw new Error(`${naam} ontbreekt of is ongeldig`);
  return v;
}

export async function koppelBezoeker(fd: FormData) {
  const leadId = lees(fd, 'lead_id');
  const visitorId = lees(fd, 'visitor_id');
  const s = db();

  const { data: lead } = await s.from('lead').select('id,client_id').eq('id', leadId).maybeSingle();
  if (!lead) throw new Error('lead niet gevonden');

  const sinds = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString();
  await s.from('lead_event')
    .update({ lead_id: leadId })
    .eq('visitor_id', visitorId)
    .eq('client_id', lead.client_id)
    .is('lead_id', null)
    .gte('occurred_at', sinds);

  await s.from('lead_identity').upsert({
    lead_id: leadId, kind: 'visitor_id', value: visitorId,
    confidence: 0.7, method: METHODE,
  }, { onConflict: 'kind,value,lead_id', ignoreDuplicates: true });

  revalidatePath(`/leads/${leadId}`);
  revalidatePath('/contactpogingen');
}

export async function ontkoppelBezoeker(fd: FormData) {
  const leadId = lees(fd, 'lead_id');
  const visitorId = lees(fd, 'visitor_id');
  const s = db();

  // Alleen wat handmatig gekoppeld is mag handmatig los; de automatische
  // stitch op de eigen bezoeker-id blijft staan.
  const { data: ident } = await s.from('lead_identity')
    .select('id').eq('lead_id', leadId).eq('kind', 'visitor_id')
    .eq('value', visitorId).eq('method', METHODE).maybeSingle();
  if (!ident) throw new Error('deze koppeling is niet handmatig gemaakt');

  await s.from('lead_event')
    .update({ lead_id: null })
    .eq('visitor_id', visitorId)
    .eq('lead_id', leadId);
  await s.from('lead_identity').delete().eq('id', ident.id);

  revalidatePath(`/leads/${leadId}`);
  revalidatePath('/contactpogingen');
}
