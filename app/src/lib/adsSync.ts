/**
 * Offline conversies naar Google Ads — vanuit het dashboard zelf.
 *
 * WAAROM
 * De conversiepixel in de browser komt bij RBB en BB structureel niet aan bij
 * Google (geverifieerd: 503's op googleads.g.doubleclick.net, en een conversie
 * die zelfs geen netwerkverzoek opleverde). We hebben het klik-ID (gclid /
 * gbraid / wbraid) al zelf, server-side, bij elke lead en contactpoging via
 * een advertentie. Dat sturen we terug via de Data Manager API — dat pad
 * hangt niet af van de browser van de bezoeker.
 *
 * Dit is de dashboard-knop-versie van de Python-pipeline in
 * CP\Leaddashboard\ingest\export\conversions.py (die blijft bestaan voor
 * losse runs vanaf de commandline). Beide schrijven naar dezelfde
 * `conversion_upload`-tabel, met hetzelfde order_id-schema ('ev-<lead_event
 * .id>'), dus geen dubbele uploads ongeacht welke van de twee je gebruikt.
 *
 * CONVERSIEACTIES
 * De "... (upload)"-acties (type UPLOAD_CLICKS) bestaan al in beide Ads-
 * accounts; ID's hieronder vast, want de Next.js-app heeft geen Google Ads
 * API-client om ze zelf op te zoeken. Verandert dit ooit (nieuw account,
 * nieuwe actie), dan hier bijwerken.
 */
import { db } from './db';

const MCC_ID = '9287874539';
const TERUGKIJK_DAGEN = 90;
const CLICK_TYPES = ['gclid', 'gbraid', 'wbraid'] as const;

type EventType = 'whatsapp_click' | 'phone_click' | 'form_submit';

const ACTIES: Record<EventType, { leadVereist: boolean }> = {
  whatsapp_click: { leadVereist: false },
  phone_click: { leadVereist: false },
  form_submit: { leadVereist: true },
};

// client_id (mi.client) -> Ads customer_id + conversieactie-ID per event_type
const CLIENT_MAP: Record<string, {
  customerId: string;
  adsAccountId: string;
  acties: Record<EventType, string>;
}> = {
  'f227668c-26dc-4c48-a6a5-1f315467ea85': { // Boers & Breuer Totaalbouw
    customerId: '5442825521',
    adsAccountId: '97a2659b-3db8-4c67-acdb-90baa46551b6',
    acties: {
      form_submit: '7759839567',
      phone_click: '7759764880',
      whatsapp_click: '7759773559',
    },
  },
  'bd1a552a-6452-49cc-bb2e-3d51a91ea8d0': { // Rotterdamse Bouwbedrijf
    customerId: '7779088776',
    adsAccountId: '6e16fbc0-4cd1-4f3f-a414-fc9ef61d360a',
    acties: {
      form_submit: '7759775479',
      phone_click: '7759775473',
      whatsapp_click: '7759774792',
    },
  },
};

function env(...namen: string[]): string | undefined {
  for (const n of namen) {
    const v = process.env[n];
    if (v) return v;
  }
  return undefined;
}

