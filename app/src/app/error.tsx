'use client';

/**
 * Vangnet voor alles wat misgaat tijdens het renderen.
 *
 * Next.js toont in productie standaard alleen een digest-nummer. Dat is voor
 * een publieke site verstandig, maar dit is een intern dashboard: hier wil je
 * lezen wat er stuk is in plaats van in de logs te moeten graven.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <>
      <h1>Er ging iets mis</h1>
      <p className="onder">Bij het ophalen van de gegevens.</p>
      <div className="kaart">
        <h3>Foutmelding</h3>
        <div className="body">
          <pre
            className="mono"
            style={{
              background: 'var(--surface-2)', border: '1px solid var(--line-soft)',
              padding: '12px 14px', fontSize: 12, overflowX: 'auto',
              whiteSpace: 'pre-wrap', marginTop: 0,
            }}
          >{error.message || 'onbekende fout'}</pre>
          {error.digest && (
            <p className="zacht mono" style={{ fontSize: 11.5 }}>digest {error.digest}</p>
          )}
          <p style={{ marginBottom: 0 }}>
            <button
              onClick={reset}
              style={{
                font: 'inherit', fontFamily: 'var(--mono)', fontSize: 12,
                padding: '6px 12px', cursor: 'pointer',
                border: '1px solid var(--accent)', borderRadius: 2,
                background: 'var(--accent-2)', color: 'var(--accent)',
              }}
            >
              opnieuw proberen
            </button>
          </p>
        </div>
      </div>
    </>
  );
}
