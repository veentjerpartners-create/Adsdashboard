/**
 * Het Veentjer-merkteken: vier blokken in een 2x2 raster.
 *
 * Nagebouwd in CSS in plaats van het PNG-logo te laden. Scherp op elk scherm,
 * geen extra verzoek, en de kleuren komen uit dezelfde tokens als de rest van
 * het scherm -- zo blijft het merk en het dashboard hetzelfde ding.
 */
export function Merkteken() {
  return (
    <span className="blokken" aria-hidden="true">
      <i /><i /><i /><i />
    </span>
  );
}
