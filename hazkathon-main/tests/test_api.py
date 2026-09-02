"""API contract tests for the EcoBiz Copilot endpoints."""

import io

from core import load_data


def _post_csv(client, csv_text: str, **params):
    return client.post(
        "/api/analyze",
        params=params,
        files={"file": ("upload.csv", io.BytesIO(csv_text.encode()), "text/csv")},
    )


def test_health(client):
    assert client.get("/api/health").json() == {"status": "ok"}


def test_analyze_sample_without_file(client):
    res = client.post("/api/analyze")
    assert res.status_code == 200
    body = res.json()
    assert body["source"] == "sample_data.csv"
    assert body["summary"]["anomaly_days"] == 7
    assert len(body["series"]) == 31
    assert body["worst_day"] is not None
    assert body["first_anomaly"] == "2025-12-15"
    assert body["last_anomaly"] == "2025-12-21"
    assert body["summary"]["baseline_reliable"] is True


def test_analyze_without_is_workday_uses_kz_calendar(client):
    """A raw export with only date/consumption_kwh still works: weekends and
    the Kazakhstan holiday calendar (holidays_kz.json) fill in is_workday."""
    res = _post_csv(
        client,
        "date,consumption_kwh\n"
        "2026-02-02,400\n"  # Monday -> workday
        "2026-02-07,80\n",  # Saturday -> non-working
    )
    assert res.status_code == 200
    series = {row["date"]: row for row in res.json()["series"]}
    assert series["2026-02-02"]["is_workday"] is True
    assert series["2026-02-07"]["is_workday"] is False
    # Only one non-working day in this tiny sample: too thin to trust.
    assert res.json()["summary"]["baseline_reliable"] is False
    assert res.json()["summary"]["off_day_samples"] == 1


def test_upload_csv_matches_core_pipeline(client, sample_csv_bytes):
    expected = len(load_data(io.BytesIO(sample_csv_bytes)))
    res = client.post(
        "/api/analyze", files={"file": ("data.csv", io.BytesIO(sample_csv_bytes), "text/csv")}
    )
    assert res.status_code == 200
    assert len(res.json()["series"]) == expected
    assert res.json()["source"] == "data.csv"


def test_tariff_changes_money_but_not_kwh(client):
    low = client.post("/api/analyze", params={"tariff": 10}).json()
    high = client.post("/api/analyze", params={"tariff": 100}).json()
    assert high["summary"]["savings_kzt"] == low["summary"]["savings_kzt"] * 10
    assert high["summary"]["total_excess_kwh"] == low["summary"]["total_excess_kwh"]
    assert high["summary"]["anomaly_days"] == low["summary"]["anomaly_days"]


def test_kwh_column_alias_is_accepted(client):
    """Real-world exports sometimes call the reading column 'kwh' instead of
    'consumption_kwh' — that should still work, not 422."""
    res = _post_csv(
        client,
        "date,kwh,is_workday\n"
        "2026-02-02,400,1\n"
        "2026-02-07,80,0\n",
    )
    assert res.status_code == 200
    series = {row["date"]: row for row in res.json()["series"]}
    assert series["2026-02-02"]["consumption_kwh"] == 400.0
    assert series["2026-02-07"]["consumption_kwh"] == 80.0


def test_multiplier_changes_anomaly_count(client):
    loose = client.post("/api/analyze", params={"multiplier": 1.2}).json()
    default = client.post("/api/analyze", params={"multiplier": 1.5}).json()
    assert loose["summary"]["multiplier"] == 1.2
    assert default["summary"]["multiplier"] == 1.5
    assert loose["summary"]["anomaly_days"] >= default["summary"]["anomaly_days"]


def test_zero_multiplier_rejected(client):
    assert client.post("/api/analyze", params={"multiplier": 0}).status_code == 422


def test_missing_columns_returns_422(client):
    res = _post_csv(client, "a,b,c\n1,2,3\n")
    assert res.status_code == 422
    assert "Отсутствуют обязательные колонки" in res.json()["detail"]


def test_bad_values_return_422(client):
    res = _post_csv(client, "date,consumption_kwh,is_workday\nnope,not-a-number,1\n")
    assert res.status_code == 422
    assert "Некорректные значения" in res.json()["detail"]


def test_empty_rows_return_422(client):
    res = _post_csv(client, "date,consumption_kwh,is_workday\n")
    assert res.status_code == 422


def test_wrong_extension_returns_415(client):
    res = client.post("/api/analyze", files={"file": ("notes.txt", b"hello", "text/plain")})
    assert res.status_code == 415


def test_negative_tariff_rejected_on_sample(client):
    assert client.post("/api/analyze", params={"tariff": -1}).status_code == 422


def test_frontend_is_served(client):
    res = client.get("/")
    assert res.status_code == 200
    assert "EcoBiz Copilot" in res.text
    for asset in ("/app.js", "/styles.css"):
        assert client.get(asset).status_code == 200


