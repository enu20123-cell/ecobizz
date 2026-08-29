"""Unit tests for bot.py's pure message-formatting logic.

format_summary_reply() takes plain dicts and returns plain text — no
Telegram objects, no network, no token needed — so it can run in the same
offline pytest suite as everything else.
"""

from bot import format_summary_reply


def _analysis(**overrides) -> dict:
    base = {
        "source": "sample_data.csv",
        "weather_adjusted": False,
        "first_anomaly": "2025-12-15",
        "last_anomaly": "2025-12-21",
        "summary": {
            "days_analyzed": 31,
            "anomaly_days": 7,
            "total_excess_kwh": 350.5,
            "savings_kzt": 6115.0,
            "co2_saved_kg": 297.9,
            "baseline_reliable": True,
            "off_day_samples": 9,
        },
    }
    base.update(overrides)
    return base


def test_format_summary_reply_includes_key_figures_verbatim():
    text = format_summary_reply(_analysis())
    assert "sample_data.csv" in text
    assert "7" in text  # anomaly_days
    assert "350.5" in text  # total_excess_kwh
    assert "6115" in text  # savings_kzt
    assert "297.9" in text  # co2_saved_kg
    assert "2025-12-15" in text and "2025-12-21" in text


def test_format_summary_reply_no_anomalies():
    analysis = _analysis(first_anomaly=None, last_anomaly=None)
    analysis["summary"]["anomaly_days"] = 0
    text = format_summary_reply(analysis)
    assert "Аномалий не найдено" in text


def test_format_summary_reply_flags_unreliable_baseline():
    analysis = _analysis()
    analysis["summary"]["baseline_reliable"] = False
    analysis["summary"]["off_day_samples"] = 1
    text = format_summary_reply(analysis)
    assert "предварительный сигнал" in text
    assert "1" in text


def test_format_summary_reply_notes_weather_adjustment():
    text = format_summary_reply(_analysis(weather_adjusted=True))
    assert "погод" in text.lower()
