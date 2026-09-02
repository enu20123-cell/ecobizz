"use strict";

/* ---------- Helpers ---------- */
const $ = (id) => document.getElementById(id);

/* ---------- Theme system ---------- */
// "auto" is a *selection mode*, not a palette: it resolves to day/night by
// the clock (06:00–18:00 = day), not a 5th color scheme. The concrete
// palette actually applied is always one of THEME_META's non-auto keys.
const THEME_STORAGE_KEY = "ecobiz-theme-mode";
const THEME_META = {
  auto: { icon: "🌗", label: "Авто" },
  day: { icon: "☀️", label: "День" },
  night: { icon: "🌙", label: "Ночь" },
  comfort: { icon: "👁", label: "Комфорт глаз" },
  contrast: { icon: "◐", label: "Высокий контраст" },
};

function resolveAutoTheme() {
  const hour = new Date().getHours();
  return hour >= 6 && hour < 18 ? "day" : "night";
}

function getThemeMode() {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY) || "night";
  } catch {
    return "night";
  }
}

function applyTheme(mode, { persist = true } = {}) {
  const resolved = mode === "auto" ? resolveAutoTheme() : mode;
  document.documentElement.setAttribute("data-theme", resolved);
  if (persist) {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, mode);
    } catch {
      // Private browsing / storage disabled — theme just won't persist across reloads.
    }
  }
  const meta = THEME_META[mode];
  $("theme-switcher-icon").textContent = mode === "auto" ? THEME_META[resolved].icon : meta.icon;
  $("theme-switcher-label").textContent = meta.label;
  document.querySelectorAll(".theme-option").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.mode === mode);
  });
  // Chart colors are read live from CSS custom properties (inline SVG
  // presentation attributes don't reliably resolve var()), so a theme
  // change needs an explicit repaint once data exists.
  if (typeof chartState !== "undefined" && chartState.series.length) drawChart();
}

function initThemeSwitcher() {
  const mode = getThemeMode();
  applyTheme(mode, { persist: false });

  const btn = $("theme-switcher-btn");
  const menu = $("theme-menu");
  btn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    const willOpen = menu.classList.contains("hidden");
    menu.classList.toggle("hidden", !willOpen);
    btn.setAttribute("aria-expanded", String(willOpen));
  });
  document.querySelectorAll(".theme-option").forEach((option) =>
    option.addEventListener("click", () => {
      applyTheme(option.dataset.mode);
      menu.classList.add("hidden");
      btn.setAttribute("aria-expanded", "false");
    }),
  );
  document.addEventListener("click", (ev) => {
    if (!menu.classList.contains("hidden") && !$("theme-switcher").contains(ev.target)) {
      menu.classList.add("hidden");
      btn.setAttribute("aria-expanded", "false");
    }
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      menu.classList.add("hidden");
      btn.setAttribute("aria-expanded", "false");
    }
  });

  // Re-resolve "auto" when the tab regains focus and every 5 minutes while
  // open, so a long-open session still crosses the 06:00/18:00 boundary.
  const reapplyIfAuto = () => {
    if (getThemeMode() === "auto") applyTheme("auto", { persist: false });
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") reapplyIfAuto();
  });
  setInterval(reapplyIfAuto, 5 * 60 * 1000);
}

// Try the origin serving the page first; if it is not our API (e.g. VS Code
// Live Server or a plain static server, which reject POSTs with 405),
// automatically fall back to the backend on port 8000.
const LOCAL_API = "http://127.0.0.1:8000";

function apiBases() {
  const bases = new Set();
  if (location.protocol.startsWith("http")) bases.add(location.origin);
  bases.add(LOCAL_API);
  return [...bases];
}

async function apiPost(path, opts = {}) {
  const bases = apiBases();
  for (let i = 0; i < bases.length; i++) {
    try {
      const res = await fetch(bases[i] + path, opts);
      const wrongBackend = res.status === 404 || res.status === 405;
      if (!wrongBackend || i === bases.length - 1) return res;
    } catch (err) {
      if (i === bases.length - 1) throw err;
    }
  }
}

// Same origin-fallback logic as apiPost, for plain GET reads (config, provenance).
const apiGet = (path) => apiPost(path, { method: "GET" });

const fmt = (n, digits = 0) =>
  Number(n).toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });

const shortDate = (iso) => {
  const [, m, d] = iso.split("-");
  return `${d}/${m}`;
};

function showStatus(message, isError = false) {
  const el = $("status");
  el.textContent = message;
  el.className = `status ${isError ? "error" : ""}`;
}

function setLoading(on) {
  $("loading").classList.toggle("hidden", !on);
  if (on) showStatus("");
  else hideStatus();
}

function hideStatus() {
  $("status").className = "status hidden";
}

/* ---------- Data fetching ---------- */
function reqTimeout(ms) {
  // AbortSignal.timeout is unavailable in older Safari; degrade gracefully.
  try {
    return AbortSignal.timeout(ms);
  } catch {
    return undefined;
  }
}

let currentMultiplier = 1.5;
let lastSampleParam = "default"; // remembers which bundled sample is active, for live re-runs

// Reads the "Параметры расчёта" panel — editable overrides for the
// config.py constants still tagged "estimate" (see /api/provenance). Their
// defaults match the backend's own defaults exactly, so including them on
// every request is a no-op until the user actually edits one; that also
// means a tariff/multiplier re-run never silently drops an edited value.
function currentSettingsParams() {
  const params = {
    co2_factor: $("set-co2").value,
    water_tariff: $("set-water-tariff").value,
    heat_tariff: $("set-heat-tariff").value,
    heat_co2_factor: $("set-heat-co2").value,
  };
  const norm = $("set-official-norm").value;
  const area = $("set-area").value;
  // Never defaulted — omitted entirely unless the user actually filled them
  // in, so the backend never invents a norm/area comparison.
  if (norm !== "") params.official_norm_kwh_per_day = norm;
  if (area !== "") params.building_area_m2 = area;
  return params;
}

