"""
Offline conversies terug naar Google Ads.

WAAROM
De conversietag op de website vuurt alleen als de bezoeker cookies accepteert.
Wie dat niet doet -- en dat is de meerderheid -- is voor Google onzichtbaar,
ook al klikte hij op WhatsApp of vulde hij het formulier in. Wij hebben die
klik wél: het snippet bewaart de gclid en stuurt hem met elk event mee. Dus
sturen we hem zelf terug via de API. Daar zijn geen cookies voor nodig.

WAT
Elk lead_event van het juiste type met een Google click-ID wordt één
ClickConversion. Eén rij per event in mi.conversion_upload, zodat je altijd
kunt zien wat er wanneer naar Google ging en waarom iets niet lukte.

    whatsapp_click  -> "WhatsApp-klik (upload)"
    phone_click     -> "Telefoon-klik (upload)"
    form_submit     -> "Offerteaanvraag (upload)"   alleen met een echte lead

De conversieacties zijn van het type UPLOAD_CLICKS (de bestaande WEBPAGE-acties
accepteren geen uploads), staan op SECUNDAIR en hebben een terugkijkvenster
van 90 dagen -- het maximum, en dezelfde termijn als ons snippet.

Het versturen gaat via de Data Manager API (zie datamanager.py): het oude
ConversionUploadService-kanaal is sinds mei 2026 dicht voor nieuwe
integraties. De acties zelf worden nog gewoon via de Ads API aangemaakt.

Secundair betekent: Google telt ze in "Alle conversies", maar biedt er niet
op. Dat is bewust. Eerst een maand kijken of de cijfers kloppen, dan pas
beslissen of WhatsApp mag sturen (roadmap stap 44).

CONSENT
Google vraagt bij EER-verkeer om de toestemmingsstatus per conversie. We
sturen wat we weten: 'accepted' -> GRANTED, onbekend -> UNKNOWN. Wie de
cookies expliciet weigerde, uploaden we niet. Een click-ID is geen
persoonsgegeven, maar we nemen de keuze van de bezoeker serieus.

    python -m ingest.run conversions            wachtrij vullen en uploaden
    python -m ingest.run conversions --dry-run  alleen laten zien wat er zou gaan
    python -m ingest.run conversions --report   wat er de laatste tijd gebeurde
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from zoneinfo import ZoneInfo

from ..connectors.google_ads.client import ads_client, describe_error, search
from ..core.db import fetch_all, tbl
from ..core.sync import sync_run

log = logging.getLogger(__name__)

TERUGKIJK_DAGEN = 90            # click-through lookback, maximum bij Google
BATCH = 500                     # Google staat 2.000 toe; kleiner is makkelijker te lezen
CLICK_TYPES = ("gclid", "gbraid", "wbraid")

# event_type -> (naam van de conversieactie, categorie, of een lead vereist is)
ACTIES: dict[str, tuple[str, str, bool]] = {
    "whatsapp_click": ("WhatsApp-klik (upload)",   "CONTACT",          False),
    "phone_click":    ("Telefoon-klik (upload)",   "PHONE_CALL_LEAD",  False),
    "form_submit":    ("Offerteaanvraag (upload)", "SUBMIT_LEAD_FORM", True),
}

CONSENT = {"accepted": "GRANTED", "denied": "DENIED"}


# --------------------------------------------------------------------------
# 1. Conversieacties: bestaan ze, en zo niet, aanmaken
# --------------------------------------------------------------------------

def bestaande_acties(customer_id: str) -> dict[str, dict]:
    """Naam -> {resource_name, type, status} van alle niet-verwijderde acties."""
    uit = {}
    for r in search(customer_id, """
        SELECT conversion_action.resource_name, conversion_action.name,
               conversion_action.type, conversion_action.status,
               conversion_action.primary_for_goal
        FROM conversion_action
        WHERE conversion_action.status != 'REMOVED'
    """):
        a = r.conversion_action
        uit[a.name] = {
            "resource_name": a.resource_name,
            "type": a.type_.name,
            "status": a.status.name,
            "primary": a.primary_for_goal,
        }
    return uit


def zorg_voor_acties(customer_id: str, *, dry_run: bool = False) -> dict[str, str]:
    """
    event_type -> resource_name. Maakt ontbrekende acties aan.

    Idempotent: een actie die al bestaat wordt hergebruikt, ook als hij met
    de hand is aangemaakt -- zolang de naam maar klopt.
    """
    client = ads_client()
    huidige = bestaande_acties(customer_id)
    uit: dict[str, str] = {}

    for event_type, (naam, categorie, _) in ACTIES.items():
        if naam in huidige:
            if huidige[naam]["type"] != "UPLOAD_CLICKS":
                log.warning("%s: '%s' bestaat maar is %s, geen UPLOAD_CLICKS; overgeslagen",
                            customer_id, naam, huidige[naam]["type"])
                continue
            uit[event_type] = huidige[naam]["resource_name"]
            continue

        if dry_run:
            log.info("%s: zou conversieactie '%s' aanmaken", customer_id, naam)
            continue

        op = client.get_type("ConversionActionOperation")
        a = op.create
        a.name = naam
        a.type_ = client.enums.ConversionActionTypeEnum.UPLOAD_CLICKS
        a.category = getattr(client.enums.ConversionActionCategoryEnum, categorie)
        a.status = client.enums.ConversionActionStatusEnum.ENABLED
        a.primary_for_goal = False            # secundair, zie de kop van dit bestand
        a.counting_type = client.enums.ConversionActionCountingTypeEnum.ONE_PER_CLICK
        a.click_through_lookback_window_days = TERUGKIJK_DAGEN
        # We sturen zelf een waarde mee (de € 40 uit de site, later de marge).
        # Zonder waarde valt Google terug op 0, niet op een verzonnen bedrag.
        a.value_settings.default_value = 0.0
        a.value_settings.always_use_default_value = False

        svc = client.get_service("ConversionActionService")
        rn = svc.mutate_conversion_actions(
            customer_id=customer_id, operations=[op]).results[0].resource_name
        log.info("%s: conversieactie '%s' aangemaakt (%s)", customer_id, naam, rn)
        uit[event_type] = rn
    return uit


# --------------------------------------------------------------------------
# 2. Wachtrij: welke events moeten nog naar Google?
# --------------------------------------------------------------------------

def _accounts_per_klant() -> dict[str, list[dict]]:
    per: dict[str, list[dict]] = {}
    for a in fetch_all("ads_account", "id,customer_id,client_id,time_zone,is_manager,currency_code"):
        if a["is_manager"] or not a["client_id"]:
            continue
        per.setdefault(a["client_id"], []).append(a)
    return per


def _campagne_account() -> dict[str, str]:
    """campaign_id (als tekst) -> ads_account_id, om bij meerdere accounts per
    klant het juiste te kiezen."""
    return {str(c["campaign_id"]): c["ads_account_id"]
            for c in fetch_all("ads_campaign", "campaign_id,ads_account_id")}


def _tijd_in_account(occurred_at: str, tz: str | None) -> str:
    """'yyyy-MM-dd HH:mm:ss+HH:MM' in de tijdzone van het account. De meest
    voorkomende reden dat Google een upload afwijst is een tijd zonder offset."""
    t = datetime.fromisoformat(occurred_at.replace("Z", "+00:00"))
    try:
        t = t.astimezone(ZoneInfo(tz or "Europe/Amsterdam"))
    except Exception:  # noqa: BLE001
        t = t.astimezone(ZoneInfo("Europe/Amsterdam"))
    s = t.strftime("%Y-%m-%d %H:%M:%S%z")
    return s[:-2] + ":" + s[-2:]


def vul_wachtrij(*, dry_run: bool = False) -> dict[str, int]:
    """
    Nieuwe conversion_upload-rijen voor events die nog niet in de wachtrij
    staan. Alleen rijen aanmaken; het uploaden gebeurt apart, zodat een
    API-fout nooit betekent dat we vergeten wat er nog moest.
    """
    sinds = (datetime.now(timezone.utc) - timedelta(days=TERUGKIJK_DAGEN)).isoformat()
    events = (
        tbl("lead_event")
        .select("id,client_id,lead_id,visitor_id,event_type,occurred_at,click_id,"
                "click_type,metadata,campaign")
        .in_("event_type", list(ACTIES))
        .in_("click_type", list(CLICK_TYPES))
        .gte("occurred_at", sinds)
        .order("occurred_at")
        .limit(5000)
        .execute()
        .data or []
    )
    if not events:
        return {"kandidaten": 0, "nieuw": 0, "overgeslagen": 0}

    al = {
        r["order_id"]
        for r in tbl("conversion_upload").select("order_id")
        .in_("order_id", [f"ev-{e['id']}" for e in events]).execute().data or []
    }
    accounts = _accounts_per_klant()
    camp_acc = _campagne_account()
    consent_per_bezoeker = {
        v["id"]: v["consent_state"]
        for v in tbl("visitor").select("id,consent_state")
        .in_("id", list({e["visitor_id"] for e in events if e["visitor_id"]}))
        .execute().data or []
    }

    nieuw: list[dict] = []
    overgeslagen = 0
    for e in events:
        order_id = f"ev-{e['id']}"
        if order_id in al:
            continue
        naam, _, lead_vereist = ACTIES[e["event_type"]]
        meta = e.get("metadata") or {}
        if meta.get("bot"):
            continue
        if lead_vereist and not e["lead_id"]:
            continue          # form_submit op de bedankpagina, zonder lead erachter

        kandidaten = accounts.get(e["client_id"]) or []
        if not kandidaten:
            overgeslagen += 1
            continue
        acc = None
        cid = str(meta.get("mi_cid") or meta.get("gad_campaignid") or "")
        if len(kandidaten) > 1 and cid and camp_acc.get(cid):
            acc = next((a for a in kandidaten if a["id"] == camp_acc[cid]), None)
        acc = acc or kandidaten[0]

        consent = consent_per_bezoeker.get(e["visitor_id"])
        rij = {
            "client_id": e["client_id"],
            "lead_id": e["lead_id"],
            "lead_event_id": e["id"],
            "ads_account_id": acc["id"],
            "conversion_action_rn": naam,     # naam; resource name volgt bij upload
            "method": "click_id",
            "click_id": e["click_id"],
            "click_type": e["click_type"],
            "order_id": order_id,
            "conversion_datetime": _tijd_in_account(e["occurred_at"], acc.get("time_zone")),
            "value": _bedrag(meta.get("value")),
            "currency": (meta.get("currency") or acc.get("currency_code") or "EUR")[:3],
            "consent_ad_user_data": CONSENT.get(consent or "", "UNKNOWN"),
            "consent_ad_personalization": CONSENT.get(consent or "", "UNKNOWN"),
            "status": "pending",
        }
        if consent == "denied":
            rij["status"] = "skipped"
            rij["skip_reason"] = "bezoeker weigerde cookies"
            overgeslagen += 1
        nieuw.append(rij)

    if nieuw and not dry_run:
        for i in range(0, len(nieuw), BATCH):
            tbl("conversion_upload").insert(nieuw[i:i + BATCH]).execute()
    return {"kandidaten": len(events), "nieuw": len(nieuw), "overgeslagen": overgeslagen}


def _bedrag(v) -> float | None:
    try:
        return float(Decimal(str(v))) if v not in (None, "") else None
    except Exception:  # noqa: BLE001
        return None


# --------------------------------------------------------------------------
# 3. Uploaden, via de Data Manager API
# --------------------------------------------------------------------------

def upload_account(acc: dict, *, dry_run: bool = False) -> dict[str, int]:
    """
    Alle pending rijen van één account naar Google.

    Eerst een validate_only-ronde per batch: de Data Manager API verwerkt
    asynchroon, en dit is het enige moment waarop Google meteen zegt wat er
    mis is. Daarna de echte upload. Een afgekeurde batch wordt rij voor rij
    opnieuw gevalideerd, zodat één foute rij niet de hele batch blokkeert en
    de fout bij de juiste rij komt te staan.
    """
    from ..connectors.google_ads.client import mcc_id
    from . import datamanager as dmx

    customer_id = acc["customer_id"]
    rijen = (
        tbl("conversion_upload").select("*")
        .eq("ads_account_id", acc["id"]).eq("status", "pending").eq("method", "click_id")
        .lt("attempts", 5)
        .order("created_at").limit(2000).execute().data or []
    )
    if not rijen:
        return {"pending": 0, "uploaded": 0, "failed": 0}

    with sync_run("google_ads.conversion_upload", scope=customer_id) as run:
        run.read(len(rijen))
        acties = zorg_voor_acties(customer_id, dry_run=dry_run)

        # Van naam naar resource name. Rijen zonder actie (nog niet aangemaakt
        # in dry-run, of een naamconflict) blijven staan tot de volgende run.
        naar_rn = {naam: acties[et] for et, (naam, _, _) in ACTIES.items() if et in acties}
        klaar = [r for r in rijen if r["conversion_action_rn"] in naar_rn
                 or r["conversion_action_rn"] in naar_rn.values()]
        if dry_run:
            for r in klaar:
                log.info("zou uploaden: %s %s %s %s", r["order_id"], r["click_type"],
                         r["conversion_action_rn"], r["conversion_datetime"])
            return {"pending": len(rijen), "uploaded": 0, "failed": 0}

        mcc = mcc_id()
        geslaagd = mislukt = 0
        nu = datetime.now(timezone.utc).isoformat()

        def event(r: dict) -> dict:
            rn = naar_rn.get(r["conversion_action_rn"], r["conversion_action_rn"])
            return {
                "action_id": rn.rsplit("/", 1)[-1],
                "click_type": r["click_type"], "click_id": r["click_id"],
                "order_id": r["order_id"],
                "at": datetime.fromisoformat(r["conversion_datetime"]),
                "value": r["value"], "currency": r["currency"],
                "consent": r["consent_ad_user_data"],
            }

        def markeer(r: dict, ok: bool, toelichting: str | None, request_id: str | None):
            rn = naar_rn.get(r["conversion_action_rn"], r["conversion_action_rn"])
            velden = {"attempts": r["attempts"] + 1, "conversion_action_rn": rn}
            if ok:
                velden.update({
                    "status": "uploaded", "uploaded_at": nu, "last_error": None,
                    "google_response": {"request_id": request_id, "kanaal": "data_manager",
                                        "opmerking": toelichting},
                })
            else:
                velden.update({"status": "failed", "last_error": (toelichting or "?")[:1000]})
            tbl("conversion_upload").update(velden).eq("id", r["id"]).execute()

        for i in range(0, len(klaar), BATCH):
            batch = klaar[i:i + BATCH]
            try:
                dmx.ingest(mcc=mcc, customer_id=customer_id,
                           events=[event(r) for r in batch], validate_only=True)
                goede = batch
            except Exception as exc:  # noqa: BLE001
                # Iets in deze batch deugt niet. Rij voor rij uitzoeken welke.
                log.warning("%s: batch afgekeurd (%s), rij voor rij valideren",
                            customer_id, _kort(exc))
                goede = []
                for r in batch:
                    try:
                        dmx.ingest(mcc=mcc, customer_id=customer_id,
                                   events=[event(r)], validate_only=True)
                        goede.append(r)
                    except Exception as exc1:  # noqa: BLE001
                        mislukt += 1
                        markeer(r, False, _kort(exc1), None)
            if not goede:
                continue
            try:
                request_id, warnings = dmx.ingest(
                    mcc=mcc, customer_id=customer_id, events=[event(r) for r in goede])
            except Exception as exc:  # noqa: BLE001
                for r in goede:
                    mislukt += 1
                    markeer(r, False, _kort(exc), None)
                continue
            for r in goede:
                geslaagd += 1
                markeer(r, True, "; ".join(warnings) or None, request_id)

        run.wrote(geslaagd)
        if mislukt:
            run.warn("afgekeurd", f"{mislukt} van {len(klaar)} afgekeurd door Google")
        return {"pending": len(rijen), "uploaded": geslaagd, "failed": mislukt}


def _kort(exc: BaseException) -> str:
    """Google API-fouten compact: de boodschap plus eventuele details."""
    msg = getattr(exc, "message", None) or str(exc)
    details = getattr(exc, "details", None)
    try:
        extra = "; ".join(str(d) for d in (details() if callable(details) else details or []))
    except Exception:  # noqa: BLE001
        extra = ""
    return (msg + (f" | {extra}" if extra else "")).replace("\n", " ")[:1000]


# --------------------------------------------------------------------------
# 4. Alles, en een rapport
# --------------------------------------------------------------------------

def run_all(*, dry_run: bool = False) -> dict[str, dict[str, int]]:
    uit: dict[str, dict[str, int]] = {"wachtrij": vul_wachtrij(dry_run=dry_run)}
    for a in fetch_all("ads_account", "id,customer_id,descriptive_name,is_manager,client_id"):
        if a["is_manager"] or not a["client_id"]:
            continue
        label = a.get("descriptive_name") or a["customer_id"]
        try:
            uit[label] = upload_account(a, dry_run=dry_run)
        except Exception as exc:  # noqa: BLE001
            log.error("upload %s mislukt: %s", label, describe_error(exc))
            uit[label] = {"pending": -1, "uploaded": 0, "failed": 0}
    return uit


def report(dagen: int = 30) -> str:
    sinds = (datetime.now(timezone.utc) - timedelta(days=dagen)).isoformat()
    rijen = (
        tbl("v_conversion_upload").select("*")
        .gte("created_at", sinds).order("created_at", desc=True).limit(200)
        .execute().data or []
    )
    accounts = {a["id"]: a.get("descriptive_name") or a["customer_id"]
                for a in fetch_all("ads_account", "id,customer_id,descriptive_name")}
    regels = [f"\nOffline conversies, laatste {dagen} dagen ({len(rijen)} rijen)\n"]
    per_status: dict[str, int] = {}
    for r in rijen:
        per_status[r["status"]] = per_status.get(r["status"], 0) + 1
    regels.append("  " + "  ".join(f"{k}: {v}" for k, v in sorted(per_status.items())) + "\n")
    regels.append(f"  {'wanneer':<17} {'account':<26} {'event':<15} {'klik':<7} {'status':<9} toelichting")
    for r in rijen[:60]:
        wanneer = (r["occurred_at"] or r["created_at"] or "")[:16].replace("T", " ")
        toel = r.get("last_error") or r.get("skip_reason") or ""
        regels.append(f"  {wanneer:<17} {accounts.get(r['ads_account_id'], '?')[:26]:<26} "
                      f"{(r['event_type'] or '?'):<15} {(r['click_type'] or ''):<7} "
                      f"{r['status']:<9} {toel[:60]}")
    return "\n".join(regels) + "\n"
