"""
Startpunt voor alle sync-taken.

    python -m ingest.run check                    verbinding en config testen
    python -m ingest.run accounts                 0.5  accounts onder het MCC
    python -m ingest.run structure                0.7  campagnes/adgroepen/zoekwoorden
    python -m ingest.run metrics                  0.8  laatste 14 dagen
    python -m ingest.run metrics --backfill 24    historie, 24 maanden terug
    python -m ingest.run terms                    zoektermen: wat mensen intypten
    python -m ingest.run clicks                   0.10 gclid -> campagne (heeft haast)
    python -m ingest.run clicks --report          hoe ver de klik-historie is
    python -m ingest.run spend --days 30          0.9  controle tegen Google Ads
    python -m ingest.run conversions              6    offline conversies naar Google Ads
    python -m ingest.run conversions --dry-run    alleen tonen wat er zou gaan
    python -m ingest.run conversions --report     wat er de laatste tijd gebeurde
    python -m ingest.run nightly                  alles wat 's nachts moet

Elke taak schrijft zijn eigen regel in mi.sync_run, dus je kunt achteraf altijd
zien wat er wanneer gelopen heeft en of het goed ging.
"""
from __future__ import annotations

import argparse
import logging
import sys


def setup_logging(verbose: bool) -> None:
    logging.basicConfig(
        format="%(asctime)s %(levelname)-7s %(name)s | %(message)s",
        datefmt="%H:%M:%S",
        level=logging.DEBUG if verbose else logging.INFO,
    )
    for noisy in ("httpx", "hpack", "httpcore", "urllib3", "google"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


def cmd_check() -> int:
    """Kijkt of alles staat, zonder iets te wijzigen."""
    from .core.config import ConfigError, settings
    from .core.db import tbl

    print()
    try:
        cfg = settings()
    except ConfigError as exc:
        print(f"  config       FOUT  {exc}")
        return 1

    print(f"  project      {cfg.project_ref}")
    print(f"  schema       {cfg.db_schema}")

    try:
        res = tbl("event_type").select("code", count="exact").limit(1).execute()
        print(f"  database     OK    {res.count} event types")
    except Exception as exc:  # noqa: BLE001
        print(f"  database     FOUT  {exc}")
        print()
        print("  Staat 'mi' bij Settings -> Data API -> Exposed schemas?")
        print("  En is de secret key in .env.local nog geldig?")
        return 1

    try:
        from .connectors.google_ads.client import ads_client, mcc_id
        ads_client()
        print(f"  google ads   OK    MCC {mcc_id()}")
    except Exception as exc:  # noqa: BLE001
        print(f"  google ads   FOUT  {exc}")
        return 1

    for table in ("client", "website", "ads_account", "ads_campaign",
                  "ads_keyword", "ads_metrics_daily", "ads_click",
                  "lead", "lead_event"):
        try:
            res = tbl(table).select("*", count="exact").limit(1).execute()
            print(f"  {table:<18} {res.count} rijen")
        except Exception as exc:  # noqa: BLE001
            print(f"  {table:<18} FOUT  {exc}")

    print()
    return 0


def cmd_accounts(report_only: bool) -> int:
    from .connectors.google_ads.accounts import report, sync_accounts

    if not report_only:
        sync_accounts()
    print(report())
    return 0


def _print_counts(title: str, result: dict) -> None:
    print()
    print(title)
    for label, counts in result.items():
        detail = "  ".join(f"{k}: {v}" for k, v in counts.items())
        print(f"  {label:<32} {detail}")
    print()


def cmd_structure() -> int:
    from .connectors.google_ads.structure import sync_all
    _print_counts("Structuur bijgewerkt", sync_all())
    return 0


def cmd_metrics(days: int, backfill_months: int | None) -> int:
    from .connectors.google_ads import metrics as m

    if backfill_months:
        _print_counts(f"Backfill {backfill_months} maanden",
                      m.backfill(months=backfill_months))
    else:
        _print_counts(f"Metrics laatste {days} dagen", m.sync_recent(days=days))
    return 0


def cmd_terms(days: int) -> int:
    from .connectors.google_ads import zoektermen as z
    result = z.sync_recent(days=days)
    print()
    print(f"Zoektermen laatste {days} dagen")
    for label, n in result.items():
        print(f"  {label:<32} {n} termen")
    print()
    return 0


def cmd_clicks(report_only: bool) -> int:
    from .connectors.google_ads import clicks as c

    if not report_only:
        result = c.sync_gap()
        print()
        print("Klikken opgehaald")
        for label, n in result.items():
            print(f"  {label:<32} {n}")
    print(c.report())
    return 0


def cmd_spend(days: int) -> int:
    """
    Stap 0.9 — de validatiestap.

    Print de spend per campagne uit onze database, zodat je die naast de
    Google Ads-interface kunt leggen. Klopt dit niet, dan is elk cijfer dat we
    erbovenop bouwen onbetrouwbaar, en zoeken we dat eerst uit.

    Leest v_campaign_daily, niet ads_metrics_daily: die view filtert het
    zoekwoordgrein eruit, zodat de spend niet dubbel geteld wordt.
    """
    from .core.db import fetch_all, tbl
    from .core.kalender import venster

    # Zelfde venster als de sync, inclusief vandaag en in de tijdzone van de
    # accounts -- anders vergelijk je twee verschillende periodes.
    start, end = venster(days)

    accounts = {a["id"]: a for a in fetch_all("ads_account", "id,customer_id,descriptive_name")}
    campaigns = {
        (c["ads_account_id"], c["campaign_id"]): c["name"]
        for c in fetch_all("ads_campaign", "ads_account_id,campaign_id,name")
    }

    res = (
        tbl("v_campaign_daily")
        .select("ads_account_id,campaign_id,impressions,clicks,cost,conversions,conversions_value")
        .gte("date", start.isoformat())
        .lte("date", end.isoformat())
        .execute()
    )

    agg: dict[tuple, dict] = {}
    for r in res.data or []:
        key = (r["ads_account_id"], r["campaign_id"])
        a = agg.setdefault(key, {"impr": 0, "clicks": 0, "cost": 0.0, "conv": 0.0, "value": 0.0})
        a["impr"] += r["impressions"] or 0
        a["clicks"] += r["clicks"] or 0
        a["cost"] += float(r["cost"] or 0)
        a["conv"] += float(r["conversions"] or 0)
        a["value"] += float(r["conversions_value"] or 0)

    print()
    print(f"Spend per campagne, {start} t/m {end}  ({days} dagen)")
    print("Leg dit naast Google Ads over exact dezelfde periode.")
    print()

    per_account: dict[str, list] = {}
    for (acc_id, camp_id), v in agg.items():
        acc = accounts.get(acc_id, {})
        label = f"{acc.get('descriptive_name') or '?'} ({acc.get('customer_id')})"
        per_account.setdefault(label, []).append(
            (campaigns.get((acc_id, camp_id), f"campagne {camp_id}"), v))

    grand = 0.0
    for label in sorted(per_account):
        rows = sorted(per_account[label], key=lambda x: -x[1]["cost"])
        total = sum(r[1]["cost"] for r in rows)
        grand += total
        print(f"  {label}")
        print(f"    {'campagne':<44} {'impr':>9} {'clicks':>8} {'kosten':>11} {'conv':>7}")
        print(f"    {'-'*44} {'-'*9} {'-'*8} {'-'*11} {'-'*7}")
        for name, v in rows:
            print(f"    {name[:44]:<44} {v['impr']:>9,} {v['clicks']:>8,} "
                  f"{v['cost']:>10,.2f}  {v['conv']:>7,.1f}")
        print(f"    {'TOTAAL':<44} {'':>9} {'':>8} {total:>10,.2f}")
        print()

    if not agg:
        print("  Geen data. Draai eerst: python -m ingest.run metrics")
        return 1

    print(f"  Alle accounts samen: EUR {grand:,.2f}")
    print()
    return 0


def cmd_conversions(dry_run: bool, report_only: bool, retry: bool) -> int:
    """
    Stap 6 — offline conversies terug naar Google Ads.

    Zie ingest/export/conversions.py voor het waarom. Kort: de conversietag op
    de site ziet alleen bezoekers die cookies accepteren; wij zien iedereen
    met een click-ID, dus sturen we die zelf terug.
    """
    from .export import conversions as cv

    if retry:
        res = (
            tbl_("conversion_upload")
            .update({"status": "pending"})
            .eq("status", "failed").lt("attempts", 5)
            .execute()
        )
        print(f"\n  {len(res.data or [])} mislukte uploads opnieuw in de wachtrij gezet")

    if not report_only:
        result = cv.run_all(dry_run=dry_run)
        print()
        print("Offline conversies" + ("  (dry-run, niets verstuurd)" if dry_run else ""))
        for label, counts in result.items():
            detail = "  ".join(f"{k}: {v}" for k, v in counts.items())
            print(f"  {label:<32} {detail}")
    print(cv.report())
    return 0


def tbl_(name: str):
    from .core.db import tbl
    return tbl(name)


def cmd_nightly() -> int:
    """Wat de scheduler straks elke nacht doet. Nu handmatig aan te roepen."""
    from .connectors.google_ads import clicks as c
    from .connectors.google_ads import metrics as m
    from .connectors.google_ads import zoektermen as z
    from .connectors.google_ads.accounts import sync_accounts
    from .connectors.google_ads.structure import sync_all

    sync_accounts()
    _print_counts("Structuur", sync_all())
    _print_counts("Metrics (rolling 14 dagen)", m.sync_recent())

    termen = z.sync_recent()
    print()
    print("Zoektermen")
    for label, n in termen.items():
        print(f"  {label:<32} {n}")

    # Als laatste, en apart: dit is de enige taak met een deadline. Faalt hij,
    # dan moet dat opvallen in plaats van wegvallen tussen de rest.
    result = c.sync_gap()
    print()
    print("Klikken (gclid -> campagne)")
    for label, n in result.items():
        print(f"  {label:<32} {n}")

    # En terug de andere kant op: wat er vandaag aan contact uit Ads kwam,
    # als offline conversie naar Google. Eigen try, want een afgewezen upload
    # mag de rest van de nacht niet als mislukt markeren.
    from .export import conversions as cv
    try:
        uploads = cv.run_all()
        print()
        print("Offline conversies naar Google Ads")
        for label, counts in uploads.items():
            detail = "  ".join(f"{k}: {v}" for k, v in counts.items())
            print(f"  {label:<32} {detail}")
    except Exception as exc:  # noqa: BLE001
        print(f"\n  offline conversies mislukt: {exc}")
    print()
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="ingest.run",
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("-v", "--verbose", action="store_true")
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("check", help="verbinding en configuratie testen")

    p_acc = sub.add_parser("accounts", help="accounts onder het MCC synchroniseren")
    p_acc.add_argument("--report", action="store_true",
                       help="niets ophalen, alleen tonen wat er in de database staat")

    sub.add_parser("structure", help="campagnes, adgroepen en zoekwoorden")

    p_met = sub.add_parser("metrics", help="dagmetrics")
    p_met.add_argument("--days", type=int, default=14,
                       help="hoeveel dagen terug (standaard 14)")
    p_met.add_argument("--backfill", type=int, metavar="MAANDEN",
                       help="historie ophalen, zoveel maanden terug")

    p_sp = sub.add_parser("spend", help="controle: spend per campagne uit onze database")
    p_sp.add_argument("--days", type=int, default=30)

    p_tm = sub.add_parser("terms", help="zoektermen ophalen")
    p_tm.add_argument("--days", type=int, default=14)

    p_cl = sub.add_parser("clicks", help="gclid -> campagne; heeft een 90-dagendeadline")
    p_cl.add_argument("--report", action="store_true",
                      help="niets ophalen, alleen tonen hoe ver we zijn")

    p_cv = sub.add_parser("conversions", help="offline conversies naar Google Ads")
    p_cv.add_argument("--dry-run", action="store_true",
                      help="niets aanmaken of versturen, alleen tonen")
    p_cv.add_argument("--report", action="store_true",
                      help="alleen tonen wat er de laatste tijd gebeurde")
    p_cv.add_argument("--retry", action="store_true",
                      help="mislukte uploads opnieuw in de wachtrij zetten")

    sub.add_parser("nightly", help="alles wat 's nachts moet")

    args = parser.parse_args(argv)
    setup_logging(args.verbose)

    if args.cmd == "check":
        return cmd_check()
    if args.cmd == "accounts":
        return cmd_accounts(args.report)
    if args.cmd == "structure":
        return cmd_structure()
    if args.cmd == "metrics":
        return cmd_metrics(args.days, args.backfill)
    if args.cmd == "terms":
        return cmd_terms(args.days)
    if args.cmd == "clicks":
        return cmd_clicks(args.report)
    if args.cmd == "spend":
        return cmd_spend(args.days)
    if args.cmd == "conversions":
        return cmd_conversions(args.dry_run, args.report, args.retry)
    if args.cmd == "nightly":
        return cmd_nightly()
    return 2


if __name__ == "__main__":
    sys.exit(main())
