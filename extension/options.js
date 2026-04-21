"use strict";

const DATA_URL            = "https://raw.githubusercontent.com/Mogzauri14/Exp_KS2025/main/elections.json";
const CACHE_KEY           = "elections_cache";
const SELECTED_COUNTRIES_KEY = "selected_countries";

// ── Data loading ──────────────────────────────────────────────
async function loadCountriesAndPrefs() {
  return new Promise((resolve) => {
    chrome.storage.local.get([CACHE_KEY, SELECTED_COUNTRIES_KEY], (result) => {
      const cached   = result[CACHE_KEY];
      const selected = result[SELECTED_COUNTRIES_KEY] ?? null; // null = all selected

      if (cached && cached.data) {
        resolve({ countries: extractCountries(cached.data), selected });
      } else {
        // Fallback: fetch fresh if no cache exists yet
        fetch(DATA_URL, { cache: "no-store" })
          .then(r => r.json())
          .then(json => resolve({ countries: extractCountries(json), selected }))
          .catch(() => resolve({ countries: [], selected }));
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

// ── Checkbox builder ──────────────────────────────────────────
function buildCheckboxes(countries, selected) {
  const container = document.getElementById("country-list-container");
  container.innerHTML = "";

  countries.forEach(country => {
    const isChecked = selected === null || selected.includes(country);

    const wrapper  = document.createElement("div");
    wrapper.className = "country-item";

    // Stable, unique id from country name
    const id = "cb-" + country.replace(/\s+/g, "-").replace(/[^a-zA-Z0-9-]/g, "").toLowerCase();

    const checkbox       = document.createElement("input");
    checkbox.type        = "checkbox";
    checkbox.id          = id;
    checkbox.value       = country;
    checkbox.checked     = isChecked;

    const label          = document.createElement("label");
    label.htmlFor        = id;
    label.textContent    = country;

    wrapper.appendChild(checkbox);
    wrapper.appendChild(label);
    container.appendChild(wrapper);
  });
}

// ── Real-time search filter ───────────────────────────────────
document.getElementById("country-search").addEventListener("input", function (e) {
  const searchTerm = e.target.value.toLowerCase();
  const wrappers   = document.querySelectorAll("#country-list-container .country-item");

  wrappers.forEach(wrapper => {
    const label = wrapper.querySelector("label");
    wrapper.style.display = label.textContent.toLowerCase().includes(searchTerm)
      ? ""        // revert to default (flex row)
      : "none";   // hide non-matching
  });
});

// ── Select All / Clear All (respects current filter) ─────────
document.getElementById("select-all-btn").addEventListener("click", () => {
  document.querySelectorAll("#country-list-container .country-item").forEach(wrapper => {
    if (wrapper.style.display !== "none") {
      wrapper.querySelector("input[type='checkbox']").checked = true;
    }
  });
});

document.getElementById("clear-all-btn").addEventListener("click", () => {
  document.querySelectorAll("#country-list-container .country-item").forEach(wrapper => {
    if (wrapper.style.display !== "none") {
      wrapper.querySelector("input[type='checkbox']").checked = false;
    }
  });
});

// ── Save ──────────────────────────────────────────────────────
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
loadCountriesAndPrefs().then(({ countries, selected }) => {
  if (countries.length === 0) {
    document.getElementById("country-list-container").innerHTML =
      '<p class="no-data">No election data cached yet. Open the extension popup first to load data, then return here.</p>';
    return;
  }
  buildCheckboxes(countries, selected);
});
