"""
Microsoft Advertising — dagcijfers uit een geëxporteerde CSV.

WAAROM GEEN API
Bing draait als test van zes weken naast Google Ads. De Bing Ads API vraagt
een developer token, OAuth via een Microsoft-account en een eigen connector;
dat is een dag werk voor een kanaal dat misschien na zes weken weer uitgaat.
Een CSV per week kost twee minuten. Blijft Bing, dan komt de connector alsnog
en schrijft die in dezelfde tabellen als dit script.

WELK RAPPORT
In Microsoft Advertising: Rapporten > Campagne (prestaties), per dag, met
minstens de kolommen datum, campagne-id, campagnenaam, vertoningen, klikken en
uitgaven. Exporteer als CSV. Een zoekwoordrapport (met zoekwoord-id en
advertentiegroep-id) mag ook: dan schrijven we op zoekwoordniveau, net als de
Google-connector. Microsoft bewaart rapporten jaren, dus een gemiste week haal
je gewoon later op; de import is idempotent en overschrijft.

HET FORMAAT
Microsoft zet boven de kolomkop een paar regels metadata en eronder een
copyright-regel. Kolomnamen zijn Engels of Nederlands, afhankelijk van de
taal van het account, en getallen en datums volgen die taal ook. Dit script
zoekt zelf de kopregel, kent beide talen en laat met --dry-run zien hoe het
de eerste regels leest, zodat je dat één keer controleert.
"""
from __future__ import annotations

import csv
import io
import logging
import re
from datetime import date, datetime
from pathlib import Path
from typing import Any

from ...core.db import fetch_all, tbl, upsert
from ...core.sync import sync_run

log = logging.getLogger(__name__)

GRAIN_KEY = "ads_account_id,date,campaign_id,ad_group_id,criterion_id"

# Kolomnamen zoals Microsoft ze exporteert, Engels en Nederlands, genormaliseerd
# (kleine letters, alleen letters en cijfers). Eerste treffer wint.
ALIASES: dict[str, tuple[str, ...]] = {
    "date":            ("gregoriandate", "timeperiod", "date", "gregoriaansedatum", "datum", "dag", "day"),
    "account_nr":      ("accountnumber", "accountnummer"),
    "account_name":    ("accountname", "accountnaam"),
    "currency":        ("currencycode", "valutacode", "currency", "valuta"),
    "campaign_id":     ("campaignid", "campagneid"),
    "campaign_name":   ("campaignname", "campagnenaam", "campaign", "campagne"),
    "campaign_status": ("campaignstatus", "campagnestatus"),
    "ad_group_id":     ("adgroupid", "advertentiegroepid"),
    "ad_group_name":   ("adgroupname", "adgroup", "advertentiegroepnaam", "advertentiegroep"),
    "keyword_id":      ("keywordid", "trefwoordid", "zoekwoordid"),
    "keyword":         ("keyword", "trefwoord", "zoekwoord"),
    "match_type":      ("bidmatchtype", "matchtype", "overeenkomsttype", "biedovereenkomsttype"),
    "impressions":     ("impressions", "impr", "vertoningen"),
    "clicks":          ("clicks", "klikken"),
    "spend":           ("spend", "cost", "uitgaven", "kosten"),
    "conversions":     ("conversions", "conversies"),
    "revenue":         ("revenue", "conversionvalue", "omzet", "conversiewaarde"),
    "all_conversions": ("allconversions", "alleconversies"),
}


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def _number(s: str) -> float:
    """'1,234.56', '1.234,56', '€ 12,30', '12.3' -> float. Leeg = 0."""
    t = re.sub(r"[^\d,.\-]", "", s or "")
    if not t:
        return 0.0
    if "," in t and "." in t:
        # De laatste van de twee is het decimaalteken.
        if t.rfind(",") > t.rfind("."):
            t = t.replace(".", "").replace(",", ".")
        else:
            t = t.replace(",", "")
    elif "," in t:
        # Alleen komma's: decimaal als er hooguit 2 cijfers achter staan,
        # anders duizendtallen ('1,234').
        head, _, tail = t.rpartition(",")
        t = f"{head}.{tail}" if len(tail) <= 2 else t.replace(",", "")
    return float(t)


def _count(s: str) -> int:
    """Aantallen (vertoningen, klikken) hebben nooit decimalen: '1.234' en
    '1,234' zijn allebei 1234. Daarom niet via _number, die '1.234' als
    één-komma-twee zou lezen."""
    t = re.sub(r"[^\d\-]", "", s or "")
    return int(t) if t and t != "-" else 0


DATE_FORMATS = ("%Y-%m-%d", "%m/%d/%Y", "%d-%m-%Y", "%d/%m/%Y", "%Y/%m/%d")


def _date(s: str, fmt: str | None) -> date:
    s = (s or "").strip()
    if fmt:
        return datetime.strptime(s, fmt).date()
    for f in DATE_FORMATS:
        try:
            return datetime.strptime(s, f).date()
        except ValueError:
            continue
    raise ValueError(f"Datum niet herkend: {s!r}. Geef --date-format mee, "
                     f"bijvoorbeeld %d-%m-%Y.")


