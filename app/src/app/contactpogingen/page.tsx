import { config, db, periode } from '@/lib/db';
import { scope } from '@/lib/scope';
import { getal, tijdstip } from '@/lib/format';
import { Setup } from '@/components/Setup';

export const dynamic = 'force-dynamic';

type SP = Record<string, string | string[] | undefined>;

/** Iemand pakte contact op, maar we weten niet wie. */
const POGINGEN = ['whatsapp_click', 'phone_click', 'email_click'] as const;

const LABEL: Record<string, string> = {
  whatsapp_click: 'WhatsApp',
  phone_click: 'Telefoon',
  email_click: 'E-mail',
};

/**
 * Contactpogingen zonder naam.
 *
 * Een WhatsApp- of telefoonklik is geen lead: we weten niet wie het is. Het
 * gesprek gaat verder op de telefoon van de eigenaar, buiten de website om.
 * Maar het is wel iemand die contact zocht, en dat mag niet onzichtbaar zijn.
 *
 * Hier staan ze met de campagne en het zoekwoord waar ze vandaan kwamen, zodat
 * je ze kunt naleggen naast je WhatsApp of je telefoon. Herken je er een, dan
 * maak je er een lead van en hangt het hele voortraject er alsnog aan.
 */
export default async function Contactpogingen({
  searchParams,
}: {
  searchParams: Promise<SP>;
}) {
  const sp = await searchParams;
  const cfg = config();
  if (cfg.ontbreekt.length) return <Setup config={cfg} />;

  const klantSlug = (Array.isArray(sp.klant) ? sp.klant[0] : sp.klant) || '';
  const { dagen, start, eind } = periode(sp);
  const sc = await scope(klantSlug || undefined);
  const s = db();

  let q = s.from('lead_event')
    .select('id,event_type,occurred_at,page_path,source,medium,campaign,term,click_id,click_type,website_id,visitor_id,metadata,lead_id')
    .in('event_type', POGINGEN as unknown as string[])
    .gte('occurred_at', `${start}T00:00:00Z`)
    .order('occurred_at', { ascending: false })
    .limit(300);
  if (sc.actief) q = q.eq('client_id', sc.actief.id);

  const [events, sites] = await Promise.all([
    q,
    s.from('website').select('id,domain'),
  ]);

  const siteNaam = new Map((sites.data ?? []).map((w) => [w.id, w.domain as string]));
  const rijen = events.data ?? [];
  const zonderNaam = rijen.filter((e) => !e.lead_id);
  const metNaam = rijen.length - zonderNaam.length;

  // Per bezoeker: hoeveel keer probeerde hij het, en wanneer voor het eerst?
  const perBezoeker = new Map<string, typeof rijen>();
  for (const e of zonderNaam) {
    const v = (e.visitor_id as string) ?? (e.id as unknown as string);
    perBezoeker.set(v, [...(perBezoeker.get(v) ?? []), e]);
  }
  const bezoekers = [...perBezoeker.values()]
    .sort((a, b) => String(b[0].occurred_at).localeCompare(String(a[0].occurred_at)));

  return (
    <>
      <h1 className="zin">Contactpogingen zonder naam</h1>
      <p className="periode">
        {start} tot {eind}
        <span className="scheider">|</span>
        {[7, 30, 90].map((d, i) => (
          <span key={d}>
            {i > 0 && <span className="scheider">/</span>}
            <a href={`/contactpogingen?d=${d}${klantSlug ? `&klant=${klantSlug}` : ''}`}
               aria-current={d === dagen ? 'true' : undefined}>{d} dagen</a>
          </span>
        ))}
      </p>

      <p className="uitleg">
        Iemand klikte op WhatsApp, je telefoonnummer of je e-mailadres. Wie het
        was weten we niet: dat gesprek gaat verder op de telefoon, buiten de
        website om. Wél weten we uit welke advertentie en op welk zoekwoord hij
        binnenkwam. Leg deze lijst naast je WhatsApp — herken je er een, dan
        maak je er een lead van en hangt het hele voortraject er alsnog aan.
      </p>

      <div className="grootboek">
        <div className="post">
          <div className="naam">Pogingen</div>
          <div className="cijfer">{getal(zonderNaam.length)}</div>
        </div>
        <div className="post">
          <div className="naam">Mensen</div>
          <div className="cijfer">{getal(bezoekers.length)}</div>
          <div className="bij">sommigen probeerden het vaker</div>
        </div>
        <div className="post">
          <div className="naam">WhatsApp</div>
          <div className="cijfer">
            {getal(zonderNaam.filter((e) => e.event_type === 'whatsapp_click').length)}
          </div>
        </div>
        <div className="post">
          <div className="naam">Telefoon</div>
          <div className="cijfer">
            {getal(zonderNaam.filter((e) => e.event_type === 'phone_click').length)}
          </div>
        </div>
        <div className={`post${metNaam ? '' : ' wacht'}`}>
          <div className="naam">Later herkend</div>
          <div className="cijfer">{getal(metNaam)}</div>
          <div className="bij">alsnog aan een lead gekoppeld</div>
        </div>
      </div>

      {bezoekers.length === 0 ? (
        <div className="niets" style={{ marginTop: 24 }}>
          <strong>Nog niemand</strong>
          <p>
            Er heeft in deze periode niemand op WhatsApp, je telefoonnummer of
            je e-mailadres geklikt.
          </p>
        </div>
      ) : (
        <>
          <h2>Wie het probeerde</h2>
          <div className="tabelrol">
            <table>
              <thead>
                <tr>
                  <th>Wanneer</th>
                  <th>Hoe</th>
                  <th>Website</th>
                  <th>Kwam binnen via</th>
                  <th>Op de pagina</th>
                </tr>
              </thead>
              <tbody>
                {bezoekers.map((groep) => {
                  const e = groep[0];
                  return (
                    <tr key={e.id as number}>
                      <td>
                        <span className="hoofd">{tijdstip(e.occurred_at as string)}</span>
                        {groep.length > 1 && (
                          <span className="onder">{groep.length}× geprobeerd</span>
                        )}
                      </td>
                      <td>
                        {groep.map((g, i) => (
                          <span key={g.id as number}>
                            {i > 0 && ', '}
                            {LABEL[g.event_type as string] ?? (g.event_type as string)}
                          </span>
                        ))}
                      </td>
                      <td>{siteNaam.get(e.website_id as string) ?? '—'}</td>
                      <td>
                        {e.campaign ? (
                          <>
                            <span className="hoofd">{e.campaign as string}</span>
                            {e.term && <span className="onder">{e.term as string}</span>}
                          </>
                        ) : (
                          <span className="leegwaarde">
                            {[e.source, e.medium].filter(Boolean).join(' / ') || 'rechtstreeks'}
                          </span>
                        )}
                      </td>
                      <td className="code">{(e.page_path as string) || '/'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <p className="uitleg" style={{ marginTop: 20 }}>
            Wil je dit automatisch koppelen, dan kan er een kort kenmerk in de
            WhatsApp-link mee, zodat het bericht dat binnenkomt begint met
            bijvoorbeeld &quot;(ref 7K2M)&quot;. Dat kenmerk hoort bij deze
            bezoeker, en dan hangt het voortraject er vanzelf aan.
          </p>
        </>
      )}
    </>
  );
}
