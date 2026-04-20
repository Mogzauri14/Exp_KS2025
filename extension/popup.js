"use strict";

// ── Configuration ─────────────────────────────────────────────
const DATA_URL =
  "https://raw.githubusercontent.com/Mogzauri14/Exp_KS2025/main/elections.json";

const CACHE_KEY = "elections_cache";
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

// ── DOM refs ──────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const stateLoading   = $("stateLoading");
const stateError     = $("stateError");
const stateEmpty     = $("stateEmpty");
const electionList   = $("electionList");
const footerEl       = $("footer");
const errorMsgEl     = $("errorMsg");
const searchInput    = $("searchInput");
const filterBar      = $("filterBar");
const refreshBtn     = $("refreshBtn");
const retryBtn       = $("retryBtn");
const filterToggle   = $("filterToggle");
const prevMonthBtn   = $("prevMonthBtn");
const nextMonthBtn   = $("nextMonthBtn");
const prevMonthLabel = $("prevMonthLabel");
const nextMonthLabel = $("nextMonthLabel");
const currentMonthLabel = $("currentMonthLabel");
const statTotal      = $("statTotal");
const statHeld       = $("statHeld");
const statHeldLabel  = $("statHeldLabel");
const listTitle      = $("listTitle");
const tabUpcoming    = $("tabUpcoming");
const tabResults     = $("tabResults");
const tabAll         = $("tabAll");

// ── State ─────────────────────────────────────────────────────
let monthsData   = {};   // { "YYYY-MM": [...elections] }
let currentMonth = "";   // "YYYY-MM" currently displayed
let serverCurrentMonth = ""; // what the scraper considers "now"
let availableMonths = []; // sorted list of month keys in the data
let activeTab    = "all"; // "upcoming" | "held" | "all"
let filterQuery  = "";

// ── Helpers ───────────────────────────────────────────────────
function show(el) { el.classList.remove("hidden"); }
function hide(el) { el.classList.add("hidden"); }

function monthName(isoMonth) {
  const [y, m] = isoMonth.split("-");
  return new Date(Date.UTC(+y, +m - 1, 1))
    .toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

function monthShort(isoMonth) {
  const [y, m] = isoMonth.split("-");
  return new Date(Date.UTC(+y, +m - 1, 1))
    .toLocaleString("en-US", { month: "short", timeZone: "UTC" }).toUpperCase();
}

function formatDate(isoStr) {
  const d = new Date(isoStr + "T12:00:00Z");
  const day = String(d.getUTCDate());
  const mon = d.toLocaleString("en-US", { month: "short", timeZone: "UTC" }).toUpperCase();
  return { day, mon };
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function statusChipClass(status) {
  switch ((status || "").toLowerCase()) {
    case "upcoming":  return "chip-upcoming";
    case "held":      return "chip-held";
    case "postponed": return "chip-postponed";
    case "cancelled": return "chip-cancelled";
    case "disputed":  return "chip-disputed";
    default:          return "chip-unknown";
  }
}

// ── Card builder ──────────────────────────────────────────────
function buildCard(election) {
  const { day, mon } = formatDate(election.date);
  const status = election.status || "Unknown";
  const li = document.createElement("li");
  li.className = "election-item";
  li.innerHTML = `
    <div class="date-badge">
      <span class="day">${escHtml(day)}</span>
      <span class="mon">${escHtml(mon)}</span>
    </div>
    <div class="election-info">
      <div class="election-top">
        <span class="election-country">${escHtml(election.country)}</span>
        <button class="election-link-icon" aria-label="Open source for ${escHtml(election.country)}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
               width="12" height="12">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
            <polyline points="15 3 21 3 21 9"/>
            <line x1="10" y1="14" x2="21" y2="3"/>
          </svg>
        </button>
      </div>
      <div class="election-type">${escHtml(election.type)}</div>
      <div class="election-chips">
        <span class="chip chip-source">${escHtml(election.source_name)}</span>
        <span class="chip ${statusChipClass(status)}">${escHtml(status)}</span>
      </div>
    </div>`;

  li.querySelector(".election-link-icon").addEventListener("click", (e) => {
    e.stopPropagation();
    chrome.tabs.create({ url: election.link });
  });
  li.addEventListener("click", () => chrome.tabs.create({ url: election.link }));

  return li;
}

// ── Render ────────────────────────────────────────────────────
function renderCurrentMonth() {
  const elections = monthsData[currentMonth] || [];

  // Apply tab filter
  let filtered = elections;
  if (activeTab === "upcoming") {
    filtered = elections.filter(e =>
      !["held", "postponed", "cancelled", "disputed"].includes(
        (e.status || "").toLowerCase()
      )
    );
  } else if (activeTab === "held") {
    filtered = elections.filter(e =>
      (e.status || "").toLowerCase() === "held"
    );
  }

  // Apply search query
  if (filterQuery) {
    const q = filterQuery.toLowerCase();
    filtered = filtered.filter(e =>
      e.country.toLowerCase().includes(q) ||
      e.type.toLowerCase().includes(q) ||
      e.source_name.toLowerCase().includes(q) ||
      (e.status || "").toLowerCase().includes(q)
    );
  }

  // Update bento stats (always from full list, not filtered)
  statTotal.textContent = String(elections.length).padStart(2, "0");
  const heldCount = elections.filter(
    e => (e.status || "").toLowerCase() === "held"
  ).length;
  statHeld.textContent = String(heldCount).padStart(2, "0");

  // Update bento label based on whether current is the "now" month
  if (currentMonth === serverCurrentMonth) {
    statHeldLabel.textContent = "Held This Month";
  } else {
    statHeldLabel.textContent = "Held";
  }

  // Update list title
  listTitle.textContent = monthName(currentMonth) + " Schedule";

  // Update month nav labels
  const idx = availableMonths.indexOf(currentMonth);
  prevMonthLabel.textContent = idx > 0 ? monthShort(availableMonths[idx - 1]) : "";
  nextMonthLabel.textContent = idx < availableMonths.length - 1
    ? monthShort(availableMonths[idx + 1]) : "";
  currentMonthLabel.textContent = monthName(currentMonth).toUpperCase();

  // Nav button visibility
  prevMonthBtn.style.visibility = idx > 0 ? "visible" : "hidden";
  nextMonthBtn.style.visibility = idx < availableMonths.length - 1 ? "visible" : "hidden";

  // Render list
  electionList.innerHTML = "";
  if (filtered.length === 0) {
    hide(electionList);
    show(stateEmpty);
    hide(stateLoading);
    hide(stateError);
    return;
  }
  hide(stateLoading);
  hide(stateError);
  hide(stateEmpty);
  show(electionList);

  const frag = document.createDocumentFragment();
  filtered.forEach((e, i) => {
    const card = buildCard(e);
    card.style.animationDelay = `${i * 18}ms`;
    frag.appendChild(card);
  });
  electionList.appendChild(frag);
}

// ── Data loading ──────────────────────────────────────────────
async function loadFromCache() {
  return new Promise((resolve) => {
    chrome.storage.local.get(CACHE_KEY, (result) => {
      const cached = result[CACHE_KEY];
      if (!cached || Date.now() - cached.ts > CACHE_TTL) return resolve(null);
      resolve(cached.data);
    });
  });
}

async function saveToCache(data) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [CACHE_KEY]: { ts: Date.now(), data } }, resolve);
  });
}

