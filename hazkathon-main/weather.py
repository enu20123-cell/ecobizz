"""Historical weather lookup for the optional weather-adjusted anomaly check.

A flat baseline cannot tell a cold non-working day (heating legitimately
working a bit harder) from a building that was simply left switched on.
This module fetches historical daily temperatures so core.py can compare
consumption against a heating-degree-day-adjusted expectation instead.

Astana coordinates are hardcoded because the bundled demo dataset and the
project brief are both about a school in Astana; swap ASTANA_LAT/LON if the
team adapts this to another city or region.
"""

from __future__ import annotations

import httpx

ASTANA_LAT = 51.1801
ASTANA_LON = 71.4460
ARCHIVE_API = "https://archive-api.open-meteo.com/v1/archive"
HDD_BASE_C = 18.0


def fetch_daily_mean_temperatures(
    start_date: str, end_date: str, *, timeout: float = 6.0
) -> dict[str, float] | None:
    """Return {ISO date: mean °C} for the range, or None if unavailable.

    Never raises: the demo must keep working with no internet or if
    Open-Meteo is down, so every failure mode here degrades to "no weather
    data" and the caller falls back to the flat baseline.
    """
    try:
        res = httpx.get(
            ARCHIVE_API,
            params={
                "latitude": ASTANA_LAT,
                "longitude": ASTANA_LON,
                "start_date": start_date,
                "end_date": end_date,
                "daily": "temperature_2m_mean",
                "timezone": "auto",
            },
            timeout=timeout,
        )
        res.raise_for_status()
        payload = res.json()
        dates = payload["daily"]["time"]
        temps = payload["daily"]["temperature_2m_mean"]
    except Exception:
        return None

    result = {d: t for d, t in zip(dates, temps) if t is not None}
    return result or None


def heating_degree_days(mean_temp_c: float, base_c: float = HDD_BASE_C) -> float:
    """HDD = how many degrees below the 18°C comfort line a day's mean temp was.

    0 on a mild/warm day (no extra heating expected), positive and growing
    the colder it gets — the input a linear regression uses to predict
    "normal" non-working-day consumption for that specific day.
    """
    return max(0.0, base_c - mean_temp_c)
