"""EcoBiz Copilot Telegram bot.

A thin messaging front-end: it talks to the same FastAPI backend
(/api/analyze, /api/insight) the web dashboard uses, so there is only one
analysis pipeline to keep correct — the bot never recomputes anything
itself. Run the backend first, then this script as a separate process:

    uvicorn backend.main:app &
    python bot.py

The token is read from TELEGRAM_BOT_TOKEN (see .env.example) and is never
hardcoded or logged.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

import httpx
from telegram import Update
from telegram.ext import Application, CommandHandler, ContextTypes, MessageHandler, filters

ENV_PATH = Path(__file__).resolve().parent / ".env"
BACKEND_URL = os.environ.get("BACKEND_URL", "http://127.0.0.1:8000").rstrip("/")
ALLOWED_SUFFIXES = (".csv", ".xlsx", ".xls")

LOGGER = logging.getLogger(__name__)


def _load_dotenv() -> None:
    """Minimal .env loader — same approach as backend/ai.py, no extra dependency."""
    if not ENV_PATH.exists():
        return
    for line in ENV_PATH.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip())


_load_dotenv()


def format_summary_reply(analysis: dict) -> str:
    """Turn an /api/analyze JSON body into a short Telegram-friendly summary.

    A pure function (no network, no Telegram objects) so it can be unit
    tested without a live bot or backend — every figure is copied straight
    from the analysis response, nothing here is invented.
    """
    s = analysis["summary"]
    lines = [
        f"📊 Источник: {analysis['source']}",
        f"Проанализировано дней: {s['days_analyzed']}",
    ]
    if not s.get("baseline_reliable", True):
        lines.append(
            f"⚠️ Базовый уровень построен всего по {s['off_day_samples']} "
            "нерабочему(им) дню(дням) — предварительный сигнал, не подтверждённый факт."
        )
    if s["anomaly_days"] == 0:
        lines.append("✅ Аномалий не найдено — здание корректно отключается в нерабочие дни.")
    else:
        lines.append(
            f"⚠️ Аномальных дней: {s['anomaly_days']}\n"
            f"Перерасход: {s['total_excess_kwh']:.1f} кВт·ч\n"
            f"Потери: {s['savings_kzt']:.0f} тенге\n"
            f"CO₂: {s['co2_saved_kg']:.1f} кг"
        )
        if analysis.get("first_anomaly"):
            span = analysis["first_anomaly"]
            if analysis.get("last_anomaly") and analysis["last_anomaly"] != span:
                span += f" — {analysis['last_anomaly']}"
            lines.append(f"Даты: {span}")
    if analysis.get("weather_adjusted"):
        lines.append("(с учётом погоды: обогрев в мороз не считается потерей)")
    return "\n".join(lines)


async def _analyze_and_reply(update: Update, file_bytes: bytes | None, filename: str) -> None:
    async with httpx.AsyncClient(timeout=30.0) as client:
        files = {"file": (filename, file_bytes, "application/octet-stream")} if file_bytes else None
        params = {"weather_adjust": True}
        try:
            res = await client.post(f"{BACKEND_URL}/api/analyze", params=params, files=files)
            res.raise_for_status()
            analysis = res.json()
        except Exception as exc:
            await update.message.reply_text(
                f"Не удалось проанализировать файл: {exc}\n"
                f"Убедитесь, что backend запущен на {BACKEND_URL}."
            )
            return

        await update.message.reply_text(format_summary_reply(analysis))

        try:
            insight_res = await client.post(
                f"{BACKEND_URL}/api/insight",
                json={
                    "source": analysis["source"],
                    "summary": analysis["summary"],
                    "anomalies": [d for d in analysis["series"] if d["is_anomaly"]],
                },
                timeout=150.0,
            )
            insight_res.raise_for_status()
            await update.message.reply_text(insight_res.json()["insight"])
        except Exception:
            LOGGER.warning("Insight request failed; the summary above already answered the user.")


async def start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await update.message.reply_text(
        "Привет! Я EcoBiz Copilot.\n\n"
        "Пришлите мне CSV или Excel файл с колонками date и consumption_kwh "
        "(по школе или бизнесу) — я найду дни, когда здание тратило энергию "
        "впустую в нерабочее время, и посчитаю потери в тенге и CO₂.\n\n"
        "Команда /demo — мгновенный пример на встроенных данных, без файла."
    )


async def demo(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await update.message.reply_text("Считаю пример…")
    await _analyze_and_reply(update, None, "sample_data.csv")


async def handle_document(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    doc = update.message.document
    if not doc.file_name or not doc.file_name.lower().endswith(ALLOWED_SUFFIXES):
        await update.message.reply_text(
            f"Поддерживаются только файлы {', '.join(ALLOWED_SUFFIXES)}."
        )
        return
    await update.message.reply_text(f"Анализирую «{doc.file_name}»…")
    tg_file = await doc.get_file()
    file_bytes = bytes(await tg_file.download_as_bytearray())
    await _analyze_and_reply(update, file_bytes, doc.file_name)


def main() -> None:
    token = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
    if not token:
        raise SystemExit(
            "TELEGRAM_BOT_TOKEN не задан — скопируйте .env.example в .env и впишите токен бота."
        )
    logging.basicConfig(level=logging.INFO)
    app = Application.builder().token(token).build()
    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("demo", demo))
    app.add_handler(MessageHandler(filters.Document.ALL, handle_document))
    LOGGER.info("EcoBiz Copilot bot polling — backend at %s", BACKEND_URL)
    app.run_polling()


if __name__ == "__main__":
    main()