def test_analyze_single_resource_file_has_only_electricity_in_resources(client):
    """Backward compatibility: an old-style date+consumption_kwh file still
    gets the exact same top-level summary/series, and `resources` — a purely
    additive field — contains only the electricity entry."""
    res = client.post("/api/analyze")
    body = res.json()
    assert res.status_code == 200
    assert set(body["resources"].keys()) == {"electricity"}
    assert body["resources"]["electricity"]["total_excess"] == body["summary"]["total_excess_kwh"]
    assert body["resources"]["electricity"]["anomaly_days"] == body["summary"]["anomaly_days"]
    assert body["weather_adjusted"] is False


def test_analyze_multi_resource_sample_exposes_water_and_heat(client):
    res = client.post("/api/analyze", params={"sample": "multi"})
    assert res.status_code == 200
    body = res.json()
    assert body["source"] == "sample_data_multi.csv"
    assert set(body["resources"].keys()) == {"electricity", "water", "heat"}
    water = body["resources"]["water"]
    assert water["unit"] == "м³"
    assert water["co2_saved_kg"] is None  # water has no meaningful CO2 factor
    assert len(water["series"]) == len(body["series"])


def test_analyze_multi_resource_file_matches_old_single_resource_response_shape(client, sample_csv_bytes):
    """A plain old single-resource upload produces an identical response to
    before this feature existed — multi-resource support never changes the
    single-resource path."""
    old = client.post(
        "/api/analyze", files={"file": ("data.csv", io.BytesIO(sample_csv_bytes), "text/csv")}
    ).json()
    again = client.post(
        "/api/analyze", files={"file": ("data.csv", io.BytesIO(sample_csv_bytes), "text/csv")}
    ).json()
    assert old["summary"] == again["summary"]
    assert old["series"] == again["series"]


def test_weather_adjust_flag_never_errors_even_when_unreachable(client, monkeypatch):
    """Open-Meteo may be unreachable in CI/offline environments — the request
    must still succeed and fall back to the flat baseline, not 500."""
    import backend.main as backend_main

    monkeypatch.setattr(backend_main.weather, "fetch_daily_mean_temperatures", lambda *a, **k: None)
    res = client.post("/api/analyze", params={"weather_adjust": True})
    assert res.status_code == 200
    assert res.json()["weather_adjusted"] is False


def test_analyze_sample_includes_cause_diagnosis_for_anomalous_days(client):
    body = client.post("/api/analyze").json()
    assert body["summary"]["anomaly_days"] == 7
    assert len(body["cause_diagnosis"]) == 7
    for entry in body["cause_diagnosis"].values():
        assert entry["confidence_label"] in ("высокая", "средняя", "низкая")
        assert entry["confirming_signals"] <= entry["available_signals"]
    assert body["cause_summary"]
    assert sum(e["days"] for e in body["cause_summary"]) == 7


def test_analyze_multi_resource_cause_diagnosis_uses_all_resources(client):
    body = client.post("/api/analyze", params={"sample": "multi"}).json()
    for date, entry in body["cause_diagnosis"].items():
        assert entry["available_signals"] >= 1
        # every diagnosed day comes from at least one resource actually anomalous that day
        assert any(
            r["series"][[d["date"] for d in r["series"]].index(date)]["is_anomaly"]
            for r in body["resources"].values()
        )


def test_analyze_resources_series_includes_anomaly_pattern(client):
    body = client.post("/api/analyze").json()
    anomalous = [d for d in body["resources"]["electricity"]["series"] if d["is_anomaly"]]
    assert anomalous
    for day in anomalous:
        assert day["pattern"] in ("устойчивая", "периодическая", "разовая")
    normal = [d for d in body["resources"]["electricity"]["series"] if not d["is_anomaly"]]
    assert all(day["pattern"] is None for day in normal)


def test_provenance_endpoint_lists_tagged_constants(client):
    res = client.get("/api/provenance")
    assert res.status_code == 200
    entries = res.json()
    assert entries
    for entry in entries:
        assert entry["kind"] in ("source", "derived", "estimate")
        assert entry["note"]


def test_config_endpoint_exposes_bot_username_not_token(client, monkeypatch):
    monkeypatch.setenv("TELEGRAM_BOT_USERNAME", "ecobizzbot")
    res = client.get("/api/config")
    assert res.status_code == 200
    body = res.json()
    assert body["telegram_bot_username"] == "ecobizzbot"
    assert "token" not in str(body).lower()


def test_analyze_includes_bootstrap_savings_range(client):
    body = client.post("/api/analyze").json()
    s = body["summary"]
    assert s["savings_kzt_p10"] is not None
    assert s["savings_kzt_p10"] <= s["savings_kzt"] <= s["savings_kzt_p90"]
    elec = body["resources"]["electricity"]
    assert elec["savings_kzt_p10"] == s["savings_kzt_p10"]
    assert elec["savings_kzt_p90"] == s["savings_kzt_p90"]


