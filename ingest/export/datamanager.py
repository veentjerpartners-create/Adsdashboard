"""
De Data Manager API: het kanaal waarlangs offline conversies nu naar Google
Ads gaan.

WAAROM NIET ConversionUploadService
Sinds mei 2026 wijst Google nieuwe integraties af met "New integrations for
uploading click conversions should use the Data Manager API". Alleen wie het
oude kanaal al gebruikte mag ermee door. Wij niet, dus dit.

WAT ANDERS IS
- Eigen OAuth-scope: https://www.googleapis.com/auth/datamanager. Het refresh
  token uit google-ads.yaml heeft alleen de Ads-scope en werkt hier niet.
  Eén keer `python -m ingest.export.datamanager token` draaien geeft een
  nieuw token; dat gaat als DATAMANAGER_REFRESH_TOKEN in .env.local.
- De API moet aan staan in het Cloud-project (google-ads-tooling):
  https://console.cloud.google.com/apis/library/datamanager.googleapis.com
- Geen developer token. Wel: login_account = het MCC, operating_account = het
  klantaccount, product_destination_id = het nummer van de conversieactie.
- Verwerking is asynchroon. Het antwoord bevat een request_id en eventuele
  veldwaarschuwingen; een conversie die Google later alsnog afkeurt (klik te
  oud, onbekende gclid) zie je alleen in Google Ads onder Doelen ->
  Diagnostiek. validate_only=True geeft wel meteen een oordeel, dus dat doen
  we eerst, per batch.
"""
from __future__ import annotations

import logging
import os
import sys
from datetime import datetime

from ..core.config import REPO_ROOT, ConfigError, settings

log = logging.getLogger(__name__)

SCOPE = "https://www.googleapis.com/auth/datamanager"
TOKEN_URI = "https://oauth2.googleapis.com/token"


def _oauth_client() -> tuple[str, str]:
    """client_id en client_secret: uit de omgeving, anders uit google-ads.yaml."""
    cid, secret = os.getenv("GOOGLE_ADS_CLIENT_ID"), os.getenv("GOOGLE_ADS_CLIENT_SECRET")
    if cid and secret:
        return cid, secret
    path = settings().google_ads_yaml
    if path and path.exists():
        import yaml
        y = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        if y.get("client_id") and y.get("client_secret"):
            return str(y["client_id"]), str(y["client_secret"])
    raise ConfigError("GOOGLE_ADS_CLIENT_ID/SECRET ontbreken, ook in google-ads.yaml.")


def credentials():
    """OAuth-credentials met de datamanager-scope."""
    token = os.getenv("DATAMANAGER_REFRESH_TOKEN")
    if not token:
        raise ConfigError(
            "DATAMANAGER_REFRESH_TOKEN ontbreekt. Draai eenmalig: "
            "python -m ingest.export.datamanager token   en zet de uitkomst in "
            f"{REPO_ROOT / '.env.local'}."
        )
    from google.oauth2.credentials import Credentials

    cid, secret = _oauth_client()
    return Credentials(
        None, refresh_token=token, token_uri=TOKEN_URI,
        client_id=cid, client_secret=secret, scopes=[SCOPE],
    )


def client():
    import google.ads.datamanager_v1 as dm
    return dm.IngestionServiceClient(credentials=credentials())


def ingest(
    *, mcc: str, customer_id: str, events: list[dict], validate_only: bool = False,
) -> tuple[str, list[str]]:
    """
    events: [{action_id, click_type, click_id, order_id, at (datetime met tz),
              value, currency, consent}]
    Geeft (request_id, waarschuwingen) terug. Fouten komen als exception.
    """
    import google.ads.datamanager_v1 as dm

    acties = sorted({e["action_id"] for e in events})
    ref = {a: f"d{i}" for i, a in enumerate(acties)}
    destinations = [
        dm.Destination(
            reference=ref[a],
            login_account=dm.ProductAccount(
                account_type=dm.ProductAccount.AccountType.GOOGLE_ADS, account_id=mcc),
            operating_account=dm.ProductAccount(
                account_type=dm.ProductAccount.AccountType.GOOGLE_ADS, account_id=customer_id),
            product_destination_id=str(a),
        )
        for a in acties
    ]

    consent_enum = {
        "GRANTED": dm.ConsentStatus.CONSENT_GRANTED,
        "DENIED": dm.ConsentStatus.CONSENT_DENIED,
    }
    rijen = []
    for e in events:
        ev = dm.Event(
            destination_references=[ref[e["action_id"]]],
            transaction_id=e["order_id"],
            event_timestamp=e["at"],
            event_source=dm.EventSource.WEB,
            ad_identifiers=dm.AdIdentifiers(**{e["click_type"]: e["click_id"]}),
        )
        if e.get("value") is not None:
            ev.conversion_value = float(e["value"])
            ev.currency = e.get("currency") or "EUR"
        c = consent_enum.get(e.get("consent") or "")
        if c is not None:
            ev.consent = dm.Consent(ad_user_data=c, ad_personalization=c)
        rijen.append(ev)

    req = dm.IngestEventsRequest(
        destinations=destinations, events=rijen, validate_only=validate_only,
    )
    resp = client().ingest_events(request=req)
    waarschuwingen = []
    for w in getattr(resp, "field_warnings", []) or []:
        waarschuwingen.append(f"{getattr(w, 'field_name', '?')}: "
                              f"{getattr(w, 'warning_description', w)}")
    return resp.request_id, waarschuwingen


def maak_token() -> int:
    """Eenmalig: in de browser inloggen en het refresh token tonen."""
    from google_auth_oauthlib.flow import InstalledAppFlow

    cid, secret = _oauth_client()
    flow = InstalledAppFlow.from_client_config(
        {"installed": {
            "client_id": cid, "client_secret": secret,
            "auth_uri": "https://accounts.google.com/o/oauth2/auth",
            "token_uri": TOKEN_URI,
        }},
        scopes=[SCOPE],
    )
    print()
    print("Er gaat een browser open. Log in met het Google-account dat toegang")
    print("heeft tot het MCC (hetzelfde als voor de Ads API).")
    print()
    creds = flow.run_local_server(port=0, prompt="consent", access_type="offline")
    print()
    print("Zet deze regel in .env.local:")
    print()
    print(f"DATAMANAGER_REFRESH_TOKEN={creds.refresh_token}")
    print()
    return 0


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "token":
        sys.exit(maak_token())
    print(__doc__)
