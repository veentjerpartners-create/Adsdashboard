"""
Stap 0.7 — campagnes, adgroepen en zoekwoorden.

Alleen dimensies, geen metrics: deze query's hebben geen segments.date, dus ze
geven de huidige stand van het account terug. Ze draaien elke nacht zodat
naamswijzigingen en nieuwe adgroepen meekomen.

REMOVED laten we bewust wél binnen: een verwijderde campagne heeft in het
verleden geld gekost en leads opgeleverd, en die historie moet leesbaar blijven.
Alleen upserten, nooit verwijderen.
"""
from __future__ import annotations

import logging

from ...core.db import fetch_all, upsert
from ...core.sync import sync_run
from .client import describe_error, search

log = logging.getLogger(__name__)

Q_CAMPAIGNS = """
    SELECT
      campaign.id,
      campaign.name,
      campaign.status,
      campaign.advertising_channel_type,
      campaign.bidding_strategy_type,
      campaign.start_date_time,
      campaign.end_date_time,
      campaign_budget.amount_micros
    FROM campaign
"""

Q_AD_GROUPS = """
    SELECT
      campaign.id,
      ad_group.id,
      ad_group.name,
      ad_group.status
    FROM ad_group
"""

Q_KEYWORDS = """
    SELECT
      ad_group.id,
      ad_group_criterion.criterion_id,
      ad_group_criterion.keyword.text,
      ad_group_criterion.keyword.match_type,
      ad_group_criterion.status,
      ad_group_criterion.final_urls
    FROM ad_group_criterion
    WHERE ad_group_criterion.type = 'KEYWORD'
"""


def _date(value) -> str | None:
    """campaign.start_date_time is een datetime-string; de kolom is een date.
    (In API v24 heten deze velden niet meer start_date / end_date.)"""
    return value[:10] if value else None


def _enum(value) -> str | None:
    """Proto-enum naar tekst, en leeg als hij niet gezet is."""
    name = getattr(value, "name", None) or (str(value) if value else None)
    return None if name in (None, "UNSPECIFIED", "UNKNOWN") else name


def sync_structure(customer_id: str, account_uuid: str) -> dict[str, int]:
    """Dimensies van één account bijwerken."""
    counts: dict[str, int] = {}

    with sync_run("google_ads.structure", scope=customer_id) as run:
        # --- campagnes ---
        rows = []
        for r in search(customer_id, Q_CAMPAIGNS):
            c = r.campaign
            rows.append({
                "ads_account_id": account_uuid,
                "campaign_id": c.id,
                "name": c.name or None,
                "status": _enum(c.status),
                "channel_type": _enum(c.advertising_channel_type),
                "bidding_strategy": _enum(c.bidding_strategy_type),
                "budget_micros": r.campaign_budget.amount_micros or None,
                "start_date": _date(c.start_date_time),
                "end_date": _date(c.end_date_time),
            })
        run.read(len(rows))
        counts["campagnes"] = upsert(
            "ads_campaign", rows, on_conflict="ads_account_id,campaign_id")

        # --- adgroepen ---
        rows = []
        for r in search(customer_id, Q_AD_GROUPS):
            rows.append({
                "ads_account_id": account_uuid,
                "campaign_id": r.campaign.id,
                "ad_group_id": r.ad_group.id,
                "name": r.ad_group.name or None,
                "status": _enum(r.ad_group.status),
            })
        run.read(len(rows))
        counts["adgroepen"] = upsert(
            "ads_ad_group", rows, on_conflict="ads_account_id,ad_group_id")

        # --- zoekwoorden ---
        rows = []
        for r in search(customer_id, Q_KEYWORDS):
            crit = r.ad_group_criterion
            rows.append({
                "ads_account_id": account_uuid,
                "ad_group_id": r.ad_group.id,
                "criterion_id": crit.criterion_id,
                "text": crit.keyword.text or None,
                "match_type": _enum(crit.keyword.match_type),
                "status": _enum(crit.status),
                "final_urls": list(crit.final_urls) or None,
            })
        run.read(len(rows))
        counts["zoekwoorden"] = upsert(
            "ads_keyword", rows,
            on_conflict="ads_account_id,ad_group_id,criterion_id")

        run.wrote(sum(counts.values()))

        if not counts["campagnes"]:
            run.warn("geen_campagnes",
                     f"Account {customer_id} heeft geen campagnes.")

    return counts


def sync_all() -> dict[str, dict[str, int]]:
    """Alle klantaccounts langs. Een MCC heeft zelf geen campagnes."""
    accounts = [
        a for a in fetch_all("ads_account", "id,customer_id,descriptive_name,is_manager")
        if not a["is_manager"]
    ]
    out: dict[str, dict[str, int]] = {}
    for a in accounts:
        label = a.get("descriptive_name") or a["customer_id"]
        try:
            out[label] = sync_structure(a["customer_id"], a["id"])
        except Exception as exc:  # noqa: BLE001
            # Eén kapot account mag de rest van de nacht niet ophouden.
            log.error("structure %s overgeslagen: %s", label, describe_error(exc))
            out[label] = {"fout": 0}
    return out
