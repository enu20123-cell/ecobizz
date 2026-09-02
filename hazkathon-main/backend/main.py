"""EcoBiz Copilot API.

Endpoints:
    POST /api/analyze   - analyze an uploaded CSV/XLSX (falls back to the
                          bundled sample when no file is given)
    GET  /api/health    - liveness check
    GET  /              - serve the frontend
"""

import io
import os
from pathlib import Path

import pandas as pd
from fastapi import FastAPI, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from starlette.types import Scope

import config
import weather
from calendar_utils import add_workday_column, load_off_periods_from_json
from core import (
    BASELINE_MULTIPLIER,
    CO2_KG_PER_KWH,
    DEFAULT_CALENDAR_PATH,
    TARIFF_KZT_PER_KWH,
    bootstrap_savings_range,
    calculate_impact,
    classify_anomaly_shapes,
    detect_anomalies,
    detect_anomalies_weather_adjusted,
    diagnose_anomaly_day,
    energy_efficiency_grade,
    get_baseline,
)
from backend.schemas import (
    AnalyzeResponse,
    CauseDiagnosis,
    CauseSummaryEntry,
    ConfigResponse,
    DayRecord,
    EfficiencyGrade,
    InsightRequest,
    InsightResponse,
    NormComparison,
    ProvenanceEntry,
    ResourceRecord,
    ResourceSummary,
    Summary,
)
from backend.ai import AIUnavailable, ask_gemini

ROOT = Path(__file__).resolve().parent.parent
SAMPLE_CSV = ROOT / "data" / "sample_data.csv"
SAMPLE_MULTI_CSV = ROOT / "data" / "sample_data_multi.csv"
FRONTEND_DIR = ROOT / "frontend"
# is_workday is optional: when the upload omits it, we derive it from weekends
# plus the Kazakhstan public-holiday/school-break calendar (holidays_kz.json).
REQUIRED_COLUMNS = {"date", "consumption_kwh"}
ALLOWED_SUFFIXES = (".csv", ".xlsx", ".xls")
# Real-world exports label the reading column differently; map the common
# aliases to our canonical name before validating — the numbers themselves
# are never touched, only the header.
CONSUMPTION_KWH_ALIASES = {"kwh", "consumption", "usage_kwh", "energy_kwh", "kwh_consumed"}

# Water and heat are entirely optional columns — a file with only
# date/consumption_kwh keeps working exactly as before. When present, each
# resource is detected independently with the exact same statistic
# (core.detect_anomalies), just pointed at a different column.
RESOURCE_META = {
    "electricity": {
        "value_column": "consumption_kwh",
        "label": "Электричество",
        "unit": "кВт·ч",
        "default_tariff": TARIFF_KZT_PER_KWH,
        "co2_factor": CO2_KG_PER_KWH,
    },
    "water": {
        "value_column": "water_m3",
        "label": "Вода",
        "unit": "м³",
        "default_tariff": config.WATER_TARIFF_KZT_PER_M3_DEMO,
        "co2_factor": None,
    },
    "heat": {
        "value_column": "heat_gcal",
        "label": "Тепло",
        "unit": "Гкал",
        "default_tariff": config.HEAT_TARIFF_KZT_PER_GCAL_DEMO,
        "co2_factor": config.HEAT_CO2_KG_PER_GCAL_DEMO,
    },
}
OPTIONAL_RESOURCE_COLUMNS = {"water_m3": "вода (м³)", "heat_gcal": "тепло (Гкал)"}

