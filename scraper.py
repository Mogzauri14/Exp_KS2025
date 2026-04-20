"""
Global Elections Calendar Scraper
Scrapes 6 election monitoring sources and outputs elections.json
with data for the previous, current, and next calendar months.
"""

import json
import logging
import re
import sys
from datetime import datetime, date
from typing import Optional

import requests
from bs4 import BeautifulSoup

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger("elections-scraper")

SESSION = requests.Session()
SESSION.headers.update({
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    )
})
TIMEOUT = 30

# Session that skips SSL verification — used only for hosts with known
# self-signed / corporate-proxy certificate chains (e.g. odihr.osce.org).
SESSION_NO_VERIFY = requests.Session()
SESSION_NO_VERIFY.headers.update(SESSION.headers)
import urllib3
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

NOW = datetime.utcnow()
CURRENT_YEAR = NOW.year
CURRENT_MONTH = NOW.month


def _add_months(year: int, month: int, delta: int) -> tuple[int, int]:
    """Return (year, month) shifted by delta months."""
    m = month - 1 + delta
    return year + m // 12, m % 12 + 1


# Build the set of (year, month) we want to collect
TARGET_MONTHS: set[tuple[int, int]] = {
    _add_months(CURRENT_YEAR, CURRENT_MONTH, -1),
    (CURRENT_YEAR, CURRENT_MONTH),
    _add_months(CURRENT_YEAR, CURRENT_MONTH, 1),
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

MONTH_ABBR = {
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
    "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12,
    # full names
    "january": 1, "february": 2, "march": 3, "april": 4,
    "june": 6, "july": 7, "august": 8, "september": 9,
    "october": 10, "november": 11, "december": 12,
}


def _parse_date(raw: str) -> Optional[date]:
    """
    Attempt to parse a date string in several common formats.
    Returns a date object or None on failure.
    """
    raw = raw.strip().rstrip("(dtDT)").strip()
    # Remove trailing status chars like " (d)" or " (t)"
    raw = re.sub(r"\s*\([a-z]+\)\s*$", "", raw, flags=re.IGNORECASE).strip()

    formats = [
        "%d %b %Y",    # 19 Apr 2026
        "%d %B %Y",    # 19 April 2026
        "%b %d %Y",    # Apr 19 2026
        "%B %d %Y",    # April 19 2026
        "%b %d, %Y",   # Apr 19, 2026
        "%B %d, %Y",   # April 19, 2026
        "%Y-%m-%d",    # 2026-04-19
        "%d/%m/%Y",    # 19/04/2026
        "%m/%d/%Y",    # 04/19/2026
    ]
    for fmt in formats:
        try:
            return datetime.strptime(raw, fmt).date()
        except ValueError:
            pass

    # Try "Month YYYY" → use day 1
    m = re.match(r"^([A-Za-z]+)\s+(\d{4})$", raw)
    if m:
        mon = MONTH_ABBR.get(m.group(1).lower())
        if mon:
            try:
                return date(int(m.group(2)), mon, 1)
            except ValueError:
                pass

    return None


def _is_target_month(d: Optional[date]) -> bool:
    return d is not None and (d.year, d.month) in TARGET_MONTHS


def _get(url: str, verify: bool = True) -> Optional[BeautifulSoup]:
    sess = SESSION if verify else SESSION_NO_VERIFY
    try:
        resp = sess.get(url, timeout=TIMEOUT, verify=verify)
        resp.raise_for_status()
        return BeautifulSoup(resp.text, "html.parser")
    except Exception as exc:
        log.error("GET %s failed: %s", url, exc)
        return None


STATUS_KEYWORDS = {
    "postponed": "Postponed",
    "delayed": "Postponed",
    "cancelled": "Cancelled",
    "canceled": "Cancelled",
    "disputed": "Disputed",
}

TODAY = date.today()


def _derive_status(raw_text: str, date_obj: Optional[date]) -> str:
    """
    Derive election status from scraped text and/or date comparison.
    Keyword scan takes priority; falls back to temporal logic.
    """
    lower = raw_text.lower()
    for kw, status in STATUS_KEYWORDS.items():
        if kw in lower:
            return status
    if date_obj is None:
        return "Unknown"
    return "Upcoming" if date_obj > TODAY else "Held"


def _entry(date_obj: date, country: str, etype: str, source: str, link: str,
           raw_text: str = "") -> dict:
    return {
        "date": date_obj.strftime("%Y-%m-%d"),
        "country": country.strip(),
        "type": etype.strip(),
        "status": _derive_status(raw_text, date_obj),
        "source_name": source,
        "link": link.strip(),
    }


# ---------------------------------------------------------------------------
# Source 1: OSCE / ODIHR
# ---------------------------------------------------------------------------

def scrape_osce() -> list[dict]:
    SOURCE = "OSCE/ODIHR"
    BASE = "https://odihr.osce.org"
    URL = f"{BASE}/odihr/elections"
    log.info("Scraping %s ...", SOURCE)
    soup = _get(URL, verify=False)  # odihr.osce.org has self-signed cert in chain
    if soup is None:
        return []

    results = []
    # Server-side table: columns are date, status, country, type, link
    table = soup.find("table")
    if not table:
        log.warning("%s: no <table> found", SOURCE)
        return results

    for row in table.find_all("tr")[1:]:  # skip header
        cells = row.find_all("td")
        if len(cells) < 4:
            continue
        date_str = cells[0].get_text(strip=True)
        country  = cells[2].get_text(strip=True)
        etype    = cells[3].get_text(strip=True)

        # Link in 5th cell (may be absent → "-")
        link_tag = cells[4].find("a") if len(cells) > 4 else None
        if link_tag and link_tag.get("href"):
            href = link_tag["href"]
            link = href if href.startswith("http") else BASE + href
        else:
            link = URL

        d = _parse_date(date_str)
        if _is_target_month(d):
            raw = row.get_text(" ")
            results.append(_entry(d, country, etype, SOURCE, link, raw))

    log.info("%s: %d elections this month", SOURCE, len(results))
    return results


# ---------------------------------------------------------------------------
# Source 2: EEAS (EU Election Observation Missions)
# ---------------------------------------------------------------------------

def scrape_eeas() -> list[dict]:
    SOURCE = "EEAS"
    URL = "https://www.eeas.europa.eu/eeas/eu-election-observation-missions-1_en"
    log.info("Scraping %s ...", SOURCE)
    soup = _get(URL)
    if soup is None:
        return []

    results = []
    # Links follow the pattern: text = "EOM [Country] [YYYY]"
    # We can only extract year from the link text; no specific date available.
    # Include missions whose year appears in any of our target months.
    target_years = {y for y, _ in TARGET_MONTHS}
    pattern = re.compile(r"EOM\s+(.+?)\s+(\d{4})$", re.IGNORECASE)

    for a in soup.find_all("a"):
        text = (a.get_text(strip=True) or "").strip()
        m = pattern.match(text)
        if not m:
            continue
        country = m.group(1).strip()
        year = int(m.group(2))
        if year not in target_years:
            continue

        href = a.get("href", "")
        if href.startswith("//"):
            href = "https:" + href
        elif href.startswith("/"):
            href = "https://www.eeas.europa.eu" + href

        # No exact date — use first day of current month as placeholder
        mission_date = date(CURRENT_YEAR, CURRENT_MONTH, 1)
        results.append(_entry(mission_date, country, "EU Election Observation Mission", SOURCE, href, text))

    log.info("%s: %d missions this year", SOURCE, len(results))
    return results


# ---------------------------------------------------------------------------
# Source 3: Carter Center
# ---------------------------------------------------------------------------

def scrape_carter_center() -> list[dict]:
    SOURCE = "Carter Center"
    BASE = "https://www.cartercenter.org"
    URL = f"{BASE}/programs/democracy/elections-observed/"
    log.info("Scraping %s ...", SOURCE)
    soup = _get(URL)
    if soup is None:
        return []

    results = []
    # Structure: <dt><strong><a href="...">Country</a></strong></dt>
    #            <dd>Month YYYY, Month YYYY, ...</dd>
    for dt in soup.find_all("dt"):
        strong = dt.find("strong")
        if not strong:
            continue
        a_tag = strong.find("a")
        country = a_tag.get_text(strip=True) if a_tag else strong.get_text(strip=True)
        link = BASE + a_tag["href"] if a_tag and a_tag.get("href", "").startswith("/") else (a_tag["href"] if a_tag else URL)

        dd = dt.find_next_sibling("dd")
        if not dd:
            continue
        dates_text = dd.get_text(strip=True)
        # Split on commas, try to parse each token
        for token in dates_text.split(","):
            token = token.strip().lstrip("*").strip()
            d = _parse_date(token)
            if _is_target_month(d):
                raw = (dt.get_text(" ") + " " + (dd.get_text(" ") if dd else ""))
                results.append(_entry(d, country, "Election Observation", SOURCE, link, raw))

    log.info("%s: %d elections this month", SOURCE, len(results))
    return results


# ---------------------------------------------------------------------------
# Source 4: ElectionGuide
# ---------------------------------------------------------------------------

def scrape_election_guide() -> list[dict]:
    SOURCE = "ElectionGuide"
    BASE = "https://www.electionguide.org"
    URL = f"{BASE}/elections/"
    log.info("Scraping %s ...", SOURCE)
    soup = _get(URL)
    if soup is None:
        return []

    results = []

    # --- Table rows (more reliably structured) ---
    for table in soup.find_all("table"):
        for row in table.find_all("tr"):
            cells = row.find_all("td")
            if len(cells) < 4:
                continue
            # cells: [flag img, country link, election link, date]
            country_a = cells[1].find("a")
            election_a = cells[2].find("a")
            date_str = cells[3].get_text(strip=True)

            if not country_a or not election_a:
                continue

            country = country_a.get_text(strip=True)
            etype = election_a.get_text(strip=True)
            href = election_a.get("href", "")
            link = href if href.startswith("http") else BASE + href

            d = _parse_date(date_str)
            if _is_target_month(d):
                raw = row.get_text(" ")
                results.append(_entry(d, country, etype, SOURCE, link, raw))

    # --- Card divs (upcoming section) ---
    # Look for divs that contain a <strong> date + two <a> tags
    if not results:
        for div in soup.find_all("div"):
            strong = div.find("strong")
            links = div.find_all("a", recursive=False)
            if not strong or len(links) < 2:
                continue
            date_str = strong.get_text(strip=True)
            d = _parse_date(date_str)
            if not _is_target_month(d):
                continue
            etype = links[0].get_text(strip=True)
            country = links[1].get_text(strip=True)
            href = links[0].get("href", "")
            link = href if href.startswith("http") else BASE + href
            raw = div.get_text(" ")
            results.append(_entry(d, country, etype, SOURCE, link, raw))

    log.info("%s: %d elections this month", SOURCE, len(results))
    return results


# ---------------------------------------------------------------------------
# Source 5: A-WEB
# ---------------------------------------------------------------------------

def scrape_aweb() -> list[dict]:
    SOURCE = "A-WEB"
    URL = "https://www.aweb.org/eng/bbs/B0000007/list.do?menuNo=300052"
    log.info("Scraping %s ...", SOURCE)
    soup = _get(URL)
    if soup is None:
        return []

    results = []
    table = soup.find("table")
    if not table:
        log.warning("%s: no <table> found", SOURCE)
        return results

    for row in table.find_all("tr")[1:]:  # skip header
        cells = row.find_all("td")
        if len(cells) < 4:
            continue
        # cols: [flag, country, election type (text + empty <a> for link), date]
        # The <a> href is the external link but its text is empty;
        # the election type text is a sibling text node in the same <td>.
        country  = cells[1].get_text(strip=True)
        etype    = cells[2].get_text(strip=True)  # full cell text
        etype_a  = cells[2].find("a")
        href     = etype_a["href"] if etype_a and etype_a.get("href") else URL
        link     = href if href.startswith("http") else URL
        date_str = cells[3].get_text(strip=True)

        d = _parse_date(date_str)
        if _is_target_month(d):
            raw = row.get_text(" ")
            results.append(_entry(d, country, etype, SOURCE, link, raw))

    log.info("%s: %d elections this month", SOURCE, len(results))
    return results


# ---------------------------------------------------------------------------
# Source 6: IPU (Inter-Parliamentary Union)
# ---------------------------------------------------------------------------

def scrape_ipu() -> list[dict]:
    SOURCE = "IPU"
    BASE = "https://data.ipu.org"
    URL = f"{BASE}/elections/"
    log.info("Scraping %s ...", SOURCE)
    soup = _get(URL)
    if soup is None:
        return []

    results = []
    table = soup.find("table")
    if not table:
        log.warning("%s: no <table> found", SOURCE)
        return results

    for row in table.find_all("tr")[1:]:
        cells = row.find_all("td")
        if len(cells) < 7:
            continue
        country  = cells[0].get_text(strip=True)
        parl_a   = cells[1].find("a")
        etype    = parl_a.get_text(strip=True) if parl_a else cells[1].get_text(strip=True)
        href     = parl_a["href"] if parl_a and parl_a.get("href") else URL
        link     = href if href.startswith("http") else BASE + href
        # col 6 = "Expected date of next elections"
        date_str = cells[6].get_text(strip=True)

        d = _parse_date(date_str)
        if _is_target_month(d):
            raw = row.get_text(" ")
            results.append(_entry(d, country, etype, SOURCE, link, raw))

    log.info("%s: %d elections this month", SOURCE, len(results))
    return results


# ---------------------------------------------------------------------------
# Source 7: Wikipedia — 2026 local electoral calendar
# ---------------------------------------------------------------------------

def scrape_wikipedia_local() -> list[dict]:
    SOURCE = "Wikipedia"
    BASE = "https://en.wikipedia.org"
    URL = f"{BASE}/wiki/2026_local_electoral_calendar"
    log.info("Scraping %s ...", SOURCE)
    soup = _get(URL)
    if soup is None:
        return []

    # Month name → number mapping (covers full names on Wikipedia headings)
    MONTH_NUM = {
        "january": 1, "february": 2, "march": 3, "april": 4,
        "may": 5, "june": 6, "july": 7, "august": 8,
        "september": 9, "october": 10, "november": 11, "december": 12,
    }

    results = []
    content = soup.find("div", class_="mw-parser-output")
    if not content:
        log.warning("%s: mw-parser-output not found", SOURCE)
        return results

    # Wikipedia wraps each h2 in <div class="mw-heading mw-heading2">.
    # The <ul> of elections is a sibling of that wrapper div.
    # Walk every mw-heading2 div, resolve the month, then grab the next <ul>.
    for heading_div in content.find_all("div", class_="mw-heading2"):
        h2 = heading_div.find("h2")
        if not h2:
            continue
        heading_text = re.sub(r"\[.*?\]", "", h2.get_text(strip=True)).strip().lower()
        month_num = MONTH_NUM.get(heading_text)
        if month_num is None:
            continue
        month_name_str = heading_text.capitalize()

        # The elections <ul> is the next sibling tag after the heading div
        ul = heading_div.find_next_sibling("ul")
        if not ul:
            continue

        for li in ul.find_all("li", recursive=False):
            raw_text = li.get_text(" ", strip=True)

            # Date is the text before the first colon
            colon_pos = raw_text.find(":")
            if colon_pos == -1:
                continue
            date_part = raw_text[:colon_pos].strip()

            # date_part already contains the month name (e.g. "4 April");
            # just append the year to get a parseable string.
            date_str = f"{date_part} 2026"
            d = _parse_date(date_str)
            if not _is_target_month(d):
                continue

            # Country: first <a> link in the li
            description = raw_text[colon_pos + 1:].strip()
            first_link = li.find("a")
            country = first_link.get_text(strip=True) if first_link else description.split(",")[0].strip()

            # Type: everything after the country name (strip leading separators)
            etype = re.sub(r"^[\s,–—-]+", "", description[len(country):]).strip()
            if not etype:
                etype = "Local election"

            # Link: prefer the first wiki link
            href = first_link["href"] if first_link and first_link.get("href") else URL
            link = href if href.startswith("http") else BASE + href

            results.append(_entry(d, country, etype, SOURCE, link, raw_text))

    log.info("%s: %d local elections in target months", SOURCE, len(results))
    return results


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

SCRAPERS = [
    scrape_osce,
    scrape_eeas,
    scrape_carter_center,
    scrape_election_guide,
    scrape_aweb,
    scrape_ipu,
    scrape_wikipedia_local,
]


def main():
    prev_ym  = _add_months(CURRENT_YEAR, CURRENT_MONTH, -1)
    next_ym  = _add_months(CURRENT_YEAR, CURRENT_MONTH,  1)
    log.info(
        "Running elections scraper — collecting %04d-%02d / %04d-%02d / %04d-%02d",
        prev_ym[0], prev_ym[1], CURRENT_YEAR, CURRENT_MONTH, next_ym[0], next_ym[1],
    )

    all_elections: list[dict] = []
    errors: list[str] = []

    for scraper in SCRAPERS:
        try:
            results = scraper()
            all_elections.extend(results)
        except Exception as exc:
            name = scraper.__name__
            log.error("Unhandled error in %s: %s", name, exc, exc_info=True)
            errors.append(f"{name}: {exc}")

    # Deduplicate on (date, country, type)
    seen: set = set()
    unique: list[dict] = []
    for e in all_elections:
        key = (e["date"], e["country"].lower(), e["type"].lower())
        if key not in seen:
            seen.add(key)
            unique.append(e)

    # Sort by date
    unique.sort(key=lambda x: x["date"])

    # Bucket into per-month lists
    months_data: dict[str, list[dict]] = {}
    for ym in sorted(TARGET_MONTHS):
        months_data[f"{ym[0]}-{ym[1]:02d}"] = []
    for e in unique:
        ym_key = e["date"][:7]  # "YYYY-MM"
        if ym_key in months_data:
            months_data[ym_key].append(e)

    output = {
        "generated_at": NOW.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "current_month": f"{CURRENT_YEAR}-{CURRENT_MONTH:02d}",
        "months": months_data,
        "errors": errors,
    }

    out_path = "elections.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2, ensure_ascii=False)

    total = sum(len(v) for v in months_data.values())
    log.info("Wrote %d unique elections across %d months to %s", total, len(months_data), out_path)
    if errors:
        log.warning("Sources with errors: %s", ", ".join(errors))


if __name__ == "__main__":
    main()
