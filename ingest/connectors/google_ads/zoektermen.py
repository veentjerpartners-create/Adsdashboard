"""
Zoektermen: wat mensen echt intypten.

Het zoekwoord is wat je inkoopt, de zoekterm is wat de bezoeker typte. Bij
brede en zinsmatches lopen die ver uiteen, en daar zit zowel het geld als de
verspilling. Omdat click_view het zoekwoord leeg teruggeeft in API v24, is dit
de enige bron die "waar kwam die klik vandaan" beantwoordt.

Google laat zeldzame zoektermen weg om te voorkomen dat een zoekopdracht naar
één persoon herleidbaar is. De som van de zoektermen ligt daarom altijd lager
dan het campagnetotaal. Dat verschil hoort zichtbaar te zijn in het dashboard,
niet weggepoetst.
"""
from __future__ import annotations

import logging
from datetime import date

from ...core.db import fetch_all, upsert
from ...core.kalender import venster
from ...core.sync import sync_run
from .client import describe_error, search

log = logging.getLogger(__name__)

ROLLING_DAYS = 14
GRAIN = "ads_account_id,date,campaign_id,ad_group_id,term_key"


def q_termen(start: date, end: date) -> str:
    return f"""
        SELECT
          search_term_view.search_term,
          search_term_view.status,
          segments.keyword.info.text,
          segments.keyword.info.match_type,
          segments.date,
          campaign.id,
          ad_group.id,
          metrics.impressions,
          metrics.clicks,
          metrics.cost_micros,
          metrics.conversions
        FROM search_term_view
        WHERE segments.date BETWEEN '{start}' AND '{end}'
    """


def _enum(v) -> str | None:
    naam = getattr(v, "name", None)
    return None if naam in (None, "UNSPECIFIED", "UNKNOWN") else naam


def sync_termen(customer_id: str, account_uuid: str, *, start: date, end: date) -> int:
    with sync_run(
        "google_ads.search_terms", scope=customer_id,
        window_start=start, window_end=end,
    ) as run:
        rijen = []
        for r in search(customer_id, q_termen(start, end)):
            m = r.metrics
            rijen.append({
                "ads_account_id": account_uuid,
                "date": str(r.segments.date),
                "campaign_id": r.campaign.id,
                "ad_group_id": r.ad_group.id,
                "search_term": r.search_term_view.search_term,
                "keyword_text": r.segments.keyword.info.text or None,
                "match_type": _enum(r.segments.keyword.info.match_type),
                "term_status": _enum(r.search_term_view.status),
                "impressions": m.impressions,
                "clicks": m.clicks,
                "cost_micros": m.cost_micros,
                "conversions": round(m.conversions, 2),
            })
        run.read(len(rijen))
        # term_key is een generated column; die mag niet mee in de insert, maar
        # PostgREST heeft hem wel nodig als conflictdoel.
        geschreven = upsert("ads_search_term_daily", rijen, on_conflict=GRAIN)
        run.wrote(geschreven)
        return geschreven


def sync_recent(days: int = ROLLING_DAYS) -> dict[str, int]:
    accounts = [
        a for a in fetch_all(
            "ads_account", "id,customer_id,descriptive_name,is_manager,time_zone")
        if not a["is_manager"]
    ]
    uit: dict[str, int] = {}
    for a in accounts:
        label = a.get("descriptive_name") or a["customer_id"]
        start, end = venster(days, a.get("time_zone"))
        try:
            uit[label] = sync_termen(a["customer_id"], a["id"], start=start, end=end)
        except Exception as exc:  # noqa: BLE001
            log.error("zoektermen %s overgeslagen: %s", label, describe_error(exc))
            uit[label] = 0
    return uit
