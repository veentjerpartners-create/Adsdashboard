/**
 * Het overzicht, gedeeld door "alle klanten" en "één klant".
 *
 * De opening is een zin, geen tegelraster. Dat is met opzet: het hele punt van
 * dit systeem is de vraag "wat leverde dat advertentiegeld op", en die vraag
 * beantwoord je in een zin, niet in tien losse getallen. De cijfers eronder
 * zijn de onderbouwing.
 */
import { db } from '@/lib/db';
import { deel, eur, getal } from '@/lib/format';
import type { Scope } from '@/lib/scope';

const PERIODES = [
  { d: 7, naam: '7 dagen' },
  { d: 30, naam: '30 dagen' },
  { d: 90, naam: '90 dagen' },
];

export async function Overzicht({
  scope, dagen, start, eind, basisUrl,
}: {
  scope: Scope; dagen: number; start: string; eind: string; basisUrl: string;
}) {
  const s = db();
  const accounts = scope.accountIds;

  let mq = s.from('v_campaign_daily')
    .select('ads_account_id,campaign_id,impressions,clicks,cost,conversions')
    .gte('date', start).lte('date', eind);
  let lq = s.from('lead')
    .select('id,client_id,status,created_at')
    .gte('created_at', `${start}T00:00:00Z`).is('deleted_at', null);
  let tq = s.from('ads_search_term_daily')
    .select('search_term,keyword_text,match_type,term_status,impressions,clicks,cost,campaign_id')
    .gte('date', start).lte('date', eind);

  if (accounts.length) {
    mq = mq.in('ads_account_id', accounts);
    tq = tq.in('ads_account_id', accounts);
  }
  if (scope.actief) lq = lq.eq('client_id', scope.actief.id);

  const [metrics, leads, termen, campagnes] = await Promise.all([
    mq, lq, tq,
    s.from('ads_campaign').select('ads_account_id,campaign_id,name,status'),
  ]);

  const t = { impr: 0, clicks: 0, kosten: 0, conv: 0 };
  for (const m of metrics.data ?? []) {
    t.impr += m.impressions ?? 0;
    t.clicks += m.clicks ?? 0;
    t.kosten += Number(m.cost ?? 0);
    t.conv += Number(m.conversions ?? 0);
  }
  const rijenLeads = leads.data ?? [];
  const gekwalificeerd = rijenLeads.filter((l) =>
    ['qualified', 'offer_sent', 'won'].includes(l.status as string)).length;
  const gewonnen = rijenLeads.filter((l) => l.status === 'won').length;
  const cpl = deel(t.kosten, rijenLeads.length);

  // --- campagnes: alles wat bestaat plus alles wat geld kostte -------------
  const campInfo = new Map(
    (campagnes.data ?? []).map((c) => [`${c.ads_account_id}-${c.campaign_id}`, c]));
  type Rij = {
    sleutel: string; naam: string; status: string; weg: boolean;
    impr: number; clicks: number; kosten: number; conv: number;
  };
  const perCampagne = new Map<string, Rij>();
  const pak = (sleutel: string, campaignId: number): Rij => {
    let r = perCampagne.get(sleutel);
    if (!r) {
      const c = campInfo.get(sleutel);
      const status = (c?.status as string) ?? 'ONBEKEND';
      r = {
        sleutel, naam: (c?.name as string) ?? `campagne ${campaignId}`,
        status, weg: status === 'REMOVED' || !c,
        impr: 0, clicks: 0, kosten: 0, conv: 0,
      };
      perCampagne.set(sleutel, r);
    }
    return r;
  };
  for (const m of metrics.data ?? []) {
    const r = pak(`${m.ads_account_id}-${m.campaign_id}`, m.campaign_id as number);
    r.impr += m.impressions ?? 0;
    r.clicks += m.clicks ?? 0;
    r.kosten += Number(m.cost ?? 0);
    r.conv += Number(m.conversions ?? 0);
  }
  for (const c of campagnes.data ?? []) {
    if (c.status === 'REMOVED') continue;
    if (accounts.length && !accounts.includes(c.ads_account_id as string)) continue;
    pak(`${c.ads_account_id}-${c.campaign_id}`, c.campaign_id as number);
  }
  const campagneRijen = [...perCampagne.values()]
    .sort((a, b) => b.kosten - a.kosten || b.impr - a.impr || a.naam.localeCompare(b.naam));

  // --- zoektermen: waar het geld heen ging --------------------------------
  type Term = {
    term: string; kw: string | null; match: string | null; status: string | null;
    impr: number; clicks: number; kosten: number;
  };
  const perTerm = new Map<string, Term>();
  for (const r of termen.data ?? []) {
    const k = r.search_term as string;
    const v = perTerm.get(k) ?? {
      term: k, kw: r.keyword_text as string, match: r.match_type as string,
      status: r.term_status as string, impr: 0, clicks: 0, kosten: 0,
    };
    v.impr += r.impressions ?? 0;
    v.clicks += r.clicks ?? 0;
    v.kosten += Number(r.cost ?? 0);
    perTerm.set(k, v);
  }
  const termRijen = [...perTerm.values()]
    .sort((a, b) => b.kosten - a.kosten || b.clicks - a.clicks || b.impr - a.impr);
  const termKosten = termRijen.reduce((a, r) => a + r.kosten, 0);

  const trechter = [
    { etiket: 'Vertoningen', n: t.impr },
    { etiket: 'Klikken', n: t.clicks },
    { etiket: 'Leads', n: rijenLeads.length },
    { etiket: 'Gekwalificeerd', n: gekwalificeerd },
    { etiket: 'Klanten', n: gewonnen },
  ];
  const top = Math.max(...trechter.map((x) => x.n), 1);

  return (
    <>
      <h1 className="zin">
        {scope.actief ? `${scope.actief.name} gaf ` : 'Er ging '}
        <b>{eur(t.kosten)}</b>
        {scope.actief ? ' uit bij Google in ' : ' naar Google in '}{dagen}{' dagen. '}
        {rijenLeads.length > 0 ? (
          <>Dat leverde <b>{rijenLeads.length}</b> {rijenLeads.length === 1 ? 'lead' : 'leads'} op.</>
        ) : t.clicks > 0 ? (
          <span className="stil">Er kwamen {t.clicks} klikken, nog geen leads.</span>
        ) : (
          <span className="stil">Er is nog geen verkeer.</span>
        )}
      </h1>

      <p className="periode">
        {start} tot {eind}
        <span className="scheider">|</span>
        {PERIODES.map((p, i) => (
          <span key={p.d}>
            {i > 0 && <span className="scheider">/</span>}
            <a href={`${basisUrl}?d=${p.d}`} aria-current={p.d === dagen ? 'true' : undefined}>
              {p.naam}
            </a>
          </span>
        ))}
      </p>

      <div className="grootboek">
        <Post naam="Vertoningen" cijfer={getal(t.impr)} />
        <Post naam="Klikken" cijfer={getal(t.clicks)}
              bij={t.impr ? `${((t.clicks / t.impr) * 100).toFixed(1)}% doorklik` : undefined} />
        <Post naam="Kosten per klik" cijfer={t.clicks ? eur(t.kosten / t.clicks) : '—'}
              wacht={!t.clicks} />
        <Post naam="Leads" cijfer={getal(rijenLeads.length)} klem={rijenLeads.length > 0} />
        <Post naam="Kosten per lead" cijfer={cpl == null ? '—' : eur(cpl)} wacht={cpl == null}
              bij={cpl == null ? 'nog geen leads' : undefined} />
        <Post naam="Marge" cijfer="—" wacht bij="volgt na de offertes" />
        <Post naam="Winst na advertenties" cijfer="—" wacht bij="volgt na de offertes" />
      </div>

      <h2>Van vertoning tot klant</h2>
      <div className="trechter">
        {trechter.map((stap, i) => {
          const vorige = i > 0 ? trechter[i - 1].n : null;
          return (
            <div className="trap" key={stap.etiket}>
              <span className="etiket">{stap.etiket}</span>
              <span className={`balk${stap.n ? '' : ' leeg'}`}>
                <i style={{ width: `${Math.max((stap.n / top) * 100, stap.n ? 1.5 : 0)}%` }} />
              </span>
              <span className="waarde">
                {getal(stap.n)}
                {vorige != null && vorige > 0 && (
                  <span className="val"> {((stap.n / vorige) * 100).toFixed(0)}%</span>
                )}
              </span>
            </div>
          );
        })}
      </div>

      <h2>
        Waar je voor betaalt
        {termKosten > 0 && (
          <span className="zijkant">
            {eur(termKosten)} van {eur(t.kosten)} toe te wijzen aan een zoekterm
          </span>
        )}
      </h2>
      {termRijen.length === 0 ? (
        <div className="niets">
          <strong>Nog geen zoektermen</strong>
          Google toont een zoekterm pas als hij vaak genoeg voorkwam, om te
          voorkomen dat één zoekopdracht herleidbaar is. Zodra er meer verkeer
          is, vullen ze zich.
        </div>
      ) : (
        <>
          <p className="uitleg">
            Wat mensen echt intypten, en welk ingekocht zoekwoord daarop matchte.
            Google laat zeldzame termen weg, dus dit telt niet op tot het
            campagnetotaal.
          </p>
          <div className="tabelrol">
            <table>
              <thead>
                <tr>
                  <th>Zoekterm</th>
                  <th>Matchte op</th>
                  <th className="cijfer">Vertoningen</th>
                  <th className="cijfer">Klikken</th>
                  <th className="cijfer">Kosten</th>
                </tr>
              </thead>
              <tbody>
                {termRijen.slice(0, 25).map((r) => (
                  <tr key={r.term}>
                    <td>
                      <span className="hoofd">{r.term}</span>
                      {r.status === 'EXCLUDED' && (
                        <span className="onder">uitgesloten</span>
                      )}
                    </td>
                    <td>
                      {r.kw ?? <span className="leegwaarde">onbekend</span>}
                      {r.match && <span className="onder">{r.match.toLowerCase()}</span>}
                    </td>
                    <td className="cijfer">{getal(r.impr)}</td>
                    <td className="cijfer">{r.clicks || <span className="leegwaarde">0</span>}</td>
                    <td className="cijfer">
                      {r.kosten > 0 ? eur(r.kosten) : <span className="leegwaarde">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <h2>Campagnes</h2>
      <div className="tabelrol">
        <table>
          <thead>
            <tr>
              <th>Campagne</th>
              <th className="cijfer">Vertoningen</th>
              <th className="cijfer">Klikken</th>
              <th className="cijfer">Kosten</th>
              <th className="cijfer">Per klik</th>
              <th className="cijfer">Conversies</th>
            </tr>
          </thead>
          <tbody>
            {campagneRijen.map((r) => {
              const cpc = deel(r.kosten, r.clicks);
              const stip = r.status === 'ENABLED' ? 'aan' : r.weg ? 'weg' : 'pauze';
              return (
                <tr key={r.sleutel}>
                  <td>
                    <span className="hoofd"><span className={`stip ${stip}`} />{r.naam}</span>
                    {r.weg && r.kosten > 0 && (
                      <span className="onder">verwijderd, gaf in deze periode nog geld uit</span>
                    )}
                    {r.weg && r.kosten === 0 && (
                      <span className="onder">verwijderd</span>
                    )}
                    {!r.weg && r.status !== 'ENABLED' && (
                      <span className="onder">{r.status.toLowerCase()}</span>
                    )}
                  </td>
                  <td className="cijfer">{getal(r.impr)}</td>
                  <td className="cijfer">{r.clicks || <span className="leegwaarde">0</span>}</td>
                  <td className="cijfer">{r.kosten > 0 ? eur(r.kosten) : <span className="leegwaarde">—</span>}</td>
                  <td className="cijfer">{cpc == null ? <span className="leegwaarde">—</span> : eur(cpc)}</td>
                  <td className="cijfer">{r.conv ? r.conv.toFixed(1) : <span className="leegwaarde">—</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Post({ naam, cijfer, bij, wacht, klem }: {
  naam: string; cijfer: string; bij?: string; wacht?: boolean; klem?: boolean;
}) {
  return (
    <div className={`post${wacht ? ' wacht' : ''}${klem ? ' klem' : ''}`}>
      <div className="naam">{naam}</div>
      <div className="cijfer">{cijfer}</div>
      {bij && <div className="bij">{bij}</div>}
    </div>
  );
}
