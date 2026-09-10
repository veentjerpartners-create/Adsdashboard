import { config, db, periode } from '@/lib/db';
import { scope } from '@/lib/scope';
import { eur, getal } from '@/lib/format';
import { Setup } from '@/components/Setup';

export const dynamic = 'force-dynamic';

type SP = Record<string, string | string[] | undefined>;

/**
 * Waar het geld heen ging.
 *
 * Een zoekwoord is wat je inkoopt, een zoekterm is wat de bezoeker typte. Bij
 * brede en zinsmatches lopen die uiteen, en dat verschil is precies waar
 * budget weglekt. click_view geeft het zoekwoord niet meer terug, dus dit is
 * de enige bron die deze vraag beantwoordt.
 */
export default async function Zoektermen({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const cfg = config();
  if (cfg.ontbreekt.length) return <Setup config={cfg} />;

  const klantSlug = (Array.isArray(sp.klant) ? sp.klant[0] : sp.klant) || '';
  const { dagen, start, eind } = periode(sp);
  const sc = await scope(klantSlug || undefined);
  const s = db();

  let tq = s.from('ads_search_term_daily')
    .select('search_term,keyword_text,match_type,term_status,impressions,clicks,cost,campaign_id,ads_account_id')
    .gte('date', start).lte('date', eind);
  let mq = s.from('v_campaign_daily').select('cost').gte('date', start).lte('date', eind);
  if (sc.accountIds.length) {
    tq = tq.in('ads_account_id', sc.accountIds);
    mq = mq.in('ads_account_id', sc.accountIds);
  }

  const [termen, metrics, campagnes] = await Promise.all([
    tq, mq, s.from('ads_campaign').select('campaign_id,name'),
  ]);

  const campNaam = new Map(
    (campagnes.data ?? []).map((c) => [c.campaign_id as number, c.name as string]));

  type Rij = {
    term: string; kw: string | null; match: string | null; status: string | null;
    camp: string; impr: number; clicks: number; kosten: number;
  };
  const per = new Map<string, Rij>();
  for (const r of termen.data ?? []) {
    const k = r.search_term as string;
    const v = per.get(k) ?? {
      term: k, kw: r.keyword_text as string, match: r.match_type as string,
      status: r.term_status as string,
      camp: campNaam.get(r.campaign_id as number) ?? '—',
      impr: 0, clicks: 0, kosten: 0,
    };
    v.impr += r.impressions ?? 0;
    v.clicks += r.clicks ?? 0;
    v.kosten += Number(r.cost ?? 0);
    per.set(k, v);
  }
  const rijen = [...per.values()]
    .sort((a, b) => b.kosten - a.kosten || b.clicks - a.clicks || b.impr - a.impr);

  const totaalSpend = (metrics.data ?? []).reduce((a, r) => a + Number(r.cost ?? 0), 0);
  const termSpend = rijen.reduce((a, r) => a + r.kosten, 0);
  const metKosten = rijen.filter((r) => r.kosten > 0);

  return (
    <>
      <h1 className="zin">
        {termSpend > 0 ? (
          <>
            <b>{eur(termSpend)}</b> is terug te voeren op {metKosten.length}{' '}
            {metKosten.length === 1 ? 'zoekterm' : 'zoektermen'}
            {sc.actief ? ` bij ${sc.actief.name}` : ''}.
          </>
        ) : (
          <>Nog geen zoektermen met kosten{sc.actief ? ` bij ${sc.actief.name}` : ''}.</>
        )}
      </h1>

      <p className="periode">
        {start} tot {eind}
        <span className="scheider">|</span>
        {[7, 30, 90].map((d, i) => (
          <span key={d}>
            {i > 0 && <span className="scheider">/</span>}
            <a href={`/zoektermen?d=${d}${klantSlug ? `&klant=${klantSlug}` : ''}`}
               aria-current={d === dagen ? 'true' : undefined}>{d} dagen</a>
          </span>
        ))}
      </p>

      {rijen.length === 0 ? (
        <div className="niets">
          <strong>Nog niets te tonen</strong>
          <p>
            Google toont een zoekterm pas als hij vaak genoeg voorkwam, zodat
            één zoekopdracht niet herleidbaar is naar een persoon. Bij weinig
            verkeer blijft deze lijst dus leeg.
          </p>
        </div>
      ) : (
        <>
          <p className="uitleg">
            {termSpend < totaalSpend && (
              <>
                Van {eur(totaalSpend)} totale kosten is {eur(termSpend)} aan een
                zoekterm toe te wijzen. Het verschil zit in termen die Google
                niet toont omdat ze te zeldzaam waren.
              </>
            )}
          </p>
          <div className="tabelrol">
            <table>
              <thead>
                <tr>
                  <th>Wat er getypt werd</th>
                  <th>Wat je daarvoor inkocht</th>
                  <th>Campagne</th>
                  <th className="cijfer">Vertoningen</th>
                  <th className="cijfer">Klikken</th>
                  <th className="cijfer">Kosten</th>
                </tr>
              </thead>
              <tbody>
                {rijen.map((r) => (
                  <tr key={r.term}>
                    <td>
                      <span className="hoofd">{r.term}</span>
                      {r.status === 'EXCLUDED' && <span className="onder">uitgesloten</span>}
                      {r.status === 'ADDED' && <span className="onder">staat als zoekwoord in het account</span>}
                    </td>
                    <td>
                      {r.kw ?? <span className="leegwaarde">onbekend</span>}
                      {r.match && <span className="onder">{r.match.toLowerCase()}</span>}
                    </td>
                    <td>{r.camp}</td>
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
    </>
  );
}
