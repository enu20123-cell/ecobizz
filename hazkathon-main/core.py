"""EcoBiz Copilot core logic.

Pipeline: load_data -> detect_anomalies -> calculate_impact

The detector needs no hardware: it compares consumption on non-working
days against the building's own "closed" baseline and flags days where
the building was clearly running as if it were occupied.
"""

from pathlib import Path

import numpy as np
import pandas as pd

from calendar_utils import add_workday_column, load_off_periods_from_json

# Real household tariff for the Abai region (see config.py for sourcing and
# alternate regional tariffs). Must be confirmed for the actual school/business
# region before final numbers are presented.
TARIFF_KZT_PER_KWH = 17.447
# Demonstration assumption, not a confirmed grid emissions factor (see config.py).
CO2_KG_PER_KWH = 0.85
BASELINE_MULTIPLIER = 1.5
# Fewer non-working days than this and the baseline is too thin to trust; the
# result is still computed for the MVP demo but flagged as unreliable.
MIN_OFF_DAY_SAMPLES = 5
DEFAULT_CALENDAR_PATH = Path(__file__).with_name("holidays_kz.json")


def load_data(file_path_or_buffer, *, filename: str | None = None) -> pd.DataFrame:
    """Load daily consumption data from a CSV or Excel file.

    If the file has no `is_workday` column, one is derived from weekends plus
    Kazakhstan public holidays and school breaks (`holidays_kz.json`) so a raw
    utility export with only `date` and `consumption_kwh` still works. A manually
    supplied `is_workday` column is always trusted over the calendar guess.
    """
    source_name = filename or getattr(file_path_or_buffer, "name", None) or str(
        file_path_or_buffer
    )
    path = str(source_name).lower()
    if path.endswith((".xlsx", ".xls")):
        df = pd.read_excel(file_path_or_buffer)
    else:
        df = pd.read_csv(file_path_or_buffer, parse_dates=["date"])

    if "is_workday" in df.columns:
        return df
    calendar_periods = load_off_periods_from_json(DEFAULT_CALENDAR_PATH)
    return add_workday_column(df, extra_off_periods=calendar_periods)


def get_baseline(df: pd.DataFrame, value_column: str = "consumption_kwh") -> float:
    """Closed-building baseline = 25th percentile of non-working-day consumption.

    `value_column` picks which reading to build the baseline from — the
    statistic itself (25th percentile) never changes, only the column it
    reads, so the same call works for electricity, water or heat.
    """
    off_days = df.loc[df["is_workday"] == 0, value_column]
    if off_days.empty:
        raise ValueError("No non-working days found; cannot build a baseline.")
    return float(off_days.quantile(0.25))


def detect_anomalies(
    df: pd.DataFrame,
    multiplier: float = BASELINE_MULTIPLIER,
    value_column: str = "consumption_kwh",
) -> pd.DataFrame:
    """Flag non-working days whose reading exceeds the closed-building baseline.

    Baseline = 25th percentile of non-working-day readings, i.e. a day
    where everything was properly switched off. A robust statistic is used
    so the baseline is not inflated by the very waste we are detecting.
    A day is an anomaly when is_workday == 0 and
    value > baseline * multiplier (defaults to BASELINE_MULTIPLIER;
    exposed as a parameter so the UI's threshold slider can explore other
    values without duplicating this logic).
    Adds boolean `is_anomaly` and `excess_kwh` (units above baseline, else 0).

    `value_column` defaults to electricity's `consumption_kwh`; pass
    `"water_m3"` or `"heat_gcal"` to run the exact same detection against a
    different resource column — the logic and thresholds are identical, only
    the input column changes. The output columns stay named `is_anomaly` /
    `excess_kwh` regardless of resource: each resource is detected into its
    own returned DataFrame copy rather than merged together, so callers
    processing multiple resources call this once per resource.

    `df.attrs["baseline_reliable"]` is False when fewer than
    MIN_OFF_DAY_SAMPLES non-working days are available — the result is still
    returned for the MVP demo, but callers should surface that caveat instead
    of presenting the baseline as a confirmed fact.
    """
    df = df.copy()
    off_days = df.loc[df["is_workday"] == 0, value_column]
    baseline = get_baseline(df, value_column=value_column)

    over_baseline = (df["is_workday"] == 0) & (
        df[value_column] > baseline * multiplier
    )
    df["is_anomaly"] = over_baseline
    df["excess_kwh"] = (df[value_column] - baseline).where(over_baseline, 0.0)
    df.attrs["baseline_reliable"] = len(off_days) >= MIN_OFF_DAY_SAMPLES
    df.attrs["off_day_samples"] = int(len(off_days))
    return df


def detect_anomalies_weather_adjusted(
    df: pd.DataFrame,
    hdd_by_date: dict,
    multiplier: float = BASELINE_MULTIPLIER,
    value_column: str = "consumption_kwh",
) -> pd.DataFrame | None:
    """Weather-corrected variant of detect_anomalies().

    A flat baseline treats every non-working day the same, which means a
    cold day where the heating legitimately worked a bit harder looks just
    like a building that was simply left switched on. This instead fits a
    linear regression of non-working-day consumption against heating-degree-
    days (HDD = max(0, 18°C - mean daily temperature)):

        expected(day) = intercept + slope * HDD(day)

    A day is an anomaly when its actual reading exceeds
    `expected(day) * multiplier` — i.e. relative to the point on *this* line
    for that day's own HDD, not one single number for the whole dataset.

    `hdd_by_date` maps ISO date strings ("YYYY-MM-DD") to HDD values (see
    weather.py). Returns None — instead of a half-broken result — when there
    are too few non-working days with known HDD, or their HDD values do not
    vary enough to fit a meaningful line; callers should fall back to
    detect_anomalies() in that case.
    """
    df = df.copy()
    off_mask = df["is_workday"] == 0
    hdd_series = df["date"].dt.strftime("%Y-%m-%d").map(hdd_by_date)

    off_hdd = hdd_series[off_mask].dropna()
    if len(off_hdd) < MIN_OFF_DAY_SAMPLES or off_hdd.nunique() < 2:
        return None

    off_values = df.loc[off_hdd.index, value_column].astype(float)
    slope, intercept = np.polyfit(off_hdd.astype(float), off_values, 1)

    expected = intercept + slope * hdd_series.astype(float)
    over_baseline = off_mask & hdd_series.notna() & (df[value_column] > expected * multiplier)

    df["is_anomaly"] = over_baseline
    df["excess_kwh"] = (df[value_column] - expected).where(over_baseline, 0.0)
    df.attrs["baseline_reliable"] = True
    df.attrs["off_day_samples"] = int(len(off_hdd))
    return df


def calculate_impact(
    df: pd.DataFrame,
    tariff: float = TARIFF_KZT_PER_KWH,
    co2_kg_per_kwh: float = CO2_KG_PER_KWH,
) -> dict:
    """Sum up financial (KZT) and environmental (kg CO2) savings from anomalies.

    Requires detect_anomalies() to have run first.
    """
    total_excess = float(df["excess_kwh"].sum())
    return {
        "total_excess_kwh": round(total_excess, 2),
        "savings_kzt": round(total_excess * tariff, 2),
        "co2_saved_kg": round(total_excess * co2_kg_per_kwh, 2),
        "anomaly_days": int(df["is_anomaly"].sum()),
    }
