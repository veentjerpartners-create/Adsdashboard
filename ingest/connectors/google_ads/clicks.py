"""
Stap 0.10 — click_view: de brug tussen een gclid en zijn campagne.

DIT IS DE ENIGE SYNC MET EEN DEADLINE.

Als een lead binnenkomt met een gclid, is dat op zichzelf een betekenisloze
string. Pas door hem hier op te zoeken weet je uit welke campagne, adgroep en
op welk zoekwoord die lead kwam. En Google levert die koppeling:

  * alleen over de laatste 90 dagen;
  * maar één dag per query (segments.date = '...', geen BETWEEN);
  * en nooit met terugwerkende kracht.

Een dag die je mist, is voorgoed weg. Daarom draait deze job elke nacht over
gisteren, en haalt hij bij een gemiste dag automatisch het gat op tot 90 dagen
terug.

WAT ER NIET IN ZIT
Niet elke klik heeft een gclid. Performance Max en Display leveren er geen, en
op iOS krijg je vaak wbraid of gbraid in plaats van gclid. Die leads krijgen
attributie via utm-parameters (zie docs/04-attributie-matching.md, L5 en de
stappen daaronder), niet via deze tabel.
"""
from __future__ import annotations

import logging
from datetime import date, timedelta

from ...core.db import fetch_all, upsert
from ...core.kalender import gisteren as gisteren_in
from ...core.sync import cursor_for, sync_run
from .client import describe_error, search

log = logging.getLogger(__name__)

# Google's harde grens. Verder terug vragen levert een lege of foute respons.
MAX_TERUG = 90

CONNECTOR = "google_ads.clicks"


def q_clicks(day: date) -> str:
    # click_view accepteert alleen een enkele dag, geen BETWEEN.
    return f"""
        SELECT
          click_view.gclid,
          click_view.keyword_info.text,
          click_view.keyword_info.match_type,
          click_view.area_of_interest.most_specific,
          campaign.id,
          ad_group.id,
          segments.date,
          segments.device,
          segments.ad_network_type
        FROM click_view
        WHERE segments.date = '{day}'
    """


def _enum(value) -> str | None:
    name = getattr(value, "name", None)
    return None if name in (None, "UNSPECIFIED", "UNKNOWN") else name


def sync_day(customer_id: str, account_uuid: str, day: date) -> int:
    """Alle klikken met een gclid van één dag, voor één account."""
    with sync_run(
        CONNECTOR, scope=customer_id,
        window_start=day, window_end=day, advance_cursor_to=day,
    ) as run:
        rows = []
        for r in search(customer_id, q_clicks(day)):
            gclid = r.click_view.gclid
            if not gclid:
                # PMax en Display leveren klikken zonder gclid. Die zeggen ons
                # niets, want we kunnen ze nooit aan een lead knopen.
                continue
            rows.append({
                "click_id": gclid,
                "ads_account_id": account_uuid,
                "click_date": str(r.segments.date),
                "campaign_id": r.campaign.id or None,
                "ad_group_id": r.ad_group.id or None,
                "keyword_text": r.click_view.keyword_info.text or None,
                "match_type": _enum(r.click_view.keyword_info.match_type),
                "device": _enum(r.segments.device),
                "ad_network": _enum(r.segments.ad_network_type),
                "area_of_interest": r.click_view.area_of_interest.most_specific or None,
            })
        run.read(len(rows))
        written = upsert("ads_click", rows, on_conflict="click_id")
        run.wrote(written)
        return written


def _eerste_zinnige_dag(account_uuid: str, grens: date) -> date:
    """
    Vanaf welke dag heeft het zin om klikken op te halen?

    Bij een eerste run zou je blind 90 dagen terug gaan. Voor een account dat
    twee dagen geleden is aangemaakt zijn dat 88 query's die gegarandeerd niets
    opleveren -- en elke query telt mee voor je dagquotum.

    Daarom: begin bij de vroegste dag waarop dit account uberhaupt vertoningen
    had. Is die er niet, dan bij de vroegste campagne-startdatum. Nooit verder
    terug dan de 90-dagengrens van Google.
    """
    from ...core.db import tbl

    res = (
        tbl("ads_metrics_daily").select("date")
        .eq("ads_account_id", account_uuid)
        .order("date", desc=False).limit(1).execute()
    )
    if res.data:
        return max(grens, date.fromisoformat(res.data[0]["date"]))

    res = (
        tbl("ads_campaign").select("start_date")
        .eq("ads_account_id", account_uuid)
        .not_.is_("start_date", "null")
        .order("start_date", desc=False).limit(1).execute()
    )
    if res.data:
        return max(grens, date.fromisoformat(res.data[0]["start_date"]))

    return grens