async function analyze(formData, label, extraParams = {}) {
  $("results").classList.add("hidden");
  $("loading-text").textContent = label
    ? `Анализируем «${label}»…`
    : "Анализируем данные по энергопотреблению…";
  setLoading(true);
  try {
    const params = new URLSearchParams({
      tariff: $("tariff").value,
      multiplier: String(currentMultiplier),
      // Always requested; the backend falls back to the flat baseline (and
      // reports weather_adjusted: false) whenever weather data isn't
      // available, so this is always safe to ask for.
      weather_adjust: "true",
      ...currentSettingsParams(),
      ...extraParams,
    });
    const res = await apiPost(`/api/analyze?${params.toString()}`, {
      method: "POST",
      body: formData,
      signal: reqTimeout(30000),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data) throw new Error(data?.detail || `Ошибка запроса (${res.status})`);
    render(data);
  } catch (err) {
    showStatus(
      `${err.message} — откройте дашборд на http://127.0.0.1:8000 (не через Live Server).`,
      true,
    );
  } finally {
    setLoading(false); // ALWAYS stop the spinner — success or failure
  }
}

/* ---------- Rendering ---------- */
let lastAnalysis = null; // reused for the AI Copilot and tariff re-runs
let lastInsight = null; // last Gemini/offline recommendation, reused by the report download
let currentResourceKey = "electricity";
// The actual uploaded File object, kept around so the tariff/multiplier/
// settings controls can re-run /api/analyze against the SAME data without
// re-reading <input type=file> — the browser clears that input's FileList
// once used, so a second read is impossible; re-sending the stored File
// object works because a File is just an immutable Blob reference.
let uploadedFile = null;

const RESOURCE_ORDER = ["electricity", "water", "heat"];
const RESOURCE_LOSS_LABEL = {
  electricity: "Потери энергии",
  water: "Потери воды",
  heat: "Потери тепла",
};
const RESOURCE_ICON = {
  electricity: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M13 2 3 14h7l-1 8 11-14h-7l0-6Z"/></svg>',
  water: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C8 8 5 11.5 5 15a7 7 0 0 0 14 0c0-3.5-3-7-7-13Z"/></svg>',
  heat: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2c-1 3-4 4-4 8a4 4 0 0 0 8 0c0-1-.5-2-1-2 .3 2-.7 3-1.5 3-1.2 0-2-1-1.5-2.5C13 7 12.5 4.5 12 2Zm-3 14a3 3 0 0 0 6 0c0-1.2-.7-2-1.5-2.6.2 1.3-.5 2.1-1.5 2.1s-1.7-.8-1.5-2.1c-.8.6-1.5 1.4-1.5 2.6Z"/></svg>',
};

function render(data) {
  $("source-name").textContent =
    data.source === "sample_data.csv" || data.source === "sample_data_multi.csv"
      ? "образец данных за месяц"
      : data.source;

  lastAnalysis = data;
  renderWeatherBadge(data);
  renderCauseSummary(data);
  renderFloorPlan(data);
  renderTopPriority(data);
  renderNormComparison(data);
  renderEfficiencyGrade(data);
  renderForecast(data);
  renderSimulator();
  buildResourceSwitcher(data);
  const keys = Object.keys(data.resources || {});
  renderResourceView(keys.includes("electricity") ? "electricity" : keys[0]);
  renderPeriodCompare(data);
  startLiveCounter(data);

  $("results").classList.remove("hidden");
  resetCopilot();
  updateListenButton(data);
  showTab("overview");
}

/* ---------- Floor-plan zone highlight — reuses cause_summary, no new logic ---------- */
// Each zone maps to one of the fixed hypothesis strings core.diagnose_anomaly_day()
// produces (see core.py) — a plain lookup, not a new diagnosis of its own.
const FLOORPLAN_ZONES = [
  { label: "Серверная", x: 16, y: 14, w: 138, h: 92, match: (h) => h.includes("Электрооборудование") },
  { label: "Классы / аудитории", x: 168, y: 14, w: 138, h: 92, match: (h) => h.includes("HVAC") },
  { label: "Столовая, сан.узлы", x: 320, y: 14, w: 138, h: 92, match: (h) => h.includes("Утечка воды") },
  { label: "Охрана и освещение", x: 472, y: 14, w: 138, h: 92, match: (h) => h.includes("Освещение") },
  { label: "Котельная / отопление", x: 168, y: 158, w: 290, h: 66, match: (h) => h.includes("Отопление осталось") },
];

function renderFloorPlan(data) {
  const box = $("floorplan-card");
  const entries = data.cause_summary || [];
  if (!entries.length) {
    box.classList.add("hidden");
    return;
  }

  const hits = FLOORPLAN_ZONES.map((zone) => ({
    zone,
    hit: entries.find((e) => zone.match(e.hypothesis)),
  }));

  const W2 = 626, H2 = 240;
  let svg = `<svg viewBox="0 0 ${W2} ${H2}" role="img" aria-label="Схема здания с подсветкой вероятных причин потерь">`;
  svg += `<rect x="0" y="118" width="${W2}" height="24" fill="${INK.surface}" stroke="${INK.border}"/>`;
  svg += `<text x="${W2 / 2}" y="134" text-anchor="middle" fill="${INK.muted}" font-size="11">коридор</text>`;

  hits.forEach(({ zone, hit }) => {
    const share = hit ? hit.share_pct : 0;
    const opacity = hit ? Math.min(0.55, 0.18 + share / 150) : 0;
    const fill = hit ? COLORS.anomaly : INK.surface;
    svg +=
      `<rect x="${zone.x}" y="${zone.y}" width="${zone.w}" height="${zone.h}" rx="6" ` +
      `fill="${fill}" fill-opacity="${hit ? opacity : 1}" stroke="${hit ? COLORS.anomaly : INK.border}" stroke-width="${hit ? 2 : 1}"/>`;
    svg += `<text x="${zone.x + zone.w / 2}" y="${zone.y + zone.h / 2 - 4}" text-anchor="middle" fill="${hit ? INK.text : INK.muted}" font-size="12" font-weight="${hit ? 700 : 400}">${zone.label}</text>`;
    if (hit) {
      svg += `<text x="${zone.x + zone.w / 2}" y="${zone.y + zone.h / 2 + 14}" text-anchor="middle" fill="${INK.text}" font-size="11">${hit.days} дн. (${fmt(hit.share_pct, 0)}%)</text>`;
    }
  });
  svg += `</svg>`;
  $("floorplan-svg").innerHTML = svg;

  const matched = hits.filter((h) => h.hit);
  $("floorplan-legend").textContent = matched.length
    ? `Подсвечено по факту диагностированных причин: ${matched.map((h) => `${h.zone.label} — ${h.hit.hypothesis.split(" — ")[0].split(" (")[0]}`).join("; ")}.`
    : "Ни одна зона не сопоставлена с диагностированными причинами в этом наборе данных.";
  box.classList.remove("hidden");
}

/* ---------- "Если только одно действие" — top priority, from cause_summary ---------- */
// Short action phrases keyed by substring of the fixed hypothesis strings
// core.diagnose_anomaly_day() produces — a lookup table, not new logic.
function actionForHypothesis(h) {
  if (h.includes("HVAC")) return "Проверьте расписание отопления и вентиляции на отмеченные нерабочие дни — переключите его в энергосберегающий режим.";
  if (h.includes("Освещение")) return "Проверьте таймеры освещения и розеточной нагрузки — обновите их под нерабочий график.";
  if (h.includes("Электрооборудование")) return "Обойдите здание в ближайший нерабочий день и проверьте, какое оборудование осталось включённым.";
  if (h.includes("Утечка")) return "Вызовите сантехника — проверьте краны, трубы и санузлы на утечку.";
  if (h.includes("Отопление осталось")) return "Проверьте котельную / тепловой узел отдельно от электросистем здания.";
  return "Проверьте отмеченные дни и системы вручную.";
}

// Ranks hypotheses by the tenge they were actually responsible for (summed
// over every resource's excess on each diagnosed date), not just day count —
// a plain aggregation of numbers /api/analyze already computed, no new math.
function computeTopPriorityAction(data) {
  const diag = data.cause_diagnosis || {};
  const dates = Object.keys(diag);
  if (!dates.length) return null;

  const kztByDate = {};
  for (const r of Object.values(data.resources || {})) {
    for (const d of r.series) {
      if (d.is_anomaly && d.excess > 0) {
        kztByDate[d.date] = (kztByDate[d.date] || 0) + d.excess * r.tariff_kzt_per_unit;
      }
    }
  }

  const byHypothesis = {};
  for (const date of dates) {
    const h = diag[date].hypothesis;
    byHypothesis[h] = (byHypothesis[h] || 0) + (kztByDate[date] || 0);
  }
  const totalKzt = Object.values(byHypothesis).reduce((a, b) => a + b, 0);
  const ranked = Object.entries(byHypothesis).sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return null;
  const [hypothesis, kzt] = ranked[0];
  return {
    hypothesis,
    kzt,
    sharePct: totalKzt > 0 ? (kzt / totalKzt) * 100 : 0,
    days: dates.filter((d) => diag[d].hypothesis === hypothesis).length,
  };
}

function renderTopPriority(data) {
  const box = $("top-priority-card");
  const top = computeTopPriorityAction(data);
  if (!top) {
    box.classList.add("hidden");
    return;
  }
  $("top-priority-body").innerHTML =
    `<p style="font-size:16px; margin-bottom:6px">${actionForHypothesis(top.hypothesis)}</p>` +
    `<p class="muted">Причина «${top.hypothesis.split(" — ")[0]}» отвечает за <strong>${fmt(top.sharePct, 0)}%</strong> ` +
    `посчитанного перерасхода (~${fmt(top.kzt)} тенге, ${top.days} дн.) — это единственное действие с наибольшей отдачей, если время ограничено.</p>`;
  box.classList.remove("hidden");
}

/* ---------- Audio checklist (Web Speech API) ---------- */
function buildChecklistText(data) {
  const entries = data.cause_summary || [];
  if (!entries.length) return "";
  const zoneFor = (h) => (FLOORPLAN_ZONES.find((z) => z.match(h)) || {}).label;
  const items = entries
    .slice(0, 5)
    .map((e, i) => {
      const zone = zoneFor(e.hypothesis);
      const place = zone ? `в зоне «${zone}»` : "";
      return `Пункт ${i + 1}. ${actionForHypothesis(e.hypothesis)} ${place}. Затронуто ${e.days} дн., это ${Math.round(e.share_pct)} процентов случаев.`;
    });
  return `Чек-лист обхода здания. Всего пунктов: ${items.length}. ` + items.join(" ");
}

function updateListenButton(data) {
  const btn = $("listen-btn");
  if (!window.speechSynthesis || !buildChecklistText(data)) {
    btn.classList.add("hidden");
    return;
  }
  btn.classList.remove("hidden");
  btn.dataset.speaking = "false";
}

$("listen-btn").addEventListener("click", () => {
  if (!window.speechSynthesis || !lastAnalysis) return;
  const btn = $("listen-btn");
  if (btn.dataset.speaking === "true") {
    speechSynthesis.cancel();
    btn.dataset.speaking = "false";
    btn.textContent = "🔊 Прослушать чек-лист";
    return;
  }
  const text = buildChecklistText(lastAnalysis);
  if (!text) return;
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = "ru-RU";
  utter.rate = 0.98;
  utter.onend = () => {
    btn.dataset.speaking = "false";
    btn.textContent = "🔊 Прослушать чек-лист";
  };
  speechSynthesis.cancel();
  speechSynthesis.speak(utter);
  btn.dataset.speaking = "true";
  btn.textContent = "⏹ Остановить";
});

/* ---------- Short executive justification ---------- */
$("exec-summary-btn").addEventListener("click", async () => {
  if (!lastAnalysis) return;
  $("exec-summary-box").classList.add("hidden");
  $("exec-summary-copy").classList.add("hidden");
  $("exec-summary-loading").classList.remove("hidden");
  try {
    const res = await apiPost("/api/insight?brief=true", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: lastAnalysis.source,
        summary: lastAnalysis.summary,
        anomalies: lastAnalysis.series.filter((d) => d.is_anomaly),
      }),
      signal: reqTimeout(150000),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data) throw new Error(data?.detail || `Ошибка запроса (${res.status})`);
    $("exec-summary-box").textContent = data.insight;
    $("exec-summary-box").classList.remove("hidden");
    $("exec-summary-copy").classList.remove("hidden");
  } catch (err) {
    showStatus(`Не удалось сформировать текст — ${err.message}`, true);
    setTimeout(hideStatus, 6000);
  } finally {
    $("exec-summary-loading").classList.add("hidden");
  }
});

$("exec-summary-copy").addEventListener("click", async () => {
  const text = $("exec-summary-box").textContent;
  try {
    await navigator.clipboard.writeText(text);
    showStatus("Текст скопирован в буфер обмена.");
    setTimeout(hideStatus, 3000);
  } catch {
    showStatus("Не удалось скопировать автоматически — выделите текст вручную.", true);
    setTimeout(hideStatus, 5000);
  }
});

function renderNormComparison(data) {
  const box = $("norm-comparison-card");
  const n = data.norm_comparison;
  if (!n) {
    box.classList.add("hidden");
    return;
  }
  const over = n.over_norm_pct;
  const verdict = over > 0 ? `на <strong>${fmt(Math.abs(over), 1)}%</strong> выше норматива` : `на <strong>${fmt(Math.abs(over), 1)}%</strong> ниже норматива`;
  $("norm-comparison-body").innerHTML =
    `<p class="norm-line">Факт: <strong>${fmt(n.actual_avg_kwh_per_day, 1)}</strong> кВт·ч/день</p>` +
    `<p class="norm-line">Норматив: <strong>${fmt(n.official_norm_kwh_per_day, 1)}</strong> кВт·ч/день <span class="tag missing">введено вручную</span></p>` +
    `<p class="muted">Фактическое потребление ${verdict}. Независимая проверка вторым методом — не статистикой по этому же зданию, а внешним нормативом.</p>`;
  box.classList.remove("hidden");
}

const GRADE_HINT = {
  A: "заметно лучше среднего по РК", B: "лучше среднего", C: "около среднего по РК",
  D: "хуже среднего", E: "заметно хуже среднего", F: "существенно выше среднего по РК",
};

function renderEfficiencyGrade(data) {
  const box = $("efficiency-grade-card");
  const g = data.efficiency_grade;
  if (!g) {
    box.classList.add("hidden");
    return;
  }
  $("efficiency-grade-body").innerHTML =
    `<div class="grade-row">` +
    `<span class="grade-badge ${g.grade}">${g.grade}</span>` +
    `<div><div class="grade-line"><strong>${fmt(g.intensity_kwh_per_m2_year, 1)}</strong> кВт·ч/м²/год</div>` +
    `<div class="muted">${GRADE_HINT[g.grade] || ""} · среднее по РК ${fmt(g.kz_average_kwh_per_m2_year, 0)} кВт·ч/м²/год (${g.ratio_to_average}×)</div></div>` +
    `</div>`;
  box.classList.remove("hidden");
}

/* ---------- Period-over-period (was/now), localStorage-backed ---------- */
// One slot, not keyed by filename: "second upload" is the trigger, whatever
// it's called — a school re-exporting the same report.csv every month and
// someone comparing two differently-named files should both just work.
const PERIOD_STORAGE_KEY = "ecobiz_last_period";

// A cheap fingerprint of "same underlying dataset" (row count + date span) —
// re-running the same file with a different tariff/multiplier must not look
// like a new period to compare against.
function periodFingerprint(data) {
  const s = data.series;
  return `${s.length}|${s[0]?.date}|${s[s.length - 1]?.date}`;
}

function snapshotOf(data) {
  const s = data.summary;
  const series = data.series;
  return {
    total_excess_kwh: s.total_excess_kwh,
    savings_kzt: s.savings_kzt,
    anomaly_days: s.anomaly_days,
    first: series[0]?.date,
    last: series[series.length - 1]?.date,
  };
}

function renderPeriodCompareBody(prevSnap, data) {
  const s = data.summary;
  const series = data.series;
  const dExcess = s.total_excess_kwh - prevSnap.total_excess_kwh;
  const better = dExcess <= 0;
  $("period-compare-body").innerHTML =
    `<p class="period-row">Прошлый раз (${prevSnap.first} — ${prevSnap.last}): <strong>${fmt(prevSnap.total_excess_kwh, 1)}</strong> кВт·ч перерасхода · <strong>${fmt(prevSnap.savings_kzt)}</strong> тенге.</p>` +
    `<p class="period-row">Сейчас (${series[0]?.date} — ${series[series.length - 1]?.date}): <strong>${fmt(s.total_excess_kwh, 1)}</strong> кВт·ч · <strong>${fmt(s.savings_kzt)}</strong> тенге.</p>` +
    `<p class="period-row">Изменение: <span class="period-delta ${better ? "better" : "worse"}">${better ? "▼" : "▲"} ${fmt(Math.abs(dExcess), 1)} кВт·ч — ${better ? "лучше, чем в прошлый раз" : "хуже, чем в прошлый раз"}</span></p>`;
}

