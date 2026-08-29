"""Generate one month of synthetic daily electricity data for EcoBiz Copilot.

Scenario: a school building. Workdays run high (~450 kWh). Weekends drop
to a "closed building" level (~80 kWh). During the winter break week the
building is empty (is_workday = 0) but consumption stays near workday
levels — equipment left on, that is the waste we want to detect.
"""

from pathlib import Path

import numpy as np
import pandas as pd

SEED = 42
START_DATE = "2025-12-01"
DAYS = 31
BREAK_START, BREAK_END = 15, 21

WORKDAY_KWH = 450.0
WEEKEND_KWH = 80.0
BREAK_KWH = 420.0
NOISE_STD = 25.0

# Water: unlike electricity, a school's water use barely changes on a break
# week (no cafeteria/toilets in use) UNLESS something is actually wrong
# (leaking tap, valve left open) — same "should have dropped, didn't" story.
WORKDAY_M3 = 12.0
WEEKEND_M3 = 1.0
BREAK_LEAK_M3 = 9.5
WATER_NOISE_STD = 0.8

# Heat: legitimately stays close to the workday level all winter regardless
# of occupancy (a closed building still needs to not freeze), so it is a
# deliberately "boring" resource here — mostly no anomalies, demonstrating
# that not every resource needs to show waste to be worth including.
WORKDAY_GCAL = 3.2
WEEKEND_GCAL = 3.0
NOISE_GCAL_STD = 0.15


def build_month() -> pd.DataFrame:
    rng = np.random.default_rng(SEED)
    rows = []
    for date in pd.date_range(START_DATE, periods=DAYS, freq="D"):
        on_break = BREAK_START <= date.day <= BREAK_END
        weekday = date.weekday() < 5

        if weekday and not on_break:
            base, is_workday = WORKDAY_KWH, 1
        elif on_break:
            base, is_workday = BREAK_KWH, 0
        else:
            base, is_workday = WEEKEND_KWH, 0

        consumption = max(20.0, rng.normal(base, NOISE_STD))
        rows.append(
            {
                "date": date.date(),
                "consumption_kwh": round(consumption, 2),
                "is_workday": is_workday,
            }
        )
    return pd.DataFrame(rows)


def build_month_multi() -> pd.DataFrame:
    """Same electricity story as build_month(), plus synthetic water and heat
    columns with their own (independent) anomaly pattern — for demoing the
    multi-resource path without touching the original single-resource file
    that the core test suite pins exact values against."""
    rng = np.random.default_rng(SEED)
    rows = []
    for date in pd.date_range(START_DATE, periods=DAYS, freq="D"):
        on_break = BREAK_START <= date.day <= BREAK_END
        weekday = date.weekday() < 5

        if weekday and not on_break:
            elec_base, is_workday = WORKDAY_KWH, 1
        elif on_break:
            elec_base, is_workday = BREAK_KWH, 0
        else:
            elec_base, is_workday = WEEKEND_KWH, 0

        water_base = WORKDAY_M3 if is_workday else (BREAK_LEAK_M3 if on_break else WEEKEND_M3)
        heat_base = WORKDAY_GCAL if is_workday else WEEKEND_GCAL

        rows.append(
            {
                "date": date.date(),
                "consumption_kwh": round(max(20.0, rng.normal(elec_base, NOISE_STD)), 2),
                "water_m3": round(max(0.2, rng.normal(water_base, WATER_NOISE_STD)), 2),
                "heat_gcal": round(max(0.5, rng.normal(heat_base, NOISE_GCAL_STD)), 2),
                "is_workday": is_workday,
            }
        )
    return pd.DataFrame(rows)


def main() -> None:
    out_dir = Path(__file__).resolve().parent

    df = build_month()
    out_path = out_dir / "sample_data.csv"
    df.to_csv(out_path, index=False)
    print(f"Wrote {len(df)} rows -> {out_path}")
    print(df.head(10).to_string(index=False))

    df_multi = build_month_multi()
    multi_path = out_dir / "sample_data_multi.csv"
    df_multi.to_csv(multi_path, index=False)
    print(f"\nWrote {len(df_multi)} rows -> {multi_path}")
    print(df_multi.head(10).to_string(index=False))


if __name__ == "__main__":
    main()
