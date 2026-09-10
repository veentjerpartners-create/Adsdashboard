import { notFound } from 'next/navigation';
import { config, db } from '@/lib/db';
import { Setup } from '@/components/Setup';
import { datum, klok, tijdstip } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function LeadDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
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
    s.from('client').select('name,default_margin_pct').eq('id', lead.client_id).maybeSingle(),
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

  const typeInfo = new Map((types.data ?? []).map((t) => [t.code as string, t]));
  const rijen = events.data ?? [];

  // Het event waarmee we wisten wie dit was.
  const identEvent = rijen.find((e) =>
    ['form_submit', 'quote_request', 'inbound_call'].includes(e.event_type as string));

  // Wat markeren we als "achteraf gekoppeld"? Alleen events uit een EERDERE
  // sessie. Alles binnen dezelfde sessie als de aanvraag was strikt genomen ook
  // anoniem op het moment zelf, maar dat op elke regel zetten is ruis -- het
  // gaat om het verschil tussen "hij vulde net het formulier in" en "hij was
  // hier drie dagen geleden al, en dat wisten we toen niet".
  const identSessie = identEvent?.session_id as string | undefined;
  const identMoment = identEvent?.occurred_at as string | undefined;

  // Groeperen per sessie, in volgorde van het eerste event.
  const sessies: { id: string; events: typeof rijen }[] = [];
  for (const e of rijen) {
    const sid = (e.session_id as string) ?? 'los';
    const laatste = sessies[sessies.length - 1];
    if (laatste && laatste.id === sid) laatste.events.push(e);
    else sessies.push({ id: sid, events: [e] });
  }

  const stitchMethode = (identiteiten.data ?? []).find((i) => i.kind === 'visitor_id');

  return (
    <>
      <p className="onder" style={{ marginBottom: 8 }}>
        <a href="/leads">← alle leads</a>
      </p>
      <h1>
        {(lead.name as string) || 'Lead zonder naam'}{' '}
        <span className="mono zacht" style={{ fontSize: '0.55em' }}>
          #{lead.public_ref as number}
        </span>
      </h1>
      <p className="onder">
        <span className={`badge ${lead.status as string}`}>{lead.status as string}</span>
        {' · '}{klant?.data?.name ?? '—'}
        {site?.data?.domain ? ` · ${site.data.domain}` : ''}
        {' · binnengekomen '}{tijdstip(lead.created_at as string)}
      </p>

      <div className="kolommen">
        <div>
          <div className="kaart" style={{ marginBottom: 24 }}>
            <h3>Tijdlijn</h3>
            {sessies.length === 0 ? (
              <div className="body zacht">
                Geen events. Deze lead kwam binnen zonder collector — via de
                mailparser of handmatig ingevoerd.
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
                      <b>Sessie {i + 1}</b>
                      <span>{datum(eerste.occurred_at as string)}</span>
                      <span>{bron || 'direct'}</span>
                      {eerste.campaign ? <span>{eerste.campaign as string}</span> : null}
                      <span>{sessie.events.length} events</span>
                      {duur > 0 && <span>{duur} min</span>}
                    </div>
                    {sessie.events.map((e) => {
                      const info = typeInfo.get(e.event_type as string);
                      const voorIdent = Boolean(
                        identMoment && identSessie &&
                        (e.occurred_at as string) < identMoment &&
                        (e.session_id as string) !== identSessie);
                      const meta = (e.metadata ?? {}) as Record<string, unknown>;
                      const extra = Object.entries(meta)
                        .filter(([k, v]) => v !== '' && v != null && k !== 'bot')
                        .map(([k, v]) => `${k}: ${v}`)
                        .join(' · ');
                      return (
                        <div className={`rij${info?.is_conversion ? ' conv' : ''}`} key={e.id as number}>
                          <span className="t">{klok(e.occurred_at as string)}</span>
                          <span>
                            <span className="e">
                              {(info?.label as string) ?? (e.event_type as string)}
                            </span>
                            {e.page_path ? <span className="m"> {e.page_path as string}</span> : null}
                            {extra ? <span className="m"> · {extra}</span> : null}
                            {voorIdent && (
                              <> <span className="tag">anoniem, achteraf gekoppeld</span></>
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

          <div className="kaart">
            <h3>Offertes, deals en winst</h3>
            <div className="body zacht">
              Nog niet gebouwd — dat is fase 3. Hier komen straks het
              offertebedrag, de orderwaarde, de marge en de winst na
              advertentiekosten te staan.
              {klant?.data?.default_margin_pct == null && (
                <>
                  {' '}Voor {klant?.data?.name ?? 'deze klant'} is nog geen standaard­marge
                  ingevuld; zonder dat percentage kan er geen winstcijfer uit een
                  kale orderwaarde komen.
                </>
              )}
            </div>
          </div>
        </div>

        <aside>
          <div className="kaart" style={{ marginBottom: 24 }}>
            <h3>Contact</h3>
            <div className="body">
              <dl className="paar">
                <dt>Naam</dt><dd>{(lead.name as string) || '—'}</dd>
                <dt>E-mail</dt>
                <dd>{lead.email ? <a href={`mailto:${lead.email}`}>{lead.email as string}</a> : '—'}</dd>
                <dt>Telefoon</dt>
                <dd>{lead.phone_e164
                  ? <a href={`tel:${lead.phone_e164}`}>{lead.phone_e164 as string}</a>
                  : ((lead.phone as string) || '—')}</dd>
                <dt>Onderwerp</dt><dd>{(lead.subject as string) || '—'}</dd>
                <dt>Type</dt><dd className="mono">{lead.lead_type as string}</dd>
                <dt>Toestemming</dt>
                <dd>{lead.consent_marketing === true ? 'ja'
                   : lead.consent_marketing === false ? 'nee' : 'onbekend'}</dd>
              </dl>
            </div>
          </div>

          <div className="kaart" style={{ marginBottom: 24 }}>
            <h3>Marketing attributie</h3>
            <div className="body">
              <dl className="paar">
                <dt>Source</dt><dd className="mono">{(lead.source as string) || '—'}</dd>
                <dt>Medium</dt><dd className="mono">{(lead.medium as string) || '—'}</dd>
                <dt>Campagne</dt><dd className="mono">{(lead.campaign as string) || '—'}</dd>
                <dt>Adgroep</dt>
                <dd className="mono">{(lead.ad_group as string) || (klik?.data?.ad_group_id ? String(klik.data.ad_group_id) : '—')}</dd>
                <dt>Zoekwoord</dt>
                <dd className="mono">{(lead.keyword as string) || (klik?.data?.keyword_text as string) || '—'}</dd>
                <dt>Click-ID</dt>
                <dd className="mono" style={{ fontSize: 11 }}>
                  {lead.click_id ? `${String(lead.click_id).slice(0, 28)}…` : '—'}
                  {lead.click_type ? <span className="zacht"> ({lead.click_type as string})</span> : null}
                </dd>
                <dt>Landingspagina</dt>
                <dd className="mono" style={{ fontSize: 11 }}>{(lead.landing_page as string) || '—'}</dd>
                <dt>Apparaat</dt>
                <dd className="mono">{(lead.device_type as string) || (klik?.data?.device as string) || '—'}</dd>
                <dt>Eerst gezien</dt><dd>{tijdstip(lead.first_seen_at as string)}</dd>
              </dl>
              {klik?.data && (
                <p className="zacht" style={{ fontSize: 12, marginTop: 12, marginBottom: 0 }}>
                  Campagne en adgroep komen uit <span className="mono">click_view</span>,
                  gematcht op de gclid van {datum(klik.data.click_date as string)}.
                </p>
              )}
            </div>
          </div>

          <div className="kaart">
            <h3>Hoe we weten dat dit één persoon is</h3>
            <div className="body">
              {(identiteiten.data ?? []).length === 0 ? (
                <p className="zacht" style={{ margin: 0 }}>Geen koppelingen vastgelegd.</p>
              ) : (
                <dl className="paar">
                  {(identiteiten.data ?? []).map((i) => (
                    <div key={`${i.kind}-${i.value}`} style={{ display: 'contents' }}>
                      <dt className="mono" style={{ fontSize: 11.5 }}>{i.kind as string}</dt>
                      <dd className="mono" style={{ fontSize: 11.5 }}>
                        {i.method as string}
                        <span className="zacht"> · {Number(i.confidence).toFixed(2)}</span>
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
              {stitchMethode && (
                <p className="zacht" style={{ fontSize: 12, marginTop: 12, marginBottom: 0 }}>
                  De events van vóór de aanvraag zijn achteraf gekoppeld op
                  bezoeker-id. Klopt dat niet, dan is het terug te draaien —
                  daarom staat het hier.
                </p>
              )}
              {historie.data && historie.data.length > 0 && (
                <>
                  <p className="zacht" style={{ fontSize: 11, marginTop: 16, marginBottom: 4,
                       textTransform: 'uppercase', letterSpacing: '.08em' }}>
                    Statusverloop
                  </p>
                  {historie.data.map((h, i) => (
                    <div key={i} className="mono zacht" style={{ fontSize: 11.5 }}>
                      {tijdstip(h.changed_at as string)} · {h.to_status as string}
                    </div>
                  ))}
                </>
              )}
            </div>
          </div>
        </aside>
      </div>
    </>
  );
}
