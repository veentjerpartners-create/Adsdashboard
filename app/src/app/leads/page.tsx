import { config, db } from '@/lib/db';
import { scope } from '@/lib/scope';
import { tijdstip } from '@/lib/format';
import { adsPlatform, herkomstNaam } from '@/lib/herkomst';
import { Setup } from '@/components/Setup';

export const dynamic = 'force-dynamic';

type SP = Record<string, string | string[] | undefined>;

const STATUS = [
  { code: 'new', naam: 'nieuw' },
  { code: 'contacted', naam: 'gebeld' },
  { code: 'qualified', naam: 'gekwalificeerd' },
  { code: 'offer_sent', naam: 'offerte uit' },
  { code: 'won', naam: 'gewonnen' },
  { code: 'lost', naam: 'verloren' },
];

// Waar de lead vandaan kwam. Dit is het filter waarmee je per klant en per
// platform de leads eruit trekt om ze te factureren: "8 leads via Bing in
// augustus" moet in één klik te zien zijn.
const VIA = [
  { code: 'ads', naam: 'via advertenties' },
  { code: 'google', naam: 'Google Ads' },
  { code: 'bing', naam: 'Bing' },
  { code: 'gratis', naam: 'niet via advertenties' },
];
const ADS_MEDIA = ['cpc', 'ppc', 'paid_social'];

const PERIODES = [
  { d: 7, naam: '7 dagen' },
  { d: 30, naam: '30 dagen' },
  { d: 90, naam: '90 dagen' },
];

/** Eerste dag van de periode als ISO-datum, in Amsterdamse tijd. */
function vanaf(dagen: number): string {
  const nu = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Amsterdam' }));
  const d = new Date(Date.UTC(nu.getFullYear(), nu.getMonth(), nu.getDate()));
  d.setUTCDate(d.getUTCDate() - (dagen - 1));
  return d.toISOString().slice(0, 10);
}

