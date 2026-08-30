"""Tariff and CO2 sourcing notes the team must double-check before the final demo.

This file intentionally holds no logic — only documented numbers. `core.py` keeps
using its own defaults (so existing tests keep passing), but every default here is
traceable to a real source instead of an "eyeballed" number.
"""

from dataclasses import dataclass

from core import BASELINE_MULTIPLIER

# Real household tariff for the Abai region (bytovoy/household tariff), cited in
# the project brief. This is the default used by core.py. It is NOT verified for
# any specific school or business — confirm the actual contracted tariff for the
# region being analyzed before presenting numbers as final.
ABAI_HOUSEHOLD_TARIFF_KZT_PER_KWH = 17.447

# CO2 factor used across the MVP. This is a demonstration assumption, not a
# confirmed emissions factor for Kazakhstan's grid mix in a specific period.
DEFAULT_CO2_KG_PER_KWH = 0.85
CO2_FACTOR_TODO = (
    "Confirm the CO2e emissions factor for Kazakhstan's electricity grid and the "
    "calculation methodology (market-based vs. location-based) before the final demo."
)

# Reference tariffs for the team to pick from when adapting to a different school
# or business region. None of these are auto-selected by the app — each entry
# keeps its context so a household tariff is never silently presented as a school
# tariff.
REGION_TARIFFS = {
    "abai_household_2024": {
        "tariff_kzt_per_kwh": 17.447,
        "consumer_type": "households (bytovoy tariff)",
        "region": "Abai region",
        "use_for_school": False,
    },
    "astana_household_average_2026": {
        "tariff_kzt_per_kwh": 28.12,
        "includes_vat": True,
        "consumer_type": "households",
        "valid_from": "2026-07-01",
        "source": "https://astrec.kz/abonentam/tarify-dlia-fizicheskih-lits",
        "use_for_school": False,
    },
    "astana_legal_entity_ceiling_2026": {
        "tariff_kzt_per_kwh": 32.74,
        "includes_vat": False,
        "consumer_type": "legal entities: price ceiling",
        "valid_from": "2026-07-01",
        "source": "https://astrec.kz/abonentam/tarify",
        "use_for_school": False,
    },
}

SCHOOL_TARIFF_TODO = (
    "Confirm the budget organization's actual contracted electricity tariff "
    "before the final demo — none of the tariffs above are a verified school rate."
)

# ---------------------------------------------------------------------------
# Water and heat — same "documented, not verified" pattern as the electricity
# tariff above. These let the multi-resource path in backend/main.py convert
# excess water/heat into tenge without inventing a number silently; they are
# clearly flagged as DEMO VALUES so nobody presents them as a real bill.
# ---------------------------------------------------------------------------

WATER_TARIFF_KZT_PER_M3_DEMO = 141.33
WATER_TARIFF_TODO = (
    "DEMO VALUE only, not sourced for a specific city or supplier — confirm the "
    "actual contracted water tariff before presenting final numbers."
)

HEAT_TARIFF_KZT_PER_GCAL_DEMO = 6540.0
HEAT_TARIFF_TODO = (
    "DEMO VALUE only, not sourced for a specific city or supplier — confirm the "
    "actual contracted heat tariff before presenting final numbers."
)

# Heat is usually produced by burning gas or coal, so — unlike water — a CO2
# factor is physically meaningful for it. Still a demo assumption, same as
# CO2_KG_PER_KWH above.
HEAT_CO2_KG_PER_GCAL_DEMO = 200.0
HEAT_CO2_FACTOR_TODO = (
    "Confirm the CO2e emissions factor for the heat source (gas/coal boiler, "
    "district heating mix) before the final demo."
)

# ---------------------------------------------------------------------------
# Provenance registry — every numeric constant the app uses, tagged with
# where it came from, structured (not just a code comment) so it can be
# rendered programmatically on the "About method" screen and scanned by
# scripts/check_config.py. `kind` is one of:
#   "source"  — traceable to a real, cited document/page
#   "derived" — computed from a source value, not itself independently sourced
#   "estimate"— an engineering placeholder with no confirmed source yet
# A number with no honest source stays an "estimate" here rather than being
# dressed up as a "source" — that distinction is the whole point of this file.
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Provenance:
    value: float | None
    kind: str  # "source" | "derived" | "estimate"
    note: str


PROVENANCE: dict[str, Provenance] = {
    "tariff_electricity_kzt_per_kwh": Provenance(
        ABAI_HOUSEHOLD_TARIFF_KZT_PER_KWH,
        "source",
        "Бытовой тариф Абайской области из брифа хакатона — не подтверждён для "
        "конкретной школы/бизнеса.",
    ),
    "co2_factor_kg_per_kwh": Provenance(
        DEFAULT_CO2_KG_PER_KWH,
        "estimate",
        "Демонстрационное допущение, не подтверждённый коэффициент сети РК.",
    ),
    "anomaly_multiplier": Provenance(
        BASELINE_MULTIPLIER,
        "estimate",
        "Инженерная оценка порога для MVP — не откалибрована по длинной реальной истории.",
    ),
    "water_tariff_kzt_per_m3": Provenance(
        WATER_TARIFF_KZT_PER_M3_DEMO,
        "estimate",
        "Демо-значение, не привязано к конкретному поставщику воды.",
    ),
    "heat_tariff_kzt_per_gcal": Provenance(
        HEAT_TARIFF_KZT_PER_GCAL_DEMO,
        "estimate",
        "Демо-значение, не привязано к конкретному поставщику тепла.",
    ),
    "heat_co2_factor_kg_per_gcal": Provenance(
        HEAT_CO2_KG_PER_GCAL_DEMO,
        "estimate",
        "Инженерная оценка для типового газового/угольного котла.",
    ),
    # Postanovleniye Pravitel'stva RK No. 1118 sets official per-region,
    # per-floor-count consumption norms for budget organizations — real,
    # findable document, but we do not have the specific figure for a given
    # region/floor-count on hand. Left as None rather than guessing a number;
    # fill in the real value (with its own source note) once confirmed.
    "official_norm_kwh_per_day": Provenance(
        None,
        "estimate",
        "TODO: не заполнено. Постановление Правительства РК №1118 задаёт официальные "
        "нормативы потребления для бюджетных организаций по регионам и этажности — "
        "нужна конкретная цифра для анализируемого здания, прежде чем сравнение "
        "'факт vs норматив' появится в отчёте.",
    ),
}
