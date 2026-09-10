import type { Metadata } from 'next';
import './globals.css';
import { db } from '@/lib/db';

export const metadata: Metadata = {
  title: 'Marketing Intelligence',
  description: 'Van advertentieklik tot marge, per lead.',
};

export const dynamic = 'force-dynamic';

/** Hoe oud is elk cijfer? Dit hoort in beeld, niet verstopt in een instelling:
 *  leads zijn live, Google Ads is van gisteren, GA4 loopt twee dagen achter. */
async function versheid() {
  try {
    const { data } = await db()
      .from('sync_cursor')
      .select('connector,last_ok_at')
      .order('last_ok_at', { ascending: false });
    const laatste = (prefix: string) =>
      data?.find((r) => r.connector?.startsWith(prefix))?.last_ok_at ?? null;
    return { ads: laatste('google_ads'), ga4: laatste('ga4') };
  } catch {
    return { ads: null, ga4: null };
  }
}

function geleden(iso: string | null) {
  if (!iso) return 'nooit';
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 60) return `${min} min geleden`;
  const uur = Math.round(min / 60);
  if (uur < 48) return `${uur} uur geleden`;
  return `${Math.round(uur / 24)} dagen geleden`;
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const v = await versheid();
  return (
    <html lang="nl">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Newsreader:wght@400;500&family=Archivo:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap"
        />
      </head>
      <body>
        <header className="top">
          <div className="top-inner">
            <a className="merk" href="/">Marketing Intelligence</a>
            <nav className="nav">
              <a href="/">Overzicht</a>
              <a href="/leads">Leads</a>
            </nav>
            <div className="vers">
              <span>leads <b>live</b></span>
              <span>ads <b>{geleden(v.ads)}</b></span>
              <span>ga4 <b>{v.ga4 ? geleden(v.ga4) : 'nog niet'}</b></span>
            </div>
          </div>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