function renderPeriodCompare(data) {
  const box = $("period-compare");
  const fp = periodFingerprint(data);
  let prev = null;
  try {
    prev = JSON.parse(localStorage.getItem(PERIOD_STORAGE_KEY) || "null");
  } catch {
    prev = null;
  }

  if (prev && prev.fingerprint === fp) {
    // Same dataset re-rendered under a different tariff/multiplier — keep
    // showing whatever comparison already existed, don't treat this as a
    // second upload of the same file.
    if (prev.comparedAgainst) {
      renderPeriodCompareBody(prev.comparedAgainst, data);
      box.classList.remove("hidden");
    } else {
      box.classList.add("hidden");
    }
    return;
  }

  const nextRecord = { fingerprint: fp, snapshot: snapshotOf(data) };
  if (prev) {
    renderPeriodCompareBody(prev.snapshot, data);
    box.classList.remove("hidden");
    nextRecord.comparedAgainst = prev.snapshot;
  } else {
    box.classList.add("hidden");
  }
  try {
    localStorage.setItem(PERIOD_STORAGE_KEY, JSON.stringify(nextRecord));
  } catch {
    // Private-browsing / storage-full — comparison just won't persist, not fatal.
  }
}

/* ---------- Live real-time loss counter ---------- */
let liveCounterHandle = null;

function startLiveCounter(data) {
  if (liveCounterHandle) {
    clearInterval(liveCounterHandle);
    liveCounterHandle = null;
  }
  const s = data.summary;
  if (!s.anomaly_days || s.savings_kzt <= 0 || !s.days_analyzed) {
    $("live-counter-card").classList.add("hidden");
    return;
  }
  // Honest rate, not a live meter reading: total losses already computed for
  // the period, spread evenly over the period's own length in seconds.
  const periodSeconds = s.days_analyzed * 86400;
  const ratePerSecond = s.savings_kzt / periodSeconds;
  $("live-counter-card").classList.remove("hidden");
  const start = performance.now();
  const tick = () => {
    const elapsed = (performance.now() - start) / 1000;
    $("live-counter-value").textContent = fmt(ratePerSecond * elapsed, 2);
  };
  tick();
  liveCounterHandle = setInterval(tick, 200);
}

function renderCauseSummary(data) {
  const box = $("cause-summary");
  const entries = data.cause_summary || [];
  if (!entries.length) {
    box.classList.add("hidden");
    return;
  }
  $("cause-summary-body").innerHTML = entries
    .map(
      (e) =>
        `<div class="cause-row">` +
        `<span class="cause-name">${e.hypothesis}</span>` +
        `<span class="cause-days">${e.days} дн. (${fmt(e.share_pct, 0)}%)</span>` +
        `<span class="cause-bar-wrap"><span class="cause-bar" style="width:${e.share_pct}%"></span></span>` +
        `</div>`,
    )
    .join("");
  box.classList.remove("hidden");
}

// Reuses the exact same savings_kzt × 3 / × 12 projection already shown on
// the Overview KPIs — this tab just gives it more room, not a new model.
function renderForecast(data) {
  const s = data.summary;
  const base = s.savings_kzt;

  const cards = [
    { label: "Текущий период", cls: "green", value: base, note: `${s.days_analyzed} дн. проанализировано` },
    { label: "Прогноз за 3 месяца", cls: "teal", value: base * 3, note: "проекция, не гарантированный результат" },
    { label: "Прогноз за год", cls: "purple", value: base * 12, note: "проекция, не гарантированный результат" },
  ];
  $("forecast-kpis").innerHTML = cards
    .map(
      (c) =>
        `<article class="kpi ${c.cls}">` +
        `<span class="kpi-label">${c.label}</span>` +
        `<span class="kpi-value">${fmt(c.value)}</span>` +
        `<span class="kpi-unit">тенге</span>` +
        `<span class="kpi-note">${c.note}</span>` +
        `</article>`,
    )
    .join("");

  const months = Array.from({ length: 12 }, (_, i) => base * (i + 1));
  const max = months[months.length - 1] || 1;
  $("forecast-bars").innerHTML = months
    .map((v, i) => {
      const h = Math.max(4, (v / max) * 100);
      const milestone = i === 2 || i === 11;
      return (
        `<div class="fbar-col${milestone ? " milestone" : ""}">` +
        `<span class="fbar-val">${milestone ? fmt(v) : ""}</span>` +
        `<div class="fbar" style="height:${h}%"></div>` +
        `<span class="fbar-label">${i + 1}</span>` +
        `</div>`
      );
    })
    .join("");
}

// Honesty rule (matches the rest of the app): only "fixed" is grounded in
// measured data — it directly scales the already-detected excess/savings.
// "sensors" is an explicit what-if assumption (labeled "оценка" in the
// markup), applied to whatever the fixed-% lever left unaddressed, so the
// two levers can never claim more than 100% of the detected waste. Pure
// client-side arithmetic on lastAnalysis — no network call, no new model.
function simulatorScenario() {
  if (!lastAnalysis) return null;
  const s = lastAnalysis.summary;
  const fixedPct = Number($("sim-fixed").value);
  const sensorsPct = Number($("sim-sensors").value);
  const remainingAfterFixed = 100 - fixedPct;
  const totalAddressedPct = Math.min(100, fixedPct + (remainingAfterFixed * sensorsPct) / 100);

  const tariff = Number($("tariff").value) || s.tariff_kzt_per_kwh;
  const beforeExcessKwh = s.total_excess_kwh;
  const afterExcessKwh = beforeExcessKwh * (1 - totalAddressedPct / 100);
  const savedKwh = beforeExcessKwh - afterExcessKwh;
  const savedKzt = savedKwh * tariff;

  return { fixedPct, sensorsPct, totalAddressedPct, beforeExcessKwh, afterExcessKwh, savedKwh, savedKzt };
}

function recomputeSimulator() {
  const scenario = simulatorScenario();
  $("sim-fixed-value").textContent = `${$("sim-fixed").value}%`;
  $("sim-sensors-value").textContent = `${$("sim-sensors").value}%`;
  if (!scenario) return;

  $("sim-result-pct").textContent = `${fmt(scenario.totalAddressedPct, 0)}%`;
  $("sim-result-kzt").textContent = `${fmt(scenario.savedKzt)} тенге`;

  const maxKwh = scenario.beforeExcessKwh || 1;
  $("sim-bar-before").style.width = "100%";
  $("sim-bar-after").style.width = `${Math.max(2, (scenario.afterExcessKwh / maxKwh) * 100)}%`;
  $("sim-before-val").textContent = `${fmt(scenario.beforeExcessKwh, 1)} кВт·ч`;
  $("sim-after-val").textContent = `${fmt(scenario.afterExcessKwh, 1)} кВт·ч`;
}

function renderSimulator() {
  const card = $("simulator-card");
  if (!lastAnalysis || lastAnalysis.summary.total_excess_kwh <= 0) {
    card.classList.add("hidden");
    return;
  }
  card.classList.remove("hidden");
  recomputeSimulator();
}

function renderWeatherBadge(data) {
  const el = $("weather-badge");
  if (data.weather_adjusted) {
    el.className = "weather-badge";
    el.innerHTML =
      '<span class="icon">🌡️</span> Учтена погода: часть расхода в мороз — легитимный обогрев, не потеря.';
  } else {
    el.className = "weather-badge inactive";
    el.innerHTML =
      '<span class="icon">🌡️</span> Погодная поправка недоступна для этого набора данных — используется обычный базовый уровень.';
  }
  el.classList.remove("hidden");
}

function buildResourceSwitcher(data) {
  const keys = Object.keys(data.resources || {});
  const wrap = $("resource-switcher");
  if (keys.length <= 1) {
    wrap.classList.add("hidden");
    wrap.innerHTML = "";
    return;
  }
  const ordered = RESOURCE_ORDER.filter((k) => keys.includes(k));
  wrap.innerHTML = ordered
    .map(
      (k, i) =>
        `<button class="seg-btn${i === 0 ? " active" : ""}" data-resource="${k}" type="button">${RESOURCE_ICON[k] || ""}${data.resources[k].label}</button>`,
    )
    .join("");
  wrap.classList.remove("hidden");
  wrap.querySelectorAll(".seg-btn").forEach((btn) =>
    btn.addEventListener("click", () => {
      wrap.querySelectorAll(".seg-btn").forEach((b) => b.classList.toggle("active", b === btn));
      renderResourceView(btn.dataset.resource);
    }),
  );
}

function setKpiUnit(id, text) {
  $(id).closest(".kpi").querySelector(".kpi-unit").textContent = text;
}

function updateTableHeaders(r) {
  const heads = document.querySelectorAll("#anomaly-table thead th");
  heads[1].textContent = `Потребление, ${r.unit}`;
  heads[2].textContent = `Превышение, ${r.unit}`;
  heads[4].textContent = r.co2_saved_kg != null ? "CO₂" : `${r.unit} эконом.`;
}

function renderResourceView(key) {
  const data = lastAnalysis;
  const r = data && data.resources && data.resources[key];
  if (!r) return;
  currentResourceKey = key;

  $("baseline-chip").textContent = `${fmt(r.baseline, 1)} ${r.unit}`;
  $("days-analyzed").textContent = `из ${r.days_analyzed} дней проанализировано`;
  $("multiplier-chip").textContent = fmt(r.multiplier, 1);
  $("multiplier-value").textContent = fmt(r.multiplier, 1);
  $("multiplier-slider").value = r.multiplier;
  currentMultiplier = r.multiplier;

  $("kpi-excess").textContent = fmt(r.total_excess, 1);
  $("kpi-excess").closest(".kpi").querySelector(".kpi-label").textContent =
    RESOURCE_LOSS_LABEL[key] || "Потери";
  setKpiUnit("kpi-excess", `${r.unit} сверх базового уровня`);

  $("kpi-kzt").textContent = fmt(r.savings_kzt);
  const rangeEl = $("kpi-kzt-range");
  if (r.savings_kzt_p10 != null && r.savings_kzt_p90 != null) {
    rangeEl.textContent = `P10—P90: ${fmt(r.savings_kzt_p10)}–${fmt(r.savings_kzt_p90)} тенге (бутстрэп, 500 итераций)`;
    rangeEl.classList.remove("hidden");
  } else {
    rangeEl.classList.add("hidden");
  }
  $("kpi-days").textContent = r.anomaly_days;
  $("kpi-quarterly").textContent = fmt(r.savings_kzt * 3);
  $("kpi-yearly").textContent = fmt(r.savings_kzt * 12);

  const co2Kpi = $("kpi-co2").closest(".kpi");
  if (r.co2_saved_kg != null) {
    $("kpi-co2").textContent = fmt(r.co2_saved_kg, 1);
    co2Kpi.querySelector(".kpi-label").textContent = "Экономия CO₂";
    co2Kpi.querySelector(".kpi-unit").textContent = "кг выбросов";
  } else {
    $("kpi-co2").textContent = fmt(r.total_excess, 1);
    co2Kpi.querySelector(".kpi-label").textContent = `${r.unit} сэкономлено`;
    co2Kpi.querySelector(".kpi-unit").textContent = "вместо перерасхода в нерабочие дни";
  }

  renderInsight({
    summary: { anomaly_days: r.anomaly_days, savings_kzt: r.savings_kzt },
    worst_day: r.worst_day,
    first_anomaly: r.first_anomaly,
    last_anomaly: r.last_anomaly,
  });

  const causeDiagnosis = data.cause_diagnosis || {};
  const adaptedSeries = r.series.map((d) => ({
    date: d.date,
    consumption_kwh: d.value,
    excess_kwh: d.excess,
    is_workday: d.is_workday,
    is_anomaly: d.is_anomaly,
    pattern: d.pattern,
    diagnosis: causeDiagnosis[d.date] || null,
  }));

  updateTableHeaders(r);
  renderChart(adaptedSeries, r.baseline * r.multiplier);
  renderTable(adaptedSeries, {
    unit: r.unit,
    tariff_per_unit: r.tariff_kzt_per_unit,
    co2_per_unit:
      r.co2_saved_kg != null ? (r.total_excess > 0 ? r.co2_saved_kg / r.total_excess : 0) : null,
  });
}