export default async function Leads({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const cfg = config();
  if (cfg.ontbreekt.length) return <Setup config={cfg} />;

  const een = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || '';
  const gekozen = een(sp.status);
  const klantSlug = een(sp.klant);
  const via = VIA.some((v) => v.code === een(sp.via)) ? een(sp.via) : '';
  const dagen = PERIODES.some((p) => p.d === Number(een(sp.d))) ? Number(een(sp.d)) : 0;
  const s = db();
  const sc = await scope(klantSlug || undefined);

  let q = s.from('lead')
    .select('id,public_ref,name,email,phone,client_id,website_id,created_at,status,lead_type,source,medium,campaign,keyword,needs_review,subject,city')
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(200);
  if (gekozen) q = q.eq('status', gekozen);
  if (sc.actief) q = q.eq('client_id', sc.actief.id);
  if (dagen) q = q.gte('created_at', `${vanaf(dagen)}T00:00:00Z`);
  // Zelfde indeling als adsPlatform() in lib/herkomst, maar dan in de query,
  // zodat de limiet van 200 pas na het filter geldt.
  if (via === 'ads') q = q.in('medium', ADS_MEDIA);
  if (via === 'google') q = q.in('medium', ADS_MEDIA).eq('source', 'google');
  if (via === 'bing') q = q.in('medium', ADS_MEDIA).in('source', ['bing', 'microsoft']);
  if (via === 'gratis') q = q.not('medium', 'in', `(${ADS_MEDIA.join(',')})`);

  // Of de collector draait leiden we af uit de data, niet uit een vinkje dat
  // iemand met de hand moet zetten -- zo'n vinkje veroudert gegarandeerd, en
  // dat gebeurde ook: het stond nog op "niet live" terwijl er al events
  // binnenkwamen.
  let eq = s.from('lead_event').select('id', { count: 'exact', head: true });
  if (sc.actief) eq = eq.eq('client_id', sc.actief.id);

  const [leads, sites, events] = await Promise.all([
    q,
    s.from('website').select('id,domain,collector_live_since'),
    eq,
  ]);

  const klantNaam = new Map(sc.klanten.map((k) => [k.id, k.name]));
  const siteNaam = new Map((sites.data ?? []).map((w) => [w.id, w.domain as string]));
  const rijen = leads.data ?? [];
  const gemeten = events.count ?? 0;

  // Telling per platform voor de kop: dat is het getal dat je factureert.
  const tel = { google: 0, bing: 0, anders: 0, geen: 0 };
  for (const l of rijen) tel[adsPlatform(l.source as string, l.medium as string) ?? 'geen'] += 1;
  const verdeling = [
    tel.google && `${tel.google} via Google Ads`,
    tel.bing && `${tel.bing} via Bing`,
    tel.anders && `${tel.anders} via andere advertenties`,
    tel.geen && `${tel.geen} niet via advertenties`,
  ].filter(Boolean) as string[];

  // Links die één filter wisselen en de rest laten staan.
  const link = (wijzig: Record<string, string | number>) => {
    const p = new URLSearchParams();
    const alles: Record<string, string | number> = {
      status: gekozen, klant: klantSlug, via, d: dagen, ...wijzig,
    };
    for (const [k, v] of Object.entries(alles)) if (v) p.set(k, String(v));
    const qs = p.toString();
    return qs ? `/leads?${qs}` : '/leads';
  };
  const gemeteneSites = (sites.data ?? [])
    .filter((w) => w.collector_live_since)
    .map((w) => w.domain as string);

  return (
    <>
      <h1 className="zin">
        {rijen.length === 0 ? (
          <>Nog geen <b>leads</b>{sc.actief ? ` bij ${sc.actief.name}` : ''}.</>
        ) : (
          <>
            {rijen.length === 200 ? 'De laatste ' : ''}
            <b>{rijen.length}</b> {rijen.length === 1 ? 'lead' : 'leads'}
            {via && ` ${VIA.find((v) => v.code === via)?.naam}`}
            {sc.actief ? ` bij ${sc.actief.name}` : ''}
            {dagen ? ` in de laatste ${dagen} dagen` : ''}.
            {!via && verdeling.length > 1 && (
              <span className="stil"> {verdeling.join(', ')}.</span>
            )}
          </>
        )}
      </h1>

      <p className="periode strak">
        <a href={link({ status: '' })} aria-current={!gekozen ? 'true' : undefined}>alles</a>
        {STATUS.map((st) => (
          <span key={st.code}>
            <span className="scheider">/</span>
            <a href={link({ status: st.code })}
               aria-current={gekozen === st.code ? 'true' : undefined}>{st.naam}</a>
          </span>
        ))}
      </p>
      <p className="periode">
        <a href={link({ via: '' })} aria-current={!via ? 'true' : undefined}>overal vandaan</a>
        {VIA.map((v) => (
          <span key={v.code}>
            <span className="scheider">/</span>
            <a href={link({ via: v.code })}
               aria-current={via === v.code ? 'true' : undefined}>{v.naam}</a>
          </span>
        ))}
        <span className="scheider">|</span>
        <a href={link({ d: 0 })} aria-current={!dagen ? 'true' : undefined}>altijd</a>
        {PERIODES.map((p) => (
          <span key={p.d}>
            <span className="scheider">/</span>
            <a href={link({ d: p.d })}
               aria-current={dagen === p.d ? 'true' : undefined}>{p.naam}</a>
          </span>
        ))}
      </p>

      {rijen.length === 0 ? (
        <div className="niets">
          <strong>
            {gekozen || via || dagen
              ? 'Geen leads binnen dit filter'
              : gemeten > 0
                ? 'Nog geen aanvraag'
                : 'Nog geen bezoekers gemeten'}
          </strong>
          {gekozen || via || dagen ? (
            <p>Probeer een ander filter, of <a href={link({ status: '', via: '', d: 0 })}>bekijk alles</a>.</p>
          ) : gemeten > 0 ? (
            <p>
              De collector draait en heeft {gemeten.toLocaleString('nl-NL')}{' '}
              {gemeten === 1 ? 'gebeurtenis' : 'gebeurtenissen'} vastgelegd
              {gemeteneSites.length > 0 && ` op ${gemeteneSites.join(' en ')}`}.
              Er heeft alleen nog niemand een formulier ingestuurd. Zodra dat
              gebeurt verschijnt de lead hier, met alles wat hij daarvoor deed.
            </p>
          ) : (
            <p>
              Er is nog geen enkele gebeurtenis binnengekomen. Dat kan kloppen
              als er nog geen bezoekers waren; duurt het langer, controleer dan
              of <code>MI_SUPABASE_KEY</code> en <code>MI_COLLECTOR_KEY</code>
              {' '}in Vercel staan en of er daarna opnieuw gedeployd is.
            </p>
          )}
        </div>
      ) : (
        <div className="tabelrol">
          <table>
            <thead>
              <tr>
                <th>Binnengekomen</th>
                <th>Wie</th>
                <th>Waarvoor</th>
                <th>Klant</th>
                <th>Kwam via</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rijen.map((l) => (
                <tr key={l.id as string}>
                  <td>
                    <span className="hoofd">{tijdstip(l.created_at as string)}</span>
                    <span className="onder">nr {l.public_ref as number}</span>
                  </td>
                  <td>
                    <a className="hoofd" href={`/leads/${l.id}`}>
                      {(l.name as string) || 'naam onbekend'}
                    </a>
                    {l.needs_review ? (
                      <span className="onder">
                        <span className="merkje aandacht">controleren</span>
                      </span>
                    ) : (
                      <span className="onder">{(l.email as string) || ''}</span>
                    )}
                  </td>
                  <td>
                    {(l.subject as string) || <span className="leegwaarde">—</span>}
                    {l.city && <span className="onder">{l.city as string}</span>}
                  </td>
                  <td>
                    {klantNaam.get(l.client_id as string) ?? '—'}
                    <span className="onder">{siteNaam.get(l.website_id as string) ?? ''}</span>
                  </td>
                  <td>
                    <span className="hoofd">
                      {adsPlatform(l.source as string, l.medium as string) && <span className="stip pauze" />}
                      {herkomstNaam(l.source as string, l.medium as string)}
                    </span>
                    {(l.campaign || l.keyword) && (
                      <span className="onder">
                        {[l.campaign, l.keyword].filter(Boolean).join(' · ')}
                      </span>
                    )}
                  </td>
                  <td>{STATUS.find((x) => x.code === l.status)?.naam ?? (l.status as string)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
