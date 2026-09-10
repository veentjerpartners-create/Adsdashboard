import { notFound } from 'next/navigation';
import { config, db } from '@/lib/db';
import { datum, klok, tijdstip } from '@/lib/format';
import { Setup } from '@/components/Setup';

export const dynamic = 'force-dynamic';

/** Events die betekenen dat er iets gebeurde dat geld waard is. */
const MIJLPALEN = new Set([
  'form_submit', 'quote_request', 'inbound_call', 'phone_click',
  'whatsapp_click', 'offer_signed', 'deal_won',
]);

export default async function LeadDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const cfg = config();
  if (cfg.ontbreekt.length) return <Setup config={cfg} />;

  const s = db();
  const { data: lead } = await s.from('lead').select('*').eq('id', id).maybeSingle();
  if (!lead) notFound();

  const [events, identiteiten, historie, klant, site, types, klik] = await Promise.all([
    s.from('lead_event')
      .select('id,event_type,occurred_at,page_path,page_type,session_id,metadata,source,medium,campaign,click_id')
      .eq('lead_id', id).order('occurred_at', { ascending: true }),
    s.from('lead_identity').select('kind,value,confidence,method,matched_at').eq('lead_id', id),
    s.from('lead_status_history').select('from_status,to_status,changed_at,note')
      .eq('lead_id', id).order('changed_at', { ascending: true }),
    s.from('client').select('name,slug,default_margin_pct').eq('id', lead.client_id).maybeSingle(),
    lead.website_id
      ? s.from('website').select('domain').eq('id', lead.website_id).maybeSingle()
      : Promise.resolve({ data: null }),
    s.from('event_type').select('code,label,category,is_conversion'),
    lead.click_id
      ? s.from('ads_click')
          .select('click_id,click_date,campaign_id,ad_group_id,keyword_text,device,ad_network')
          .eq('click_id', lead.click_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const typeNaam = new Map((types.data ?? []).map((t) => [t.code as string, t.label as string]));
  const rijen = events.data ?? [];

  // Het event waarmee we wisten wie dit was.
  const ident = rijen.find((e) =>
    ['form_submit', 'quote_request', 'inbound_call'].includes(e.event_type as string));
  const identSessie = ident?.session_id as string | undefined;
  const identMoment = ident?.occurred_at as string | undefined;

  // Groeperen per sessie, in volgorde van het eerste event.
  const sessies: { id: string; events: typeof rijen }[] = [];
  for (const e of rijen) {
    const sid = (e.session_id as string) ?? 'los';
    const laatste = sessies[sessies.length - 1];
    if (laatste && laatste.id === sid) laatste.events.push(e);
    else sessies.push({ id: sid, events: [e] });
  }

  const gestitcht = (identiteiten.data ?? []).some((i) => i.method === 'visitor_stitch');

  return (
    <>
      <p className="periode">
        <a href="/leads">Alle leads</a>
        {klant?.data?.slug && (
          <>
            <span className="scheider">/</span>
            <a href={`/leads?klant=${klant.data.slug}`}>{klant.data.name as string}</a>
          </>
        )}
      </p>

      <h1 className="zin">
        {(lead.name as string) || 'Lead zonder naam'}
        {lead.campaign ? (
          <> kwam binnen via <b>{lead.campaign as string}</b>.</>
        ) : lead.source ? (
          <> kwam binnen via <b>{lead.source as string}</b>.</>
        ) : '.'}
      </h1>
      <p className="periode">
        nr {lead.public_ref as number}
        <span className="scheider">|</span>
        {tijdstip(lead.created_at as string)}
        {site?.data?.domain && (
          <><span className="scheider">|</span>{site.data.domain as string}</>
        )}
      </p>

      <div className="tweeluik">
        <div>
          <div className="blok">
            <h3>Wat deze persoon deed</h3>
            {sessies.length === 0 ? (
              <div className="niets">
                <strong>Geen gedrag vastgelegd</strong>
                <p>
                  Deze lead kwam binnen zonder collector, via de mailparser of
                  handmatig. Naam en herkomst kloppen; wat hij op de site deed
                  weten we niet.
                </p>
              </div>
            ) : (
              sessies.map((sessie, i) => {
                const eerste = sessie.events[0];
                const laatste = sessie.events[sessie.events.length - 1];
                const duur = Math.round(
                  (new Date(laatste.occurred_at as string).getTime() -
                   new Date(eerste.occurred_at as string).getTime()) / 60000);
                const bron = [eerste.source, eerste.medium].filter(Boolean).join(' / ');
                return (
                  <div className="sessie" key={sessie.id + i}>
                    <div className="sessiekop">
                      <b>{datum(eerste.occurred_at as string)}</b>
                      <span>{bron || 'rechtstreeks'}</span>
                      {eerste.campaign ? <span>{eerste.campaign as string}</span> : null}
                      <span>{duur > 0 ? `${duur} min` : 'binnen een minuut'}</span>
                    </div>
                    {sessie.events.map((e) => {
                      const voorheen = Boolean(
                        identMoment && identSessie &&
                        (e.occurred_at as string) < identMoment &&
                        (e.session_id as string) !== identSessie);
                      const meta = (e.metadata ?? {}) as Record<string, unknown>;
                      const extra = Object.entries(meta)
                        .filter(([k, v]) => v !== '' && v != null && k !== 'bot')
                        .map(([, v]) => String(v))
                        .join(', ');
                      return (
                        <div
                          className={`beurt${MIJLPALEN.has(e.event_type as string) ? ' mijlpaal' : ''}`}
                          key={e.id as number}
                        >
                          <span className="spoor" />
                          <span className="stond">{klok(e.occurred_at as string)}</span>
                          <span>
                            <span className="wat">
                              {typeNaam.get(e.event_type as string) ?? (e.event_type as string)}
                            </span>
                            {e.page_path ? (
                              <span className="waar"> {e.page_path as string}</span>
                            ) : null}
                            {extra ? <span className="waar"> — {extra}</span> : null}
                            {voorheen && (
                              <span className="voorheen">toen nog anoniem</span>
                            )}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                );
              })
            )}
          </div>

          <div className="blok">
            <h3>Offerte, deal en winst</h3>
            <div className="niets">
              <strong>Nog niet in gebruik</strong>
              <p>
                Hier komen het offertebedrag, de orderwaarde, de marge en de
                winst na advertentiekosten.
                {klant?.data?.default_margin_pct == null && (
                  <> Voor {klant?.data?.name ?? 'deze klant'} staat nog geen
                  standaardmarge; zonder dat percentage valt uit een kale
                  orderwaarde geen winst af te leiden.</>
                )}
              </p>
            </div>
          </div>
        </div>

        <aside>
          <div className="blok">
            <h3>Contact</h3>
            <dl className="lijst">
              <dt>Naam</dt><dd>{(lead.name as string) || '—'}</dd>
              <dt>E-mail</dt>
              <dd>{lead.email ? <a href={`mailto:${lead.email}`}>{lead.email as string}</a> : '—'}</dd>
              <dt>Telefoon</dt>
              <dd>
                {lead.phone_e164
                  ? <a href={`tel:${lead.phone_e164}`}>{lead.phone_e164 as string}</a>
                  : ((lead.phone as string) || '—')}
              </dd>
              <dt>Onderwerp</dt><dd>{(lead.subject as string) || '—'}</dd>
              <dt>Toestemming</dt>
              <dd>
                {lead.consent_marketing === true ? 'gegeven'
                  : lead.consent_marketing === false ? 'niet gegeven' : 'onbekend'}
              </dd>
            </dl>
          </div>

          <div className="blok">
            <h3>Waar hij vandaan kwam</h3>
            <dl className="lijst">
              <dt>Bron</dt>
              <dd>{[lead.source, lead.medium].filter(Boolean).join(' / ') || '—'}</dd>
              <dt>Campagne</dt><dd>{(lead.campaign as string) || '—'}</dd>
              <dt>Advertentiegroep</dt>
              <dd>{(lead.ad_group as string) ||
                   (klik?.data?.ad_group_id ? String(klik.data.ad_group_id) : '—')}</dd>
              <dt>Zoekwoord</dt>
              <dd>{(lead.keyword as string) || (klik?.data?.keyword_text as string) || '—'}</dd>
              <dt>Landingspagina</dt>
              <dd className="code">{(lead.landing_page as string) || '—'}</dd>
              <dt>Apparaat</dt>
              <dd>{(lead.device_type as string) || (klik?.data?.device as string) || '—'}</dd>
              <dt>Eerste bezoek</dt><dd>{tijdstip(lead.first_seen_at as string)}</dd>
              <dt>Klik-id</dt>
              <dd className="code" style={{ fontSize: 11 }}>
                {lead.click_id ? `${String(lead.click_id).slice(0, 26)}…` : '—'}
              </dd>
            </dl>
            {klik?.data && (
              <p className="uitleg" style={{ marginTop: 12, marginBottom: 0, fontSize: 12.5 }}>
                Campagne en advertentiegroep zijn opgezocht bij de advertentieklik
                van {datum(klik.data.click_date as string)}.
              </p>
            )}
          </div>

          <div className="blok">
            <h3>Waarom dit één persoon is</h3>
            {(identiteiten.data ?? []).length === 0 ? (
              <p className="uitleg" style={{ margin: 0 }}>Geen koppelingen vastgelegd.</p>
            ) : (
              <dl className="lijst">
                {(identiteiten.data ?? []).map((i) => (
                  <div key={`${i.kind}-${i.value}`} style={{ display: 'contents' }}>
                    <dt>{herkenning(i.method as string)}</dt>
                    <dd>{(Number(i.confidence) * 100).toFixed(0)}% zeker</dd>
                  </div>
                ))}
              </dl>
            )}
            {gestitcht && (
              <p className="uitleg" style={{ marginTop: 12, marginBottom: 0, fontSize: 12.5 }}>
                Wat hij vóór de aanvraag deed is achteraf gekoppeld op zijn
                bezoeker-id. Klopt dat niet, dan is het terug te draaien — daarom
                staat het hier en niet verstopt.
              </p>
            )}
            {historie.data && historie.data.length > 0 && (
              <>
                <h3 style={{ marginTop: 26 }}>Verloop</h3>
                <dl className="lijst">
                  {historie.data.map((h, i) => (
                    <div key={i} style={{ display: 'contents' }}>
                      <dt>{tijdstip(h.changed_at as string)}</dt>
                      <dd>{h.to_status as string}</dd>
                    </div>
                  ))}
                </dl>
              </>
            )}
          </div>
        </aside>
      </div>
    </>
  );
}

/** De matchmethode in gewone taal. */
function herkenning(methode: string): string {
  switch (methode) {
    case 'exact_lead_id': return 'Dezelfde inzending';
    case 'visitor_stitch': return 'Zelfde browser';
    case 'email_match': return 'Zelfde e-mailadres';
    case 'phone_match': return 'Zelfde telefoonnummer';
    case 'ga_client_bridge': return 'Zelfde Analytics-bezoeker';
    default: return methode;
  }
}
