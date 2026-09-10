import { config, db } from '@/lib/db';
import { scope } from '@/lib/scope';
import { tijdstip } from '@/lib/format';
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

export default async function Leads({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const cfg = config();
  if (cfg.ontbreekt.length) return <Setup config={cfg} />;

  const gekozen = (Array.isArray(sp.status) ? sp.status[0] : sp.status) || '';
  const klantSlug = (Array.isArray(sp.klant) ? sp.klant[0] : sp.klant) || '';
  const s = db();
  const sc = await scope(klantSlug || undefined);

  let q = s.from('lead')
    .select('id,public_ref,name,email,phone,client_id,website_id,created_at,status,lead_type,source,medium,campaign,keyword,needs_review')
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(200);
  if (gekozen) q = q.eq('status', gekozen);
  if (sc.actief) q = q.eq('client_id', sc.actief.id);

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
            {sc.actief ? ` bij ${sc.actief.name}` : ''}.
          </>
        )}
      </h1>

      <p className="periode">
        <a href={klantSlug ? `/leads?klant=${klantSlug}` : '/leads'}
           aria-current={!gekozen ? 'true' : undefined}>alles</a>
        {STATUS.map((st) => (
          <span key={st.code}>
            <span className="scheider">/</span>
            <a href={`/leads?status=${st.code}${klantSlug ? `&klant=${klantSlug}` : ''}`}
               aria-current={gekozen === st.code ? 'true' : undefined}>{st.naam}</a>
          </span>
        ))}
      </p>

      {rijen.length === 0 ? (
        <div className="niets">
          <strong>
            {gekozen
              ? 'Geen leads met deze status'
              : gemeten > 0
                ? 'Nog geen aanvraag'
                : 'Nog geen bezoekers gemeten'}
          </strong>
          {gekozen ? (
            <p>Probeer een andere status, of bekijk alles.</p>
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
                    {klantNaam.get(l.client_id as string) ?? '—'}
                    <span className="onder">{siteNaam.get(l.website_id as string) ?? ''}</span>
                  </td>
                  <td>
                    {(l.campaign as string) || (l.source as string) || (
                      <span className="leegwaarde">onbekend</span>
                    )}
                    {l.keyword && <span className="onder">{l.keyword as string}</span>}
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