const PATTERN_CLASS = { устойчивая: "persistent", периодическая: "periodic", разовая: "oneoff" };

function renderInsight({ summary, worst_day, first_anomaly, last_anomaly }) {
  const box = $("insight");
  if (!worst_day) {
    box.textContent =
      "Хорошие новости: в каждый нерабочий день потребление оставалось близко к базовому уровню — потерь не обнаружено.";
    box.classList.remove("hidden");
    return;
  }
  const span =
    first_anomaly === last_anomaly
      ? `<strong>${shortDate(first_anomaly)}</strong>`
      : `в период с <strong>${shortDate(first_anomaly)} по ${shortDate(last_anomaly)}</strong>`;
  box.innerHTML =
    `⚠ Здание потребляло энергию так, будто было занято людьми, в <strong>${summary.anomaly_days}</strong> нерабочий(их) день(дней) ${span}. ` +
    `Самый затратный день: <strong>${shortDate(worst_day)}</strong> — за весь период это обошлось примерно в ` +
    `<strong>${fmt(summary.savings_kzt)} тенге</strong>. Проверьте таймеры отопления и освещения.`;
  box.classList.remove("hidden");
}

function renderTable(series, s) {
  const rows = series.filter((d) => d.is_anomaly);
  const tbody = $("anomaly-table").querySelector("tbody");
  tbody.innerHTML = "";
  $("no-anomalies").classList.toggle("hidden", rows.length > 0);
  const unit = s.unit || "кВт·ч";

  for (const d of [...rows].sort((a, b) => b.excess_kwh - a.excess_kwh)) {
    const co2Cell =
      s.co2_per_unit != null
        ? `${fmt(d.excess_kwh * s.co2_per_unit, 1)} кг`
        : `${fmt(d.excess_kwh, 1)} ${unit}`;
    const patternCell = d.pattern
      ? `<span class="pattern-chip ${PATTERN_CLASS[d.pattern] || ""}">${d.pattern}</span>`
      : "—";
    const reasonCell = d.diagnosis
      ? `${d.diagnosis.hypothesis} <span class="confidence">(${d.diagnosis.confirming_signals}/${d.diagnosis.available_signals}, ${d.diagnosis.confidence_label})</span>`
      : "—";
    tbody.insertAdjacentHTML(
      "beforeend",
      `<tr>
        <td>${d.date}</td>
        <td class="num">${fmt(d.consumption_kwh, 1)} ${unit}</td>
        <td class="num excess">+${fmt(d.excess_kwh, 1)} ${unit}</td>
        <td class="num">${fmt(d.excess_kwh * s.tariff_per_unit)} тенге</td>
        <td class="num">${co2Cell}</td>
        <td>${patternCell}</td>
        <td class="reason-cell">${reasonCell}</td>
      </tr>`,
    );
  }
}

/* ---------- Charts: SVG with TradingView-style mouse analysis ----------
   wheel = zoom at cursor · drag = pan · shift+drag = select range · dbl-click = reset */

const W = 1000;
const H = 380;
const MARGIN = { top: 24, right: 22, bottom: 46, left: 64 };
// SVG presentation attributes don't reliably resolve var() across browsers,
// so chart colors are read live from the CSS custom properties in
// styles.css instead of being hardcoded — refreshThemeColors() mutates
// these two objects in place every time the active theme could have
// changed, so every drawing helper below just reads COLORS.x / INK.x as
// plain values without needing to know about theming at all.
const COLORS = { workday: "", offday: "", anomaly: "" };
const INK = { text: "", muted: "", grid: "", amber: "", surface: "", border: "" };

function themeColor(varName) {
  return getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
}

function refreshThemeColors() {
  COLORS.workday = themeColor("--blue");
  COLORS.offday = themeColor("--chart-offday");
  COLORS.anomaly = themeColor("--red");
  INK.text = themeColor("--text");
  INK.muted = themeColor("--muted");
  INK.grid = themeColor("--border");
  INK.amber = themeColor("--amber");
  INK.surface = themeColor("--surface");
  INK.border = themeColor("--border-strong");
}
refreshThemeColors();

const MIN_SPAN = 4;

const chartState = {
  series: [], threshold: 0, view: "bar",
  i0: 0, i1: null,
  anim: true,
};

function niceCeil(v) {
  const pow = 10 ** Math.floor(Math.log10(v));
  const d = v / pow;
  const m = d <= 1 ? 1 : d <= 2 ? 2 : d <= 2.5 ? 2.5 : d <= 5 ? 5 : 10;
  return m * pow;
}

function defsGradients() {
  return `<defs>${Object.entries(COLORS)
    .map(([name, hex]) =>
      `<linearGradient id="g-${name}" x1="0" y1="0" x2="0" y2="1">` +
      `<stop offset="0%" stop-color="${hex}" stop-opacity="0.95"/>` +
      `<stop offset="100%" stop-color="${hex}" stop-opacity="0.45"/></linearGradient>`)
    .join("")}<linearGradient id="g-area" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0%" stop-color="${COLORS.workday}" stop-opacity="0.28"/>` +
    `<stop offset="100%" stop-color="${COLORS.workday}" stop-opacity="0"/></linearGradient></defs>`;
}

function makeY(maxV) {
  const innerH = H - MARGIN.top - MARGIN.bottom;
  const maxKwh = niceCeil(maxV * 1.06);
  const yScale = (v) => MARGIN.top + innerH - (v / maxKwh) * innerH;
  const invert = (py) => ((MARGIN.top + innerH - py) / innerH) * maxKwh;
  let grid = "";
  for (let t = 0; t <= 4; t++) {
    const v = (maxKwh * t) / 4;
    const yy = yScale(v).toFixed(1);
    grid += `<line x1="${MARGIN.left}" y1="${yy}" x2="${W - MARGIN.right}" y2="${yy}" stroke="${INK.grid}"/>` +
      `<text x="${MARGIN.left - 10}" y="${+yy + 4}" fill="${INK.muted}" font-size="11" text-anchor="end">${fmt(v)}</text>`;
  }
  grid += `<text x="12" y="${MARGIN.top - 6}" fill="${INK.muted}" font-size="11">кВт·ч</text>`;
  return { maxKwh, yScale, invert, grid, innerH };
}

function refLines(y, mean, showMean) {
  const tv = chartState.threshold;
  let out =
    `<line x1="${MARGIN.left}" y1="${y.yScale(tv).toFixed(1)}" x2="${W - MARGIN.right}" y2="${y.yScale(tv).toFixed(1)}" stroke="${INK.amber}" stroke-width="2" stroke-dasharray="7 5"/>` +
    `<text x="${W - MARGIN.right}" y="${(y.yScale(tv) - 7).toFixed(1)}" fill="${INK.amber}" font-size="11" text-anchor="end">порог ${fmt(tv, 1)}</text>`;
  if (showMean && mean > 0) {
    out += `<line x1="${MARGIN.left}" y1="${y.yScale(mean).toFixed(1)}" x2="${W - MARGIN.right}" y2="${y.yScale(mean).toFixed(1)}" stroke="${INK.muted}" stroke-width="1" stroke-dasharray="2 5"/>` +
      `<text x="${MARGIN.left + 4}" y="${(y.yScale(mean) - 6).toFixed(1)}" fill="${INK.muted}" font-size="10.5">ср. ${fmt(mean, 1)}</text>`;
  }
  return out;
}

const dayColor = (d) =>
  d.is_anomaly ? COLORS.anomaly : d.is_workday ? COLORS.workday : COLORS.offday;

function weeklyItems(series) {
  const map = new Map();
  for (const d of series) {
    const dt = new Date(`${d.date}T00:00:00`);
    const mon = new Date(dt);
    mon.setDate(dt.getDate() - ((dt.getDay() + 6) % 7));
    const key = `${mon.getFullYear()}-${String(mon.getMonth() + 1).padStart(2, "0")}-${String(mon.getDate()).padStart(2, "0")}`;
    if (!map.has(key)) map.set(key, { work: 0, base: 0, waste: 0, days: 0 });
    const w = map.get(key);
    if (d.is_workday) w.work += d.consumption_kwh;
    else { w.waste += d.excess_kwh; w.base += d.consumption_kwh - d.excess_kwh; }
    w.days++;
  }
  return [...map.entries()].map(([key, w]) => ({
    label: `нед. ${shortDate(key)}`,
    total: w.work + w.base + w.waste,
    days: w.days,
    segs: [
      { name: "Рабочие дни", v: w.work, color: COLORS.workday },
      { name: "Нерабочие (норма)", v: w.base, color: COLORS.offday },
      { name: "Потери", v: w.waste, color: COLORS.anomaly },
    ],
  }));
}

function cumulativeItems(series) {
  let t = 0, waste = 0;
  return series.map((d) => {
    t += d.consumption_kwh;
    waste += d.excess_kwh;
    return { label: shortDate(d.date), total: t, waste };
  });
}

/* ----- SVG builders (one per view) ----- */
function xLabelsFor(items, xCenter, labels) {
  const n = items.length;
  const step = Math.max(1, Math.ceil(n / 12));
  let out = "";
  items.forEach((_, i) => {
    if (i % step) return;
    const lx = xCenter(i).toFixed(1);
    out += `<text x="${lx}" y="${H - 12}" fill="${INK.muted}" font-size="11" text-anchor="middle" transform="rotate(-40 ${lx} ${H - 12})">${labels[i]}</text>`;
  });
  return out;
}

