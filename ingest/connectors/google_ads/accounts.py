"""
Stap 0.5 — accountdiscovery.

Haalt alle accounts onder het MCC op en zet ze in mi.ads_account. Dit is dezelfde
GAQL-query als in CP\\GoogleAds\\test_connection.py en bb_koppel_mcc.py, nu met
level <= 2 zodat ook accounts onder een tussenliggende manager meekomen.

Nieuwe klantaccounts verschijnen hierna automatisch. Het koppelen aan een klant
(ads_account.client_id) blijft handwerk — dat is één keer per klant, en beter
een bewuste keuze dan een gok op naam.
"""
from __future__ import annotations

import logging

from ...core.db import fetch_all, upsert
from ...core.sync import sync_run
from .client import mcc_id, search

log = logging.getLogger(__name__)

QUERY = """
    SELECT
      customer_client.id,
      customer_client.descriptive_name,
      customer_client.currency_code,
      customer_client.time_zone,
      customer_client.manager,
      customer_client.status,
      customer_client.level
    FROM customer_client
    WHERE customer_client.level <= 2
"""


def sync_accounts() -> list[dict]:
    """Upsert alle accounts onder het MCC. Geeft de weggeschreven rijen terug."""
    mcc = mcc_id()

    with sync_run("google_ads.accounts", scope=mcc, mode="incremental") as run:
        results = search(mcc, QUERY)
        run.read(len(results))

        rows = []
        for r in results:
            c = r.customer_client
            rows.append({
                "customer_id": str(c.id),
                "descriptive_name": c.descriptive_name or None,
                "currency_code": c.currency_code or None,
                # Nodig voor offline conversies: conversion_date_time moet in de
                # tijdzone van het ACCOUNT, niet die van onze server.
                "time_zone": c.time_zone or None,
                "is_manager": bool(c.manager),
                "manager_customer_id": mcc,
                "status": c.status.name if c.status else None,
            })

        # Het MCC zelf komt ook als rij terug (level 0). Die houden we, want
        # bij een MCC-account hoort geen klant en dat wil je kunnen zien.
        written = upsert("ads_account", rows, on_conflict="customer_id")
        run.wrote(written)

        if not rows:
            run.warn("geen_accounts",
                     f"Geen accounts gevonden onder MCC {mcc}. Klopt het MCC-id?")

    return rows


def report() -> str:
    """Leesbaar overzicht van wat er staat, en wat er nog gekoppeld moet worden."""
    accounts = fetch_all(
        "ads_account",
        "customer_id,descriptive_name,currency_code,time_zone,is_manager,status,client_id",
    )
    clients = {c["id"]: c["name"] for c in fetch_all("client", "id,name")}

    accounts.sort(key=lambda a: (a["is_manager"], a.get("descriptive_name") or ""))

    lines = [
        "",
        f"{len(accounts)} accounts in mi.ads_account",
        "",
        f"{'customer_id':<12} {'naam':<34} {'val':<4} {'tijdzone':<18} {'soort':<8} klant",
        "-" * 104,
    ]
    losse = 0
    for a in accounts:
        soort = "MANAGER" if a["is_manager"] else "klant"
        if a["is_manager"]:
            klant = "(manager, hoort bij geen klant)"
        else:
            klant = clients.get(a.get("client_id") or "", "NOG KOPPELEN")
        if not a["is_manager"] and not a.get("client_id"):
            losse += 1
        lines.append(
            f"{a['customer_id']:<12} {(a.get('descriptive_name') or '?')[:34]:<34} "
            f"{(a.get('currency_code') or '?'):<4} {(a.get('time_zone') or '?')[:18]:<18} "
            f"{soort:<8} {klant}"
        )

    if losse:
        lines += [
            "",
            f"{losse} klantaccount(s) hangen nog aan geen enkele klant.",
            "Volgende stap: per account het domein en de standaardmarge doorgeven,",
            "dan zet ik client + website + koppeling in één keer neer.",
        ]
    return "\n".join(lines)
