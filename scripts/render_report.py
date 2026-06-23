#!/usr/bin/env python3
"""Read a JSON spec, render each chart to PNG in out_dir, and print a JSON mapping to stdout.

Usage: python3 render_report.py <spec.json>

The spec must contain:
  out_dir  - output directory for PNGs
  dpi      - (optional) output DPI, default 200 -> 1920x1080 at figsize (9.6, 5.4)
  charts   - list of chart specs with keys: type ("line"|"tree"), key, ...chart-specific fields

Stdout last line: JSON object mapping chart key to absolute PNG path.
Each chart failure is reported to stderr without stopping other charts.
"""
import json
import os
import sys

from charts.fonts import setup_cjk_font, apply_dark_theme
from charts.line_chart import draw_line_chart
from charts.tree_chart import draw_tree_chart


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: render_report.py <spec.json>", file=sys.stderr)
        return 2

    spec_path = sys.argv[1]
    try:
        with open(spec_path, "r", encoding="utf-8") as f:
            spec = json.load(f)
    except Exception as e:
        print(f"failed to read spec: {e}", file=sys.stderr)
        return 1

    setup_cjk_font()
    apply_dark_theme()

    out_dir = spec.get("out_dir", "/tmp/ops-report")
    os.makedirs(out_dir, exist_ok=True)
    dpi = spec.get("dpi", 200)

    produced: dict = {}
    for chart in spec.get("charts", []):
        key = chart.get("key") or chart.get("type", "unknown")
        out_png = os.path.join(out_dir, f"{key}.png")
        try:
            if chart["type"] == "line":
                draw_line_chart(chart, out_png, dpi)
            elif chart["type"] == "tree":
                draw_tree_chart(chart, out_png, dpi)
            else:
                print(f"unknown chart type: {chart['type']}", file=sys.stderr)
                continue
            produced[key] = out_png
        except Exception as e:
            print(f"chart {key} failed: {e}", file=sys.stderr)

    # Node side reads this final JSON line.
    print(json.dumps(produced, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
