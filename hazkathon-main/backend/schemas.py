"""Typed API contract for EcoBiz Copilot (shared with the OpenAPI docs)."""

from pydantic import BaseModel, Field


class DayRecord(BaseModel):
    """One day of consumption as returned to the frontend."""

    date: str
    consumption_kwh: float
    is_workday: bool
    is_anomaly: bool
    excess_kwh: float


class Summary(BaseModel):
    total_excess_kwh: float
    savings_kzt: float
    co2_saved_kg: float
    anomaly_days: int = Field(ge=0)
    baseline_kwh: float = Field(ge=0)
    multiplier: float
    tariff_kzt_per_kwh: float = Field(ge=0)
    co2_factor: float
    days_analyzed: int = Field(ge=1)
    # False when fewer than core.MIN_OFF_DAY_SAMPLES non-working days were
    # available to build the baseline — the UI/insight text should say so
    # instead of presenting the numbers as a confirmed result.
    baseline_reliable: bool = True
    off_day_samples: int = Field(default=0, ge=0)


class ResourceRecord(BaseModel):
    """One day of one resource (electricity/water/heat), generic across units."""

    date: str
    value: float
    is_workday: bool
    is_anomaly: bool
    excess: float


class ResourceSummary(BaseModel):
    """Same shape as Summary/DayRecord but resource-agnostic, keyed by resource
    name in AnalyzeResponse.resources. Electricity's entry mirrors the
    top-level `summary`/`series` numbers exactly — it is not recomputed."""

    label: str
    unit: str
    total_excess: float
    savings_kzt: float
    # None for resources with no meaningful CO2 factor (e.g. water).
    co2_saved_kg: float | None = None
    baseline: float = Field(ge=0)
    multiplier: float
    tariff_kzt_per_unit: float = Field(ge=0)
    days_analyzed: int = Field(ge=1)
    anomaly_days: int = Field(ge=0)
    baseline_reliable: bool = True
    off_day_samples: int = Field(default=0, ge=0)
    worst_day: str | None = None
    first_anomaly: str | None = None
    last_anomaly: str | None = None
    series: list[ResourceRecord] = Field(default_factory=list)


class AnalyzeResponse(BaseModel):
    summary: Summary
    series: list[DayRecord]
    source: str
    worst_day: str | None = None
    first_anomaly: str | None = None
    last_anomaly: str | None = None
    # True when non-working-day electricity anomalies were computed against a
    # heating-degree-day-adjusted expectation instead of the flat baseline
    # (only when weather data was actually available for the date range).
    weather_adjusted: bool = False
    # Keyed by resource name ("electricity", "water", "heat"); only resources
    # actually present in the uploaded file are included.
    resources: dict[str, ResourceSummary] = Field(default_factory=dict)


class InsightRequest(BaseModel):
    """The frontend posts back the analysis it received from /api/analyze."""

    source: str
    summary: Summary
    anomalies: list[DayRecord] = Field(default_factory=list)


class InsightResponse(BaseModel):
    insight: str
    model: str