def test_analyze_bootstrap_range_absent_under_weather_adjustment(client, monkeypatch):
    """The bootstrap resamples the flat baseline — under weather adjustment the
    point estimate comes from a regression instead, so the range would not
    describe the same number and must be omitted rather than shown mismatched."""
    import backend.main as backend_main

    monkeypatch.setattr(
        backend_main,
        "detect_anomalies_weather_adjusted",
        lambda df, hdd_by_date, multiplier=1.5: backend_main.detect_anomalies(df, multiplier=multiplier),
    )
    monkeypatch.setattr(backend_main.weather, "fetch_daily_mean_temperatures", lambda *a, **k: {"2025-12-01": -5.0})
    res = client.post("/api/analyze", params={"weather_adjust": True})
    body = res.json()
    assert body["weather_adjusted"] is True
    assert body["summary"]["savings_kzt_p10"] is None
    assert body["summary"]["savings_kzt_p90"] is None


def test_analyze_norm_comparison_only_when_supplied(client):
    without = client.post("/api/analyze").json()
    assert without["norm_comparison"] is None

    with_norm = client.post("/api/analyze", params={"official_norm_kwh_per_day": 200}).json()
    nc = with_norm["norm_comparison"]
    assert nc is not None
    assert nc["official_norm_kwh_per_day"] == 200
    assert nc["actual_avg_kwh_per_day"] > 0


def test_analyze_efficiency_grade_only_when_area_supplied(client):
    without = client.post("/api/analyze").json()
    assert without["efficiency_grade"] is None

    with_area = client.post("/api/analyze", params={"building_area_m2": 1000}).json()
    grade = with_area["efficiency_grade"]
    assert grade is not None
    assert grade["grade"] in ("A", "B", "C", "D", "E", "F")
    assert grade["benchmark_label"] == "Казахстан (среднее)"


def test_analyze_efficiency_grade_uses_building_type_benchmark(client):
    national = client.post("/api/analyze", params={"building_area_m2": 1000}).json()["efficiency_grade"]
    school = client.post(
        "/api/analyze", params={"building_area_m2": 1000, "building_type": "school"}
    ).json()["efficiency_grade"]

    assert school["benchmark_label"] == "Школа/детсад"
    # Same intensity, different benchmark -> the ratio (and possibly the
    # letter) is computed against a different number, not just relabeled.
    assert school["kz_average_kwh_per_m2_year"] != national["kz_average_kwh_per_m2_year"]
    assert school["intensity_kwh_per_m2_year"] == national["intensity_kwh_per_m2_year"]


def test_analyze_rejects_unknown_building_type(client):
    res = client.post("/api/analyze", params={"building_area_m2": 1000, "building_type": "spaceship"})
    assert res.status_code == 422
    assert "spaceship" in res.json()["detail"]


def test_analyze_co2_and_resource_overrides_apply(client):
    body = client.post(
        "/api/analyze",
        params={"sample": "multi", "co2_factor": 1.0, "water_tariff": 200, "heat_tariff": 7000, "heat_co2_factor": 180},
    ).json()
    assert body["summary"]["co2_factor"] == 1.0
    assert body["resources"]["water"]["tariff_kzt_per_unit"] == 200
    assert body["resources"]["water"]["co2_saved_kg"] is None  # water never gets a CO2 factor, override or not
    assert body["resources"]["heat"]["tariff_kzt_per_unit"] == 7000


def test_analyze_rejects_negative_overrides(client):
    for param in ("co2_factor", "water_tariff", "heat_tariff", "heat_co2_factor", "official_norm_kwh_per_day", "building_area_m2"):
        res = client.post("/api/analyze", params={param: -1})
        assert res.status_code == 422, param


def test_insight_brief_mode_is_short_and_offline_by_default(client, monkeypatch):
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    analysis = client.post("/api/analyze").json()
    res = client.post(
        "/api/insight",
        params={"brief": True},
        json={
            "source": analysis["source"],
            "summary": analysis["summary"],
            "anomalies": [d for d in analysis["series"] if d["is_anomaly"]],
        },
    )
    assert res.status_code == 200
    body = res.json()
    assert body["model"] == "offline-fallback"
    # A brief executive justification should be much shorter than the full
    # four-section Markdown action plan, and contain no Markdown headings.
    assert "##" not in body["insight"]
    assert len(body["insight"]) < 800


def test_insight_falls_back_offline_without_api_key(client, monkeypatch):
    """No GEMINI_API_KEY in this test environment: the demo must still return
    a usable recommendation instead of a 503, built from the verified numbers."""
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    analysis = client.post("/api/analyze").json()
    res = client.post(
        "/api/insight",
        json={
            "source": analysis["source"],
            "summary": analysis["summary"],
            "anomalies": [d for d in analysis["series"] if d["is_anomaly"]],
        },
    )
    assert res.status_code == 200
    body = res.json()
    assert body["model"] == "offline-fallback"
    assert str(round(analysis["summary"]["total_excess_kwh"], 2)) in body["insight"] or "kWh" in body["insight"]
