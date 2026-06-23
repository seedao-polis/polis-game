"""Line chart renderer for member counts and event signup trends. Supports multiple series."""
from datetime import datetime
import matplotlib.pyplot as plt
import matplotlib.dates as mdates

# Bright palette tuned for a dark background; cycles across series, first color used for single-series fill.
_PALETTE = ["#4dabf7", "#ffa94d", "#69db7c", "#da77f2", "#ff8787", "#3bc9db"]


def draw_line_chart(chart: dict, out_png: str, dpi: int = 200) -> None:
    """Render a 1920x1080 line chart from spec dict.

    chart keys:
      title     - chart title (shown at top)
      y_label   - y-axis label
      x_format  - strftime format for x-axis ticks ("%H:%M" for daily, "%m-%d" for monthly)
      lines     - list of {name, points:[{t: unix_seconds, y: number}]}
    """
    fig, ax = plt.subplots(figsize=(9.6, 5.4), dpi=dpi)  # 9.6 * 200 = 1920, 5.4 * 200 = 1080
    x_format = chart.get("x_format", "%H:%M")
    lines = chart.get("lines", [])

    for i, line in enumerate(lines):
        pts = sorted(line.get("points", []), key=lambda p: p["t"])
        if not pts:
            continue
        xs = [datetime.fromtimestamp(p["t"]) for p in pts]
        ys = [p["y"] for p in pts]
        color = _PALETTE[i % len(_PALETTE)]
        ax.plot(xs, ys, linewidth=2, color=color, label=line.get("name", ""))
        if len(lines) == 1:
            ax.fill_between(xs, ys, alpha=0.15, color=color)

    ax.set_title(chart.get("title", ""), fontsize=18)
    ax.set_xlabel("时间", fontsize=12)
    ax.set_ylabel(chart.get("y_label", ""), fontsize=12)
    ax.xaxis.set_major_formatter(mdates.DateFormatter(x_format))
    ax.grid(True, alpha=0.3)
    # Always show the legend at the top-left, even for a single line, so each line maps to its name.
    if any(line.get("name") for line in lines):
        ax.legend(fontsize=9, loc="upper left")
    fig.autofmt_xdate()
    fig.tight_layout()
    fig.savefig(out_png, dpi=dpi)
    plt.close(fig)
