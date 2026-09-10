"""
Configuratie uit de omgeving.

Leest .env.local uit de repo-root. Secrets staan nergens in de code en nergens
in git; dit is de enige plek die ze uit de omgeving haalt.

Google Ads-credentials komen standaard uit het bestaande
CP\\GoogleAds\\google-ads.yaml, zodat die geheimen op één plek blijven staan
in plaats van gekopieerd te worden.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

# ingest/core/config.py -> ingest/core -> ingest -> repo-root
REPO_ROOT = Path(__file__).resolve().parents[2]

# .env.local wint van .env, en beide laten bestaande omgevingsvariabelen staan
# (op Railway zijn die er wel en de bestanden niet).
load_dotenv(REPO_ROOT / ".env.local", override=False)
load_dotenv(REPO_ROOT / ".env", override=False)


class ConfigError(RuntimeError):
    """Ontbrekende of onbruikbare configuratie. Nooit retryen: dit is een bug
    of een vergeten variabele, geen hapering."""


def _get(name: str, default: str | None = None, *, required: bool = False) -> str | None:
    value = os.getenv(name) or default
    if required and not value:
        raise ConfigError(
            f"{name} ontbreekt. Zet hem in {REPO_ROOT / '.env.local'} "
            f"(zie .env.example) of in de omgeving."
        )
    return value


@dataclass(frozen=True)
class Settings:
    # --- Supabase ---
    supabase_url: str
    supabase_key: str
    db_schema: str

    # --- Google Ads ---
    google_ads_yaml: Path | None
    login_customer_id: str | None

    # --- GA4 ---
    ga4_credentials: Path | None

    @property
    def project_ref(self) -> str:
        return self.supabase_url.split("//", 1)[-1].split(".", 1)[0]


def load_settings() -> Settings:
    # De secret key heet in de nieuwe Supabase-stijl SUPABASE_SECRET_KEY en in
    # de oude SUPABASE_SERVICE_ROLE_KEY. Beide accepteren, zodat een rotatie
    # geen codewijziging vraagt.
    key = _get("SUPABASE_SECRET_KEY") or _get("SUPABASE_SERVICE_ROLE_KEY")
    if not key:
        raise ConfigError(
            "SUPABASE_SECRET_KEY ontbreekt. Haal een secret key op bij "
            "Supabase -> Settings -> API Keys en zet hem in .env.local. "
            "Stuur hem nooit door een chat."
        )

    yaml_path = _get(
        "GOOGLE_ADS_YAML",
        str(REPO_ROOT.parent / "GoogleAds" / "google-ads.yaml"),
    )
    ga4_path = _get("GOOGLE_APPLICATION_CREDENTIALS")

    return Settings(
        supabase_url=_get("SUPABASE_URL", required=True),  # type: ignore[arg-type]
        supabase_key=key,
        db_schema=_get("SUPABASE_DB_SCHEMA", "mi"),  # type: ignore[arg-type]
        google_ads_yaml=Path(yaml_path) if yaml_path else None,
        login_customer_id=_get("GOOGLE_ADS_LOGIN_CUSTOMER_ID"),
        ga4_credentials=Path(ga4_path) if ga4_path else None,
    )


_cached: Settings | None = None


def settings() -> Settings:
    """Eén keer inlezen, daarna hergebruiken."""
    global _cached
    if _cached is None:
        _cached = load_settings()
    return _cached