function drawBarsSvg(items, y) {
  const n = items.length;
  const slot = (W - MARGIN.left - MARGIN.right) / n;
  const barW = Math.min(40, Math.max(3, slot * 0.72));
  const xCenter = (i) => MARGIN.left + i * slot + slot / 2;
  let svg = "";
  const step = Math.max(1, Math.ceil(n / 12));
  items.forEach((d, i) => {
    const cx = xCenter(i);
    const yTop = y.yScale(d.kwh);
    const kind = d.excess > 0 ? "anomaly" : d.closed ? "offday" : "workday";
    svg += `<rect class="bar" style="animation-delay:${Math.min(i * 14, 600)}ms" x="${(cx - barW / 2).toFixed(1)}" y="${yTop.toFixed(1)}" width="${barW.toFixed(1)}" height="${(MARGIN.top + y.innerH - yTop).toFixed(1)}" rx="4" fill="url(#g-${kind})"${d.excess > 0 ? ` stroke="${INK.surface}" stroke-width="1"` : ""}/>`;
    if ((chartState.anim || d.excess > 0) && (n <= 21 || d.excess > 0 || i % step === 0)) {
      svg += `<text x="${cx.toFixed(1)}" y="${(yTop - 5).toFixed(1)}" fill="${d.excess > 0 ? COLORS.anomaly : INK.muted}" font-size="${d.excess > 0 ? 11 : 9.5}" font-weight="${d.excess > 0 ? 700 : 400}" text-anchor="middle">${d.excess > 0 ? "+" + fmt(d.excess) : fmt(d.kwh)}</text>`;
    }
  });
  svg += xLabelsFor(items, xCenter, items.map((d) => shortDate(d.label)));
  return { svg, xCenter };
}

function drawLineSvg(items, y) {
  const n = items.length;
  const slot = (W - MARGIN.left - MARGIN.right) / n;
  const xCenter = (i) => MARGIN.left + i * slot + slot / 2;
  const pts = items.map((d, i) => `${xCenter(i).toFixed(1)},${y.yScale(d.kwh).toFixed(1)}`);
  let svg =
    `<path class="fade-in" d="M${pts[0]} L${pts.join(" L")} L${xCenter(n - 1).toFixed(1)},${(MARGIN.top + y.innerH).toFixed(1)} L${MARGIN.left},${(MARGIN.top + y.innerH).toFixed(1)} Z" fill="url(#g-area)"/>` +
    `<polyline points="${pts.join(" ")}" fill="none" stroke="${COLORS.workday}" stroke-width="2.5" stroke-linejoin="round"/>`;
  items.forEach((d, i) => {
    svg += `<circle cx="${xCenter(i).toFixed(1)}" cy="${y.yScale(d.kwh).toFixed(1)}" r="${d.excess > 0 ? 4.5 : 2.6}" fill="${d.color}"${d.excess > 0 ? ` stroke="${INK.surface}" stroke-width="1.2"` : ""}/>`;
  });
  svg += xLabelsFor(items, xCenter, items.map((d) => shortDate(d.label)));
  return { svg, xCenter };
}

function drawWeeklySvg(items, y) {
  const n = items.length;
  const slot = (W - MARGIN.left - MARGIN.right) / n;
  const barW = Math.min(70, Math.max(10, slot * 0.66));
  const xCenter = (i) => MARGIN.left + i * slot + slot / 2;
  let svg = "";
  items.forEach((w, wi) => {
    const cx = xCenter(wi);
    let acc = 0;
    for (const sg of w.segs) {
      const y1 = y.yScale(acc + sg.v);
      acc += sg.v;
      if (sg.v <= 0) continue;
      svg += `<rect class="bar" style="animation-delay:${wi * 60}ms" x="${(cx - barW / 2).toFixed(1)}" y="${y1.toFixed(1)}" width="${barW.toFixed(1)}" height="${(y.yScale(acc) - y1).toFixed(1)}" rx="2" fill="${sg.color}"/>`;
    }
    svg += `<text x="${cx.toFixed(1)}" y="${(y.yScale(acc) - 6).toFixed(1)}" fill="${INK.text}" font-size="10.5" font-weight="600" text-anchor="middle">${fmt(acc)}</text>`;
  });
  svg += xLabelsFor(items, xCenter, items.map((w) => w.label));
  return { svg, xCenter };
}

function drawCumulativeSvg(items, y) {
  const n = items.length;
  const slot = (W - MARGIN.left - MARGIN.right) / n;
  const xCenter = (i) => MARGIN.left + i * slot + slot / 2;
  const pt = (key) => items.map((d, i) => `${xCenter(i).toFixed(1)},${y.yScale(d[key]).toFixed(1)}`).join(" ");
  let svg =
    `<polyline points="${pt("total")}" fill="none" stroke="${COLORS.workday}" stroke-width="2.6" stroke-linejoin="round"/>` +
    `<polyline points="${pt("waste")}" fill="none" stroke="${COLORS.anomaly}" stroke-width="2.2" stroke-dasharray="5 4"/>` +
    `<text x="${MARGIN.left + 6}" y="${MARGIN.top + 2}" fill="${COLORS.workday}" font-size="11">— накопительно, кВт·ч</text>` +
    `<text x="${MARGIN.left + 168}" y="${MARGIN.top + 2}" fill="${COLORS.anomaly}" font-size="11">-- накопительные потери</text>`;
  items.forEach((d, i) => {
    svg += `<circle cx="${xCenter(i).toFixed(1)}" cy="${y.yScale(d.total).toFixed(1)}" r="2.4" fill="${COLORS.workday}"/><circle cx="${xCenter(i).toFixed(1)}" cy="${y.yScale(d.waste).toFixed(1)}" r="2.2" fill="${COLORS.anomaly}"/>`;
  });
  svg += xLabelsFor(items, xCenter, items.map((d) => d.label));
  return { svg, xCenter };
}

/* ----- TradingView-style mouse interaction ----- */
let plot = null;
let drag = null; // shared across redraws so panning survives re-renders
let lastMouseUp = null;

function attachInteraction(svgEl, geom, describe) {
  svgEl.classList.add("plot");
  const NS = "http://www.w3.org/2000/svg";
  const mk = (tag) => document.createElementNS(NS, tag);
  const set = (el, attrs) => { for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); };

  const vLine = mk("line"); set(vLine, { stroke: INK.muted, "stroke-dasharray": "3 3", opacity: 0 });
  const hLine = mk("line"); set(hLine, { stroke: INK.muted, "stroke-dasharray": "3 3", opacity: 0 });
  const selRect = mk("rect"); set(selRect, { fill: "rgba(94,200,255,.12)", stroke: COLORS.workday, "stroke-dasharray": "4 3", opacity: 0 });
  const yG = mk("g"), yR = mk("rect"), yT = mk("text");
  set(yR, { fill: INK.surface, stroke: INK.border, rx: 3 }); set(yT, { fill: INK.text, "font-size": "10.5", "text-anchor": "middle" });
  yG.append(yR, yT); set(yG, { opacity: 0 });
  svgEl.append(selRect, vLine, hLine, yG);

  const info = $("chart-info");
  const toLocal = (ev) => {
    const p = svgEl.createSVGPoint();
    p.x = ev.clientX; p.y = ev.clientY;
    return p.matrixTransform(svgEl.getScreenCTM().inverse());
  };
  const idxAt = (mx) => Math.max(0, Math.min(geom.n - 1, Math.floor((mx - MARGIN.left) / geom.slot)));

  if (lastMouseUp) window.removeEventListener("mouseup", lastMouseUp);
  lastMouseUp = (ev) => {
    if (!drag) return;
    if (drag.mode === "select") {
      const a = idxAt(drag.startX), b = idxAt(toLocal(ev).x);
      set(selRect, { opacity: 0 });
      if (Math.abs(b - a) >= MIN_SPAN - 1) zoomTo(a, b + 1);
      else drawChart();
    } else {
      svgEl.style.cursor = "";
    }
    drag = null;
  };
  window.addEventListener("mouseup", lastMouseUp);

  svgEl.onmousemove = (ev) => {
    if (drag && drag.mode === "select") {
      const { x: mx } = toLocal(ev);
      const x0 = Math.min(drag.startX, mx), x1 = Math.max(drag.startX, mx);
      set(selRect, { x: x0, y: MARGIN.top, width: x1 - x0, height: H - MARGIN.top - MARGIN.bottom, opacity: 1 });
      return;
    }
    const { x: mx, y: my } = toLocal(ev);
    const idx = idxAt(mx);
    const cx = geom.xCenter(idx);
    set(vLine, { x1: cx, x2: cx, y1: MARGIN.top, y2: H - MARGIN.bottom, opacity: drag ? 0 : 1 });
    if (my >= MARGIN.top && my <= H - MARGIN.bottom && !drag) {
      set(hLine, { x1: MARGIN.left, x2: W - MARGIN.right, y1: my, y2: my, opacity: 1 });
      yT.textContent = fmt(Math.max(0, geom.y.invert(my)), 1);
      set(yR, { width: yT.textContent.length * 6.2 + 10, height: 16 });
      set(yG, { transform: `translate(${W - MARGIN.right + 2},${my - 8})`, opacity: 1 });
    } else { set(hLine, { opacity: 0 }); set(yG, { opacity: 0 }); }

    info.innerHTML = describe(idx);
    info.classList.remove("hidden");

    if (drag && drag.mode === "pan") {
      const dSlots = Math.round((drag.mx - mx) / geom.slot);
      if (dSlots !== drag.applied) {
        drag.applied = dSlots;
        panTo(drag.startI0 + dSlots);
      }
    } else if (!drag) {
      drag = null;
    }
  };

  svgEl.onmouseleave = () => {
    if (drag && drag.mode === "select") return;
    set(vLine, { opacity: 0 }); set(hLine, { opacity: 0 });
    set(yG, { opacity: 0 });
    info.classList.add("hidden");
  };

  svgEl.onmousedown = (ev) => {
    const { x: mx } = toLocal(ev);
    if (ev.shiftKey) {
      drag = { mode: "select", startX: mx };
      set(selRect, { x: mx, y: MARGIN.top, width: 0, opacity: 1 });
    } else {
      drag = { mode: "pan", mx, startI0: chartState.i0, applied: 0 };
      svgEl.style.cursor = "grabbing";
    }
    ev.preventDefault();
  };

  svgEl.onwheel = (ev) => {
    ev.preventDefault();
    const { x: mx } = toLocal(ev);
    const n = chartState.series.length;
    const span = chartState.i1 ? chartState.i1 - chartState.i0 : n;
    const anchor = chartState.i0 + (mx - MARGIN.left) / ((W - MARGIN.left - MARGIN.right) / span);
    const factor = ev.deltaY > 0 ? 1.2 : 1 / 1.2;
    let newSpan = Math.round(span * factor);
    newSpan = Math.max(MIN_SPAN, Math.min(n, newSpan));
    const frac = (anchor - chartState.i0) / span;
    let i0 = Math.round(anchor - frac * newSpan);
    i0 = Math.max(0, Math.min(n - newSpan, i0));
    chartState.i0 = i0;
    chartState.i1 = i0 + newSpan;
    $("zoom-reset").classList.remove("hidden");
    drawChart();
  };

  svgEl.ondblclick = resetZoom;
}

function panTo(newI0) {
  const n = chartState.series.length;
  const span = chartState.i1 ? chartState.i1 - chartState.i0 : n;
  newI0 = Math.max(0, Math.min(n - span, newI0));
  chartState.i0 = newI0;
  chartState.i1 = newI0 + span;
  drawChart();
}

function zoomTo(a, b) {
  const lo = Math.max(0, Math.min(a, b));
  const hi = Math.min(chartState.series.length, Math.max(a, b));
  if (hi - lo < MIN_SPAN) return;
  chartState.i0 = lo;
  chartState.i1 = hi;
  $("zoom-reset").classList.remove("hidden");
  drawChart();
}

function resetZoom() {
  chartState.i0 = 0;
  chartState.i1 = null;
  $("zoom-reset").classList.add("hidden");
  drawChart();
}

