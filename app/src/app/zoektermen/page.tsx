import { config, db, periode, allesOphalen } from '@/lib/db';
import { scope } from '@/lib/scope';
import { eur, getal, datum } from '@/lib/format';
import { Setup } from '@/components/Setup';
import { zoekwoorden } from '@/lib/zoekwoorden';
import { ZoekwoordenPerKlant } from '@/components/Zoekwoorden';

export const dynamic = 'force-dynamic';

type SP = Record<string, string | string[] | undefined>;

/**
 * Waar het geld heen ging.
 *
 * Een zoekwoord is wat je inkoopt, een zoekterm is wat de bezoeker typte. Bij
 * brede en zinsmatches lopen die uiteen, en dat verschil is precies waar
 * budget weglekt. click_view geeft het zoekwoord niet meer terug, dus dit is
 * de enige bron die deze vraag beantwoordt.
 *
 * Met ?wat=zoekwoorden kantelt de pagina naar de andere kant: niet wat er
 * getypt werd, maar wat er ingekocht is en wat dat ooit gekost heeft -- de
 * lijst die je naar de klant stuurt. Met ?d=alles over de hele historie.
 */
export default async function Zoektermen({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const cfg = config();
  if (cfg.ontbreekt.length) return <Setup config={cfg} />;

  const klantSlug = (Array.isArray(sp.klant) ? sp.klant[0] : sp.klant) || '';
  const wat = (Array.isArray(sp.wat) ? sp.wat[0] : sp.wat) === 'zoekwoorden' ? 'zoekwoorden' : 'termen';
  const { dagen, alles, start, eind } = periode(sp);
  const sc = await scope(klantSlug || undefined);
  const s = db();

  const url = (p: { wat?: string; d?: string | number }) => {
    const q = new URLSearchParams();
    if ((p.wat ?? wat) === 'zoekwoorden') q.set('wat', 'zoekwoorden');
    const dd = p.d ?? (alles ? 'alles' : dagen);
    if (String(dd) !== '30') q.set('d', String(dd));
    if (klantSlug) q.set('klant', klantSlug);
    const qs = q.toString();
    return `/zoektermen${qs ? `?${qs}` : ''}`;
  };
  const periodeKeuze = (
    <p className="periode">
      {alles ? 'hele historie' : `${start} tot ${eind}`}
      <span className="scheider">|</span>
      {[7, 30, 90].map((d, i) => (
        <span key={d}>
          {i > 0 && <span className="scheider">/</span>}
          <a href={url({ d })} aria-current={d === dagen ? 'true' : undefined}>{d} dagen</a>
        </span>
      ))}
      <span className="scheider">/</span>
      <a href={url({ d: 'alles' })} aria-current={alles ? 'true' : undefined}>altijd</a>
      <span className="scheider">|</span>
      <a href={url({ wat: 'termen' })} aria-current={wat === 'termen' ? 'true' : undefined}>wat getypt werd</a>
      <span className="scheider">/</span>
      <a href={url({ wat: 'zoekwoorden' })} aria-current={wat === 'zoekwoorden' ? 'true' : undefined}>wat ingekocht is</a>
    </p>
  );

  if (wat === 'zoekwoorden') {
    const rijen = await zoekwoorden(sc, start, eind);
    const totaal = rijen.reduce((a, r) => a + r.kosten, 0);
    const eerste = rijen.reduce<string | null>(
      (a, r) => (!a || r.eersteDag < a ? r.eersteDag : a), null);
    const klanten = sc.actief ? [sc.actief] : sc.klanten;
    const metRijen = klanten.filter((k) => rijen.some((r) => r.clientId === k.id));

    return (
      <>
        <h1 className="zin">
          {rijen.length ? (
            <>
              <b>{eur(totaal)}</b> uitgegeven aan {getal(rijen.length)} zoekwoorden
              {sc.actief ? ` bij ${sc.actief.name}` : ` bij ${metRijen.length} klanten`}
              {alles && eerste && <span className="stil"> sinds {datum(eerste)}</span>}.
            </>
          ) : (
            <>Nog geen zoekwoorden met kosten{sc.actief ? ` bij ${sc.actief.name}` : ''}.</>
          )}
        </h1>
        {periodeKeuze}
        <p className="uitleg">
          Wat er is ingekocht en wat dat kostte. Alleen dagen waarop een zoekwoord
          daadwerkelijk geld kostte tellen mee; een zoekwoord dat alleen vertoond
          werd staat er niet in. Verwijderde zoekwoorden blijven staan, want daar
          is wél voor betaald.
        </p>
        {rijen.length === 0 ? (
          <div className="niets">
            <strong>Nog niets te tonen</strong>
            <p>
              De historie komt uit <code>python -m ingest.run metrics --backfill 24</code>;
              de laatste 14 dagen komen elke nacht mee.
            </p>
          </div>
        ) : (
          <ZoekwoordenPerKlant klanten={klanten} rijen={rijen}
                               csvQuery={alles ? '' : `&d=${dagen}`} />
        )}
      </>
    );
  }

  const tq = (van: number, tot: number) => {
    let q = s.from('ads_search_term_daily')
      .select('search_term,keyword_text,match_type,term_status,impressions,clicks,cost,campaign_id,ads_account_id')
      .gte('date', start).lte('date', eind);
    if (sc.accountIds.length) q = q.in('ads_account_id', sc.accountIds);
    return q.order('date').order('search_term').range(van, tot);
  };
  const mq = (van: number, tot: number) => {
    let q = s.from('v_campaign_daily').select('cost').gte('date', start).lte('date', eind);
    if (sc.accountIds.length) q = q.in('ads_account_id', sc.accountIds);
    return q.range(van, tot);
  };

  const [termen, metrics, campagnes, accounts] = await Promise.all([
    allesOphalen(tq), allesOphalen(mq), s.from('ads_campaign').select('campaign_id,name'),
    s.from('ads_account').select('id,client_id'),
  ]);
  const klantVanAccount = new Map(
    (accounts.data ?? []).map((a) => [a.id as string, a.client_id as string]));

  const campNaam = new Map(
    (campagnes.data ?? []).map((c) => [c.campaign_id as number, c.name as string]));

  type Rij = {
    clientId: string; term: string; kw: string | null; match: string | null;
    status: string | null; camp: string; impr: number; clicks: number; kosten: number;
  };
  // Per klant apart tellen: dezelfde zoekterm bij twee klanten zijn twee regels.
  const per = new Map<string, Rij>();
  for (const r of termen) {
    const clientId = klantVanAccount.get(r.ads_account_id as string) ?? '';
    const k = `${clientId}|${r.search_term}`;
    const v = per.get(k) ?? {
      clientId, term: r.search_term as string,
      kw: r.keyword_text as string, match: r.match_type as string,
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

  const totaalSpend = metrics.reduce((a, r) => a + Number(r.cost ?? 0), 0);
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

      {periodeKeuze}

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
          {(sc.actief ? [sc.actief] : sc.klanten)
            .map((k) => ({ klant: k, rijen: rijen.filter((r) => r.clientId === k.id) }))
            .filter((g) => g.rijen.length > 0)
            .map(({ klant, rijen }) => (
              <section key={klant.id} className="blok">
                <h2 className="klantkop">
                  {klant.name}
                  <span className="meta">
                    {getal(rijen.length)} zoektermen · {eur(rijen.reduce((a, r) => a + r.kosten, 0))}
                  </span>
                </h2>
                <TermenTabel rijen={rijen} />
              </section>
            ))}
        </>
      )}
    </>
  );
}

function TermenTabel({ rijen }: { rijen: {
  term: string; kw: string | null; match: string | null; status: string | null;
  camp: string; impr: number; clicks: number; kosten: number;
}[] }) {
  return (
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
  );
}
