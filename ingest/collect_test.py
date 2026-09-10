"""
Acceptatietest voor de collector.

Speelt precies het scenario uit de briefing na:

    Google Ads klik -> landingspagina -> paginaweergave -> WhatsApp-klik
    ... drie dagen niets ...
    terug op de site -> formulier gestart -> formulier verstuurd

De WhatsApp-klik gebeurt terwijl we NIET weten wie de bezoeker is. Pas bij de
inzending ontstaat de lead, en dan moeten alle eerdere events er alsnog aan
hangen. Dat is de kern van het hele systeem; als dit niet klopt, klopt de
tijdlijn op de leadpagina ook niet.

Draait tegen de echte database, maar ruimt zichzelf op.

    python -m ingest.collect_test
    python -m ingest.collect_test --behouden    # laat de testlead staan
"""
from __future__ import annotations

import argparse
import json
import uuid
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from .core.db import db, settings, tbl

TESTMAIL = "collector-test@voorbeeld-mi.nl"

# De database slaat alles in UTC op -- dat is goed. Voor het lezen rekenen we
# om naar de tijdzone van de klant. Nooit naar de tijdzone van de server: die
# stond bij het schrijven van deze test op UTC-5, en dat is niet Amsterdam.
KLANT_TZ = ZoneInfo("Europe/Amsterdam")


def lokaal(iso: str) -> str:
    """UTC-tijdstempel uit de database naar leesbare klanttijd."""
    return (datetime.fromisoformat(iso.replace("Z", "+00:00"))
            .astimezone(KLANT_TZ).strftime("%d %b %H:%M"))


def rpc(payload: dict) -> dict:
    """mi.collect() aanroepen zoals het endpoint dat doet."""
    client = db()
    schema = settings().db_schema
    if hasattr(client, "schema"):
        res = client.schema(schema).rpc("collect", {"p": payload}).execute()
    else:
        res = client.postgrest.schema(schema).rpc("collect", {"p": payload}).execute()
    return res.data if isinstance(res.data, dict) else json.loads(res.data)


