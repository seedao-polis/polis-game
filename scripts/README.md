# scripts/ — Python Chart Rendering

Stateless Python scripts that render PNG charts from a JSON spec produced by the Node ops-report
module. Node handles data access and Telegram delivery; Python handles all chart rendering.

## Setup

Create a dedicated virtualenv (required once per machine/container):

```bash
# From the project root
python3 -m venv scripts/.venv
scripts/.venv/bin/pip install -r scripts/requirements.txt
```

The virtualenv is excluded from version control (`scripts/.venv/` in `.gitignore`).
`requirements.txt` is version-controlled and should be reinstalled after any updates to it.

On Linux, Chinese labels require a CJK font package:

```bash
# Debian/Ubuntu
apt-get install -y fonts-noto-cjk

# For graphviz dot layout (optional — tree_chart.py falls back to pure-Python layout without it)
apt-get install -y graphviz
```

## Usage

The main entry point reads a spec JSON file and writes PNGs to the `out_dir` specified inside it:

```bash
scripts/.venv/bin/python3 scripts/render_report.py /path/to/spec.json
```

Stdout last line: JSON mapping chart keys to absolute PNG paths.
Stderr: per-chart warnings; a chart failure does not stop other charts.

## Standalone test

Create a minimal spec to verify rendering end-to-end:

```bash
mkdir -p /tmp/ops-test

cat > /tmp/ops-test/spec.json << 'EOF'
{
  "period": "daily",
  "range": {"from": 1750000000, "to": 1750086400},
  "width": 1920, "height": 1080, "dpi": 200,
  "out_dir": "/tmp/ops-test",
  "charts": [
    {
      "type": "line", "key": "member",
      "title": "围观群人数", "y_label": "群成员人数", "x_format": "%H:%M",
      "lines": [{"name": "SeeDAO 2.0 围观群", "points": [
        {"t": 1750000000, "y": 1200},
        {"t": 1750003600, "y": 1215},
        {"t": 1750007200, "y": 1210}
      ]}]
    },
    {
      "type": "tree", "key": "wiki", "title": "知识库浏览热点", "subtitle": "统计时间 ...",
      "nodes": [
        {"token": "root", "parent": null, "title": "数字城邦", "readers": 0},
        {"token": "n1", "parent": "root", "title": "白皮书", "readers": 42},
        {"token": "n2", "parent": "root", "title": "治理流程", "readers": 15}
      ]
    }
  ]
}
EOF

scripts/.venv/bin/python3 scripts/render_report.py /tmp/ops-test/spec.json
# Expected stdout: {"member": "/tmp/ops-test/member.png", "wiki": "/tmp/ops-test/wiki.png"}
```

## Syntax check

```bash
scripts/.venv/bin/python3 -m py_compile scripts/render_report.py
scripts/.venv/bin/python3 -m py_compile scripts/charts/fonts.py
scripts/.venv/bin/python3 -m py_compile scripts/charts/line_chart.py
scripts/.venv/bin/python3 -m py_compile scripts/charts/tree_chart.py
```
