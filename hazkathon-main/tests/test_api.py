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