def ms(dagen_geleden: float) -> int:
    t = datetime.now(timezone.utc) - timedelta(days=dagen_geleden)
    return int(t.timestamp() * 1000)


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--behouden", action="store_true",
                   help="testlead niet opruimen, zodat je hem in de database kunt bekijken")
    args = p.parse_args()

    site = tbl("website").select("domain,collector_key,client_id").limit(1).execute()
    if not site.data:
        print("Geen website in mi.website. Draai eerst de seed.")
        return 1
    key = site.data[0]["collector_key"]
    print(f"\nTest tegen {site.data[0]['domain']}\n")

    vid = str(uuid.uuid4())
    sid1 = str(uuid.uuid4())
    sid2 = str(uuid.uuid4())
    gclid = "TEST-" + uuid.uuid4().hex[:24]

    def event(t, sid, dagen, url, meta=None, met_klik=True, lead=None):
        payload = {
            "k": key, "vid": vid, "sid": sid, "uid": str(uuid.uuid4()),
            "t": t, "ts": ms(dagen), "url": url,
            "ttl": "Testpagina", "ref": "https://www.google.com/",
            "dev": "mobile", "cs": "accepted",
            "utm": {"source": "google", "medium": "cpc",
                    "campaign": "daklekkage", "term": "daklekkage reparatie"} if met_klik else {},
            "cid": {"id": gclid, "type": "gclid"} if met_klik else {},
            "gac": "1234567890.1757000000",
            "meta": meta or {},
        }
        if lead:
            payload["lead"] = lead
        return rpc(payload)

    # --- Sessie 1: advertentieklik, drie dagen geleden, nog anoniem ---
    print("Sessie 1 (3 dagen geleden, anoniem)")
    for t, url, meta in [
        ("session_start", "https://x.nl/daklekkage/", None),
        ("page_view", "https://x.nl/daklekkage/", {"page_type": "dienst"}),
        ("page_view", "https://x.nl/dakrenovatie.html", {"page_type": "dienst"}),
        ("whatsapp_click", "https://x.nl/dakrenovatie.html", {"cta_location": "fab"}),
    ]:
        r = event(t, sid1, 3, url, meta)
        print(f"  {t:<16} {'ok' if r.get('ok') else r}")

    # --- Sessie 2: vandaag terug, en nu vult hij het formulier in ---
    print("\nSessie 2 (vandaag, wordt geidentificeerd)")
    for t, url, meta in [
        ("page_view", "https://x.nl/contact.html", {"page_type": "contact"}),
        ("form_start", "https://x.nl/contact.html", {"form_id": "contact"}),
    ]:
        r = event(t, sid2, 0, url, meta, met_klik=False)
        print(f"  {t:<16} {'ok' if r.get('ok') else r}")

    res = event("form_submit", sid2, 0, "https://x.nl/contact.html",
                met_klik=False,
                lead={"name": "Test Persoon", "email": TESTMAIL,
                      "phone": "06-12345678", "subject": "daklekkage",
                      "browser_lead_id": "test" + uuid.uuid4().hex[:10]})
    print(f"  {'form_submit':<16} {'ok' if res.get('ok') else res}")

    lead_id = res.get("lead_id")
    if not lead_id:
        print("\nFOUT: er is geen lead aangemaakt.")
        return 1

    # --- Controle ---
    lead = tbl("lead").select(
        "public_ref,name,email,phone_e164,source,medium,campaign,click_id,"
        "landing_page,status,match_confidence,consent_marketing"
    ).eq("id", lead_id).single().execute().data

    events = tbl("lead_event").select("event_type,occurred_at,page_path").eq(
        "lead_id", lead_id).order("occurred_at").execute().data

    ids = tbl("lead_identity").select("kind,confidence,method").eq(
        "lead_id", lead_id).execute().data

    print(f"\nLead #{lead['public_ref']} - {lead['name']}")
    print(f"  telefoon        {lead['phone_e164']}   (uit '06-12345678')")
    print(f"  herkomst        {lead['source']} / {lead['medium']} / {lead['campaign']}")
    print(f"  click-id        {(lead['click_id'] or '')[:24]}...")
    print(f"  landingspagina  {lead['landing_page']}")
    print(f"  consent         {lead['consent_marketing']}")

    print(f"\nTijdlijn ({len(events)} events, gekoppeld: {res['gekoppelde_events']})")
    for e in events:
        print(f"  {lokaal(e['occurred_at']):<14} {e['event_type']:<16} {e['page_path'] or ''}")

    print("\nHoe we weten dat dit een en dezelfde persoon is")
    for i in ids:
        print(f"  {i['kind']:<18} {i['method']:<18} {i['confidence']}")

    # --- Oordeel ---
    print()
    fouten = []
    typen = [e["event_type"] for e in events]
    if "whatsapp_click" not in typen:
        fouten.append("de WhatsApp-klik van 3 dagen geleden hangt NIET aan de lead")
    if len(events) < 7:
        fouten.append(f"maar {len(events)} events gekoppeld, verwacht 7")
    if lead["campaign"] != "daklekkage":
        fouten.append(f"campagne is '{lead['campaign']}', verwacht 'daklekkage' "
                      f"(uit de eerste sessie, niet de laatste)")
    if lead["phone_e164"] != "+31612345678":
        fouten.append(f"telefoon niet genormaliseerd: {lead['phone_e164']}")
    if not lead["click_id"]:
        fouten.append("gclid niet overgenomen op de lead")

    if fouten:
        print("MISLUKT:")
        for f in fouten:
            print("  -", f)
        return 1

    print("GESLAAGD - een anonieme WhatsApp-klik van drie dagen eerder hangt")
    print("           aan de lead, met de campagne van de eerste sessie.")

    if not args.behouden:
        tbl("lead_event").delete().eq("lead_id", lead_id).execute()
        tbl("lead_event").delete().eq("visitor_id", vid).execute()
        tbl("lead").delete().eq("id", lead_id).execute()
        tbl("visit_session").delete().eq("visitor_id", vid).execute()
        tbl("visitor").delete().eq("id", vid).execute()
        print("\nTestdata opgeruimd.")
    else:
        print(f"\nTestlead #{lead['public_ref']} blijft staan.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
