#!/usr/bin/env bash
# Runs the FastAPI backend and the Telegram bot as two processes inside one
# Render service (the free plan only gives us one web service, and a second
# background worker needs a paid plan — so both live here instead).
set -e

export BACKEND_URL="http://127.0.0.1:${PORT}"

uvicorn backend.main:app --host 0.0.0.0 --port "$PORT" &
WEB_PID=$!

python bot.py &
BOT_PID=$!

# If either process dies, stop the other and exit so Render restarts both.
wait -n "$WEB_PID" "$BOT_PID"
kill "$WEB_PID" "$BOT_PID" 2>/dev/null || true
wait
