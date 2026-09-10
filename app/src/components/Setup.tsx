import type { Config } from '@/lib/db';

/**
 * Wat je ziet als een instelling ontbreekt.
 *
 * Bewust geen foutscherm met een digest-nummer: een ontbrekende variabele is
 * geen storing maar een onafgemaakte configuratie, en dan hoor je te lezen
 * welke en waar je hem zet.
 */
export function Setup({ config }: { config: Config }) {
  return (
    <>
      <h1>Nog even instellen</h1>
      <p className="onder">
        Het dashboard kan de database niet bereiken omdat
        {config.ontbreekt.length === 1 ? ' een variabele ontbreekt' : ' er variabelen ontbreken'}.
      </p>

      <div className="kaart" style={{ marginBottom: 24 }}>
        <h3>Ontbrekend</h3>
        <div className="body">
          <dl className="paar">
            {config.ontbreekt.map((o) => (
              <div key={o.naam} style={{ display: 'contents' }}>
                <dt className="mono">{o.naam}</dt>
                <dd className="zacht">{o.uitleg}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>

      <div className="kaart">
        <h3>Waar je ze zet</h3>
        <div className="body">
          <p style={{ marginTop: 0 }}>
            <strong>Op Vercel:</strong> Project → Settings → Environment
            Variables. Na het toevoegen moet je opnieuw deployen — bestaande
            deployments pikken nieuwe variabelen niet vanzelf op.
            Dat laatste is de meest voorkomende reden dat dit scherm blijft staan.
          </p>
          <p>
            <strong>Lokaal:</strong> in <code>app/.env.local</code>.
          </p>
          <p style={{ marginBottom: 0 }}>
            Het dashboard heeft er drie nodig, meer niet:
          </p>
          <pre
            className="mono"
            style={{
              background: 'var(--surface-2)', border: '1px solid var(--line-soft)',
              padding: '12px 14px', fontSize: 12, overflowX: 'auto', marginBottom: 0,
            }}
          >{`MI_SUPABASE_URL=https://xxxx.supabase.co
MI_SUPABASE_KEY=sb_secret_...
MI_DB_SCHEMA=mi`}</pre>
          <p className="zacht" style={{ fontSize: 12.5, marginBottom: 0 }}>
            De Google Ads- en mailvariabelen horen hier niet: die draaien bij de
            nachtelijke sync op Railway. Hoe minder sleutels op een plek, hoe
            kleiner de schade als er ooit iets uitlekt.
          </p>
        </div>
      </div>
    </>
  );
}
