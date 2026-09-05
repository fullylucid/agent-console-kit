#!/usr/bin/env python3
"""Render fit-probe.html's RESULTS blob (stdin) as one line per case; exit 1 if any case is bad."""
import sys, json, re
t = sys.stdin.read(); m = re.search(r"RESULTS (\[.*\]) LAG (\[.*\])", t)
if not m:
    print(t[:300] or "NO OUTPUT"); sys.exit(1)
rows = json.loads(m.group(1)); lag = json.loads(m.group(2)); bad = 0
for r in rows:
    ok = not (r["overflowX"] or r["overflowY"] or not r["done"])   # widerFits is informational: ≤ one quarter-step of slack
    bad += not ok
    print(f'{r["renderer"]} dpr{r["dpr"]} {r["w"]:5}x{r["h"]:<4} cols={r["cols"]} fs={r["fs"]:6} painted={r["painted"]:7} '
          f'gap={r["gap"]:6} rows={r["rows"]:3} mirrorH={r["mirrorH"]:5} heightBound={str(r["heightBound"]):5} '
          f'overflowX={str(r["overflowX"]):5} overflowY={str(r["overflowY"]):5} widerFits={str(r["widerFits"]):5} '
          f'passes={r["passes"]} done={r["done"]}{"" if ok else "  <-- BAD"}')
print(f"cases={len(rows)} bad={bad} widerFits={sum(r['widerFits'] for r in rows)} screen-box-lag-cases={len(lag)} {lag[:3]}"); sys.exit(1 if bad else 0)
