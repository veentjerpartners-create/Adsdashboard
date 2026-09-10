/**
 * Opmaak. Eén plek, zodat bedragen en datums overal hetzelfde lezen.
 *
 * Tijden altijd in de tijdzone van de klant, nooit die van de server: die stond
 * bij het bouwen op UTC-5 en dat is geen Amsterdam.
 */
const TZ = 'Europe/Amsterdam';

export const eur = (n: number | null | undefined) =>
  n == null
    ? '—'
    : new Intl.NumberFormat('nl-NL', {
        style: 'currency', currency: 'EUR', maximumFractionDigits: 2,
      }).format(n);

export const getal = (n: number | null | undefined) =>
  n == null ? '—' : new Intl.NumberFormat('nl-NL').format(n);

export const pct = (n: number | null | undefined) =>
  n == null ? '—' : new Intl.NumberFormat('nl-NL', {
    style: 'percent', maximumFractionDigits: 1,
  }).format(n);

export const datum = (iso: string | null | undefined) =>
  !iso ? '—' : new Intl.DateTimeFormat('nl-NL', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: TZ,
  }).format(new Date(iso));

export const tijdstip = (iso: string | null | undefined) =>
  !iso ? '—' : new Intl.DateTimeFormat('nl-NL', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    timeZone: TZ,
  }).format(new Date(iso));

export const klok = (iso: string | null | undefined) =>
  !iso ? '—' : new Intl.DateTimeFormat('nl-NL', {
    hour: '2-digit', minute: '2-digit', timeZone: TZ,
  }).format(new Date(iso));

/** Deelt veilig: geeft null in plaats van Infinity of NaN. */
export const deel = (a: number, b: number) => (b ? a / b : null);
