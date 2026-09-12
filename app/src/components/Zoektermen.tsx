/**
 * De zoektermentabel, gedeeld door de pagina "Waar je voor betaalt" en het
 * overzicht. Een regel zonder term is een restregel: klikken op het zoekwoord
 * waarvoor Google de zoekterm (nog) niet heeft vrijgegeven.
 */
import { eur, getal } from '@/lib/format';
import type { Zoekterm } from '@/lib/zoektermen';

export function TermenTabel({ rijen, campagne = true, totaal = true }: {
  rijen: Zoekterm[]; campagne?: boolean; totaal?: boolean;
}) {
  const impr = rijen.reduce((a, r) => a + r.impr, 0);
  const clicks = rijen.reduce((a, r) => a + r.clicks, 0);
  const kosten = rijen.reduce((a, r) => a + r.kosten, 0);

  return (
    <div className="tabelrol">
      <table>
        <thead>
          <tr>
            <th>Wat er getypt werd</th>
            <th>Wat je daarvoor inkocht</th>
            {campagne && <th>Campagne</th>}
            <th className="cijfer">Vertoningen</th>
            <th className="cijfer">Klikken</th>
            <th className="cijfer">Kosten</th>
          </tr>
        </thead>
        <tbody>
          {rijen.map((r, i) => (
            <tr key={i} className={r.term ? undefined : 'rest'}>
              <td>
                {r.term ? (
                  <>
                    <span className="hoofd">{r.term}</span>
                    {r.status === 'EXCLUDED' && <span className="onder">uitgesloten</span>}
                    {r.status === 'ADDED' && <span className="onder">staat als zoekwoord in het account</span>}
                  </>
                ) : (
                  <>
                    <span className="hoofd stil">nog niet gerapporteerd</span>
                    <span className="onder">Google geeft de zoekterm later vrij</span>
                  </>
                )}
              </td>
              <td>
                {r.kw ?? <span className="leegwaarde">onbekend</span>}
                {r.match && <span className="onder">{r.match.toLowerCase()}</span>}
              </td>
              {campagne && (
                <td>
                  {r.campagne}
                  <span className="onder">{r.adgroep}</span>
                </td>
              )}
              <td className="cijfer">{r.impr ? getal(r.impr) : <span className="leegwaarde">—</span>}</td>
              <td className="cijfer">{r.clicks || <span className="leegwaarde">0</span>}</td>
              <td className="cijfer">
                {r.kosten > 0 ? eur(r.kosten) : <span className="leegwaarde">—</span>}
              </td>
            </tr>
          ))}
        </tbody>
        {totaal && (
          <tfoot>
            <tr>
              <th>Totaal</th>
              <th />
              {campagne && <th />}
              <th className="cijfer">{getal(impr)}</th>
              <th className="cijfer">{getal(clicks)}</th>
              <th className="cijfer">{eur(kosten)}</th>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}
