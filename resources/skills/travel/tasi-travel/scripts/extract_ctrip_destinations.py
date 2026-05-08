#!/usr/bin/env python3
"""Extract Ctrip travel-guide destination links from you.ctrip.com.

The preferred path reads the server-rendered Next.js data block and falls back
to rendered /place/*.html anchors when that data is unavailable.
"""

from __future__ import annotations

import argparse
import csv
import html
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Iterable


DEFAULT_URL = "https://you.ctrip.com/"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0 Safari/537.36"
)


def fetch_html(url: str, timeout: int) -> str:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        charset = response.headers.get_content_charset() or "utf-8"
        return response.read().decode(charset, errors="replace")


def read_html(args: argparse.Namespace) -> str:
    if args.html_file:
        return Path(args.html_file).read_text(encoding=args.encoding)
    return fetch_html(args.url, args.timeout)


def normalize_url(href: str, base_url: str) -> str:
    absolute = urllib.parse.urljoin(base_url, html.unescape(href.strip()))
    parsed = urllib.parse.urlsplit(absolute)
    return urllib.parse.urlunsplit(
        (parsed.scheme, parsed.netloc, parsed.path, parsed.query, "")
    )


def clean_text(value: str) -> str:
    value = re.sub(r"<[^>]+>", "", value)
    value = html.unescape(value)
    return re.sub(r"\s+", " ", value).strip()


def normalize_name(value: Any) -> str:
    text = clean_text(str(value or ""))
    text = re.sub(r"(旅游攻略|自由行攻略|自助游攻略)$", "", text)
    return re.sub(r"\s+", "", text).casefold()


def iter_destination_items(
    city_selector_data: dict[str, Any], scope_filter: str
) -> Iterable[dict[str, Any]]:
    scope_map = {
        "domestic": "domesticTab",
        "international": "internationalTab",
    }
    scopes = (
        scope_map.items()
        if scope_filter == "all"
        else [(scope_filter, scope_map[scope_filter])]
    )

    for scope, key in scopes:
        tab_list = city_selector_data.get(key, {}).get("tabList", [])
        for tab in tab_list:
            tab_name = tab.get("tabName") or ""
            for item in tab.get("districtList", []):
                url = item.get("url")
                name = item.get("name")
                if not url or not name:
                    continue
                yield {
                    "scope": scope,
                    "tab": tab_name,
                    "id": item.get("id"),
                    "name": name,
                    "url": url,
                    "image": item.get("image"),
                    "sourceMethod": "__NEXT_DATA__",
                }


def extract_from_next_data(
    page_html: str, base_url: str, scope_filter: str
) -> list[dict[str, Any]]:
    match = re.search(
        r'<script[^>]+id=["\']__NEXT_DATA__["\'][^>]*>(?P<json>.*?)</script>',
        page_html,
        flags=re.IGNORECASE | re.DOTALL,
    )
    if not match:
        return []

    data = json.loads(html.unescape(match.group("json")))
    city_selector_data = (
        data.get("props", {})
        .get("pageProps", {})
        .get("initialState", {})
        .get("CitySelectorData", {})
    )

    rows = []
    for item in iter_destination_items(city_selector_data, scope_filter):
        item["url"] = normalize_url(str(item["url"]), base_url)
        rows.append(item)
    return rows


def extract_from_place_anchors(page_html: str, base_url: str) -> list[dict[str, Any]]:
    rows = []
    anchor_re = re.compile(
        r"<a\b(?P<attrs>[^>]*)>(?P<text>.*?)</a>",
        flags=re.IGNORECASE | re.DOTALL,
    )
    href_re = re.compile(
        r"""\bhref\s*=\s*(?P<quote>["'])(?P<href>(?:(?:https?:)?//you\.ctrip\.com)?/place/[^"']+\.html)(?P=quote)""",
        flags=re.IGNORECASE,
    )

    for anchor in anchor_re.finditer(page_html):
        href_match = href_re.search(anchor.group("attrs"))
        if not href_match:
            continue
        name = clean_text(anchor.group("text"))
        if not name:
            continue
        rows.append(
            {
                "scope": "",
                "tab": "",
                "id": "",
                "name": name,
                "url": normalize_url(href_match.group("href"), base_url),
                "image": "",
                "sourceMethod": "anchor_fallback",
            }
        )
    return rows


def dedupe_rows(rows: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    deduped: dict[str, dict[str, Any]] = {}
    for row in rows:
        url = str(row.get("url") or "")
        if url and url not in deduped:
            deduped[url] = row
    return list(deduped.values())


def filter_rows_by_name(
    rows: Iterable[dict[str, Any]], target_name: str | None
) -> list[dict[str, Any]]:
    if not target_name:
        return list(rows)

    target = normalize_name(target_name)
    return [row for row in rows if normalize_name(row.get("name")) == target]


def extract_destinations(
    page_html: str, base_url: str, scope_filter: str, target_name: str | None = None
) -> list[dict[str, Any]]:
    rows = extract_from_next_data(page_html, base_url, scope_filter)
    if not rows:
        rows = extract_from_place_anchors(page_html, base_url)
    return filter_rows_by_name(dedupe_rows(rows), target_name)


def write_json(rows: list[dict[str, Any]]) -> None:
    json.dump(rows, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")


def write_csv(rows: list[dict[str, Any]]) -> None:
    fieldnames = ["scope", "tab", "id", "name", "url", "image", "sourceMethod"]
    writer = csv.DictWriter(sys.stdout, fieldnames=fieldnames, extrasaction="ignore")
    writer.writeheader()
    writer.writerows(rows)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Extract Ctrip /place/*.html destination links from you.ctrip.com."
    )
    parser.add_argument("--url", default=DEFAULT_URL, help="Ctrip guide entry URL.")
    parser.add_argument(
        "--html-file",
        help="Read a saved HTML file instead of fetching --url.",
    )
    parser.add_argument(
        "--encoding",
        default="utf-8",
        help="Encoding used with --html-file. Default: utf-8.",
    )
    parser.add_argument(
        "--scope",
        choices=["all", "domestic", "international"],
        default="all",
        help="Limit Next.js data extraction to one destination scope.",
    )
    parser.add_argument(
        "--name",
        help="Return only exact destination-name matches, e.g. 三亚.",
    )
    parser.add_argument(
        "--require-match",
        action="store_true",
        help="Exit with code 2 when --name returns no exact match.",
    )
    parser.add_argument(
        "--format",
        choices=["json", "csv"],
        default="json",
        help="Output format. Default: json.",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=20,
        help="Network timeout in seconds when fetching --url.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    try:
        page_html = read_html(args)
        rows = extract_destinations(page_html, args.url, args.scope, args.name)
    except (OSError, urllib.error.URLError, json.JSONDecodeError, KeyError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    if args.require_match and args.name and not rows:
        print(f"error: no exact Ctrip destination match for {args.name}", file=sys.stderr)
        return 2

    if args.format == "csv":
        write_csv(rows)
    else:
        write_json(rows)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
