"""
Opnieuw proberen, met verstand.

Wel retryen: quota vol, timeout, tijdelijke serverfout. Dat lost zich op met
wachten.

Niet retryen: authenticatiefouten en verkeerde argumenten. Dat is een bug of
een verlopen token; honderd keer opnieuw proberen maakt het niet beter en
verstopt de echte melding.
"""
from __future__ import annotations

import functools
import logging
import random
import time
from typing import Callable, TypeVar

log = logging.getLogger(__name__)

T = TypeVar("T")

# Foutcodes en -namen die met wachten overgaan.
RETRYABLE_MARKERS = (
    "RESOURCE_EXHAUSTED",
    "DEADLINE_EXCEEDED",
    "UNAVAILABLE",
    "INTERNAL",
    "ABORTED",
    "TOO_MANY_REQUESTS",
    "RATE_LIMIT",
    "429",
    "500",
    "502",
    "503",
    "504",
    "CONCURRENT_MODIFICATION",
)

# Zodra een van deze in de fout voorkomt: direct stoppen.
FATAL_MARKERS = (
    "AUTHENTICATION_ERROR",
    "AUTHORIZATION_ERROR",
    "INVALID_ARGUMENT",
    "PERMISSION_DENIED",
    "NOT_FOUND",
    "DEVELOPER_TOKEN",
    "CUSTOMER_NOT_ENABLED",
    "invalid_grant",
)


def is_retryable(exc: BaseException) -> bool:
    text = f"{type(exc).__name__}: {exc}"
    if any(marker in text for marker in FATAL_MARKERS):
        return False
    return any(marker in text for marker in RETRYABLE_MARKERS)


def with_retry(
    attempts: int = 5,
    base_delay: float = 2.0,
    max_delay: float = 90.0,
) -> Callable[[Callable[..., T]], Callable[..., T]]:
    """
    Exponentiële backoff met jitter. De jitter voorkomt dat tien accounts na
    een quota-fout alle tien op precies hetzelfde moment terugkomen.
    """

    def decorator(fn: Callable[..., T]) -> Callable[..., T]:
        @functools.wraps(fn)
        def wrapper(*args, **kwargs) -> T:
            last: BaseException | None = None
            for attempt in range(1, attempts + 1):
                try:
                    return fn(*args, **kwargs)
                except BaseException as exc:  # noqa: BLE001 — bewust breed
                    last = exc
                    if not is_retryable(exc) or attempt == attempts:
                        raise
                    delay = min(base_delay * 2 ** (attempt - 1), max_delay)
                    delay += random.uniform(0, delay * 0.25)
                    log.warning(
                        "%s poging %d/%d mislukt (%s), opnieuw over %.1fs",
                        fn.__name__, attempt, attempts, exc, delay,
                    )
                    time.sleep(delay)
            raise last  # type: ignore[misc]

        return wrapper

    return decorator
