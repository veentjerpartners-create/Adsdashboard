"""
Stap 0.8 — dagmetrics, met een rolling window.

WAAROM 14 DAGEN EN NIET ALLEEN GISTEREN
Google schrijft conversies en conversiewaarden met terugwerkende kracht bij: de
conversieactie van Boers & Breuer heeft een terugkijkvenster van 30 dagen, dus
een klik van vandaag kan over drie weken nog een conversie opleveren. Haal je
alleen gisteren op, dan blijven je cijfers van vorige week structureel te laag.
Elke nacht de laatste 14 dagen opnieuw ophalen en overschrijven kost bijna niets
en houdt het kloppend.

TWEE GREINEN IN ÉÉN TABEL
Campagneniveau krijgt ad_group_id = -1 en criterion_id = -1; zoekwoordniveau
krijgt de echte id's. Tel die nooit bij elkaar op — gebruik mi.v_campaign_daily
of mi.v_keyword_daily (zie migratie 008).
"""
from __future__ import annotations

import logging
from datetime import date, timedelta

from ...core.db import fetch_all, upsert
from ...core.kalender import vandaag, venster
from ...core.sync import sync_run
from .client import describe_error, search

log = logging.getLogger(__name__)

ROLLING_DAYS = 14
GRAIN_KEY = "ads_account_id,date,campaign_id,ad_group_id,criterion_id"

METRICS = """
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value,
      metrics.all_conversions,
      metrics.interactions
"""


def q_campaign(start: date, end: date) -> str:
    return f"""
        SELECT segments.date, campaign.id, {METRICS}
        FROM campaign
        WHERE segments.date BETWEEN '{start}' AND '{end}'
    """


def q_keyword(start: date, end: date) -> str:
    return f"""
        SELECT segments.date, campaign.id, ad_group.id,
               ad_group_criterion.criterion_id, {METRICS}
        FROM keyword_view
        WHERE segments.date BETWEEN '{start}' AND '{end}'
    """


def _row(account_uuid: str, r, *, ad_group_id: int = -1, criterion_id: int = -1) -> dict:
    m = r.metrics
    return {
        "ads_account_id": account_uuid,
        "date": r.segments.date,
        "campaign_id": r.campaign.id,
        "ad_group_id": ad_group_id,
        "criterion_id": criterion_id,
        "impressions": m.impressions,
        "clicks": m.clicks,
        "cost_micros": m.cost_micros,
        # Afronden op 2 decimalen: numeric(12,2) in de database, en Google geeft
        # gemodelleerde conversies als kommagetal terug.
        "conversions": round(m.conversions, 2),
        "conversions_value": round(m.conversions_value, 2),
        "all_conversions": round(m.all_conversions, 2),
        "interactions": m.interactions,
    }


def sync_metrics(
    customer_id: str,
    account_uuid: str,
    *,
    start: date,
    end: date,
    mode: str = "incremental",
) -> dict[str, int]:
    """Metrics van één account over één venster. Idempotent: overschrijft."""
    counts: dict[str, int] = {}

    with sync_run(
        "google_ads.metrics", scope=customer_id, mode=mode,
        window_start=start, window_end=end,
    ) as run:
        # --- campagneniveau ---
        rows = [_row(account_uuid, r) for r in search(customer_id, q_campaign(start, end))]
        run.read(len(rows))
        counts["campagne-dagen"] = upsert("ads_metrics_daily", rows, on_conflict=GRAIN_KEY)

        # --- zoekwoordniveau ---
        rows = [
            _row(account_uuid, r,
                 ad_group_id=r.ad_group.id,
                 criterion_id=r.ad_group_criterion.criterion_id)
            for r in search(customer_id, q_keyword(start, end))
        ]
        run.read(len(rows))
        counts["zoekwoord-dagen"] = upsert("ads_metrics_daily", rows, on_conflict=GRAIN_KEY)

        run.wrote(sum(counts.values()))

        if not counts["campagne-dagen"]:
            run.warn("geen_metrics",
                     f"Account {customer_id} heeft geen vertoningen tussen "
                     f"{start} en {end}.")

    return counts


def _client_accounts() -> list[dict]:
    return [
        a for a in fetch_all(
            "ads_account", "id,customer_id,descriptive_name,is_manager,time_zone",
            platform="google")
        if not a["is_manager"]
    ]


def sync_recent(days: int = ROLLING_DAYS) -> dict[str, dict[str, int]]:
    """
    Het nachtelijke werk: de laatste `days` dagen opnieuw ophalen, tot en met
    vandaag, in de tijdzone van elk account afzonderlijk.
    """
    out: dict[str, dict[str, int]] = {}
    for a in _client_accounts():
        label = a.get("descriptive_name") or a["customer_id"]
        start, end = venster(days, a.get("time_zone"))
        try:
            out[label] = sync_metrics(a["customer_id"], a["id"], start=start, end=end)
        except Exception as exc:  # noqa: BLE001
            log.error("metrics %s overgeslagen: %s", label, describe_error(exc))
            out[label] = {"fout": 0}
    return out


def backfill(months: int = 24, chunk_days: int = 30) -> dict[str, dict[str, int]]:
    """
    Historie ophalen, in blokken. Dezelfde upsert, dus je kunt dit afbreken en
    herstarten zonder dubbele rijen.

    Blokken van 30 dagen omdat één query over twee jaar zoekwoorddata te groot
    wordt en bij een fout alles kwijt is.
    """
    out: dict[str, dict[str, int]] = {}

    for a in _client_accounts():
        label = a.get("descriptive_name") or a["customer_id"]
        end = vandaag(a.get("time_zone"))
        oldest = end - timedelta(days=int(months * 30.44))
        totals = {"campagne-dagen": 0, "zoekwoord-dagen": 0}
        # Een account dat vorige maand gepauzeerd is heeft recente lege blokken
        # maar wel historie daarvoor. Pas na drie lege blokken op rij (~90 dagen)
        # nemen we aan dat we voorbij de start van het account zijn.
        leeg_op_rij = 0
        window_end = end
        while window_end >= oldest:
            window_start = max(oldest, window_end - timedelta(days=chunk_days - 1))
            try:
                got = sync_metrics(a["customer_id"], a["id"],
                                   start=window_start, end=window_end, mode="backfill")
                for k, v in got.items():
                    totals[k] = totals.get(k, 0) + v
                if got.get("campagne-dagen"):
                    leeg_op_rij = 0
                else:
                    leeg_op_rij += 1
                    if leeg_op_rij >= 3:
                        log.info("%s: drie lege blokken op rij voor %s, stoppen",
                                 label, window_start)
                        break
            except Exception as exc:  # noqa: BLE001
                log.error("backfill %s %s..%s overgeslagen: %s",
                          label, window_start, window_end, describe_error(exc))
            window_end = window_start - timedelta(days=1)
        out[label] = totals
    return out
