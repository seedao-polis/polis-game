"""CJK font setup for matplotlib. Registers available fonts and writes rcParams so Chinese labels render correctly."""
import os
import matplotlib
from matplotlib import font_manager

# Candidate font paths aligned with src/core/event-render.ts ensureFont() list.
_FONT_CANDIDATES = [
    "/System/Library/Fonts/PingFang.ttc",                       # macOS
    "/System/Library/Fonts/STHeiti Medium.ttc",                 # macOS fallback
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",   # Linux noto-cjk
    "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",             # Linux WenQuanYi
]

# Family names in preference order, matching the fonts above.
_FAMILY_PREF = ["PingFang SC", "Heiti SC", "Noto Sans CJK SC", "WenQuanYi Zen Hei"]


def setup_cjk_font() -> str:
    """Register available CJK fonts and configure rcParams. Returns the first preferred family name."""
    for path in _FONT_CANDIDATES:
        if os.path.exists(path):
            try:
                font_manager.fontManager.addfont(path)
            except Exception:
                pass
    matplotlib.rcParams["font.sans-serif"] = _FAMILY_PREF + ["sans-serif"]
    matplotlib.rcParams["axes.unicode_minus"] = False  # render minus sign correctly
    return matplotlib.rcParams["font.sans-serif"][0]


# Dark theme palette: deep background with light foreground for lines, labels, axes and ticks.
DARK_BG = "#1a1b1e"
DARK_FG = "#e9ecef"
DARK_MUTED = "#adb5bd"
DARK_GRID = "#343a40"


def apply_dark_theme() -> None:
    """Configure a dark-background theme: dark canvas with light text, axes, ticks and grid."""
    matplotlib.rcParams.update({
        "figure.facecolor": DARK_BG,
        "savefig.facecolor": DARK_BG,
        "axes.facecolor": DARK_BG,
        "axes.edgecolor": DARK_MUTED,
        "axes.labelcolor": DARK_FG,
        "axes.titlecolor": DARK_FG,
        "text.color": DARK_FG,
        "xtick.color": DARK_MUTED,
        "ytick.color": DARK_MUTED,
        "grid.color": DARK_GRID,
    })