/* ----- Donut (unchanged math, exact split via backend excess_kwh) ----- */
function donutArc(cx, cy, rO, rI, a0, a1) {
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const p = (r, a) => `${(cx + r * Math.cos(a)).toFixed(2)} ${(cy + r * Math.sin(a)).toFixed(2)}`;
  return `M ${p(rO, a0)} A ${rO} ${rO} 0 ${large} 1 ${p(rO, a1)} L ${p(rI, a1)} A ${rI} ${rI} 0 ${large} 0 ${p(rI, a0)} Z`;
}

function drawDonut(series) {
  let work = 0, base = 0, waste = 0;
  for (const d of series) {
    if (d.is_workday) work += d.consumption_kwh;
    else { waste += d.excess_kwh; base += d.consumption_kwh - d.excess_kwh; }
  }
  const total = work + base + waste;
  if (!total) return;
  const slices = [
    { name: "Потребление в рабочие дни", val: work, color: COLORS.workday },
    { name: "Норма в нерабочие дни", val: base, color: COLORS.offday },
    { name: "Потери энергии", val: waste, color: COLORS.anomaly },
  ].filter((s) => s.val > 0);

  const cx = 175, cy = 172, rO = 120, rI = 76, pad = 0.012;
  let angle = -Math.PI / 2, arcs = "";
  for (const s of slices) {
    const sweep = (s.val / total) * Math.PI * 2;
    arcs += `<path class="slice" d="${donutArc(cx, cy, rO, rI, angle + pad / 2, angle + sweep - pad / 2)}" fill="${s.color}"><title>${s.name}: ${fmt(s.val, 1)} кВт·ч (${((s.val / total) * 100).toFixed(1)}%)</title></path>`;
    angle += sweep;
  }
  const center =
    `<text x="${cx}" y="${cy - 8}" text-anchor="middle" fill="${INK.text}" font-size="24" font-weight="700">${fmt(total)}</text>` +
    `<text x="${cx}" y="${cy + 12}" text-anchor="middle" fill="${INK.muted}" font-size="11">кВт·ч всего · ${series.length} дн.</text>` +
    `<text x="${cx}" y="${cy + 30}" text-anchor="middle" fill="${COLORS.anomaly}" font-size="11.5" font-weight="600">${((waste / total) * 100).toFixed(1)}% — потери</text>`;
  const rows = slices.map((s) =>
    `<div class="row${s.color === COLORS.anomaly ? " waste" : ""}"><span class="swatch" style="background:${s.color}"></span><span class="name">${s.name}</span><span class="val">${fmt(s.val, 1)} кВт·ч</span><span class="pct">${((s.val / total) * 100).toFixed(1)}%</span></div>`).join("");
  $("chart").innerHTML =
    `<div class="donut-wrap fade-in"><svg viewBox="0 0 350 344" style="width:350px" role="img">${arcs}${center}</svg><div class="dlegend">${rows}</div></div>`;
}

/* ----- orchestrator ----- */
function renderChart(series, threshold) {
  Object.assign(chartState, { series, threshold, i0: 0, i1: null, anim: true });
  drawChart();
}

function drawChart() {
  refreshThemeColors();
  const { series, view } = chartState;
  if (!series.length) return;
  if (view === "donut") { drawDonut(series); return; }

  const full =
    view === "weekly" ? weeklyItems(series)
    : view === "cumulative" ? cumulativeItems(series)
    : series.map((d) => ({
        label: d.date,
        kwh: d.consumption_kwh,
        excess: d.excess_kwh,
        closed: !d.is_workday,
        color: dayColor(d),
      }));

  chartState.i0 = Math.max(0, Math.min(chartState.i0, full.length - 1));
  if (!chartState.i1 || chartState.i1 > full.length) chartState.i1 = full.length;
  const items = full.slice(chartState.i0, chartState.i1);
  const n = items.length;
  if (!n) return;
  const slot = (W - MARGIN.left - MARGIN.right) / n;
  const xCenter = (i) => MARGIN.left + i * slot + slot / 2;

  let maxV, mean = 0, builder, describe;
  if (view === "weekly") {
    maxV = Math.max(...items.map((w) => w.total));
    builder = drawWeeklySvg;
    describe = (i) => {
      const w = items[i];
      const segRows = w.segs.filter((s) => s.v > 0)
        .map((s) => `<div class="ci-row"><i class="dot" style="background:${s.color};display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:5px"></i>${s.name}: <b>${fmt(s.v, 1)}</b> кВт·ч</div>`).join("");
      return `<div class="ci-date">${w.label}</div><div class="ci-row">всего <b>${fmt(w.total, 1)} кВт·ч</b> · ${w.days} дн.</div>${segRows}`;
    };
  } else if (view === "cumulative") {
    maxV = Math.max(...items.map((d) => d.total));
    builder = drawCumulativeSvg;
    describe = (i) => {
      const d = items[i];
      return `<div class="ci-date">${d.label}</div><div class="ci-row">всего: <b>${fmt(d.total, 1)} кВт·ч</b></div><div class="ci-warn">потери на этот момент: ${fmt(d.waste, 1)} кВт·ч</div>`;
    };
  } else {
    maxV = Math.max(...items.map((d) => d.kwh), chartState.threshold);
    const kwhs = items.map((d) => d.kwh);
    mean = kwhs.reduce((a, b) => a + b, 0) / n;
    builder = view === "line" ? drawLineSvg : drawBarsSvg;
    describe = (i) => {
      const d = items[i];
      return `<div class="ci-date">${d.label}${d.closed ? " · нерабочий день" : " · рабочий день"}</div><div class="ci-row"><b>${fmt(d.kwh, 1)} кВт·ч</b>${mean ? ` · ср. ${fmt(mean, 1)}` : ""}</div>${d.excess > 0 ? `<div class="ci-warn">⚠ +${fmt(d.excess, 1)} кВт·ч сверх базового уровня</div>` : ""}`;
    };
  }

  const y = makeY(maxV);
  const { svg } = builder(items, y);
  const showMean = view === "bar" || view === "line";
  $("chart").innerHTML =
    `<svg viewBox="0 0 ${W} ${H}" role="img" class="${chartState.anim ? "fade-in" : ""}">${defsGradients()}${y.grid}${refLines(y, mean, showMean)}${svg}</svg>`;
  chartState.anim = false;

  const svgEl = $("chart").querySelector("svg");
  attachInteraction(svgEl, { n, slot, xCenter, y }, describe);
}
/* ---------- AI Copilot ---------- */

// Shows the exact figures the /api/insight prompt is built from — direct
// answer to "what data does the AI actually receive", visible before the
// recommendation text itself, not buried in the README.
function renderAiDataBlock() {
  if (!lastAnalysis) return;
  const s = lastAnalysis.summary;
  const dates = lastAnalysis.series
    .filter((d) => d.is_anomaly)
    .slice(0, 5)
    .map((d) => d.date)
    .join(", ");
  $("ai-data-block").innerHTML =
    `<strong>Данные, переданные ИИ:</strong>` +
    `<ul>` +
    `<li>Источник: ${lastAnalysis.source} · дней проанализировано: ${s.days_analyzed}</li>` +
    `<li>Аномальных дней: ${s.anomaly_days} · перерасход: ${fmt(s.total_excess_kwh, 1)} кВт·ч</li>` +
    `<li>Потери: ${fmt(s.savings_kzt)} тенге · CO₂: ${fmt(s.co2_saved_kg, 1)} кг</li>` +
    `<li>Погодная поправка учтена: ${lastAnalysis.weather_adjusted ? "да" : "нет"}</li>` +
    (dates ? `<li>Отмеченные даты (топ-5): ${dates}</li>` : "") +
    `</ul>`;
  $("ai-data-block").classList.remove("hidden");
}

function resetCopilot() {
  $("insight-text").classList.add("hidden");
  $("insight-text").innerHTML = "";
  $("insight-loading").classList.add("hidden");
  lastInsight = null;
  renderAiDataBlock();
  if (window.speechSynthesis) speechSynthesis.cancel();
  $("listen-btn").dataset.speaking = "false";
  $("listen-btn").textContent = "🔊 Прослушать чек-лист";
  $("exec-summary-box").classList.add("hidden");
  $("exec-summary-box").textContent = "";
  $("exec-summary-copy").classList.add("hidden");
}

// Minimal safe Markdown renderer (headings, bullets, bold, code) — input is
// HTML-escaped first so nothing from the model can inject markup.
function mdToHtml(md) {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (s) =>
    esc(s)
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");
  let html = "";
  let inList = false;
  for (const line of md.split("\n")) {
    const li = line.match(/^\s*(?:[-*]|\d+\.)\s+(.*)$/);
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (li) {
      if (!inList) {
        html += "<ul>";
        inList = true;
      }
      html += `<li>${inline(li[1])}</li>`;
    } else {
      if (inList) {
        html += "</ul>";
        inList = false;
      }
      if (h) html += `<h3>${inline(h[2])}</h3>`;
      else if (line.trim()) html += `<p>${inline(line)}</p>`;
    }
  }
  if (inList) html += "</ul>";
  return html;
}

$("insight-btn").addEventListener("click", async () => {
  if (!lastAnalysis) return;
  resetCopilot();
  $("insight-loading").classList.remove("hidden");
  try {
    const res = await apiPost("/api/insight", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: lastAnalysis.source,
        summary: lastAnalysis.summary,
        anomalies: lastAnalysis.series.filter((d) => d.is_anomaly),
      }),
      signal: reqTimeout(150000),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data) throw new Error(data?.detail || `Ошибка запроса (${res.status})`);
    const box = $("insight-text");
    box.innerHTML = mdToHtml(data.insight);
    box.classList.remove("hidden");
    lastInsight = data;
  } catch (err) {
    showStatus(`Копилот недоступен — ${err.message}`, true);
    setTimeout(hideStatus, 6000);
  } finally {
    $("insight-loading").classList.add("hidden");
  }
});

/* ---------- Events ---------- */
document.querySelectorAll(".seg-btn").forEach((btn) =>
  btn.addEventListener("click", () => {
    document
      .querySelectorAll(".seg-btn")
      .forEach((b) => b.classList.toggle("active", b === btn));
    Object.assign(chartState, { view: btn.dataset.view, i0: 0, i1: null, anim: true });
    $("zoom-reset").classList.add("hidden");
    drawChart();
  }),
);



$("upload-btn").addEventListener("click", () => $("file-input").click());

$("file-input").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (file) {
    uploadedFile = file; // kept for live re-runs from the tariff/slider/settings controls
    const formData = new FormData();
    formData.append("file", file);
    // Passing the filename makes the loading state show which file is
    // actually being analyzed, so it's never silently unclear whether an
    // upload was picked up.
    analyze(formData, file.name); // re-renders the dashboard and resets the AI Copilot panel
  }
  e.target.value = "";
});

$("sample-btn").addEventListener("click", () => {
  uploadedFile = null;
  lastSampleParam = "default";
  analyze(new FormData());
});

$("sample-multi-btn").addEventListener("click", () => {
  uploadedFile = null;
  lastSampleParam = "multi";
  analyze(new FormData(), null, { sample: "multi" });
});

function isBundledSample(source) {
  return source === "sample_data.csv" || source === "sample_data_multi.csv";
}

