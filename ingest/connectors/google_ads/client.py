"""
Google Ads-client.

Hergebruikt de bestaande credentials uit CP\\GoogleAds\\google-ads.yaml, precies
zoals test_connection.py dat doet. Die geheimen blijven dus op één plek staan;
we kopiëren ze niet naar dit project.

Draait dit op Railway, waar dat yaml-bestand niet bestaat, dan valt hij terug op
losse omgevingsvariabelen.
"""
from __future__ import annotations

import logging
from typing import Any, Iterator

from ...core.config import ConfigError, settings
from ...core.retry import with_retry

log = logging.getLogger(__name__)


def describe_error(exc: BaseException) -> str:
    """Google Ads-fouten compact samenvatten.

    Een GoogleAdsException stringify't naar een paar honderd regels gRPC-dump
    waarin de enige nuttige regel -- welk veld of welke waarde fout is --
    wegvalt. Dit haalt de foutcodes en de boodschappen eruit.
    """
    failure = getattr(exc, "failure", None)
    if failure is None:
        return f"{type(exc).__name__}: {exc}"
    parts = []
    for err in failure.errors:
        code = ""
        try:
            which = err.error_code.__class__.pb(err.error_code).WhichOneof("error_code")
            if which:
                code = f"{which}={getattr(err.error_code, which)} "
        except Exception:  # noqa: BLE001
            pass
        loc = ""
        if err.location and err.location.field_path_elements:
            loc = " @ " + ".".join(
                e.field_name for e in err.location.field_path_elements if e.field_name)
        parts.append(f"{code}{err.message}{loc}")
    rid = getattr(exc, "request_id", None)
    return " | ".join(parts) + (f"  (request {rid})" if rid else "")


def _client_from_env():
    import os

    cfg = {
        "developer_token": os.getenv("GOOGLE_ADS_DEVELOPER_TOKEN"),
        "client_id": os.getenv("GOOGLE_ADS_CLIENT_ID"),
        "client_secret": os.getenv("GOOGLE_ADS_CLIENT_SECRET"),
        "refresh_token": os.getenv("GOOGLE_ADS_REFRESH_TOKEN"),
        "login_customer_id": os.getenv("GOOGLE_ADS_LOGIN_CUSTOMER_ID"),
        "use_proto_plus": True,
    }
    missing = [k for k, v in cfg.items() if v is None and k != "use_proto_plus"]
    if missing:
        raise ConfigError(
            "Geen google-ads.yaml gevonden en deze variabelen ontbreken: "
            + ", ".join(missing)
        )
    from google.ads.googleads.client import GoogleAdsClient

    return GoogleAdsClient.load_from_dict(cfg)


_cached = None


def ads_client():
    """Eén client per proces. Het refresh token wordt intern hergebruikt."""
    global _cached
    if _cached is not None:
        return _cached

    from google.ads.googleads.client import GoogleAdsClient

    path = settings().google_ads_yaml
    if path and path.exists():
        log.debug("Google Ads-credentials uit %s", path)
        _cached = GoogleAdsClient.load_from_storage(str(path))
    else:
        log.debug("Google Ads-credentials uit de omgeving")
        _cached = _client_from_env()
    return _cached


def mcc_id() -> str:
    """Het MCC waaronder de klantaccounts hangen."""
    cid = settings().login_customer_id or getattr(ads_client(), "login_customer_id", None)
    if not cid:
        raise ConfigError("GOOGLE_ADS_LOGIN_CUSTOMER_ID ontbreekt (MCC zonder streepjes).")
    return str(cid).replace("-", "")


@with_retry()
def search(customer_id: str, query: str) -> list[Any]:
    """
    Eén GAQL-query, volledig uitgelezen.

    search_stream in plaats van search: één stream in plaats van paginering,
    dus minder API-operations. Bij Basic access heb je 15.000 operations per dag
    en dat wil je niet verspillen aan paginering.

    De hele stream wordt hier in geheugen gelezen. Dat is prima voor dimensies
    en dagmetrics; voor click_view met heel veel rijen komt er later een
    variant die per batch teruggeeft.
    """
    service = ads_client().get_service("GoogleAdsService")
    rows: list[Any] = []
    for batch in service.search_stream(customer_id=str(customer_id), query=query):
        rows.extend(batch.results)
    return rows


def search_iter(customer_id: str, query: str) -> Iterator[Any]:
    """Zelfde query, maar rij voor rij — voor grote resultaten.

    Let op: de retry-decorator zit hier bewust niet op. Een generator die
    halverwege opnieuw begint zou rijen dubbel opleveren; de aanroeper moet zelf
    beslissen wat er bij een fout gebeurt.
    """
    service = ads_client().get_service("GoogleAdsService")
    for batch in service.search_stream(customer_id=str(customer_id), query=query):
        yield from batch.results
