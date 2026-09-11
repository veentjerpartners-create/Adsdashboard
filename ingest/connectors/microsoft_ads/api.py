"""
Microsoft Advertising — dagcijfers via de Reporting API.

WAAROM NAAST DE CSV-IMPORT
De CSV-import (csv_import.py) blijft bestaan voor een losse week of een
correctie. Maar zodra Bing bij twee klanten draait, is "elke week een export
klikken" precies het soort werk dat blijft liggen, en dan klopt kosten per lead
niet meer. Deze connector haalt hetzelfde rapport op via de API en geeft het
door aan dezelfde importer, dus de database ziet geen verschil.

WAT HIJ NODIG HEEFT
CP\\GoogleAds\\microsoft-ads.yaml (zie microsoft-ads.yaml.example daar):
    developer_token   Microsoft Advertising -> Gereedschap -> Ontwikkelaarsinstellingen
    client_id         portal.azure.com -> App-registraties -> Overzicht
    client_secret     zelfde app -> Certificaten & geheimen (de WAARDE)
    customer_id       Microsoft Ads -> Instellingen -> Accountgegevens (Klant-ID)
    refresh_token     vul je met  python bing_auth.py  in CP\\GoogleAds
Het pad is te overschrijven met MICROSOFT_ADS_YAML; op een server zonder dat
bestand werken ook losse variabelen MICROSOFT_ADS_DEVELOPER_TOKEN enzovoort.

WELKE ACCOUNTS
Alle accounts onder de klant (customer_id). Elk account wordt een rij in
ads_account met platform = 'microsoft' en customer_id = het accountnummer
(G1459T4P); aan welke klant hij hangt is een keuze en staat in de seed
(db/seed/011_microsoft_accounts.sql), niet in de accountnaam -- die is bij
Microsoft nogal eens "Stijn veentjer" terwijl er een klantcampagne in staat.
"""
from __future__ import annotations

import logging
import os
import tempfile
from datetime import date, timedelta
from pathlib import Path
from typing import Any

from ...core.config import ConfigError, REPO_ROOT
from .csv_import import import_csv

log = logging.getLogger(__name__)

ENV = "production"
KOLOMMEN = [
    "TimePeriod", "AccountNumber", "AccountName", "CurrencyCode",
    "CampaignId", "CampaignName", "CampaignStatus",
    "Impressions", "Clicks", "Spend", "Conversions", "Revenue", "AllConversions",
]


def _yaml_path() -> Path:
    return Path(os.getenv("MICROSOFT_ADS_YAML")
                or str(REPO_ROOT.parent / "GoogleAds" / "microsoft-ads.yaml"))


def credentials() -> dict[str, str]:
    """De vijf waarden die de API nodig heeft; uit het yaml of uit de omgeving."""
    cfg: dict[str, Any] = {}
    pad = _yaml_path()
    if pad.exists():
        import yaml
        cfg = yaml.safe_load(pad.read_text(encoding="utf-8")) or {}
    keys = ("developer_token", "client_id", "client_secret", "customer_id", "refresh_token")
    out = {k: str(cfg.get(k) or os.getenv(f"MICROSOFT_ADS_{k.upper()}") or "").strip()
           for k in keys}
    leeg = [k for k in keys if not out[k]]
    if leeg:
        raise ConfigError(
            f"Microsoft Ads: {', '.join(leeg)} ontbreekt in {pad} "
            f"(of als MICROSOFT_ADS_... in de omgeving). client_id en client_secret "
            f"komen uit een app-registratie op portal.azure.com; refresh_token vul je "
            f"daarna met  python bing_auth.py  in CP\\GoogleAds.")
    return out


def _auth(cred: dict[str, str], account_id: int | None = None):
    from bingads.authorization import AuthorizationData, OAuthWebAuthCodeGrant
    oauth = OAuthWebAuthCodeGrant(client_id=cred["client_id"], client_secret=cred["client_secret"],
                                  redirection_uri="http://localhost:8080")
    oauth.request_oauth_tokens_by_refresh_token(cred["refresh_token"])
    return AuthorizationData(account_id=account_id, customer_id=int(cred["customer_id"]),
                             developer_token=cred["developer_token"], authentication=oauth)