def _client_accounts() -> list[dict]:
    return [
        a for a in fetch_all(
            "ads_account", "id,customer_id,descriptive_name,is_manager,time_zone")
        if not a["is_manager"]
    ]


def sync_gap(max_days: int = MAX_TERUG) -> dict[str, int]:
    """
    Het nachtelijke werk.

    Kijkt per account tot welke dag we klaar zijn (mi.sync_cursor) en haalt
    alles op tot en met gisteren. Is de job een week niet gelopen, dan pakt hij
    die week vanzelf in. Nooit verder terug dan 90 dagen, want daar heeft Google
    de data niet meer.
    """
    out: dict[str, int] = {}

    for a in _client_accounts():
        label = a.get("descriptive_name") or a["customer_id"]
        # Vandaag slaan we hier wel over: click_view van een lopende dag is
        # onvolledig, en anders zou de cursor doorschuiven en de rest van de
        # dag nooit meer opgehaald worden.
        gisteren = gisteren_in(a.get("time_zone"))
        grens = gisteren - timedelta(days=max_days - 1)
        laatste = cursor_for(CONNECTOR, a["customer_id"])
        if laatste:
            vanaf = max(grens, laatste + timedelta(days=1))
        else:
            # Eerste run: niet blind 90 dagen terug, maar vanaf het moment dat
            # dit account voor het eerst iets deed.
            vanaf = _eerste_zinnige_dag(a["id"], grens)
            log.info("%s: eerste run, klikken vanaf %s", label, vanaf)

        if vanaf > gisteren:
            log.info("%s: klikken zijn bij t/m %s", label, laatste)
            out[label] = 0
            continue

        if laatste and (vanaf - laatste).days > 1:
            log.warning(
                "%s: gat van %s tot %s valt buiten het 90-dagenvenster van Google "
                "en is niet meer op te halen.",
                label, laatste + timedelta(days=1), vanaf - timedelta(days=1),
            )

        totaal = 0
        dag = vanaf
        while dag <= gisteren:
            try:
                totaal += sync_day(a["customer_id"], a["id"], dag)
            except Exception as exc:  # noqa: BLE001
                # Eén mislukte dag mag de rest niet ophouden; de cursor blijft
                # dan staan, dus morgen probeert hij het opnieuw.
                log.error("klikken %s %s overgeslagen: %s", label, dag, describe_error(exc))
                break
            dag += timedelta(days=1)
        out[label] = totaal
        log.info("%s: %d klikken met gclid opgehaald", label, totaal)

    return out


def report() -> str:
    """Hoe ver zijn we, en hoeveel klikken hebben we?"""
    from ...core.db import tbl

    lines = ["", "Klik-historie (gclid -> campagne)", ""]
    for a in _client_accounts():
        label = a.get("descriptive_name") or a["customer_id"]
        laatste = cursor_for(CONNECTOR, a["customer_id"])
        gisteren = gisteren_in(a.get("time_zone"))
        n = (
            tbl("ads_click").select("click_id", count="exact")
            .eq("ads_account_id", a["id"]).limit(1).execute().count
        )
        achterstand = (gisteren - laatste).days if laatste else None
        stand = f"bij t/m {laatste}" if laatste else "nooit gelopen"
        alarm = ""
        if achterstand and achterstand > 0:
            alarm = f"  <-- {achterstand} dag(en) achter"
        lines.append(f"  {label:<32} {n:>6} klikken   {stand}{alarm}")
    lines += [
        "",
        "Google bewaart deze koppeling 90 dagen. Een gemiste dag is voorgoed weg.",
        "",
    ]
    return "\n".join(lines)