// Shared by the tariff input, threshold slider and settings panel: re-runs
// /api/analyze against whatever is currently loaded — the bundled sample by
// name, or the actual uploaded File object kept in `uploadedFile` (not a
// re-read of the file input, which the browser has already cleared).
function rerunWithCurrentSource() {
  if (!lastAnalysis) return;
  if (isBundledSample(lastAnalysis.source)) {
    analyze(new FormData(), null, { sample: lastSampleParam });
    return;
  }
  if (uploadedFile) {
    const formData = new FormData();
    formData.append("file", uploadedFile);
    analyze(formData, uploadedFile.name);
  }
}

let debounceTimer;
$("tariff").addEventListener("input", () => {
  if ($("results").classList.contains("hidden")) return;
  recomputeSimulator(); // instant client-side feedback; the full re-analyze below is debounced
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(rerunWithCurrentSource, 450);
});

$("sim-fixed").addEventListener("input", recomputeSimulator);
$("sim-sensors").addEventListener("input", recomputeSimulator);

$("settings-toggle").addEventListener("click", () => {
  const open = !$("settings-body").classList.toggle("hidden");
  $("settings-toggle").textContent = open ? "⚙ Скрыть параметры" : "⚙ Показать параметры";
  $("settings-toggle").setAttribute("aria-expanded", String(open));
});

$("settings-apply").addEventListener("click", rerunWithCurrentSource);

/* ---------- Tabs ---------- */
function showTab(name) {
  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.classList.toggle("hidden", panel.id !== `tab-${name}`);
  });
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    const active = btn.dataset.tab === name;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-selected", active ? "true" : "false");
  });
}

document.querySelectorAll(".tab-btn").forEach((btn) =>
  btn.addEventListener("click", () => showTab(btn.dataset.tab)),
);

/* ---------- Anomaly threshold slider (item 5) ----------
   Re-runs the existing /api/analyze with a different multiplier — no
   detection logic is duplicated on the client. */
let multiplierDebounce;
$("multiplier-slider").addEventListener("input", () => {
  const value = Number($("multiplier-slider").value).toFixed(1);
  $("multiplier-value").textContent = value;
  clearTimeout(multiplierDebounce);
  multiplierDebounce = setTimeout(() => {
    currentMultiplier = value;
    rerunWithCurrentSource();
  }, 300);
});

/* ---------- "Скачать отчёт" — printable HTML report ---------- */
function buildReportHtml() {
  if (!lastAnalysis) return "";
  const { summary: s, series, source } = lastAnalysis;
  const anomalies = series.filter((d) => d.is_anomaly).sort((a, b) => b.excess_kwh - a.excess_kwh);
  const generated = new Date().toLocaleString("ru-RU");
  const tariffNote = s.baseline_reliable
    ? "подтверждённый (данных по нерабочим дням достаточно)"
    : "демо (нерабочих дней в выборке пока мало — предварительный сигнал, не подтверждённый факт)";
  const rows = anomalies
    .map(
      (d) =>
        `<tr><td>${d.date}</td><td>${fmt(d.consumption_kwh, 1)} кВт·ч</td>` +
        `<td>+${fmt(d.excess_kwh, 1)} кВт·ч</td>` +
        `<td>${fmt(d.excess_kwh * s.tariff_kzt_per_kwh)} тенге</td></tr>`,
    )
    .join("");
  const insightBlock = lastInsight
    ? `<h2>Рекомендация ИИ</h2>
       <p class="muted">Источник: ${lastInsight.model === "offline-fallback" ? "офлайн-шаблон (Gemini был недоступен)" : `Gemini (${lastInsight.model})`}</p>
       <div>${mdToHtml(lastInsight.insight)}</div>`
    : "";
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8" />
<title>Отчёт EcoBiz Copilot — ${source}</title>
<style>
  body { font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #111; padding: 24px; max-width: 760px; margin: 0 auto; }
  h1 { font-size: 20px; } h2 { font-size: 15px; margin-top: 22px; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th, td { border-bottom: 1px solid #ccc; padding: 5px 8px; text-align: left; font-size: 12.5px; }
  .muted { color: #555; font-size: 12px; }
  .summary { display: grid; grid-template-columns: repeat(2, 1fr); gap: 4px 20px; margin: 10px 0; }
  @media print { body { padding: 0; } }
</style></head>
<body>
  <h1>EcoBiz Copilot — отчёт по потерям энергии</h1>
  <p class="muted">Сгенерировано: ${generated} · Источник данных: ${source}</p>
  <p class="muted">Тариф: ${s.tariff_kzt_per_kwh} тенге/кВт·ч (${tariffNote})</p>
  <h2>Сводные цифры</h2>
  <div class="summary">
    <div>Потери энергии: <strong>${fmt(s.total_excess_kwh, 1)} кВт·ч</strong></div>
    <div>Потери в тенге: <strong>${fmt(s.savings_kzt)} тенге</strong></div>
    <div>Экономия CO₂: <strong>${fmt(s.co2_saved_kg, 1)} кг</strong></div>
    <div>Аномальных дней: <strong>${s.anomaly_days} из ${s.days_analyzed}</strong></div>
    <div>Прогноз экономии за 3 месяца: <strong>${fmt(s.savings_kzt * 3)} тенге</strong> (проекция, не гарантия)</div>
    <div>Прогноз экономии за год: <strong>${fmt(s.savings_kzt * 12)} тенге</strong> (проекция, не гарантия)</div>
    <div>Базовый уровень: <strong>${fmt(s.baseline_kwh, 1)} кВт·ч</strong> (порог ×${fmt(s.multiplier, 1)})</div>
  </div>
  <h2>Аномальные даты</h2>
  <table><thead><tr><th>Дата</th><th>Потребление</th><th>Превышение</th><th>Потери</th></tr></thead>
  <tbody>${rows || '<tr><td colspan="4">Аномалий не обнаружено</td></tr>'}</tbody></table>
  ${insightBlock}
</body></html>`;
}

function openPrintWindow(html) {
  const win = window.open("", "_blank");
  if (!win) {
    showStatus("Не удалось открыть окно — разрешите всплывающие окна для этого сайта.", true);
    setTimeout(hideStatus, 6000);
    return;
  }
  win.document.write(html);
  win.document.close();
  win.focus();
  win.print();
}

$("download-btn").addEventListener("click", () => openPrintWindow(buildReportHtml()));

/* ---------- "Служебная записка" — a ready-to-print official memo draft ---------- */
function buildMemoHtml() {
  if (!lastAnalysis) return "";
  const { summary: s, source } = lastAnalysis;
  const today = new Date().toLocaleDateString("ru-RU");
  const top = computeTopPriorityAction(lastAnalysis);
  const findings = [
    `За период анализа (${s.days_analyzed} дн.) зафиксировано ${s.anomaly_days} нерабочий(их) день(дней), в которые потребление энергии соответствовало занятому зданию.`,
    `Суммарный избыточный расход составил ${fmt(s.total_excess_kwh, 1)} кВт·ч, что эквивалентно ${fmt(s.savings_kzt)} тенге.`,
    s.baseline_reliable
      ? "Базовый уровень потребления подтверждён достаточным объёмом данных по нерабочим дням."
      : `Базовый уровень построен по ${s.off_day_samples} нерабочему(им) дню(дням) — предварительный сигнал, рекомендуется уточнить на более длинной истории.`,
  ];
  if (top) {
    findings.push(`Наиболее вероятная причина по расчёту: «${top.hypothesis.split(" — ")[0]}» (${fmt(top.sharePct, 0)}% посчитанного перерасхода).`);
  }
  const recommendation = top
    ? actionForHypothesis(top.hypothesis)
    : "Проверить расписание инженерных систем на нерабочие дни.";

  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8" />
<title>Служебная записка — ${source}</title>
<style>
  body { font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #111; padding: 36px; max-width: 720px; margin: 0 auto; }
  h1 { font-size: 17px; text-align: center; text-transform: uppercase; letter-spacing: 0.02em; margin-bottom: 4px; }
  .subtitle { text-align: center; color: #555; font-size: 12.5px; margin-bottom: 28px; }
  .field { margin-bottom: 14px; }
  .field .k { font-weight: 700; }
  ol { padding-left: 20px; }
  li { margin-bottom: 8px; }
  .sign { margin-top: 56px; display: flex; justify-content: space-between; }
  .sign .line { border-top: 1px solid #111; width: 220px; padding-top: 4px; font-size: 12px; color: #555; }
  @media print { body { padding: 0; } }
</style></head>
<body>
  <h1>Служебная записка</h1>
  <p class="subtitle">по результатам автоматического анализа энергопотребления · EcoBiz Copilot</p>
  <div class="field"><span class="k">Дата:</span> ${today}</div>
  <div class="field"><span class="k">Объект / источник данных:</span> ${source}</div>
  <div class="field"><span class="k">Кому:</span> _______________________________</div>
  <div class="field"><span class="k">От кого:</span> _______________________________</div>

  <p class="field k">Установлено:</p>
  <ol>${findings.map((f) => `<li>${f}</li>`).join("")}</ol>

  <p class="field k">Рекомендуется:</p>
  <ol><li>${recommendation}</li><li>Повторно проверить показатели после внесения изменений в расписание инженерных систем.</li></ol>

  <p class="muted" style="font-size:11.5px; color:#777; margin-top:20px">
    Цифры рассчитаны автоматически (25-й перцентиль потребления в нерабочие дни × порог ${fmt(s.multiplier, 1)});
    методика и источники констант — см. вкладку «О методе» дашборда EcoBiz Copilot.
  </p>

  <div class="sign">
    <div class="line">Подпись, расшифровка</div>
    <div class="line">Дата</div>
  </div>
</body></html>`;
}

$("download-memo-btn").addEventListener("click", () => openPrintWindow(buildMemoHtml()));

/* ---------- Telegram link + provenance table (fetched once, not per-analysis) ---------- */
async function loadTelegramLink() {
  try {
    const res = await apiGet("/api/config");
    const data = await res.json();
    if (data.telegram_bot_username) {
      document.querySelectorAll(".js-telegram-link").forEach((link) => {
        link.href = `https://t.me/${data.telegram_bot_username}`;
        link.classList.remove("hidden");
      });
    }
  } catch {
    // No backend reachable yet, or bot not configured — link just stays hidden.
  }
}

const PROVENANCE_KIND_LABEL = { source: "источник", derived: "вывод", estimate: "оценка" };

async function loadProvenanceTable() {
  try {
    const res = await apiGet("/api/provenance");
    const entries = await res.json();
    $("provenance-table").innerHTML = entries
      .map((e) => {
        const valueText = e.value === null ? "не задано" : fmt(e.value, e.value < 10 ? 3 : 1);
        return (
          `<div class="prov-row">` +
          `<span class="prov-key">${e.key}</span>` +
          `<span class="prov-value">${valueText}</span>` +
          `<span class="prov-kind ${e.kind}">${PROVENANCE_KIND_LABEL[e.kind] || e.kind}</span>` +
          `<span class="prov-note">${e.note}</span>` +
          `</div>`
        );
      })
      .join("");
  } catch {
    $("provenance-table").innerHTML = '<p class="muted">Не удалось загрузить источники — backend недоступен.</p>';
  }
}

/* ---------- Portfolio: compare multiple buildings ---------- */
// Kept only in this tab's JS memory, per session — nothing is persisted or
// sent anywhere beyond the existing /api/analyze calls, one per object.
let portfolio = []; // { id, name, result }
let portfolioSeq = 0;

async function analyzeForPortfolio(formData, extraParams = {}) {
  const params = new URLSearchParams({
    tariff: $("tariff").value,
    weather_adjust: "true",
    ...currentSettingsParams(),
    ...extraParams,
  });
  const res = await apiPost(`/api/analyze?${params.toString()}`, {
    method: "POST",
    body: formData,
    signal: reqTimeout(30000),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data) throw new Error(data?.detail || `Ошибка запроса (${res.status})`);
  return data;
}

async function addToPortfolio(entries) {
  $("portfolio-loading").classList.remove("hidden");
  for (const entry of entries) {
    try {
      const data = await analyzeForPortfolio(entry.formData, entry.extraParams || {});
      portfolio.push({ id: ++portfolioSeq, name: entry.label || data.source, result: data });
    } catch (err) {
      showStatus(`Не удалось добавить «${entry.label}» в портфель — ${err.message}`, true);
      setTimeout(hideStatus, 6000);
    }
  }
  $("portfolio-loading").classList.add("hidden");
  renderPortfolio();
}

function renderPortfolio() {
  const empty = $("portfolio-empty");
  const table = $("portfolio-table");
  const summaryEl = $("portfolio-summary");
  if (!portfolio.length) {
    empty.classList.remove("hidden");
    table.classList.add("hidden");
    summaryEl.classList.add("hidden");
    return;
  }
  empty.classList.add("hidden");
  table.classList.remove("hidden");

  const sorted = [...portfolio].sort((a, b) => b.result.summary.savings_kzt - a.result.summary.savings_kzt);
  const total = sorted.reduce((acc, p) => acc + p.result.summary.savings_kzt, 0);
  let cumBefore = 0;
  const rows = sorted.map((p, i) => {
    const s = p.result.summary;
    // "Top priority" = still inside the leading 80% of total losses before
    // this row is added — the handful of objects worth visiting first.
    const isTop = total > 0 && cumBefore / total < 0.8;
    cumBefore += s.savings_kzt;
    return { p, s, i, isTop };
  });
  const topCount = rows.filter((r) => r.isTop).length;
  const topShare = total > 0 ? (rows.filter((r) => r.isTop).reduce((a, r) => a + r.s.savings_kzt, 0) / total) * 100 : 0;

  table.querySelector("tbody").innerHTML = rows
    .map(
      ({ p, s, i, isTop }) =>
        `<tr class="${isTop ? "top-priority" : ""}">` +
        `<td><span class="rank-badge">${i + 1}</span></td>` +
        `<td>${p.name}</td>` +
        `<td class="num">${fmt(s.total_excess_kwh, 1)}</td>` +
        `<td class="num">${fmt(s.savings_kzt)}</td>` +
        `<td class="num">${s.anomaly_days} / ${s.days_analyzed}</td>` +
        `<td><span class="reliability-chip ${s.baseline_reliable ? "yes" : "no"}">${s.baseline_reliable ? "да" : "мало данных"}</span></td>` +
        `<td><button class="remove-btn" data-id="${p.id}" type="button" title="Убрать из портфеля">✕</button></td>` +
        `</tr>`,
    )
    .join("");

  summaryEl.textContent =
    `${sorted.length} объект(ов) в портфеле · суммарные потери ${fmt(total)} тенге · ` +
    `топ-${topCount} объект(ов) (отмечены слева) дают ${fmt(topShare, 0)}% от общей суммы потерь — приоритет для выезда.`;
  summaryEl.classList.remove("hidden");

  table.querySelectorAll(".remove-btn").forEach((btn) =>
    btn.addEventListener("click", () => {
      portfolio = portfolio.filter((p) => p.id !== Number(btn.dataset.id));
      renderPortfolio();
    }),
  );
}

$("portfolio-add-btn").addEventListener("click", () => $("portfolio-file-input").click());

$("portfolio-file-input").addEventListener("change", async (e) => {
  const files = [...e.target.files];
  e.target.value = "";
  if (!files.length) return;
  const entries = files.map((file) => {
    const fd = new FormData();
    fd.append("file", file);
    return { formData: fd, label: file.name };
  });
  await addToPortfolio(entries);
});

$("portfolio-add-demo").addEventListener("click", async () => {
  await addToPortfolio([
    { formData: new FormData(), label: "sample_data.csv (демо)" },
    { formData: new FormData(), label: "sample_data_multi.csv (демо)", extraParams: { sample: "multi" } },
  ]);
});

/* ---------- OCR receipt photo input (Tesseract.js, loaded lazily from a CDN) ----------
   Client-side only: the image never leaves the browser for OCR. Extracted
   date/amount are a draft the user reviews before adding — OCR on a photo
   is never trusted blindly. The accumulated history is analyzed by building
   an ordinary CSV in memory and running it through the exact same
   /api/analyze path as a file upload — no separate backend logic. */
let tesseractLoadPromise = null;
let ocrLastRawText = "";
let ocrHistory = []; // { id, date, kwh }
let ocrHistorySeq = 0;

function loadTesseract() {
  if (window.Tesseract) return Promise.resolve();
  if (tesseractLoadPromise) return tesseractLoadPromise;
  tesseractLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/5.0.4/tesseract.min.js";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Не удалось загрузить библиотеку распознавания текста — проверьте интернет-соединение."));
    document.head.appendChild(script);
  });
  return tesseractLoadPromise;
}

// Heuristic, not a real receipt parser: first date-shaped substring, and
// either a number next to "квт"/"kwh"/"итого"/"к оплате" or, failing that,
// the largest plausible number on the page. Always shown as editable
// fields — never fed into analysis without the user reviewing it.
function parseReceiptText(text) {
  let date = null;
  const dateMatch = text.match(/(\d{2})[.\-/](\d{2})[.\-/](\d{4})/) || text.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (dateMatch) {
    if (dateMatch[0].includes("-") && dateMatch[1].length === 4) {
      date = `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`;
    } else {
      date = `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}`;
    }
  }

  let kwh = null;
  const lines = text.split("\n");
  const numRe = /(\d[\d\s]*[.,]?\d*)/;
  for (const line of lines) {
    if (/квт|kwh|потребл|итого|к\s*оплате/i.test(line)) {
      const m = line.match(numRe);
      if (m) {
        const n = parseFloat(m[1].replace(/\s/g, "").replace(",", "."));
        if (!Number.isNaN(n) && n > 0) {
          kwh = n;
          break;
        }
      }
    }
  }
  if (kwh == null) {
    const allNums = [...text.matchAll(/\d[\d\s]{0,6}[.,]?\d*/g)]
      .map((m) => parseFloat(m[0].replace(/\s/g, "").replace(",", ".")))
      .filter((n) => !Number.isNaN(n) && n > 0 && n < 1000000);
    if (allNums.length) kwh = Math.max(...allNums);
  }
  return { date, kwh };
}

$("ocr-file-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  $("ocr-error").classList.add("hidden");
  $("ocr-result").classList.add("hidden");
  $("ocr-progress").classList.remove("hidden");
  $("ocr-progress-text").textContent = "Загружаем модель распознавания…";
  try {
    await loadTesseract();
    $("ocr-progress-text").textContent = "Распознаём текст на фото…";
    const { data } = await window.Tesseract.recognize(file, "rus+eng", {
      logger: (m) => {
        if (m.status === "recognizing text") {
          $("ocr-progress-text").textContent = `Распознаём текст на фото… ${Math.round((m.progress || 0) * 100)}%`;
        }
      },
    });
    ocrLastRawText = data.text || "";
    const { date, kwh } = parseReceiptText(ocrLastRawText);
    $("ocr-date").value = date || "";
    $("ocr-kwh").value = kwh != null ? kwh : "";
    $("ocr-raw-text").textContent = ocrLastRawText.trim() || "(текст не распознан)";
    $("ocr-result").classList.remove("hidden");
  } catch (err) {
    $("ocr-error").textContent = `Не удалось распознать фото — ${err.message}. Можно ввести дату и потребление вручную ниже, если распознавание недоступно.`;
    $("ocr-error").classList.remove("hidden");
    $("ocr-date").value = "";
    $("ocr-kwh").value = "";
    $("ocr-raw-text").textContent = "";
    $("ocr-result").classList.remove("hidden"); // still let the user type values in manually
  } finally {
    $("ocr-progress").classList.add("hidden");
    e.target.value = "";
  }
});

