"use strict";

const DATA_URL               = "https://raw.githubusercontent.com/Mogzauri14/Exp_KS2025/main/elections.json";
const CACHE_KEY              = "elections_cache";
const SELECTED_COUNTRIES_KEY = "selected_countries";
const PINNED_COUNTRIES_KEY   = "pinned_countries";

// Module-level state so pin toggle can rebuild without re-fetching
let allCountries    = [];
let currentSelected = null; // null = all checked
let currentPinned   = [];

const PIN_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
  stroke-linecap="round" stroke-linejoin="round" width="14" height="14">
  <line x1="12" y1="17" x2="12" y2="22"/>
  <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/>
</svg>`;

// ── Data loading ──────────────────────────────────────────────
async function loadAll() {
  return new Promise((resolve) => {
    chrome.storage.local.get([CACHE_KEY, SELECTED_COUNTRIES_KEY, PINNED_COUNTRIES_KEY], (result) => {
      const cached   = result[CACHE_KEY];
      const selected = result[SELECTED_COUNTRIES_KEY] ?? null;
      const pinned   = result[PINNED_COUNTRIES_KEY]   ?? [];

      if (cached && cached.data) {
        resolve({ countries: extractCountries(cached.data), selected, pinned });
      } else {
        fetch(DATA_URL, { cache: "no-store" })
          .then(r => r.json())
          .then(json => resolve({ countries: extractCountries(json), selected, pinned }))
          .catch(() => resolve({ countries: [], selected, pinned }));
      }
    });
  });
}

function extractCountries(json) {
  const set = new Set();
  if (json.months) {
    Object.values(json.months).forEach(elections =>
      elections.forEach(e => { if (e.country) set.add(e.country); })
    );
  } else if (json.elections) {
    json.elections.forEach(e => { if (e.country) set.add(e.country); });
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

// ── List builder ──────────────────────────────────────────────
function buildCheckboxes(countries, selected, pinned) {
  const container = document.getElementById("country-list-container");
  container.innerHTML = "";

  // Pinned countries float to the top, rest stay alphabetical
  const sorted = [
    ...countries.filter(c =>  pinned.includes(c)),
    ...countries.filter(c => !pinned.includes(c)),
  ];

  sorted.forEach(country => {
    const isChecked = selected === null || selected.includes(country);
    const isPinned  = pinned.includes(country);

    const wrapper     = document.createElement("div");
    wrapper.className = "country-item" + (isPinned ? " pinned" : "");

    const id          = "cb-" + country.replace(/\s+/g, "-").replace(/[^a-zA-Z0-9-]/g, "").toLowerCase();

    const checkbox    = document.createElement("input");
    checkbox.type     = "checkbox";
    checkbox.id       = id;
    checkbox.value    = country;
    checkbox.checked  = isChecked;

    const label       = document.createElement("label");
    label.htmlFor     = id;
    label.textContent = country;

    const pinBtn          = document.createElement("button");
    pinBtn.className      = "pin-btn" + (isPinned ? " active" : "");
    pinBtn.title          = isPinned
      ? "Unpin — removes from popup-only view"
      : "Pin — popup will show only pinned countries";
    pinBtn.dataset.country = country;
    pinBtn.innerHTML      = PIN_SVG;

    pinBtn.addEventListener("click", () => {
      const c   = pinBtn.dataset.country;
      const idx = currentPinned.indexOf(c);
      if (idx === -1) currentPinned.push(c);
      else            currentPinned.splice(idx, 1);

      chrome.storage.local.set({ [PINNED_COUNTRIES_KEY]: currentPinned }, () => {
        buildCheckboxes(allCountries, currentSelected, currentPinned);
        // Re-apply any active search term after rebuild
        const term = document.getElementById("country-search").value;
        if (term) document.getElementById("country-search").dispatchEvent(new Event("input"));
      });
    });

    wrapper.appendChild(checkbox);
    wrapper.appendChild(label);
    wrapper.appendChild(pinBtn);
    container.appendChild(wrapper);
  });

  updatePinSummary(pinned.length);
}

// ── Pin summary banner ────────────────────────────────────────
function updatePinSummary(count) {
  let banner = document.getElementById("pin-summary");
  if (!banner) {
    banner = document.createElement("p");
    banner.id = "pin-summary";
    banner.className = "pin-summary";
    document.querySelector(".options-header").after(banner);
  }
  if (count === 0) {
    banner.textContent = "No countries pinned — popup shows all results.";
    banner.classList.remove("active");
  } else {
    banner.textContent = `${count} ${count === 1 ? "country" : "countries"} pinned — popup shows only these.`;
    banner.classList.add("active");
  }
}

// ── Real-time search filter ───────────────────────────────────
document.getElementById("country-search").addEventListener("input", function (e) {
  const searchTerm = e.target.value.toLowerCase();
  document.querySelectorAll("#country-list-container .country-item").forEach(wrapper => {
    const label = wrapper.querySelector("label");
    wrapper.style.display = label.textContent.toLowerCase().includes(searchTerm) ? "" : "none";
  });
});

// ── Select All / Clear All (respects current search filter) ──
document.getElementById("select-all-btn").addEventListener("click", () => {
  document.querySelectorAll("#country-list-container .country-item").forEach(wrapper => {
    if (wrapper.style.display !== "none")
      wrapper.querySelector("input[type='checkbox']").checked = true;
  });
});

document.getElementById("clear-all-btn").addEventListener("click", () => {
  document.querySelectorAll("#country-list-container .country-item").forEach(wrapper => {
    if (wrapper.style.display !== "none")
      wrapper.querySelector("input[type='checkbox']").checked = false;
  });
});

// ── Save (checkbox selections only — pins auto-save on toggle) ─
document.getElementById("save-btn").addEventListener("click", () => {
  const checked = Array.from(
    document.querySelectorAll("#country-list-container input[type='checkbox']:checked")
  ).map(cb => cb.value);

  chrome.storage.local.set({ [SELECTED_COUNTRIES_KEY]: checked }, () => {
    const btn = document.getElementById("save-btn");
    btn.textContent = "Saved!";
    btn.classList.add("btn-saved");
    setTimeout(() => {
      btn.textContent = "Save";
      btn.classList.remove("btn-saved");
    }, 1500);
  });
});

// ── Init ──────────────────────────────────────────────────────
loadAll().then(({ countries, selected, pinned }) => {
  if (countries.length === 0) {
    document.getElementById("country-list-container").innerHTML =
      '<p class="no-data">No election data cached yet. Open the extension popup first to load data, then return here.</p>';
    return;
  }
  allCountries    = countries;
  currentSelected = selected;
  currentPinned   = pinned;
  buildCheckboxes(allCountries, currentSelected, currentPinned);
});