app = FastAPI(title="EcoBiz Copilot", version="2.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def _to_frame(raw: bytes | Path, filename: str) -> pd.DataFrame:
    """Read raw upload bytes (or a path) into a DataFrame."""
    handle = raw if isinstance(raw, Path) else io.BytesIO(raw)
    try:
        if filename.lower().endswith((".xlsx", ".xls")):
            return pd.read_excel(handle)
        return pd.read_csv(handle)
    except Exception as exc:
        raise HTTPException(400, f"Не удалось прочитать «{filename}»: {exc}") from exc


def _clean(df: pd.DataFrame) -> pd.DataFrame:
    """Validate required columns and coerce types with clear error messages."""
    if "consumption_kwh" not in df.columns:
        for col in df.columns:
            if col.strip().lower() in CONSUMPTION_KWH_ALIASES:
                df = df.rename(columns={col: "consumption_kwh"})
                break

    missing = REQUIRED_COLUMNS - set(df.columns)
    if missing:
        raise HTTPException(
            422, f"Отсутствуют обязательные колонки: {', '.join(sorted(missing))}"
        )
    if df.empty:
        raise HTTPException(422, "Файл не содержит строк с данными.")

    out = df.copy()
    out["date"] = pd.to_datetime(out["date"], errors="coerce")
    out["consumption_kwh"] = pd.to_numeric(out["consumption_kwh"], errors="coerce")
    bad_dates = int(out["date"].isna().sum())
    bad_kwh = int(out["consumption_kwh"].isna().sum())
    if bad_dates or bad_kwh:
        raise HTTPException(
            422,
            f"Некорректные значения: {bad_dates} неверных дат(ы), "
            f"{bad_kwh} неверных значений кВт·ч.",
        )

    for column, label in OPTIONAL_RESOURCE_COLUMNS.items():
        if column not in out.columns:
            continue
        out[column] = pd.to_numeric(out[column], errors="coerce")
        bad = int(out[column].isna().sum())
        if bad:
            raise HTTPException(
                422, f"Некорректные значения: {bad} неверных значений в колонке «{label}»."
            )

    if "is_workday" in out.columns:
        workday = pd.to_numeric(out["is_workday"], errors="coerce")
        if workday.isna().any():
            raise HTTPException(422, "Колонка 'is_workday' должна содержать только 0 или 1 в каждой строке.")
        out["is_workday"] = workday.astype(int)
    else:
        calendar_periods = load_off_periods_from_json(DEFAULT_CALENDAR_PATH)
        out = add_workday_column(out, extra_off_periods=calendar_periods)
    return out


def _build_resource_summary(
    df: pd.DataFrame,
    key: str,
    *,
    tariff: float | None = None,
    multiplier: float = BASELINE_MULTIPLIER,
    co2_factor: float | None = None,
    precomputed: pd.DataFrame | None = None,
    skip_bootstrap: bool = False,
) -> ResourceSummary:
    """Run the shared detection pipeline for one resource and shape it into
    the resource-agnostic block used by AnalyzeResponse.resources.

    `precomputed` lets the caller reuse a DataFrame already flagged by
    detect_anomalies() (or its weather-adjusted variant) instead of running
    detection twice for electricity. `co2_factor`, when given, overrides the
    resource's default CO2 factor (e.g. a confirmed grid figure typed into
    the "Параметры расчёта" panel) — water still never gets one, regardless.
    """
    meta = RESOURCE_META[key]
    flagged = (
        precomputed
        if precomputed is not None
        else detect_anomalies(df, multiplier=multiplier, value_column=meta["value_column"])
    )
    resource_tariff = tariff if tariff is not None else meta["default_tariff"]
    effective_co2 = meta["co2_factor"] if co2_factor is None else co2_factor
    if key == "water":
        effective_co2 = None  # no physically meaningful CO2 factor for water, ever
    impact = calculate_impact(
        flagged, tariff=resource_tariff, co2_kg_per_kwh=effective_co2 or 0.0
    )
    shapes = classify_anomaly_shapes(flagged)
    bootstrap = (
        None
        if skip_bootstrap
        else bootstrap_savings_range(df, tariff=resource_tariff, multiplier=multiplier, value_column=meta["value_column"])
    )

    series = [
        ResourceRecord(
            date=row.date.strftime("%Y-%m-%d"),
            value=round(float(getattr(row, meta["value_column"])), 2),
            is_workday=bool(row.is_workday),
            is_anomaly=bool(row.is_anomaly),
            excess=round(float(row.excess_kwh), 2),
            pattern=shapes.get(row.date.strftime("%Y-%m-%d")),
        )
        for row in flagged.itertuples(index=False)
    ]
    anomalies = [r for r in series if r.is_anomaly]
    worst = max(anomalies, key=lambda r: r.excess) if anomalies else None

    return ResourceSummary(
        label=meta["label"],
        unit=meta["unit"],
        total_excess=impact["total_excess_kwh"],
        savings_kzt=impact["savings_kzt"],
        co2_saved_kg=impact["co2_saved_kg"] if effective_co2 is not None else None,
        baseline=round(get_baseline(flagged, value_column=meta["value_column"]), 2),
        multiplier=multiplier,
        tariff_kzt_per_unit=resource_tariff,
        days_analyzed=int(len(flagged)),
        anomaly_days=impact["anomaly_days"],
        baseline_reliable=bool(flagged.attrs["baseline_reliable"]),
        off_day_samples=int(flagged.attrs["off_day_samples"]),
        worst_day=worst and worst.date,
        first_anomaly=anomalies[0].date if anomalies else None,
        last_anomaly=anomalies[-1].date if anomalies else None,
        savings_kzt_p10=bootstrap["p10"] if bootstrap else None,
        savings_kzt_p90=bootstrap["p90"] if bootstrap else None,
        series=series,
    )


def _build_cause_diagnosis(
    resources: dict[str, ResourceSummary], weather_adjusted: bool
) -> tuple[dict, list]:
    """Merge every resource's per-day is_anomaly flags by date and run
    core.diagnose_anomaly_day() on each day with at least one anomaly, then
    roll the results up into a period-level ranking (cause_summary)."""
    flags_by_date: dict = {}
    for key, resource in resources.items():
        for record in resource.series:
            flags_by_date.setdefault(record.date, {})[key] = record.is_anomaly

    diagnosis: dict[str, CauseDiagnosis] = {}
    hypothesis_counts: dict[str, int] = {}
    for date, flags in flags_by_date.items():
        result = diagnose_anomaly_day(flags, weather_adjusted=weather_adjusted)
        if result is None:
            continue
        diagnosis[date] = CauseDiagnosis(**result)
        hypothesis_counts[result["hypothesis"]] = hypothesis_counts.get(result["hypothesis"], 0) + 1

    total = len(diagnosis)
    summary = (
        [
            CauseSummaryEntry(hypothesis=h, days=n, share_pct=round(n / total * 100, 1))
            for h, n in sorted(hypothesis_counts.items(), key=lambda kv: kv[1], reverse=True)
        ]
        if total
        else []
    )
    return diagnosis, summary


def _analyze(
    df: pd.DataFrame,
    tariff: float,
    multiplier: float,
    *,
    weather_adjust: bool = False,
    co2_factor: float | None = None,
    water_tariff: float | None = None,
    heat_tariff: float | None = None,
    heat_co2_factor: float | None = None,
    official_norm_kwh_per_day: float | None = None,
    building_area_m2: float | None = None,
    building_type: str | None = None,
) -> AnalyzeResponse:
    """Run the full pipeline and shape a JSON-friendly response.

    When `weather_adjust` is set, electricity anomalies are computed against
    a heating-degree-day-adjusted expectation instead of the flat baseline —
    see core.detect_anomalies_weather_adjusted(). Any failure to fetch
    weather (no internet, Open-Meteo down, too little data to fit a line)
    falls back to the flat baseline silently; `weather_adjusted` in the
    response says which one actually ran.

    `co2_factor`/`water_tariff`/`heat_tariff`/`heat_co2_factor` override the
    config.py demo defaults for the constants still tagged "estimate" in
    config.PROVENANCE — the "Параметры расчёта" panel on the dashboard lets a
    user type in a confirmed number without editing code. `None` keeps the
    default. `official_norm_kwh_per_day`/`building_area_m2` are never
    defaulted from config at all — both stay entirely absent from the
    response unless the caller supplies them, since neither has an honest
    global default.
    """
    weather_adjusted = False
    flagged = None
    if weather_adjust:
        try:
            start = df["date"].min().strftime("%Y-%m-%d")
            end = df["date"].max().strftime("%Y-%m-%d")
            temps = weather.fetch_daily_mean_temperatures(start, end)
            if temps:
                hdd_by_date = {d: weather.heating_degree_days(t) for d, t in temps.items()}
                weather_flagged = detect_anomalies_weather_adjusted(
                    df, hdd_by_date, multiplier=multiplier
                )
                if weather_flagged is not None:
                    flagged = weather_flagged
                    weather_adjusted = True
        except Exception:
            flagged = None
    if flagged is None:
        flagged = detect_anomalies(df, multiplier=multiplier)

    effective_elec_co2 = CO2_KG_PER_KWH if co2_factor is None else co2_factor
    impact = calculate_impact(flagged, tariff=tariff, co2_kg_per_kwh=effective_elec_co2)
    # The bootstrap resamples the *flat* 25th-percentile baseline (see
    # core.bootstrap_savings_range) — that maps directly onto the point
    # estimate only when the flat baseline is what actually produced it.
    # Under weather adjustment the point estimate comes from a per-day
    # regression line instead, so a flat-baseline range would not describe
    # the same number; skip it rather than show a mismatched interval.
    bootstrap = None if weather_adjusted else bootstrap_savings_range(df, tariff=tariff, multiplier=multiplier)

    series = [
        DayRecord(
            date=row.date.strftime("%Y-%m-%d"),
            consumption_kwh=round(float(row.consumption_kwh), 2),
            is_workday=bool(row.is_workday),
            is_anomaly=bool(row.is_anomaly),
            excess_kwh=round(float(row.excess_kwh), 2),
        )
        for row in flagged.itertuples(index=False)
    ]
    anomalies = [r for r in series if r.is_anomaly]
    worst = max(anomalies, key=lambda r: r.excess_kwh) if anomalies else None

    resources = {
        "electricity": _build_resource_summary(
            df,
            "electricity",
            tariff=tariff,
            multiplier=multiplier,
            co2_factor=co2_factor,
            precomputed=flagged,
            skip_bootstrap=weather_adjusted,
        )
    }
    resource_tariff_overrides = {"water": water_tariff, "heat": heat_tariff}
    resource_co2_overrides = {"heat": heat_co2_factor}
    for key, meta in RESOURCE_META.items():
        if key == "electricity" or meta["value_column"] not in df.columns:
            continue
        resources[key] = _build_resource_summary(
            df,
            key,
            tariff=resource_tariff_overrides.get(key),
            multiplier=multiplier,
            co2_factor=resource_co2_overrides.get(key),
        )

    cause_diagnosis, cause_summary = _build_cause_diagnosis(resources, weather_adjusted)

    norm_comparison = None
    if official_norm_kwh_per_day:
        actual_avg = float(df["consumption_kwh"].mean())
        norm_comparison = NormComparison(
            official_norm_kwh_per_day=official_norm_kwh_per_day,
            actual_avg_kwh_per_day=round(actual_avg, 2),
            over_norm_pct=round((actual_avg / official_norm_kwh_per_day - 1) * 100, 1),
        )

    efficiency_grade = None
    if building_area_m2:
        benchmark_meta = config.BUILDING_TYPE_BENCHMARKS.get(building_type)
        grade_kwargs = {
            "total_consumption": float(df["consumption_kwh"].sum()),
            "days_analyzed": int(len(df)),
            "area_m2": building_area_m2,
        }
        if benchmark_meta:
            grade_kwargs["kz_average"] = benchmark_meta["kwh_per_m2_year"]
        grade = energy_efficiency_grade(**grade_kwargs)
        if grade:
            efficiency_grade = EfficiencyGrade(
                **grade,
                benchmark_label=benchmark_meta["label"] if benchmark_meta else "Казахстан (среднее)",
            )

    return AnalyzeResponse(
        summary=Summary(
            **impact,
            baseline_kwh=round(get_baseline(flagged), 2),
            multiplier=multiplier,
            tariff_kzt_per_kwh=tariff,
            co2_factor=effective_elec_co2,
            days_analyzed=int(len(flagged)),
            baseline_reliable=bool(flagged.attrs["baseline_reliable"]),
            off_day_samples=int(flagged.attrs["off_day_samples"]),
            savings_kzt_p10=bootstrap["p10"] if bootstrap else None,
            savings_kzt_p90=bootstrap["p90"] if bootstrap else None,
        ),
        series=series,
        source="",
        worst_day=worst and worst.date,
        first_anomaly=anomalies[0].date if anomalies else None,
        last_anomaly=anomalies[-1].date if anomalies else None,
        weather_adjusted=weather_adjusted,
        resources=resources,
        cause_diagnosis=cause_diagnosis,
        cause_summary=cause_summary,
        norm_comparison=norm_comparison,
        efficiency_grade=efficiency_grade,
    )


@app.post("/api/analyze")
async def analyze(
    file: UploadFile | None = None,
    tariff: float = TARIFF_KZT_PER_KWH,
    multiplier: float = BASELINE_MULTIPLIER,
    weather_adjust: bool = False,
    sample: str = "default",
    # All five below are optional, honest overrides of the "estimate"-tagged
    # config.py defaults (see config.PROVENANCE) — the "Параметры расчёта"
    # panel on the dashboard sends them when the user types in a confirmed
    # number. None everywhere keeps today's behaviour exactly as before.
    co2_factor: float | None = None,
    water_tariff: float | None = None,
    heat_tariff: float | None = None,
    heat_co2_factor: float | None = None,
    official_norm_kwh_per_day: float | None = None,
    building_area_m2: float | None = None,
    building_type: str | None = None,
):
    if building_type is not None and building_type not in config.BUILDING_TYPE_BENCHMARKS:
        raise HTTPException(
            422,
            f"Неизвестный тип здания «{building_type}»; допустимые значения: "
            f"{', '.join(sorted(config.BUILDING_TYPE_BENCHMARKS))}.",
        )
    if tariff < 0:
        raise HTTPException(422, "Тариф не может быть отрицательным.")
    if multiplier <= 0:
        raise HTTPException(422, "Множитель порога аномалии должен быть положительным.")
    for value, label in (
        (co2_factor, "коэффициент CO2"),
        (water_tariff, "тариф воды"),
        (heat_tariff, "тариф тепла"),
        (heat_co2_factor, "коэффициент CO2 тепла"),
        (official_norm_kwh_per_day, "официальный норматив"),
        (building_area_m2, "площадь объекта"),
    ):
        if value is not None and value < 0:
            raise HTTPException(422, f"Параметр «{label}» не может быть отрицательным.")

    if file is None or not file.filename:
        source: bytes | Path = SAMPLE_MULTI_CSV if sample == "multi" else SAMPLE_CSV
        label = source.name
    else:
        if not file.filename.lower().endswith(ALLOWED_SUFFIXES):
            raise HTTPException(
                415, f"Неподдерживаемый тип файла; используйте {', '.join(ALLOWED_SUFFIXES)}"
            )
        source = await file.read()
        label = file.filename

    try:
        df = _clean(_to_frame(source, label))
        result = _analyze(
            df,
            tariff,
            multiplier,
            weather_adjust=weather_adjust,
            co2_factor=co2_factor,
            water_tariff=water_tariff,
            heat_tariff=heat_tariff,
            heat_co2_factor=heat_co2_factor,
            official_norm_kwh_per_day=official_norm_kwh_per_day,
            building_area_m2=building_area_m2,
            building_type=building_type,
        )
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(400, f"Не удалось проанализировать «{label}»: {exc}") from exc

    result.source = label
    return result


def _fallback_insight(req: InsightRequest) -> str:
    """Offline recommendation used when Gemini is unreachable or unconfigured.

    The demo must survive a venue with no Wi-Fi or an expired API key, so this
    reuses the same four-section structure as the Gemini prompt but fills it
    with a templated explanation instead of a model call. Every figure comes
    straight from the verified analysis, never invented.
    """
    s = req.summary
    dates = ", ".join(a.date for a in sorted(req.anomalies, key=lambda x: x.excess_kwh, reverse=True)[:5])
    reliability_note = (
        ""
        if s.baseline_reliable
        else (
            f"\n\n*Примечание: базовый уровень рассчитан всего по {s.off_day_samples} "
            "нерабочему(им) дню(дням) в этом наборе данных — соберите более длинную историю, "
            "прежде чем считать его подтверждённым.*"
        )
    )
    return (
        f"## Сводка\n"
        f"За {s.days_analyzed} дн. в {s.anomaly_days} нерабочий(их) день(дней) здание "
        f"потребляло энергию так, будто было занято людьми: перерасход составил "
        f"{s.total_excess_kwh} кВт·ч (~{s.savings_kzt:.0f} тенге при тарифе "
        f"{s.tariff_kzt_per_kwh} тенге/кВт·ч, {s.co2_saved_kg} кг CO₂)."
        + (f" Аномальные даты: {dates}." if dates else "")
        + f"{reliability_note}\n\n"
        "## Что вероятно произошло\n"
        "1. **Отопление или вентиляция остались в обычном рабочем режиме** — самая частая "
        "причина, когда потребление в нерабочий день остаётся близким к рабочему уровню "
        "вместо снижения до базового значения.\n"
        "2. **Таймеры освещения или вентиляции не обновлены под нерабочий период** — "
        "таймеры, настроенные на рабочий график, продолжают работать без изменений в "
        "выходные и каникулы.\n"
        "3. **Оборудование или серверы остались в активном режиме** — нагрузки, которые "
        "никогда не переводятся в режим ожидания, дают именно такой ровный необъяснимый "
        "перерасход.\n\n"
        "## Меры по исправлению\n"
        "1. Попросите завхоза или техника BMS проверить график отопления и вентиляции на "
        "отмеченные даты и переключить его в энергосберегающий режим на нерабочие дни.\n"
        "2. Пройдите по зданию в следующий нерабочий день, чтобы проверить, какие системы "
        "всё ещё работают на полную мощность.\n"
        "3. Если есть система BMS, добавьте явные календарные исключения для выходных и "
        "каникул вместо стандартного недельного расписания.\n\n"
        "## Профилактика и мониторинг\n"
        "Добавьте базовый уровень нерабочего дня как порог тревоги и проверяйте этот отчёт "
        "после каждого периода каникул, чтобы пропущенное исключение обнаруживалось за "
        "несколько дней, а не месяцев.\n\n"
        "*(Офлайн-режим — Gemini был недоступен, поэтому эта рекомендация сформирована "
        "локально на основе проверенных цифр выше, а не моделью ИИ.)*"
    )


def _fallback_insight_brief(req: InsightRequest) -> str:
    """Offline 3-4 sentence executive justification — same honesty rules as
    _fallback_insight(), just for a director/akimat audience instead of a
    building manager: no headings, no technical jargon, only the verified
    numbers already computed."""
    s = req.summary
    if not s.anomaly_days:
        return (
            f"За {s.days_analyzed} дн. проверенных данных аномалий не обнаружено — здание "
            "корректно отключается в нерабочее время, дополнительных мер и затрат не требуется."
        )
    payback_note = (
        "" if s.savings_kzt <= 0 else
        f" Исправление не требует капитальных затрат — только пересмотр расписания BMS, "
        f"после чего эта сумма перестаёт теряться каждый следующий период."
    )
    return (
        f"За {s.days_analyzed} дн. здание потребляло энергию так, будто было занято людьми, "
        f"в {s.anomaly_days} нерабочий(их) день(дней) — перерасход {s.total_excess_kwh} кВт·ч, "
        f"это ~{s.savings_kzt:.0f} тенге и {s.co2_saved_kg} кг CO₂ за этот период.{payback_note} "
        "Причина в подавляющем большинстве подобных случаев — забытое расписание отопления, "
        "вентиляции или освещения на выходные и каникулы, а не неисправное оборудование."
    )


@app.post("/api/insight", response_model=InsightResponse)
async def insight(req: InsightRequest, brief: bool = False):
    """Turn the current analysis into concrete recommendations via Gemini.

    Falls back to a locally templated recommendation (still built from the
    verified numbers, never invented) when Gemini has no key, no network, or
    errors out — so a live demo never breaks because of connectivity.

    `brief=true` asks for a short 3-4 sentence executive justification (for a
    director/akimat, not the building manager doing the walkthrough) instead
    of the full four-section action plan — same underlying verified numbers,
    a different audience and length, not a different analysis.
    """
    s = req.summary
    lines = [
        f"Набор данных: {req.source} ({s.days_analyzed} дн. суточных данных электропотребления здания).",
        (
            f"Базовый уровень нерабочего дня: {s.baseline_kwh} кВт·ч; "
            f"порог аномалии: базовый уровень x {s.multiplier}."
        ),
        (
            f"Обнаружено {s.anomaly_days} нерабочих день(дней), когда здание потребляло "
            f"энергию как занятое: суммарный перерасход {s.total_excess_kwh} кВт·ч "
            f"(~{s.savings_kzt:.0f} тенге при тарифе {s.tariff_kzt_per_kwh} тенге/кВт·ч, "
            f"{s.co2_saved_kg} кг CO₂)."
        ),
    ]
    if req.anomalies:
        top = ", ".join(
            f"{a.date} (+{a.excess_kwh} кВт·ч сверх {a.consumption_kwh} кВт·ч)"
            for a in sorted(req.anomalies, key=lambda x: x.excess_kwh, reverse=True)[:5]
        )
        lines.append(f"Отмеченные даты (от самой затратной): {top}.")
    else:
        lines.append("В этом наборе данных аномалий не обнаружено.")

    if brief:
        prompt = "\n".join(lines) + (
            "\n\nТы пишешь короткое обоснование ситуации для директора школы или акимата — "
            "НЕ технический план действий для завхоза. Ровно 3-4 предложения на русском "
            "языке, без заголовков, без списков, без Markdown-разметки: почему это важно, "
            "сколько теряется в тенге за этот период, что исправление обычно не требует "
            "бюджета (пересмотр расписания BMS, а не ремонт или закупка), и что деньги "
            "перестают теряться сразу после исправления. Используй только цифры, приведённые "
            "выше — ничего не придумывай. Никаких приветствий, прощаний или инженерных терминов."
        )
    else:
        prompt = "\n".join(lines) + (
            "\n\nТы — старший консультант по энергоэффективности зданий и пишешь напрямую для "
            "управляющего зданием. Напиши ПОДРОБНЫЙ план действий на русском языке в формате "
            "Markdown строго со следующими разделами (заголовки тоже должны быть на русском):"
            "\n\n## Сводка"
            "\nДва-три предложения, количественно описывающих проблему с использованием точных "
            "цифр в кВт·ч, тенге и CO₂ и отмеченных дат выше."
            "\n\n## Что вероятно произошло"
            "\nНазови 2-4 наиболее вероятные категории причин словами (например: график "
            "отопления/вентиляции, таймеры освещения, оборудование или розеточная нагрузка "
            "оставлены включёнными, IT-серверы, системы охраны, отсутствие календарных "
            "исключений на праздники). Для каждой категории объясни, ПОЧЕМУ ты её подозреваешь, "
            "сравнивая отмеченное потребление с базовым уровнем и типичным рабочим уровнем в "
            "данных — только словами и категориями, без числовых оценок по видам оборудования."
            "\n\n## Меры по исправлению"
            "\nПронумерованные, конкретные шаги. Для каждого шага укажи, что именно нужно "
            "проверить или изменить и кто должен это сделать (техник BMS, завхоз, IT, "
            "руководство) — не придумывай новых числовых показателей сверх переданных выше."
            "\n\n## Профилактика и мониторинг"
            "\nКонкретные меры контроля: календарные исключения BMS на праздники/каникулы, "
            "суб-счётчики, пороги тревоги на основе базового уровня нерабочего дня, и как часто "
            "нужно проверять данные."
            "\n\nПравила: используй только даты и цифры, приведённые выше; отвечай ТОЛЬКО на "
            "русском языке, включая заголовки разделов; не указывай числовые оценки "
            "энергопотребления по типам оборудования или отдельным системам — у тебя нет данных "
            "для этого, только переданные тебе агрегированные цифры и общие категории причин; "
            "никакого общего наполнителя, приветствий и прощаний."
        )

    try:
        text = ask_gemini(prompt)
        model = os.environ.get("GEMINI_MODEL", "gemini-3.6-flash")
    except AIUnavailable:
        text = _fallback_insight_brief(req) if brief else _fallback_insight(req)
        model = "offline-fallback"
    return InsightResponse(insight=text, model=model)


@app.get("/api/health")
async def health():
    return {"status": "ok"}


@app.get("/api/provenance", response_model=list[ProvenanceEntry])
async def provenance():
    """Every numeric constant the app uses, tagged with where it came from —
    powers the "About method" screen's sourcing table. See config.PROVENANCE
    and scripts/check_config.py."""
    return [
        ProvenanceEntry(key=key, value=prov.value, kind=prov.kind, note=prov.note)
        for key, prov in config.PROVENANCE.items()
    ]


@app.get("/api/config", response_model=ConfigResponse)
async def public_config():
    """Non-secret runtime config the frontend needs — never the bot token
    itself, only its public @username so the UI can link to the Telegram bot."""
    return ConfigResponse(telegram_bot_username=os.environ.get("TELEGRAM_BOT_USERNAME", "").strip())


class NoCacheStaticFiles(StaticFiles):
    """Force browsers to revalidate the frontend bundle on every load.

    Without this, a redeploy can silently leave users running a stale
    cached app.js — invisible bugs, "fixed" code that still misbehaves.
    Correctness beats the (negligible, for a dashboard this size) cost
    of an extra conditional request per file.
    """

    async def get_response(self, path: str, scope: Scope):
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-cache"
        return response


app.mount("/", NoCacheStaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8000)
