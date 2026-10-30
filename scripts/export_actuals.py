"""Export real results for backtests: per game the final score, first-inning runs and each starter's
box line, plus a season-to-date baseline (the player's average in his earlier starts that season).

python scripts/export_actuals.py --season 2025 --start 2025-08-04 --end 2025-09-29 --retro-dir <dir>
"""
import argparse
import json
import os
import sys

import pandas as pd

sys.path.insert(0, os.path.dirname(__file__))
import retro  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

ap = argparse.ArgumentParser()
ap.add_argument("--season", type=int, default=2025)
ap.add_argument("--start", required=True)
ap.add_argument("--end", required=True)
ap.add_argument("--retro-dir", default=os.path.join(ROOT, "data_raw"))
ap.add_argument("--out", default=os.path.join(ROOT, "backtest", "actuals.json"))
a = ap.parse_args()

games, pa, box, _ = retro.load_season(a.retro_dir, a.season)
games = games[games.gtype == "R"]
box = box[box.game.isin(games.game)].copy()
box["TB"] = box.H + box.D + 2 * box["T"] + 3 * box.HR
box["HRR"] = box.H + box.R + box.RBI
bat_stats = {"h": "H", "tb": "TB", "hr": "HR", "r": "R", "rbi": "RBI", "hrr": "HRR", "bb": "BB", "k": "K"}
pit_stats = {"pk": "pK", "outs": "outs", "er": "pER", "ph": "pH", "pbb": "pBB"}
box = box.sort_values("date")
out = []
for g in games[(games.date >= a.start) & (games.date < a.end)].sort_values("date").itertuples():
    rows = box[box.game == g.game]
    before = box[box.date < g.date]
    players = {}
    for r in rows.itertuples():
        if r.start == 1 and r.slot > 0:
            hist = before[(before.pid == r.pid) & (before.start == 1) & (before.slot > 0)]
            players[r.pid] = {"kind": "B", "act": {k: int(getattr(r, v)) for k, v in bat_stats.items()},
                              "base": {k: float(hist[v].mean()) for k, v in bat_stats.items()} if len(hist) >= 10 else None}
        if r.GS == 1:
            hist = before[(before.pid == r.pid) & (before.GS == 1)]
            players[r.pid + "|P"] = {"kind": "P", "pid": r.pid, "act": {k: int(getattr(r, v)) for k, v in pit_stats.items()},
                                     "base": {k: float(hist[v].mean()) for k, v in pit_stats.items()} if len(hist) >= 4 else None}
    out.append({"id": g.game, "date": g.date, "away": g.away, "home": g.home, "ascore": int(g.ascore), "hscore": int(g.hscore),
                "inn1": int(g.a_inn1 + g.h_inn1), "players": players})
os.makedirs(os.path.dirname(a.out), exist_ok=True)
json.dump(out, open(a.out, "w"))
print(f"wrote {len(out)} games to {a.out}")
