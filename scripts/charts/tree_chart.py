"""Knowledge-base reading distribution as a networkx node graph. Node size encodes reader count.

Layout preference: graphviz dot (top-down tree). Falls back to a pure-Python BFS hierarchical
layout when pygraphviz or system graphviz is unavailable (Python 3.14+ / no graphviz package).
"""
import math

import networkx as nx
import matplotlib.pyplot as plt

# Node fill interpolates between staff blue and non-staff red by the non-staff reader share.
# Medium tones tuned for a dark background: clear but neither glaring-bright nor muddy-dark,
# and their midpoint blend stays a readable muted purple.
_STAFF_BLUE = (0x4A, 0x84, 0xC4)
_NONSTAFF_RED = (0xC4, 0x5A, 0x5A)
_FOLDER_GREY = "#868e96"


def _blend_staff_color(nonstaff_ratio: float) -> str:
    """Blend from staff blue (0.0) to non-staff red (1.0) by the non-staff reader share."""
    r = max(0.0, min(1.0, nonstaff_ratio))
    rgb = tuple(round(_STAFF_BLUE[i] + (_NONSTAFF_RED[i] - _STAFF_BLUE[i]) * r) for i in range(3))
    return "#%02x%02x%02x" % rgb


def _hierarchy_pos(G: "nx.DiGraph", roots: list) -> dict:
    """Pure-Python BFS hierarchical layout: y by depth, x by position within level."""
    levels: dict = {}
    depth: dict = {}
    seen: set = set()
    queue = [(r, 0) for r in roots]
    while queue:
        node, d = queue.pop(0)
        if node in seen:
            continue
        seen.add(node)
        depth[node] = d
        levels.setdefault(d, []).append(node)
        queue.extend((c, d + 1) for c in G.successors(node))
    pos = {}
    max_d = max(levels) if levels else 0
    for d, nodes in levels.items():
        n = len(nodes)
        for i, node in enumerate(nodes):
            x = (i + 1) / (n + 1)
            y = 1.0 - (d / (max_d + 1))  # root at top, leaves at bottom
            pos[node] = (x, y)
    return pos


def _level_stats(G: "nx.DiGraph", roots: list) -> tuple:
    """Return (depth, max_level_width) from a BFS, used to size the canvas to the tree."""
    levels: dict = {}
    seen: set = set()
    queue = [(r, 0) for r in roots]
    while queue:
        node, d = queue.pop(0)
        if node in seen:
            continue
        seen.add(node)
        levels.setdefault(d, []).append(node)
        queue.extend((c, d + 1) for c in G.successors(node))
    depth = (max(levels) + 1) if levels else 1
    max_width = max((len(v) for v in levels.values()), default=1)
    return depth, max_width


def draw_tree_chart(chart: dict, out_png: str, dpi: int = 200) -> None:
    """Render a knowledge-base browsing-hotspot tree.

    The canvas grows with the tree's breadth and depth so labels never crowd. Each circle's radius
    scales linearly between the chart's minimum and maximum distinct-reader counts, so small
    differences in reader count are visible. Folder nodes with no readers render as a uniform small dot.

    chart keys:
      title    - chart title
      subtitle - optional line under the title (e.g. statistics time range)
      nodes    - list of {token, parent (token or null), title, readers, nonstaff}
                 readers/nonstaff are DISTINCT reader counts (deduplicated per person), not raw views.
    Node color fades from staff blue to non-staff red by the non-staff share (nonstaff / readers).
    Each read node shows "(non-staff readers) distinct readers" at the top-left of its circle.
    """
    G: nx.DiGraph = nx.DiGraph()
    for n in chart.get("nodes", []):
        G.add_node(n["token"], label=n.get("title", ""), readers=n.get("readers", 0),
                   nonstaff=n.get("nonstaff", 0))
    for n in chart.get("nodes", []):
        if n.get("parent") and G.has_node(n["parent"]):
            G.add_edge(n["parent"], n["token"])

    roots = [n for n in G.nodes if G.in_degree(n) == 0]

    # Prefer graphviz dot layout for clean top-down tree structure; fall back when unavailable.
    try:
        pos = nx.nx_agraph.graphviz_layout(G, prog="dot")
    except Exception:
        pos = _hierarchy_pos(G, roots)

    # Canvas grows with tree breadth and depth so node labels stay readable.
    depth, max_width = _level_stats(G, roots)
    w_in = max(12.0, max_width * 1.6)
    h_in = max(7.0, depth * 2.3)
    # Bound the pixel dimensions for messaging by lowering effective dpi on very large canvases.
    eff_dpi = max(60, min(dpi, int(7000 / max(w_in, h_in))))

    # Radius maps linearly across the chart's browse-count range for sensitivity; folders stay small.
    readers = {t: G.nodes[t]["readers"] for t in G.nodes}
    browsed = [v for v in readers.values() if v > 0]
    v_min = min(browsed) if browsed else 0
    v_max = max(browsed) if browsed else 0
    r_min, r_max, r_folder = 9.0, 42.0, 6.0

    def radius_for(v: int) -> float:
        if v <= 0:
            return r_folder
        if v_max <= v_min:
            return (r_min + r_max) / 2.0
        return r_min + (v - v_min) / (v_max - v_min) * (r_max - r_min)

    node_radius = {t: radius_for(readers[t]) for t in G.nodes}
    sizes = [math.pi * node_radius[t] ** 2 for t in G.nodes]
    # Browsed nodes fade blue->red by non-staff share; folders (no browses) stay neutral grey.
    def _nonstaff_ratio(t: str) -> float:
        total = readers[t]
        return (G.nodes[t]["nonstaff"] / total) if total > 0 else 0.0

    node_colors = [
        _blend_staff_color(_nonstaff_ratio(t)) if readers[t] > 0 else _FOLDER_GREY
        for t in G.nodes
    ]
    labels = {t: G.nodes[t]["label"] for t in G.nodes}

    fig, ax = plt.subplots(figsize=(w_in, h_in), dpi=eff_dpi)
    nx.draw_networkx_edges(G, pos, ax=ax, edge_color="#adb5bd", arrows=False)
    nx.draw_networkx_nodes(G, pos, ax=ax, node_size=sizes,
                           node_color=node_colors, alpha=1.0, linewidths=0)
    nx.draw_networkx_labels(G, pos, labels, ax=ax, font_size=8, font_color="#e9ecef")

    # "(non-staff readers) distinct readers" printed at the top-left of each read circle.
    for t in G.nodes:
        if readers[t] <= 0:
            continue
        r = node_radius[t]
        label = f"({G.nodes[t]['nonstaff']}) {readers[t]}"
        ax.annotate(label, xy=pos[t], xycoords="data",
                    xytext=(-r, r), textcoords="offset points",
                    ha="right", va="bottom", fontsize=8, color="#74c0fc")

    ax.margins(0.10)
    ax.axis("off")
    # Keep the subtitle a fixed short distance below the title regardless of canvas height, and
    # reserve a header band above the tree so neither overlaps the nodes.
    fig.subplots_adjust(top=max(0.78, 1.0 - 1.4 / h_in), bottom=0.02, left=0.02, right=0.98)
    title_y = 0.985
    fig.suptitle(chart.get("title", ""), fontsize=18, y=title_y)
    subtitle = chart.get("subtitle", "")
    if subtitle:
        fig.text(0.5, title_y - 0.45 / h_in, subtitle, ha="center", va="top",
                 fontsize=11, color="#adb5bd")
    fig.savefig(out_png, dpi=eff_dpi)
    plt.close(fig)