def _cel(r: dict[str, str], kolom: str | None) -> str | None:
    """Waarde van een optionele kolom, gestript; None als de kolom er niet is of leeg is."""
    if not kolom:
        return None
    return r.get(kolom, "").strip() or None


def _read_table(path: Path) -> tuple[dict[str, str], list[dict[str, str]]]:
    """
    Leest de CSV en geeft (kolomtoewijzing, rijen) terug. Zoekt zelf de kopregel:
    de eerste regel waarin zowel een datum- als een campagnekolom herkend wordt.
    """
    text = path.read_bytes().decode("utf-8-sig", errors="replace")
    sample = text[:4096]
    delim = ";" if sample.count(";") > sample.count(",") else ","
    reader = csv.reader(io.StringIO(text), delimiter=delim)

    header: list[str] | None = None
    mapping: dict[str, str] = {}
    rows: list[dict[str, str]] = []
    for rec in reader:
        if header is None:
            normed = [_norm(c) for c in rec]
            cand: dict[str, str] = {}
            for field, names in ALIASES.items():
                for n in names:
                    if n in normed:
                        cand[field] = rec[normed.index(n)]
                        break
            if "date" in cand and ("campaign_id" in cand or "campaign_name" in cand):
                header, mapping = rec, cand
            continue
        if not any(c.strip() for c in rec):
            continue
        if rec[0].strip().startswith(("©", "(c)", "Microsoft")):
            break  # de voettekst van Microsoft
        if len(rec) < len(header):
            rec = rec + [""] * (len(header) - len(rec))
        rows.append(dict(zip(header, rec)))

    if header is None:
        raise ValueError(
            "Geen kopregel gevonden met een datum- en een campagnekolom. "
            "Is dit een campagne- of zoekwoordrapport per dag?")
    return mapping, rows


def _account(account_nr: str | None, name: str | None, client_slug: str | None,
             currency: str | None, *, dry_run: bool) -> dict[str, Any]:
    """De ads_account-rij voor dit Microsoft-account; maakt hem aan als hij ontbreekt."""
    if not account_nr:
        raise ValueError("Geen accountnummer: zet de kolom 'Account number' in het "
                         "rapport of geef --account mee (bijv. X1234567).")
    bestaand = fetch_all("ads_account", "id,customer_id,client_id,descriptive_name,platform",
                         customer_id=account_nr)
    if bestaand:
        a = bestaand[0]
        if a["platform"] != "microsoft":
            raise ValueError(f"Account {account_nr} staat als {a['platform']} in de "
                             f"database; dat is geen Microsoft-account.")
        return a

    client_id = None
    if client_slug:
        c = fetch_all("client", "id,name", slug=client_slug)
        if not c:
            raise ValueError(f"Geen klant met slug {client_slug!r}.")
        client_id = c[0]["id"]

    row = {
        "customer_id": account_nr,
        "descriptive_name": name or f"Microsoft {account_nr}",
        "currency_code": currency or "EUR",
        "time_zone": "Europe/Amsterdam",
        "is_manager": False,
        "platform": "microsoft",
        "client_id": client_id,
    }
    if dry_run:
        log.info("[dry-run] zou ads_account aanmaken: %s", row)
        return {"id": None, **row}
    res = tbl("ads_account").insert(row).execute()
    a = res.data[0]
    log.info("ads_account aangemaakt voor Microsoft %s (%s)", account_nr, row["descriptive_name"])
    if not client_id:
        log.warning("Account %s hangt nog aan geen klant. Zet ads_account.client_id "
                    "of importeer met --client <slug>.", account_nr)
    return a