function renderOcrHistory() {
  const empty = $("ocr-history-empty");
  const table = $("ocr-history-table");
  const analyzeBtn = $("ocr-analyze-btn");
  if (!ocrHistory.length) {
    empty.classList.remove("hidden");
    table.classList.add("hidden");
    analyzeBtn.disabled = true;
    analyzeBtn.textContent = "Проанализировать историю";
    return;
  }
  empty.classList.add("hidden");
  table.classList.remove("hidden");
  analyzeBtn.disabled = false;
  analyzeBtn.textContent = `Проанализировать историю (${ocrHistory.length})`;

  const sorted = [...ocrHistory].sort((a, b) => a.date.localeCompare(b.date));
  table.querySelector("tbody").innerHTML = sorted
    .map(
      (r) =>
        `<tr><td>${r.date}</td><td class="num">${fmt(r.kwh, 2)}</td>` +
        `<td><button class="remove-btn" data-id="${r.id}" type="button" title="Убрать запись">✕</button></td></tr>`,
    )
    .join("");
  table.querySelectorAll(".remove-btn").forEach((btn) =>
    btn.addEventListener("click", () => {
      ocrHistory = ocrHistory.filter((r) => r.id !== Number(btn.dataset.id));
      renderOcrHistory();
    }),
  );
}

$("ocr-add-btn").addEventListener("click", () => {
  const date = $("ocr-date").value;
  const kwh = parseFloat($("ocr-kwh").value);
  if (!date) {
    showStatus("Укажите дату записи перед добавлением.", true);
    setTimeout(hideStatus, 4000);
    return;
  }
  if (Number.isNaN(kwh) || kwh < 0) {
    showStatus("Укажите корректное значение потребления (кВт·ч).", true);
    setTimeout(hideStatus, 4000);
    return;
  }
  ocrHistory = ocrHistory.filter((r) => r.date !== date); // one record per date, latest edit wins
  ocrHistory.push({ id: ++ocrHistorySeq, date, kwh });
  renderOcrHistory();
  // Clear the fields but keep the form open — manual entry (no photo, e.g.
  // when OCR/the CDN is unreachable) needs to add several days in a row
  // without re-selecting a file just to see the inputs again.
  $("ocr-date").value = "";
  $("ocr-kwh").value = "";
});

$("ocr-analyze-btn").addEventListener("click", () => {
  if (!ocrHistory.length) return;
  const rows = ["date,consumption_kwh"];
  for (const r of [...ocrHistory].sort((a, b) => a.date.localeCompare(b.date))) {
    rows.push(`${r.date},${r.kwh}`);
  }
  const csvBlob = new Blob([rows.join("\n")], { type: "text/csv" });
  const file = new File([csvBlob], "квитанции-ocr.csv", { type: "text/csv" });
  uploadedFile = file;
  const formData = new FormData();
  formData.append("file", file);
  analyze(formData, file.name);
});

initThemeSwitcher();
loadTelegramLink();
loadProvenanceTable();

// Load something immediately so the screen is never empty.
analyze(new FormData());
