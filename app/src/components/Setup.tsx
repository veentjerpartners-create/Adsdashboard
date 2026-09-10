import type { Config } from '@/lib/db';

/**
 * Wat je ziet als een instelling ontbreekt.
 *
 * Bewust geen foutscherm met een digest-nummer: een onafgemaakte configuratie
 * is geen storing, en hoort te vertellen welke variabele mist en waar hij hoort.
 */
export function Setup({ config }: { config: Config }) {
  return (
    <>
      <h1 className="zin">
        Het dashboard kan de database nog niet bereiken.
      </h1>

      <div className="blok">
        <h3>Wat er ontbreekt</h3>
        <dl className="lijst">
          {config.ontbreekt.map((o) => (
            <div key={o.naam} style={{ display: 'contents' }}>
              <dt className="code">{o.naam}</dt>
              <dd>{o.uitleg}</dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="niets">
        <strong>Waar je ze zet</strong>
        <p>
          Op Vercel: Project, dan Settings, dan Environment Variables. Voeg je
          er een toe, deploy dan opnieuw — een bestaande deployment pikt nieuwe
          variabelen niet vanzelf op. Dat is de gewoonste reden dat dit scherm
          blijft staan terwijl je zeker weet dat je het goed hebt ingevuld.
        </p>
        <p>Lokaal horen ze in <code>app/.env.local</code>. Het dashboard heeft er drie nodig:</p>
        <p className="code" style={{ color: 'var(--tekst-2)', lineHeight: 1.9 }}>
          MI_SUPABASE_URL=https://xxxx.supabase.co<br />
          MI_SUPABASE_KEY=sb_secret_…<br />
          MI_DB_SCHEMA=mi
        </p>
        <p>
          De sleutels voor Google Ads en de mailbox horen hier niet: die draaien
          bij de nachtelijke sync. Hoe minder sleutels op één plek, hoe kleiner
          de schade als er ooit iets uitlekt.
        </p>
      </div>
    </>
  );
}
