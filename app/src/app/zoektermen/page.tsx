import { config, db, periode, allesOphalen } from '@/lib/db';
import { scope } from '@/lib/scope';
import { eur, getal, datum } from '@/lib/format';
import { Setup } from '@/components/Setup';
import { zoekwoorden } from '@/lib/zoekwoorden';
import { zoektermen } from '@/lib/zoektermen';
import { TermenTabel } from '@/components/Zoektermen';
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

  const mq = (van: number, tot: number) => {
    let q = s.from('v_campaign_daily').select('cost').gte('date', start).lte('date', eind);
    if (sc.accountIds.length) q = q.in('ads_account_id', sc.accountIds);
    return q.range(van, tot);
  };
  const [rijen, metrics] = await Promise.all([zoektermen(sc, start, eind), allesOphalen(mq)]);
  const totaalSpend = metrics.reduce((a, r) => a + Number(r.cost ?? 0), 0);
  const termSpend = rijen.reduce((a, r) => a + (r.term ? r.kosten : 0), 0);
  const restSpend = rijen.reduce((a, r) => a + (r.term ? 0 : r.kosten), 0);
  const metKosten = rijen.filter((r) => r.term && r.kosten > 0);

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
            Van {eur(totaalSpend)} totale kosten is {eur(termSpend)} aan een zoekterm
            toe te wijzen.
            {restSpend > 0 && (
              <>
                {' '}De overige {eur(restSpend)} zit in klikken waarvoor Google de
                zoekterm (nog) niet vrijgeeft — dat gebeurt met uren tot een dag
                vertraging, en zeldzame termen blijven weg. Die klikken staan als
                <i> nog niet gerapporteerd</i> bij hun zoekwoord, zodat het totaal
                klopt met wat er betaald is.
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
                    {getal(rijen.filter((r) => r.term).length)} zoektermen ·{' '}
                    {getal(rijen.reduce((a, r) => a + r.clicks, 0))} klikken ·{' '}
                    {eur(rijen.reduce((a, r) => a + r.kosten, 0))}
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