function applyDataToUI(json, isStale = false) {
  // Support both old format (json.elections flat) and new format (json.months)
  if (json.months) {
    monthsData = json.months;
    availableMonths = Object.keys(monthsData).sort();
    serverCurrentMonth = json.current_month || availableMonths[Math.floor(availableMonths.length / 2)];
  } else {
    // Legacy fallback: single flat elections array
    const key = json.month || "unknown";
    monthsData = { [key]: json.elections || [] };
    availableMonths = [key];
    serverCurrentMonth = key;
  }

  // Default to the server's current month
  if (!currentMonth || !monthsData[currentMonth]) {
    currentMonth = serverCurrentMonth;
  }

  const genAt = json.generated_at
    ? new Date(json.generated_at).toLocaleString("en-US", {
        month: "short", day: "numeric",
        hour: "2-digit", minute: "2-digit",
      })
    : "unknown";
  footerEl.textContent = `Updated ${genAt}${isStale ? " · cached" : ""}`;

  if (json.errors && json.errors.length > 0) {
    console.warn("Scraper reported errors:", json.errors);
  }

  renderCurrentMonth();
}

async function fetchData(forceRefresh = false) {
  show(stateLoading);
  hide(stateError);
  hide(stateEmpty);
  hide(electionList);
  refreshBtn.classList.add("spinning");
  searchInput.value = "";
  filterQuery = "";

  try {
    if (!forceRefresh) {
      const cached = await loadFromCache();
      if (cached) { applyDataToUI(cached); return; }
    }
    const resp = await fetch(DATA_URL, { cache: "no-store" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
    const json = await resp.json();
    await saveToCache(json);
    applyDataToUI(json);
  } catch (err) {
    console.error("Elections fetch error:", err);
    const stale = await loadFromCache().catch(() => null);
    if (stale) {
      applyDataToUI(stale, true);
    } else {
      errorMsgEl.textContent = `Could not load data: ${err.message}`;
      hide(stateLoading);
      show(stateError);
    }
  } finally {
    refreshBtn.classList.remove("spinning");
  }
}

// ── Event listeners ───────────────────────────────────────────
refreshBtn.addEventListener("click", () => fetchData(true));
retryBtn.addEventListener("click",   () => fetchData(true));

filterToggle.addEventListener("click", () => {
  filterBar.classList.toggle("hidden");
  if (!filterBar.classList.contains("hidden")) searchInput.focus();
});

searchInput.addEventListener("input", () => {
  filterQuery = searchInput.value;
  renderCurrentMonth();
});

prevMonthBtn.addEventListener("click", () => {
  const idx = availableMonths.indexOf(currentMonth);
  if (idx > 0) { currentMonth = availableMonths[idx - 1]; renderCurrentMonth(); }
});

nextMonthBtn.addEventListener("click", () => {
  const idx = availableMonths.indexOf(currentMonth);
  if (idx < availableMonths.length - 1) {
    currentMonth = availableMonths[idx + 1];
    renderCurrentMonth();
  }
});

[tabUpcoming, tabResults, tabAll].forEach(tab => {
  tab.addEventListener("click", () => {
    [tabUpcoming, tabResults, tabAll].forEach(t => t.classList.remove("active"));
    tab.classList.add("active");
    activeTab = tab.dataset.filter;
    renderCurrentMonth();
  });
});

// ── Init ──────────────────────────────────────────────────────
fetchData();
