"""
Sync-boekhouding.

Elke run schrijft een regel in mi.sync_run: wat, waarover, welk venster, hoeveel
rijen, gelukt of niet. Bij succes schuift mi.sync_cursor mee.

Waarom dat telt: een mislukte nacht moet zichtbaar zijn in het dashboard in
plaats van als een stille nul door te sijpelen in de cijfers. En de cursor
blijft bij een fout staan, zodat de volgende run het gat opnieuw pakt.
"""
from __future__ import annotations

import logging
import traceback
from contextlib import contextmanager
from datetime import date, datetime, timezone
from typing import Any, Iterator

from .db import tbl

log = logging.getLogger(__name__)


class SyncRun:
    """Meegegeven aan de connector, die er rijen en waarschuwingen in kwijt kan."""

    def __init__(self, run_id: str, connector: str, scope: str):
        self.run_id = run_id
        self.connector = connector
        self.scope = scope
        self.rows_read = 0
        self.rows_written = 0
        self.warnings: list[dict[str, Any]] = []

    def read(self, n: int = 1) -> None:
        self.rows_read += n

    def wrote(self, n: int) -> None:
        self.rows_written += n

    def warn(self, code: str, message: str, **extra: Any) -> None:
        """Iets dat de run niet stopt maar wel gezien moet worden. Bijvoorbeeld
        GA4 dat een (other)-rij teruggaf, of een account zonder campagnes."""
        log.warning("[%s/%s] %s: %s", self.connector, self.scope, code, message)
        self.warnings.append({"code": code, "message": message, **extra})


@contextmanager
def sync_run(
    connector: str,
    scope: str,
    *,
    mode: str = "incremental",
    window_start: date | None = None,
    window_end: date | None = None,
    advance_cursor_to: date | None = None,
) -> Iterator[SyncRun]:
    """
    Gebruik:

        with sync_run("google_ads.accounts", scope=MCC) as run:
            ...
            run.wrote(n)

    Gaat er iets mis, dan wordt de fout weggeschreven én opnieuw opgegooid —
    de aanroeper beslist of de hele nacht faalt of alleen dit account.
    """
    started = datetime.now(timezone.utc)
    row = {
        "connector": connector,
        "scope": scope,
        "mode": mode,
        "window_start": window_start.isoformat() if window_start else None,
        "window_end": window_end.isoformat() if window_end else None,
        "status": "running",
        "started_at": started.isoformat(),
    }
    created = tbl("sync_run").insert(row).execute()
    run_id = created.data[0]["id"]
    run = SyncRun(run_id, connector, scope)
    log.info("-> %s [%s] gestart", connector, scope)

    try:
        yield run
    except BaseException as exc:  # noqa: BLE001
        # Google Ads-fouten stringify'en naar honderden regels gRPC-dump; die
        # willen we niet in de database en niet op het scherm.
        try:
            from ..connectors.google_ads.client import describe_error
            beschrijving = describe_error(exc)
        except Exception:  # noqa: BLE001
            beschrijving = f"{type(exc).__name__}: {exc}"
        tbl("sync_run").update({
            "status": "failed",
            "rows_read": run.rows_read,
            "rows_written": run.rows_written,
            "warnings": run.warnings,
            "error": f"{type(exc).__name__}: {exc}\n{traceback.format_exc(limit=6)}",
            "finished_at": datetime.now(timezone.utc).isoformat(),
        }).eq("id", run_id).execute()
        log.error("FOUT %s [%s]: %s", connector, scope, beschrijving)
        raise
    else:
        status = "partial" if run.warnings else "ok"
        finished = datetime.now(timezone.utc)
        tbl("sync_run").update({
            "status": status,
            "rows_read": run.rows_read,
            "rows_written": run.rows_written,
            "warnings": run.warnings,
            "finished_at": finished.isoformat(),
        }).eq("id", run_id).execute()

        tbl("sync_cursor").upsert({
            "connector": connector,
            "scope": scope,
            "last_complete_date": (advance_cursor_to or window_end).isoformat()
                                  if (advance_cursor_to or window_end) else None,
            "last_ok_at": finished.isoformat(),
            "updated_at": finished.isoformat(),
        }, on_conflict="connector,scope").execute()

        log.info(
            "OK   %s [%s] %s - %d gelezen, %d weggeschreven, %.1fs",
            connector, scope, status, run.rows_read, run.rows_written,
            (finished - started).total_seconds(),
        )


def cursor_for(connector: str, scope: str) -> date | None:
    """Tot en met welke dag is deze connector klaar? None = nog nooit gelopen."""
    res = (
        tbl("sync_cursor")
        .select("last_complete_date")
        .eq("connector", connector)
        .eq("scope", scope)
        .limit(1)
        .execute()
    )
    if not res.data:
        return None
    value = res.data[0].get("last_complete_date")
    return date.fromisoformat(value) if value else None
