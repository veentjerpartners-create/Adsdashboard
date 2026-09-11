import { notFound } from 'next/navigation';
import { config, db } from '@/lib/db';
import { datum, klok, tijdstip } from '@/lib/format';
import { Setup } from '@/components/Setup';
import { koppelBezoeker, ontkoppelBezoeker } from './acties';

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

  // Dezelfde persoon, een andere aanvraag: zelfde e-mail of telefoon bij
  // dezelfde klant. Twee apparaten, twee bezoeker-id's, één mens.
  const hashes = [lead.email_sha256, lead.phone_sha256].filter(Boolean) as string[];
  const orFilter = [
    lead.email_sha256 ? `email_sha256.eq.${lead.email_sha256}` : null,
    lead.phone_sha256 ? `phone_sha256.eq.${lead.phone_sha256}` : null,
  ].filter(Boolean).join(',');
  const gemaakt = lead.created_at as string;
  const veertienDagenEerder = new Date(new Date(gemaakt).getTime() - 14 * 24 * 3600 * 1000).toISOString();
  const handmatig = new Set(
    (identiteiten.data ?? [])
      .filter((i) => i.kind === 'visitor_id' && i.method === 'manual_stitch')
      .map((i) => i.value as string));

  const [dezelfde, kandidaten] = await Promise.all([
    hashes.length
      ? s.from('lead').select('id,public_ref,name,subject,created_at,campaign,source,status')
          .eq('client_id', lead.client_id).neq('id', id).is('deleted_at', null)
          .or(orFilter).order('created_at', { ascending: false }).limit(10)
      : Promise.resolve({ data: [] as Record<string, unknown>[] }),
    // Anonieme contactpogingen bij deze klant in de twee weken vóór de
    // aanvraag, van een andere bezoeker: was dat misschien deze persoon?
    s.from('lead_event')
      .select('id,visitor_id,event_type,occurred_at,page_path,source,medium,campaign,click_id')
      .eq('client_id', lead.client_id).is('lead_id', null)
      .in('event_type', ['whatsapp_click', 'phone_click', 'email_click'])
      .gte('occurred_at', veertienDagenEerder).lte('occurred_at', gemaakt)
      .neq('visitor_id', (lead.first_visitor_id as string) ?? '00000000-0000-0000-0000-000000000000')
      .order('occurred_at', { ascending: false }).limit(60),
  ]);

  type Kandidaat = { visitor: string; events: NonNullable<typeof kandidaten.data> };
  const perKandidaat = new Map<string, Kandidaat>();
  for (const e of kandidaten.data ?? []) {
    const v = e.visitor_id as string;
    if (!v) continue;
    const k = perKandidaat.get(v) ?? { visitor: v, events: [] };
    k.events.push(e);
    perKandidaat.set(v, k);
  }
  const kandidaatRijen = [...perKandidaat.values()].slice(0, 8);

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

  // Wat het formulier verder nog meegaf: de dienst van de pagina, de plaats,
  // welk formulier. Alleen tonen wat er is.
  const LABEL: Record<string, string> = {
    service: 'Dienst', city: 'Plaats', plaats: 'Plaats', form_id: 'Formulier',
    source_page: 'Vanaf pagina',
  };
  const aanvraagMeta: [string, string][] = Object.entries(
    ((ident?.metadata ?? {}) as Record<string, unknown>))
    .filter(([k, v]) => LABEL[k] && v !== '' && v != null)
    .filter(([k]) => !(k === 'city' || k === 'plaats') || !lead.city)
    .map(([k, v]) => [LABEL[k], String(v)]);

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
        {lead.subject ? <> vraagt naar <b>{String(lead.subject).toLowerCase()}</b> en</> : null}
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
            <h3>De aanvraag</h3>
            <dl className="lijst">
              <dt>Soort</dt><dd>{soort(lead.lead_type as string)}</dd>
              <dt>Onderwerp</dt><dd>{(lead.subject as string) || '—'}</dd>
              {aanvraagMeta.map(([k, v]) => (
                <div key={k} style={{ display: 'contents' }}>
                  <dt>{k}</dt><dd>{v}</dd>
                </div>
              ))}
              {lead.city ? <><dt>Plaats</dt><dd>{lead.city as string}</dd></> : null}
              {lead.budget_band ? <><dt>Budget</dt><dd>{lead.budget_band as string}</dd></> : null}
            </dl>
            {lead.message ? (
              <p className="bericht">{lead.message as string}</p>
            ) : (
              <p className="uitleg" style={{ marginTop: 12, marginBottom: 0, fontSize: 12.5 }}>
                {lead.ingest_source === 'collector'
                  ? 'Geen bericht meegekomen. Aanvragen van vóór 11 september 2026 hebben er geen; kijk in de Formspree-mail.'
                  : 'Geen bericht bekend.'}
              </p>
            )}
          </div>

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

          {((dezelfde.data ?? []).length > 0 || kandidaatRijen.length > 0 || handmatig.size > 0) && (
            <div className="blok">
              <h3>Dezelfde persoon?</h3>

              {(dezelfde.data ?? []).length > 0 && (
                <>
                  <p className="uitleg" style={{ margin: '0 0 10px', fontSize: 12.5 }}>
                    Eerdere aanvragen met hetzelfde e-mailadres of telefoonnummer.
                  </p>
                  <dl className="lijst">
                    {(dezelfde.data ?? []).map((l) => (
                      <div key={l.id as string} style={{ display: 'contents' }}>
                        <dt>{datum(l.created_at as string)}</dt>
                        <dd>
                          <a href={`/leads/${l.id}`}>nr {l.public_ref as number}</a>
                          {l.subject ? ` — ${l.subject as string}` : ''}
                          {(l.campaign || l.source) && (
                            <span className="onder">{(l.campaign as string) || (l.source as string)}</span>
                          )}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </>
              )}

              {(kandidaatRijen.length > 0 || handmatig.size > 0) && (
                <>
                  <p className="uitleg" style={{ margin: '14px 0 10px', fontSize: 12.5 }}>
                    Anonieme contactpogingen bij {klant?.data?.name ?? 'deze klant'} in de
                    twee weken vóór de aanvraag, vanaf een ander apparaat of een andere
                    browser. Herken je er een — bijvoorbeeld uit je WhatsApp — koppel hem
                    dan; het hele voortraject hangt dan aan deze lead. Terugdraaien kan.
                  </p>
                  {kandidaatRijen.map((k) => {
                    const eerste = k.events[k.events.length - 1];
                    const soorten = [...new Set(k.events.map((e) =>
                      typeNaam.get(e.event_type as string) ?? (e.event_type as string)))];
                    return (
                      <form action={koppelBezoeker} className="kandidaat" key={k.visitor}>
                        <input type="hidden" name="lead_id" value={id} />
                        <input type="hidden" name="visitor_id" value={k.visitor} />
                        <div>
                          <span className="hoofd">
                            {tijdstip(eerste.occurred_at as string)}
                            {k.events.length > 1 ? ` · ${k.events.length}×` : ''}
                          </span>
                          <span className="onder">
                            {soorten.join(', ')}
                            {eerste.page_path ? ` op ${eerste.page_path as string}` : ''}
                            {eerste.campaign
                              ? ` · ${eerste.campaign as string}`
                              : eerste.source ? ` · ${eerste.source as string}` : ''}
                            {eerste.click_id ? ' · uit een advertentie' : ''}
                          </span>
                        </div>
                        <button type="submit" className="knop">Koppel</button>
                      </form>
                    );
                  })}
                  {[...handmatig].map((v) => (
                    <form action={ontkoppelBezoeker} className="kandidaat gekoppeld" key={v}>
                      <input type="hidden" name="lead_id" value={id} />
                      <input type="hidden" name="visitor_id" value={v} />
                      <div>
                        <span className="hoofd">Handmatig gekoppelde bezoeker</span>
                        <span className="onder">{v.slice(0, 8)}… — de events staan hierboven in de tijdlijn</span>
                      </div>
                      <button type="submit" className="knop stil">Ontkoppel</button>
                    </form>
                  ))}
                </>
              )}
            </div>
          )}
        </aside>
      </div>
    </>
  );
}

/** Hoe de lead binnenkwam, in gewone taal. */
function soort(leadType: string): string {
  switch (leadType) {
    case 'form': return 'Formulier op de website';
    case 'phone': return 'Telefoongesprek';
    case 'whatsapp': return 'WhatsApp-gesprek';
    case 'email': return 'E-mail';
    case 'manual': return 'Handmatig ingevoerd';
    case 'import': return 'Geïmporteerd';
    default: return leadType;
  }
}

/** De matchmethode in gewone taal. */
function herkenning(methode: string): string {
  switch (methode) {
    case 'exact_lead_id': return 'Dezelfde inzending';
    case 'visitor_stitch': return 'Zelfde browser';
    case 'manual_stitch': return 'Handmatig gekoppeld';
    case 'email_match': return 'Zelfde e-mailadres';
    case 'phone_match': return 'Zelfde telefoonnummer';
    case 'ga_client_bridge': return 'Zelfde Analytics-bezoeker';
    default: return methode;
  }
}
