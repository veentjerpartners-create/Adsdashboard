"""
Databasetoegang.

Alles staat in het schema 'mi', want deze database wordt gedeeld met de CMS.
Elke query gaat daarom expliciet via tbl(), nooit rechtstreeks via
client.table() — dat zou in 'public' terechtkomen en dus in de CMS.

De ingestion gebruikt de secret key en omzeilt daarmee bewust RLS. Die key
staat alleen in .env.local en in de omgeving van Railway.
"""
from __future__ import annotations

import logging
from typing import Any, Iterable, Sequence

from supabase import Client, create_client

from .config import settings

log = logging.getLogger(__name__)

_client: Client | None = None


def db() -> Client:
    global _client
    if _client is None:
        cfg = settings()
        _client = create_client(cfg.supabase_url, cfg.supabase_key)
        log.debug("Supabase-client voor %s, schema %s", cfg.project_ref, cfg.db_schema)
    return _client


def tbl(name: str):
    """Een tabel in ons eigen schema. Gebruik dit altijd."""
    schema = settings().db_schema
    client = db()
    # supabase-py 2.x heeft Client.schema(); oudere versies alleen .postgrest.
    if hasattr(client, "schema"):
        return client.schema(schema).table(name)
    return client.postgrest.schema(schema).from_(name)


def upsert(
    table: str,
    rows: Sequence[dict[str, Any]],
    *,
    on_conflict: str,
    chunk_size: int = 500,
) -> int:
    """
    Idempotent wegschrijven op een natuurlijke sleutel.

    Nooit DELETE: verdwenen data uit de bron laten we staan, we overschrijven
    alleen. Twee keer dezelfde dag ophalen mag geen dubbele rijen geven.

    `on_conflict` moet kolommen noemen die door een échte unique constraint of
    unique index gedekt zijn — PostgREST kan niets met een expressie-index.
    """
    if not rows:
        return 0

    written = 0
    for start in range(0, len(rows), chunk_size):
        chunk = list(rows[start : start + chunk_size])
        tbl(table).upsert(chunk, on_conflict=on_conflict).execute()
        written += len(chunk)
    log.debug("%s: %d rijen weggeschreven", table, written)
    return written


def fetch_all(table: str, columns: str = "*", **eq: Any) -> list[dict[str, Any]]:
    """Alle rijen ophalen, met paginering langs de PostgREST-limiet heen."""
    out: list[dict[str, Any]] = []
    page, size = 0, 1000
    while True:
        q = tbl(table).select(columns)
        for key, value in eq.items():
            q = q.eq(key, value)
        res = q.range(page * size, (page + 1) * size - 1).execute()
        batch = res.data or []
        out.extend(batch)
        if len(batch) < size:
            return out
        page += 1


def chunked(items: Iterable[Any], size: int):
    """Iterable in blokken, voor batchgewijs verwerken."""
    batch: list[Any] = []
    for item in items:
        batch.append(item)
        if len(batch) >= size:
            yield batch
            batch = []
    if batch:
        yield batch
