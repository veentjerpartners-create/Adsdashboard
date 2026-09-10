"""
Welke dag is het?

Klinkt triviaal, is het niet. Google rapporteert segments.date in de tijdzone
van het ADVERTENTIEACCOUNT, niet in UTC en niet in die van onze server. Die
server stond bij het bouwen op UTC-5: date.today() gaf daar 9 september terwijl
het in Amsterdam al 10 september was. Elk datumvenster stond dus een dag
verkeerd, en dan mis je stelselmatig de nieuwste dag spend.

Daarom nergens date.today() in de connectoren, altijd via deze module met de
tijdzone van het account erbij.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

STANDAARD_TZ = "Europe/Amsterdam"


def _zone(tz: str | None) -> ZoneInfo:
    try:
        return ZoneInfo(tz or STANDAARD_TZ)
    except Exception:  # noqa: BLE001 — onbekende tijdzone uit de API
        return ZoneInfo(STANDAARD_TZ)


def vandaag(tz: str | None = None) -> date:
    """Vandaag, gezien vanuit het account."""
    return datetime.now(_zone(tz)).date()


def gisteren(tz: str | None = None) -> date:
    return vandaag(tz) - timedelta(days=1)


def venster(dagen: int, tz: str | None = None) -> tuple[date, date]:
    """
    Het rolling window voor de metrics-sync.

    Inclusief vandaag. Dat is bewust: de Google Ads-interface toont vandaag ook,
    en als wij hem overslaan wijkt ons dashboard elke dag zichtbaar af van wat
    jij in Google ziet. Vandaag is nog niet af, maar de sync draait elke nacht
    de laatste veertien dagen opnieuw en overschrijft wat er stond -- dus de
    onvolledigheid corrigeert zichzelf.
    """
    eind = vandaag(tz)
    return eind - timedelta(days=dagen - 1), eind
