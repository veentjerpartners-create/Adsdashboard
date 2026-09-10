import type { Metadata } from 'next';
import './globals.css';
import { config, db } from '@/lib/db';
import { Merkteken } from '@/components/Merkteken';

export const metadata: Metadata = {
  title: 'Veentjer Marketing Intelligence',
  description: 'Van advertentieklik tot marge, per klant.',
};

export const dynamic = 'force-dynamic';

type RailKlant = { slug: string; name: string; spend: number };

/**
 * De zijbalk kent de klanten en hun spend, zodat het wisselen tussen klanten
 * een structureel onderdeel van het scherm is en niet een filter dat je moet
 * zoeken. Ook zonder database moet de balk staan -- anders zie je bij een
 * configuratiefout een kaal scherm zonder navigatie.
 */
async function railData(): Promise<{ klanten: RailKlant[]; adsSync: string | null }> {
  if (config().ontbreekt.length) return { klanten: [], adsSync: null };
  try {
    const s = db();
    const eind = new Date();
    const start = new Date(eind);
    start.setUTCDate(start.getUTCDate() - 29);
    const dag = (d: Date) => d.toISOString().slice(0, 10);

    const [klanten, accounts, metrics, cursors] = await Promise.all([
      s.from('client').select('id,name,slug').order('name'),
      s.from('ads_account').select('id,client_id,is_manager'),
      s.from('v_campaign_daily').select('ads_account_id,cost')
        .gte('date', dag(start)).lte('date', dag(eind)),
      s.from('sync_cursor').select('connector,last_ok_at'),
    ]);

    const klantVanAccount = new Map<string, string>();
    for (const a of accounts.data ?? []) {
      if (!a.is_manager && a.client_id) klantVanAccount.set(a.id as string, a.client_id as string);
    }
    const spend = new Map<string, number>();
    for (const m of metrics.data ?? []) {
      const k = klantVanAccount.get(m.ads_account_id as string);
      if (k) spend.set(k, (spend.get(k) ?? 0) + Number(m.cost ?? 0));
    }

    return {
      klanten: (klanten.data ?? []).map((k) => ({
        slug: k.slug as string,
        name: k.name as string,
        spend: spend.get(k.id as string) ?? 0,
      })),
      adsSync: (cursors.data ?? []).find((c) =>
        String(c.connector).startsWith('google_ads'))?.last_ok_at as string ?? null,
    };
  } catch {
    return { klanten: [], adsSync: null };
  }
}

function geleden(iso: string | null) {
  if (!iso) return 'nog niet gedraaid';
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 60) return `${min} min geleden`;
  const uur = Math.round(min / 60);
  if (uur < 48) return `${uur} uur geleden`;
  return `${Math.round(uur / 24)} dagen geleden`;
}

const euro = (n: number) =>
  new Intl.NumberFormat('nl-NL', {
    style: 'currency', currency: 'EUR', maximumFractionDigits: 0,
  }).format(n);

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const { klanten, adsSync } = await railData();

  return (
    <html lang="nl">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&family=Archivo:wght@400;500;600&family=IBM+Plex+Mono:wght@400&display=swap"
        />
      </head>
      <body>
        <div className="schil">
          <nav className="rail">
            <a className="merk" href="/">
              <Merkteken />
              <span className="merk-naam">
                Veentjer
                <span>Marketing Intelligence</span>
              </span>
            </a>

            <div>
              <p className="railkop">Klanten</p>
              <div className="railgroep">
                <a className="railitem" href="/">Alle klanten</a>
                {klanten.map((k) => (
                  <a key={k.slug} className="railitem" href={`/klant/${k.slug}`}>
                    {k.name}
                    <span className="bedrag">{k.spend > 0 ? euro(k.spend) : '—'}</span>
                  </a>
                ))}
              </div>
            </div>

            <div>
              <p className="railkop">Alles</p>
              <div className="railgroep">
                <a className="railitem" href="/leads">Leads</a>
                <a className="railitem" href="/zoektermen">Waar je voor betaalt</a>
              </div>
            </div>

            <div className="railvoet">
              Leads komen binnen zodra ze gebeuren.<br />
              Google Ads bijgewerkt <b>{geleden(adsSync)}</b>.
            </div>
          </nav>

          <div className="inhoud">{children}</div>
        </div>
      </body>
    </html>
  );
}
