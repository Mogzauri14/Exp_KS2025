"use strict";

// ── Configuration ────────────────────────────────────────────
// Replace YOUR_GITHUB_USER and YOUR_REPO before deploying.
const DATA_URL =
  "https://raw.githubusercontent.com/Mogzauri14/Exp_KS2025/main/elections.json";

// Cache key + TTL (30 minutes)
const CACHE_KEY = "elections_cache";
const CACHE_TTL = 30 * 60 * 1000;

// ── DOM refs ─────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const stateLoading = $("stateLoading");
const stateError   = $("stateError");
const stateEmpty   = $("stateEmpty");
const stateResults = $("stateResults");
const electionList = $("electionList");
const subtitleEl   = $("subtitle");
const footerEl     = $("footer");
const errorMsgEl   = $("errorMsg");
const searchInput  = $("searchInput");
const refreshBtn   = $("refreshBtn");
const retryBtn     = $("retryBtn");

// ── State ─────────────────────────────────────────────────────
let allElections = [];

// ── Helpers ──────────────────────────────────────────────────
function show(el)  { el.classList.remove("hidden"); }
function hide(el)  { el.classList.add("hidden"); }

function showState(active) {
  [stateLoading, stateError, stateEmpty, stateResults].forEach((el) => {
    el === active ? show(el) : hide(el);
  });
}

function formatDate(isoStr) {
  const [, , dd] = isoStr.split("-");
  const d = new Date(isoStr + "T12:00:00Z");
  const mon = d.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  return { day: dd.replace(/^0/, ""), mon };
}

function monthLabel(isoMonth) {
  const [y, m] = isoMonth.split("-");
  const d = new Date(Date.UTC(Number(y), Number(m) - 1, 1));
  return d.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

function externalLinkIcon() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
      width="13" height="13">
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
    <polyline points="15 3 21 3 21 9"/>
    <line x1="10" y1="14" x2="21" y2="3"/>
  </svg>`;
}

function statusClass(status) {
  if (!status) return "status-unknown";
  switch (status.toLowerCase()) {
    case "upcoming":   return "status-upcoming";
    case "held":       return "status-held";
    case "postponed":  return "status-postponed";
    case "cancelled":  return "status-cancelled";
    case "disputed":   return "status-disputed";
    default:           return "status-unknown";
  }
}

function buildCard(election) {
  const { day, mon } = formatDate(election.date);
  const status = election.status || "Unknown";
  const li = document.createElement("li");
  li.className = "election-item";
  li.innerHTML = `
    <div class="date-badge" aria-label="${election.date}">
      <span class="day">${day}</span>
      <span class="mon">${mon}</span>
    </div>
    <div class="election-info">
      <div class="election-country">${escHtml(election.country)}</div>
      <div class="election-type">${escHtml(election.type)}</div>
      <div class="election-meta">
        <span class="source-chip">${escHtml(election.source_name)}</span>
        <span class="status-badge ${statusClass(status)}">${escHtml(status)}</span>
      </div>
    </div>
    <a class="election-link" href="${escHtml(election.link)}"
       target="_blank" rel="noopener noreferrer"
       title="Open source page" aria-label="Open source page for ${escHtml(election.country)}">
      ${externalLinkIcon()}
    </a>`;

  // Open link via chrome.tabs API (works in extension context)
  li.querySelector(".election-link").addEventListener("click", (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: election.link });
  });

  return li;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderList(elections) {
  electionList.innerHTML = "";
  if (elections.length === 0) {
    showState(stateEmpty);
    return;
  }
  showState(stateResults);
  const frag = document.createDocumentFragment();
  elections.forEach((e, i) => {
    const card = buildCard(e);
    card.style.animationDelay = `${i * 20}ms`;
    frag.appendChild(card);
  });
  electionList.appendChild(frag);
}

function applyFilter(query) {
  const q = query.toLowerCase().trim();
  if (!q) { renderList(allElections); return; }
  const filtered = allElections.filter(
    (e) =>
      e.country.toLowerCase().includes(q) ||
      e.type.toLowerCase().includes(q) ||
      e.source_name.toLowerCase().includes(q) ||
      (e.status || "").toLowerCase().includes(q)
  );
  renderList(filtered);
  if (filtered.length === 0) showState(stateEmpty);
}

// ── Data loading ─────────────────────────────────────────────
async function loadFromCache() {
  return new Promise((resolve) => {
    chrome.storage.local.get(CACHE_KEY, (result) => {
      const cached = result[CACHE_KEY];
      if (!cached) return resolve(null);
      if (Date.now() - cached.ts > CACHE_TTL) return resolve(null);
      resolve(cached.data);
    });
  });
}

async function saveToCache(data) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [CACHE_KEY]: { ts: Date.now(), data } }, resolve);
  });
}

async function fetchData(forceRefresh = false) {
  showState(stateLoading);
  refreshBtn.classList.add("spinning");
  searchInput.value = "";

  try {
    // Try cache first unless forced refresh
    if (!forceRefresh) {
      const cached = await loadFromCache();
      if (cached) {
        applyDataToUI(cached);
        return;
      }
    }

    const resp = await fetch(DATA_URL, { cache: "no-store" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
    const json = await resp.json();
    await saveToCache(json);
    applyDataToUI(json);
  } catch (err) {
    console.error("Elections fetch error:", err);
    // If refresh fails, fall back to stale cache
    const stale = await loadFromCache().catch(() => null);
    if (stale) {
      applyDataToUI(stale, true);
    } else {
      errorMsgEl.textContent = `Could not load data: ${err.message}`;
      showState(stateError);
    }
  } finally {
    refreshBtn.classList.remove("spinning");
  }
}

function applyDataToUI(json, isStale = false) {
  allElections = (json.elections || []);

  const label = json.month ? monthLabel(json.month) : "this month";
  subtitleEl.textContent = `${allElections.length} election${allElections.length !== 1 ? "s" : ""} · ${label}`;

  const genAt = json.generated_at
    ? new Date(json.generated_at).toLocaleString("en-US", {
        month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
      })
    : "unknown";
  footerEl.textContent = `Updated ${genAt}${isStale ? " · (cached)" : ""}`;

  if (json.errors && json.errors.length > 0) {
    console.warn("Scraper reported errors:", json.errors);
  }

  renderList(allElections);
}

// ── Event listeners ──────────────────────────────────────────
searchInput.addEventListener("input", () => applyFilter(searchInput.value));
refreshBtn.addEventListener("click", () => fetchData(true));
retryBtn.addEventListener("click",   () => fetchData(true));

// ── Init ─────────────────────────────────────────────────────
fetchData();
