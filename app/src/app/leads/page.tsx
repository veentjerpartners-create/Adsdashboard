import { config, db } from '@/lib/db';
import { Setup } from '@/components/Setup';
import { tijdstip } from '@/lib/format';

export const dynamic = 'force-dynamic';

type SP = Record<string, string | string[] | undefined>;

const STATUSSEN = [
  'new', 'contacted', 'qualified', 'offer_sent', 'won', 'lost', 'disqualified',
] as const;

export default async function Leads({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const status = (Array.isArray(sp.status) ? sp.status[0] : sp.status) || '';

  // Eerst kijken of we uberhaupt kunnen verbinden. Zonder deze controle geeft
  // een ontbrekende variabele een foutscherm met een digest-nummer, en dan
  // moet je in de logs gaan graven voor iets wat je gewoon kunt lezen.
  const cfg = config();
  if (cfg.ontbreekt.length) return <Setup config={cfg} />;

  const s = db();

  let q = s.from('lead')
    // Eén letterlijke string: supabase-js leidt het rijtype hieruit af, en
    // met een samengestelde string lukt dat niet.
    .select('id,public_ref,name,email,phone,client_id,website_id,created_at,status,lead_type,source,medium,campaign,keyword,needs_review')
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(200);
  if (status) q = q.eq('status', status);

  const [leads, klanten, sites] = await Promise.all([
    q,
    s.from('client').select('id,name'),
    s.from('website').select('id,domain,collector_live_since'),
  ]);

  const klantNaam = new Map((klanten.data ?? []).map((k) => [k.id, k.name as string]));
  const siteNaam = new Map((sites.data ?? []).map((w) => [w.id, w.domain as string]));
  const rijen = leads.data ?? [];

  return (
    <>
      <h1>Leads</h1>
      <p className="onder">
        {rijen.length === 200 ? 'nieuwste 200' : `${rijen.length} leads`}
        {status && ` met status ${status}`}
      </p>

      <div className="filters">
        <a href="/leads" aria-current={!status ? 'true' : undefined}>alle</a>
        {STATUSSEN.map((st) => (
          <a key={st} href={`/leads?status=${st}`}
             aria-current={status === st ? 'true' : undefined}>{st}</a>
        ))}
      </div>

      {rijen.length === 0 ? (
        <div className="leeg">
          <strong>Nog geen leads</strong>
          {status
            ? <>Geen leads met status <code>{status}</code>.</>
            : <>
                De collector staat nog niet live op een website. Zet{' '}
                <code>api/collect.js</code> plus de environment-variabelen in
                de site-repo en deploy; vanaf dan komt elke aanvraag hier binnen,
                met tijdlijn.
              </>}
        </div>
      ) : (
        <div className="tabelwrap">
          <table>
            <thead>
              <tr>
                <th>Datum</th>
                <th>Ref</th>
                <th>Naam</th>
                <th>Klant</th>
                <th>Bron</th>
                <th>Campagne</th>
                <th>Type</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rijen.map((l) => (
                <tr key={l.id as string}>
                  <td className="mono zacht">{tijdstip(l.created_at as string)}</td>
                  <td className="mono">
                    <a href={`/leads/${l.id}`}>#{l.public_ref as number}</a>
                  </td>
                  <td>
                    <a href={`/leads/${l.id}`}>{(l.name as string) || 'zonder naam'}</a>
                    {l.needs_review && <> <span className="tag">controleren</span></>}
                    <div className="zacht mono">{(l.email as string) || ''}</div>
                  </td>
                  <td>
                    {klantNaam.get(l.client_id as string) ?? '—'}
                    <div className="zacht mono">{siteNaam.get(l.website_id as string) ?? ''}</div>
                  </td>
                  <td className="mono">
                    {(l.source as string) || '—'}
                    {l.medium ? <span className="zacht"> / {l.medium as string}</span> : null}
                  </td>
                  <td className="mono">
                    {(l.campaign as string) || '—'}
                    {l.keyword ? <div className="zacht">{l.keyword as string}</div> : null}
                  </td>
                  <td className="mono zacht">{l.lead_type as string}</td>
                  <td>
                    <span className={`badge ${l.status as string}`}>{l.status as string}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
