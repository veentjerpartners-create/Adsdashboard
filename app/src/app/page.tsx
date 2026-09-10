import { db, periode } from '@/lib/db';
import { deel, eur, getal } from '@/lib/format';

export const dynamic = 'force-dynamic';

type SP = Record<string, string | string[] | undefined>;

export default async function Overzicht({
  searchParams,
}: {
  searchParams: Promise<SP>;
}) {
  const sp = await searchParams;
  const { dagen, start, eind } = periode(sp);
  const s = db();

  // v_campaign_daily in plaats van ads_metrics_daily: die view filtert het
  // zoekwoordgrein eruit. Zonder dat filter tel je de spend dubbel.
  const [campMetrics, accounts, klanten, campagnes, leads] = await Promise.all([
    s.from('v_campaign_daily')
      .select('ads_account_id,campaign_id,impressions,clicks,cost,conversions')
      .gte('date', start).lte('date', eind),
    s.from('ads_account').select('id,customer_id,descriptive_name,client_id,is_manager'),
    s.from('client').select('id,name,slug,default_margin_pct'),
    s.from('ads_campaign').select('ads_account_id,campaign_id,name,status'),
    s.from('lead').select('id,client_id,status,created_at')
      .gte('created_at', `${start}T00:00:00Z`).is('deleted_at', null),
  ]);

  const accountVanKlant = new Map<string, string>();
  for (const a of accounts.data ?? []) {
    if (!a.is_manager && a.client_id) accountVanKlant.set(a.id, a.client_id);
  }

  type Totaal = {
    impressies: number; clicks: number; kosten: number; conversies: number;
    leads: number; gekwalificeerd: number; deals: number;
  };
  const leeg = (): Totaal => ({
    impressies: 0, clicks: 0, kosten: 0, conversies: 0,
    leads: 0, gekwalificeerd: 0, deals: 0,
  });

  const perKlant = new Map<string, Totaal>();
  const alles = leeg();

  for (const r of campMetrics.data ?? []) {
    const klant = accountVanKlant.get(r.ads_account_id as string);
    const t = klant ? (perKlant.get(klant) ?? leeg()) : null;
    const bij = (o: Totaal) => {
      o.impressies += r.impressions ?? 0;
      o.clicks += r.clicks ?? 0;
      o.kosten += Number(r.cost ?? 0);
      o.conversies += Number(r.conversions ?? 0);
    };
    bij(alles);
    if (t && klant) { bij(t); perKlant.set(klant, t); }
  }

  for (const l of leads.data ?? []) {
    const t = perKlant.get(l.client_id as string) ?? leeg();
    t.leads += 1;
    alles.leads += 1;
    if (['qualified', 'offer_sent', 'won'].includes(l.status as string)) {
      t.gekwalificeerd += 1; alles.gekwalificeerd += 1;
    }
    if (l.status === 'won') { t.deals += 1; alles.deals += 1; }
    perKlant.set(l.client_id as string, t);
  }

  const actieveCampagnes = (campagnes.data ?? []).filter((c) => c.status === 'ENABLED');
  const cpl = deel(alles.kosten, alles.leads);

  const bereiken = [7, 30, 90];

  return (
    <>
      <h1>Overzicht</h1>
      <p className="onder">
        {start} t/m {eind} · {dagen} dagen · alle klanten
      </p>

      <div className="filters">
        {bereiken.map((d) => (
          <a key={d} href={`/?d=${d}`} aria-current={d === dagen ? 'true' : undefined}>
            {d} dagen
          </a>
        ))}
      </div>

      <div className="kpis">
        <Tegel label="Spend" waarde={eur(alles.kosten)} />
        <Tegel label="Impressies" waarde={getal(alles.impressies)} />
        <Tegel label="Clicks" waarde={getal(alles.clicks)}
               hint={alles.impressies ? `CTR ${((alles.clicks / alles.impressies) * 100).toFixed(1)}%` : undefined} />
        <Tegel label="Leads" waarde={getal(alles.leads)} />
        <Tegel label="CPL" waarde={cpl == null ? '—' : eur(cpl)}
               leeg={cpl == null} hint={cpl == null ? 'nog geen leads' : undefined} />
        <Tegel label="Gekwalificeerd" waarde={getal(alles.gekwalificeerd)} />
        <Tegel label="Deals" waarde={getal(alles.deals)} />
        <Tegel label="Omzet" waarde="—" leeg hint="fase 3" />
        <Tegel label="Marge" waarde="—" leeg hint="fase 3" />
        <Tegel label="Winst na ads" waarde="—" leeg hint="fase 3" />
      </div>

      <h2>Van klik naar klant</h2>
      <div className="funnel">
        <Stap n={getal(alles.impressies)} l="Impressies" />
        <Stap n={getal(alles.clicks)} l="Clicks"
              r={alles.impressies ? `${((alles.clicks / alles.impressies) * 100).toFixed(1)}% van impressies` : undefined} />
        <Stap n={getal(alles.leads)} l="Leads"
              r={alles.clicks ? `${((alles.leads / alles.clicks) * 100).toFixed(1)}% van clicks` : 'wacht op de collector'} />
        <Stap n={getal(alles.gekwalificeerd)} l="Gekwalificeerd" />
        <Stap n="—" l="Offertes" r="fase 3" />
        <Stap n={getal(alles.deals)} l="Deals" />
      </div>

      <h2>Per klant</h2>
      {(klanten.data ?? []).length === 0 ? (
        <div className="leeg">
          <strong>Nog geen klanten</strong>
          Draai <code>db/seed/010_klanten.sql</code>.
        </div>
      ) : (
        <div className="tabelwrap">
          <table>
            <thead>
              <tr>
                <th>Klant</th>
                <th className="n">Spend</th>
                <th className="n">Clicks</th>
                <th className="n">Leads</th>
                <th className="n">CPL</th>
                <th className="n">Deals</th>
                <th className="n">Marge %</th>
                <th>Campagnes</th>
              </tr>
            </thead>
            <tbody>
              {(klanten.data ?? []).map((k) => {
                const t = perKlant.get(k.id as string) ?? leeg();
                const c = deel(t.kosten, t.leads);
                const account = (accounts.data ?? []).find(
                  (a) => a.client_id === k.id && !a.is_manager);
                const eigen = actieveCampagnes.filter(
                  (x) => x.ads_account_id === account?.id);
                const totaalEigen = (campagnes.data ?? []).filter(
                  (x) => x.ads_account_id === account?.id && x.status !== 'REMOVED');
                return (
                  <tr key={k.id as string}>
                    <td><strong>{k.name as string}</strong></td>
                    <td className="n">{eur(t.kosten)}</td>
                    <td className="n">{getal(t.clicks)}</td>
                    <td className="n">{getal(t.leads)}</td>
                    <td className="n">{c == null ? '—' : eur(c)}</td>
                    <td className="n">{getal(t.deals)}</td>
                    <td className="n">
                      {k.default_margin_pct == null
                        ? <span className="zacht">niet ingevuld</span>
                        : `${k.default_margin_pct}%`}
                    </td>
                    <td className="mono">
                      {eigen.length} actief
                      {totaalEigen.length > eigen.length && (
                        <span className="zacht"> · {totaalEigen.length - eigen.length} gepauzeerd</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <h2>Campagnes</h2>
      <div className="tabelwrap">
        <table>
          <thead>
            <tr>
              <th>Campagne</th>
              <th>Status</th>
              <th className="n">Impressies</th>
              <th className="n">Clicks</th>
              <th className="n">Spend</th>
              <th className="n">CPC</th>
              <th className="n">Conversies</th>
            </tr>
          </thead>
          <tbody>
            {(campagnes.data ?? [])
              .filter((c) => c.status !== 'REMOVED')
              .map((c) => {
                const rijen = (campMetrics.data ?? []).filter(
                  (m) => m.ads_account_id === c.ads_account_id &&
                         m.campaign_id === c.campaign_id);
                const impr = rijen.reduce((a, r) => a + (r.impressions ?? 0), 0);
                const clicks = rijen.reduce((a, r) => a + (r.clicks ?? 0), 0);
                const kosten = rijen.reduce((a, r) => a + Number(r.cost ?? 0), 0);
                const conv = rijen.reduce((a, r) => a + Number(r.conversions ?? 0), 0);
                const cpc = deel(kosten, clicks);
                return (
                  <tr key={`${c.ads_account_id}-${c.campaign_id}`}>
                    <td>{c.name as string}</td>
                    <td><span className={`badge ${String(c.status).toLowerCase()}`}>{c.status as string}</span></td>
                    <td className="n">{getal(impr)}</td>
                    <td className="n">{getal(clicks)}</td>
                    <td className="n">{eur(kosten)}</td>
                    <td className="n">{cpc == null ? '—' : eur(cpc)}</td>
                    <td className="n">{conv ? conv.toFixed(1) : '—'}</td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Tegel({ label, waarde, hint, leeg }: {
  label: string; waarde: string; hint?: string; leeg?: boolean;
}) {
  return (
    <div className={`kpi${leeg ? ' leeg' : ''}`}>
      <div className="label">{label}</div>
      <div className="waarde">{waarde}</div>
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

function Stap({ n, l, r }: { n: string; l: string; r?: string }) {
  return (
    <div className="stap">
      <div className="n">{n}</div>
      <div className="l">{l}</div>
      {r && <div className="r">{r}</div>}
    </div>
  );
}
