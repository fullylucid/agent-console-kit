#!/usr/bin/env python3
"""Render fit-probe.html's RESULTS blob (stdin) as one line per case; exit 1 if any case is bad."""
import sys, json, re
t = sys.stdin.read(); m = re.search(r"RESULTS (\[.*\]) LAG (\[.*\])", t)
if not m:
    print(t[:300] or "NO OUTPUT"); sys.exit(1)
rows = json.loads(m.group(1)); lag = json.loads(m.group(2)); bad = 0
# widerFits is a RESIDUAL, not a pass/fail per case: a fit that leaves under one quarter-step of
# slack is what the bucket and the 2px cap hysteresis buy, and demanding zero would trade a stable
# font for a tighter one. But "informational" was doing no work — the count printed and nothing
# read it, so a regression that doubled the residual passed as silently as a clean run. So it is
# bounded in AGGREGATE instead: measured on HEAD the probe shows 1-3 of 10 by design, and this
# fails past 40% of cases. Raise it deliberately with a number, or not at all.
WIDER_FITS_MAX_FRAC = 0.4
for r in rows:
    ok = not (r["overflowX"] or r["overflowY"] or not r["done"])
    bad += not ok
    print(f'{r["renderer"]} dpr{r["dpr"]} {r["w"]:5}x{r["h"]:<4} cols={r["cols"]} fs={r["fs"]:6} painted={r["painted"]:7} '
          f'gap={r["gap"]:6} rows={r["rows"]:3} mirrorH={r["mirrorH"]:5} heightBound={str(r["heightBound"]):5} '
          f'overflowX={str(r["overflowX"]):5} overflowY={str(r["overflowY"]):5} widerFits={str(r["widerFits"]):5} '
          f'passes={r["passes"]} done={r["done"]}{"" if ok else "  <-- BAD"}')
wider = sum(r['widerFits'] for r in rows)
allowed = int(len(rows) * WIDER_FITS_MAX_FRAC)
wider_bad = wider > allowed
print(f"cases={len(rows)} bad={bad} widerFits={wider}/{len(rows)} (allowed <= {allowed}, "
      f"{WIDER_FITS_MAX_FRAC:.0%}){'  <-- RESIDUAL EXCEEDED' if wider_bad else ''} "
      f"screen-box-lag-cases={len(lag)} {lag[:3]}")
sys.exit(1 if (bad or wider_bad) else 0)