def import_csv(
    path: str | Path,
    *,
    account_nr: str | None = None,
    account_name: str | None = None,
    client_slug: str | None = None,
    date_format: str | None = None,
    dry_run: bool = False,
) -> dict[str, int]:
    path = Path(path)
    mapping, rows = _read_table(path)
    col = mapping.get

    log.info("Kolommen herkend: %s",
             ", ".join(f"{k}<-{v!r}" for k, v in mapping.items()))
    for need in ("campaign_id", "impressions", "clicks", "spend"):
        if not col(need):
            raise ValueError(f"Kolom voor {need!r} ontbreekt in het rapport.")

    keyword_grain = bool(col("keyword_id") and col("ad_group_id"))
    if col("ad_group_id") and not col("keyword_id"):
        raise ValueError("Rapport op advertentiegroepniveau: dat past niet in "
                         "ads_metrics_daily. Exporteer per campagne of per zoekwoord.")

    eerste = rows[0] if rows else {}
    nr = account_nr or _cel(eerste, col("account_nr"))
    naam = account_name or _cel(eerste, col("account_name"))
    valuta = _cel(eerste, col("currency"))
    acc = _account(nr, naam, client_slug, valuta, dry_run=dry_run)

    metrics: dict[tuple, dict[str, Any]] = {}
    campaigns: dict[int, dict[str, Any]] = {}
    ad_groups: dict[int, dict[str, Any]] = {}
    keywords: dict[tuple[int, int], dict[str, Any]] = {}
    dates: list[date] = []

    for r in rows:
        d = _date(r[col("date")], date_format)
        dates.append(d)
        cid = _count(r[col("campaign_id")])
        campaigns[cid] = {
            "ads_account_id": acc["id"], "campaign_id": cid,
            "name": _cel(r, col("campaign_name")),
            "status": _cel(r, col("campaign_status")),
            "channel_type": "SEARCH",
        }
        agid, crid = -1, -1
        if keyword_grain:
            agid = _count(r[col("ad_group_id")])
            crid = _count(r[col("keyword_id")])
            ad_groups[agid] = {
                "ads_account_id": acc["id"], "campaign_id": cid, "ad_group_id": agid,
                "name": _cel(r, col("ad_group_name")),
            }
            mt = _cel(r, col("match_type"))
            keywords[(agid, crid)] = {
                "ads_account_id": acc["id"], "ad_group_id": agid, "criterion_id": crid,
                "text": _cel(r, col("keyword")),
                "match_type": mt.upper() if mt else None,
            }
        key = (d, cid, agid, crid)
        m = metrics.setdefault(key, {
            "ads_account_id": acc["id"], "date": d.isoformat(), "campaign_id": cid,
            "ad_group_id": agid, "criterion_id": crid,
            "impressions": 0, "clicks": 0, "cost_micros": 0,
            "conversions": 0.0, "conversions_value": 0.0, "all_conversions": 0.0,
            "interactions": 0,
        })
        # Zelfde dag/campagne kan meerdere regels hebben (per apparaat, per
        # netwerk); optellen tot één rij op onze grein.
        m["impressions"] += _count(r[col("impressions")])
        clicks = _count(r[col("clicks")])
        m["clicks"] += clicks
        m["interactions"] += clicks
        m["cost_micros"] += int(round(_number(r[col("spend")]) * 1_000_000))
        if col("conversions"):
            m["conversions"] += _number(r[col("conversions")])
        if col("revenue"):
            m["conversions_value"] += _number(r[col("revenue")])
        if col("all_conversions"):
            m["all_conversions"] += _number(r[col("all_conversions")])
        elif col("conversions"):
            m["all_conversions"] += _number(r[col("conversions")])

    for m in metrics.values():
        for k in ("conversions", "conversions_value", "all_conversions"):
            m[k] = round(m[k], 2)

    if not metrics:
        raise ValueError("Geen datarijen in het rapport.")
    start, end = min(dates), max(dates)
    grein = "zoekwoord" if keyword_grain else "campagne"
    totaal_spend = sum(m["cost_micros"] for m in metrics.values()) / 1e6
    log.info("%s: %d %s-dagen, %s t/m %s, %d campagnes, EUR %.2f",
             path.name, len(metrics), grein, start, end, len(campaigns), totaal_spend)

    if dry_run:
        print()
        print(f"  bestand      {path}")
        print(f"  account      {acc['customer_id']}  {acc.get('descriptive_name') or ''}")
        print(f"  grein        {grein}")
        print(f"  periode      {start} t/m {end}")
        print(f"  rijen        {len(metrics)}  (uit {len(rows)} regels in de CSV)")
        print(f"  spend        EUR {totaal_spend:.2f}")
        print()
        print("  eerste drie rijen zoals ze de database in zouden gaan:")
        for m in list(metrics.values())[:3]:
            naam = campaigns[m["campaign_id"]]["name"] or m["campaign_id"]
            print(f"    {m['date']}  {naam!s:<45.45} "
                  f"impr {m['impressions']:>6}  klik {m['clicks']:>4}  "
                  f"EUR {m['cost_micros'] / 1e6:>8.2f}  conv {m['conversions']}")
        print()
        print("  Klopt de datum (dag/maand) en het bedrag? Draai dan zonder --dry-run.")
        return {"rijen": len(metrics), "dry_run": 1}

    counts: dict[str, int] = {}
    with sync_run("microsoft_ads.csv", scope=acc["customer_id"], mode="manual",
                  window_start=start, window_end=end, advance_cursor_to=end) as run:
        run.read(len(rows))
        counts["campagnes"] = upsert("ads_campaign", list(campaigns.values()),
                                     on_conflict="ads_account_id,campaign_id")
        if keyword_grain:
            counts["adgroepen"] = upsert("ads_ad_group", list(ad_groups.values()),
                                         on_conflict="ads_account_id,ad_group_id")
            counts["zoekwoorden"] = upsert("ads_keyword", list(keywords.values()),
                                           on_conflict="ads_account_id,ad_group_id,criterion_id")
        counts[f"{grein}-dagen"] = upsert("ads_metrics_daily", list(metrics.values()),
                                          on_conflict=GRAIN_KEY)
        run.wrote(sum(counts.values()))
        if not keyword_grain and totaal_spend == 0:
            run.warn("geen_spend", f"Rapport {path.name} bevat EUR 0 aan uitgaven.")
    return counts