def accounts(cred: dict[str, str] | None = None) -> list[dict[str, Any]]:
    """Alle accounts onder de klant: [{id, number, name}]."""
    from bingads.service_client import ServiceClient
    cred = cred or credentials()
    svc = ServiceClient(service="CustomerManagementService", version=13,
                        authorization_data=_auth(cred), environment=ENV)
    res = svc.GetAccountsInfo(CustomerId=int(cred["customer_id"]))
    rijen = []
    for a in getattr(res, "AccountInfo", []) or []:
        rijen.append({"id": int(a.Id), "number": str(a.Number), "name": str(a.Name),
                      "status": str(getattr(a, "AccountLifeCycleStatus", "") or "")})
    return rijen


def download_report(cred: dict[str, str], account_id: int, start: date, eind: date) -> Path | None:
    """Campagnerapport per dag als CSV in de temp-map; None als er niets is."""
    from bingads.service_client import ServiceClient
    from bingads.v13.reporting import ReportingDownloadParameters, ReportingServiceManager

    auth = _auth(cred, account_id)
    mgr = ReportingServiceManager(authorization_data=auth, poll_interval_in_milliseconds=3000,
                                  environment=ENV)
    svc = ServiceClient(service="ReportingService", version=13, authorization_data=auth,
                        environment=ENV)

    req = svc.factory.create("CampaignPerformanceReportRequest")
    req.Format = "Csv"
    req.ReturnOnlyCompleteData = False
    req.Aggregation = "Daily"
    req.Columns = svc.factory.create("ArrayOfCampaignPerformanceReportColumn")
    req.Columns.CampaignPerformanceReportColumn.extend(KOLOMMEN)
    scope = svc.factory.create("AccountThroughCampaignReportScope")
    scope.AccountIds = {"long": [account_id]}
    scope.Campaigns = None
    req.Scope = scope
    tijd = svc.factory.create("ReportTime")
    tijd.CustomDateRangeStart = svc.factory.create("Date")
    tijd.CustomDateRangeStart.Day, tijd.CustomDateRangeStart.Month, tijd.CustomDateRangeStart.Year = \
        start.day, start.month, start.year
    tijd.CustomDateRangeEnd = svc.factory.create("Date")
    tijd.CustomDateRangeEnd.Day, tijd.CustomDateRangeEnd.Month, tijd.CustomDateRangeEnd.Year = \
        eind.day, eind.month, eind.year
    tijd.PredefinedTime = None
    tijd.ReportTimeZone = "AmsterdamBerlinBernRomeStockholmVienna"
    req.Time = tijd

    params = ReportingDownloadParameters(
        report_request=req, result_file_directory=tempfile.gettempdir(),
        result_file_name=f"microsoft_ads_{account_id}.csv", overwrite_result_file=True,
        timeout_in_milliseconds=180000)
    pad = mgr.download_file(params)
    return Path(pad) if pad else None


def sync(dagen: int = 14, *, dry_run: bool = False) -> dict[str, dict[str, int]]:
    """Laatste `dagen` dagen voor elk account ophalen en importeren.

    Veertien dagen, net als de Google-metrics: Microsoft corrigeert klikken en
    uitgaven nog een paar dagen na dato, en de import overschrijft, dus de
    overlap maakt dat vanzelf goed.
    """
    cred = credentials()
    eind = date.today()
    start = eind - timedelta(days=dagen - 1)
    uit: dict[str, dict[str, int]] = {}
    for a in accounts(cred):
        label = f"{a['name']} ({a['number']})"
        try:
            pad = download_report(cred, a["id"], start, eind)
        except Exception as exc:  # noqa: BLE001
            log.error("Microsoft %s: rapport ophalen mislukt: %s", label, exc)
            uit[label] = {"fout": 1}
            continue
        if pad is None:
            log.info("Microsoft %s: geen cijfers in %s t/m %s", label, start, eind)
            uit[label] = {"rijen": 0}
            continue
        try:
            uit[label] = import_csv(pad, account_nr=a["number"], account_name=a["name"],
                                    dry_run=dry_run)
        except ValueError as exc:
            # "Geen datarijen" is bij een net gestart account normaal.
            log.info("Microsoft %s: %s", label, exc)
            uit[label] = {"rijen": 0}
    return uit
