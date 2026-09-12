/**
 * De ingekochte zoekwoorden waar voor betaald is, per klant een tabel.
 *
 * Dit is de lijst die naar de klant gaat, dus per klant een eigen blok met
 * eigen totaalregel en een CSV-knop -- niet één lange tabel met een
 * klantkolom.
 */
import { eur, getal, datum } from '@/lib/format';
import type { Klant } from '@/lib/scope';
import type { Zoekwoord } from '@/lib/zoekwoorden';

const STATUS = { aan: 'actief', pauze: 'gepauzeerd', weg: 'verwijderd' } as const;

export function ZoekwoordenPerKlant({ klanten, rijen, csvQuery }: {
  klanten: Klant[]; rijen: Zoekwoord[]; csvQuery: string;
}) {
  const perKlant = klanten
    .map((k) => ({ klant: k, rijen: rijen.filter((r) => r.clientId === k.id) }))
    .filter((g) => g.rijen.length > 0);

  return perKlant.map(({ klant, rijen }) => (
    <Klantblok key={klant.id} klant={klant} rijen={rijen} csvQuery={csvQuery} />
  ));
}

function Klantblok({ klant, rijen, csvQuery }: {
  klant: Klant; rijen: Zoekwoord[]; csvQuery: string;
}) {
  const kosten = rijen.reduce((a, r) => a + r.kosten, 0);
  const clicks = rijen.reduce((a, r) => a + r.clicks, 0);
  const impr = rijen.reduce((a, r) => a + r.impr, 0);
  const conv = rijen.reduce((a, r) => a + r.conversies, 0);
  const rond = (n: number) => getal(Math.round(n * 10) / 10);

  return (
    <section className="blok">
      <h2 className="klantkop">
        {klant.name}
        <span className="meta">
          {getal(rijen.length)} zoekwoorden · {eur(kosten)} ·{' '}
          <a href={`/zoektermen/csv?klant=${klant.slug}${csvQuery}`}>download als CSV</a>
        </span>
      </h2>
      <div className="tabelrol">
        <table>
          <thead>
            <tr>
              <th>Zoekwoord</th>
              <th>Campagne</th>
              <th>Betaald van – tot</th>
              <th className="cijfer">Vertoningen</th>
              <th className="cijfer">Klikken</th>
              <th className="cijfer">Per klik</th>
              <th className="cijfer">Conversies</th>
              <th className="cijfer">Kosten</th>
            </tr>
          </thead>
          <tbody>
            {rijen.map((r) => (
              <tr key={`${r.tekst}|${r.match}`}>
                <td>
                  <span className="hoofd">
                    <i className={`stip ${r.status}`} title={STATUS[r.status]} />
                    {r.tekst}
                  </span>
                  <span className="onder">
                    {r.match}{r.status !== 'aan' && ` · ${STATUS[r.status]}`}
                  </span>
                </td>
                <td>{r.campagnes.join(', ')}</td>
                <td>
                  {r.eersteDag === r.laatsteDag
                    ? datum(r.eersteDag)
                    : `${datum(r.eersteDag)} – ${datum(r.laatsteDag)}`}
                </td>
                <td className="cijfer">{getal(r.impr)}</td>
                <td className="cijfer">{r.clicks || <span className="leegwaarde">0</span>}</td>
                <td className="cijfer">
                  {r.clicks ? eur(r.kosten / r.clicks) : <span className="leegwaarde">—</span>}
                </td>
                <td className="cijfer">
                  {r.conversies ? rond(r.conversies) : <span className="leegwaarde">—</span>}
                </td>
                <td className="cijfer">{eur(r.kosten)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th>Totaal</th>
              <th />
              <th />
              <th className="cijfer">{getal(impr)}</th>
              <th className="cijfer">{getal(clicks)}</th>
              <th className="cijfer">{clicks ? eur(kosten / clicks) : '—'}</th>
              <th className="cijfer">{conv ? rond(conv) : '—'}</th>
              <th className="cijfer">{eur(kosten)}</th>
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
}