async function datamanagerToken(): Promise<string> {
  const refreshToken = env('DATAMANAGER_REFRESH_TOKEN');
  const clientId = env('GOOGLE_ADS_CLIENT_ID');
  const clientSecret = env('GOOGLE_ADS_CLIENT_SECRET');
  if (!refreshToken || !clientId || !clientSecret) {
    throw new Error(
      'DATAMANAGER_REFRESH_TOKEN, GOOGLE_ADS_CLIENT_ID of GOOGLE_ADS_CLIENT_SECRET ontbreekt in .env.local',
    );
  }
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error(`token ophalen mislukt: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return json.access_token as string;
}

type Kandidaat = {
  id: number;
  client_id: string;
  lead_id: string | null;
  visitor_id: string | null;
  event_type: EventType;
  occurred_at: string;
  click_id: string;
  click_type: 'gclid' | 'gbraid' | 'wbraid';
  metadata: Record<string, unknown> | null;
};

/** Nieuwe conversion_upload-rijen aanmaken voor events die er nog niet in staan. */
async function vulWachtrij(): Promise<{ kandidaten: number; nieuw: number }> {
  const s = db();
  const sinds = new Date(Date.now() - TERUGKIJK_DAGEN * 24 * 3600 * 1000).toISOString();

  const { data: events, error } = await s.from('lead_event')
    .select('id,client_id,lead_id,visitor_id,event_type,occurred_at,click_id,click_type,metadata')
    .in('event_type', Object.keys(ACTIES))
    .in('click_type', CLICK_TYPES as unknown as string[])
    .gte('occurred_at', sinds)
    .order('occurred_at')
    .limit(5000);
  if (error) throw error;
  const kandidaten = (events ?? []) as Kandidaat[];
  if (!kandidaten.length) return { kandidaten: 0, nieuw: 0 };

  const orderIds = kandidaten.map((e) => `ev-${e.id}`);
  const { data: bestaand } = await s.from('conversion_upload')
    .select('order_id').in('order_id', orderIds);
  const al = new Set((bestaand ?? []).map((r) => r.order_id as string));

  const visitorIds = [...new Set(kandidaten.map((e) => e.visitor_id).filter(Boolean))] as string[];
  const { data: bezoekers } = visitorIds.length
    ? await s.from('visitor').select('id,consent_state').in('id', visitorIds)
    : { data: [] as { id: string; consent_state: string | null }[] };
  const consentPerBezoeker = new Map((bezoekers ?? []).map((v) => [v.id, v.consent_state]));

  const nieuw: Record<string, unknown>[] = [];
  for (const e of kandidaten) {
    const orderId = `ev-${e.id}`;
    if (al.has(orderId)) continue;
    const actie = ACTIES[e.event_type];
    if (!actie) continue;
    if (actie.leadVereist && !e.lead_id) continue;
    if ((e.metadata as { bot?: boolean } | null)?.bot) continue;

    const cfg = CLIENT_MAP[e.client_id];
    if (!cfg) continue; // klant zonder Google Ads-koppeling in CLIENT_MAP

    const consent = e.visitor_id ? consentPerBezoeker.get(e.visitor_id) : null;
    const rij: Record<string, unknown> = {
      client_id: e.client_id,
      lead_id: e.lead_id,
      lead_event_id: e.id,
      ads_account_id: cfg.adsAccountId,
      conversion_action_rn: `customers/${cfg.customerId}/conversionActions/${cfg.acties[e.event_type]}`,
      method: 'click_id',
      click_id: e.click_id,
      click_type: e.click_type,
      order_id: orderId,
      conversion_datetime: naarAccountTijd(e.occurred_at),
      currency: 'EUR',
      consent_ad_user_data: consent === 'accepted' ? 'GRANTED' : consent === 'denied' ? 'DENIED' : 'UNKNOWN',
      consent_ad_personalization: consent === 'accepted' ? 'GRANTED' : consent === 'denied' ? 'DENIED' : 'UNKNOWN',
      status: consent === 'denied' ? 'skipped' : 'pending',
    };
    if (consent === 'denied') rij.skip_reason = 'bezoeker weigerde cookies';
    nieuw.push(rij);
  }

  if (nieuw.length) {
    const { error: insertError } = await s.from('conversion_upload').insert(nieuw);
    if (insertError) throw insertError;
  }
  return { kandidaten: kandidaten.length, nieuw: nieuw.length };
}

/** 'yyyy-MM-dd HH:mm:ss+02:00' in Amsterdamse tijd — Google wijst een tijd zonder offset af. */
function naarAccountTijd(iso: string): string {
  const d = new Date(iso);
  const delen = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(d).reduce((acc, p) => ({ ...acc, [p.type]: p.value }), {} as Record<string, string>);
  const lokaal = new Date(`${delen.year}-${delen.month}-${delen.day}T${delen.hour}:${delen.minute}:${delen.second}Z`);
  const offsetMin = Math.round((lokaal.getTime() - d.getTime()) / 60000);
  const teken = offsetMin >= 0 ? '+' : '-';
  const uu = String(Math.floor(Math.abs(offsetMin) / 60)).padStart(2, '0');
  const mm = String(Math.abs(offsetMin) % 60).padStart(2, '0');
  return `${delen.year}-${delen.month}-${delen.day} ${delen.hour}:${delen.minute}:${delen.second}${teken}${uu}:${mm}`;
}

type WachtRij = {
  id: string;
  client_id: string;
  order_id: string;
  click_id: string;
  click_type: string;
  conversion_action_rn: string;
  conversion_datetime: string;
  consent_ad_user_data: string;
  attempts: number;
};

/** Eén batch pending-rijen voor één klant naar de Data Manager API. */
async function uploadBatch(token: string, customerId: string, rijen: WachtRij[], validateOnly: boolean) {
  const acties = [...new Set(rijen.map((r) => r.conversion_action_rn.split('/').pop()!))];
  const ref = new Map(acties.map((a, i) => [a, `d${i}`]));

  const body = {
    destinations: acties.map((a) => ({
      reference: ref.get(a),
      loginAccount: { accountType: 'GOOGLE_ADS', accountId: MCC_ID },
      operatingAccount: { accountType: 'GOOGLE_ADS', accountId: customerId },
      productDestinationId: a,
    })),
    events: rijen.map((r) => ({
      destinationReferences: [ref.get(r.conversion_action_rn.split('/').pop()!)],
      transactionId: r.order_id,
      eventTimestamp: r.conversion_datetime.replace(' ', 'T'),
      eventSource: 'WEB',
      adIdentifiers: { [r.click_type]: r.click_id },
      ...(r.consent_ad_user_data === 'GRANTED' || r.consent_ad_user_data === 'DENIED'
        ? { consent: { adUserData: r.consent_ad_user_data, adPersonalization: r.consent_ad_user_data } }
        : {}),
    })),
    validateOnly,
  };

  const res = await fetch('https://datamanager.googleapis.com/v1/events:ingest', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(json));
  return json as { requestId?: string; fieldWarnings?: unknown[] };
}

export type SyncResultaat = {
  wachtrij: { kandidaten: number; nieuw: number };
  perAccount: Record<string, { pending: number; uploaded: number; failed: number }>;
  fout?: string;
};

/** De hele cyclus: wachtrij vullen, dan alles pending uploaden. Voor de knop in het dashboard. */
export async function syncAdsConversies(): Promise<SyncResultaat> {
  const wachtrij = await vulWachtrij();
  const perAccount: SyncResultaat['perAccount'] = {};

  let token: string;
  try {
    token = await datamanagerToken();
  } catch (e) {
    return { wachtrij, perAccount, fout: e instanceof Error ? e.message : String(e) };
  }

  const s = db();
  for (const cfg of Object.values(CLIENT_MAP)) {
    const { data: rijen, error } = await s.from('conversion_upload')
      .select('id,client_id,order_id,click_id,click_type,conversion_action_rn,conversion_datetime,consent_ad_user_data,attempts')
      .eq('ads_account_id', cfg.adsAccountId).eq('status', 'pending').eq('method', 'click_id')
      .lt('attempts', 5).order('created_at').limit(2000);
    if (error) throw error;
    const klaar = (rijen ?? []) as WachtRij[];
    if (!klaar.length) {
      perAccount[cfg.customerId] = { pending: 0, uploaded: 0, failed: 0 };
      continue;
    }

    let goede = klaar;
    try {
      await uploadBatch(token, cfg.customerId, klaar, true);
    } catch {
      // Eén rij deugt niet; per rij valideren zodat de rest wel doorgaat.
      goede = [];
      for (const r of klaar) {
        try {
          await uploadBatch(token, cfg.customerId, [r], true);
          goede.push(r);
        } catch (e1) {
          await markeer(r, false, e1 instanceof Error ? e1.message : String(e1));
        }
      }
    }

    let geslaagd = 0;
    let mislukt = klaar.length - goede.length;
    if (goede.length) {
      try {
        const resp = await uploadBatch(token, cfg.customerId, goede, false);
        for (const r of goede) {
          await markeer(r, true, null, resp.requestId);
          geslaagd += 1;
        }
      } catch (e) {
        for (const r of goede) await markeer(r, false, e instanceof Error ? e.message : String(e));
        mislukt += goede.length;
      }
    }
    perAccount[cfg.customerId] = { pending: klaar.length, uploaded: geslaagd, failed: mislukt };
  }

  return { wachtrij, perAccount };
}

async function markeer(r: WachtRij, ok: boolean, foutmelding: string | null, requestId?: string) {
  const s = db();
  const velden: Record<string, unknown> = { attempts: r.attempts + 1 };
  if (ok) {
    velden.status = 'uploaded';
    velden.uploaded_at = new Date().toISOString();
    velden.last_error = null;
    velden.google_response = { kanaal: 'data_manager', bron: 'dashboard-knop', request_id: requestId ?? null };
  } else {
    velden.status = 'failed';
    velden.last_error = (foutmelding ?? '?').slice(0, 1000);
  }
  await s.from('conversion_upload').update(velden).eq('id', r.id);
}
