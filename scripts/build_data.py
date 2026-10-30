"""Build site/data/model.json for Diamond Sim.

Sources
  --source statsapi   (default) MLB Stats API: this season + last season, upcoming schedule, rosters
  --source retro      Retrosheet event files (development and backtests; completed seasons only)

Usage
  python scripts/build_data.py                                  # live build (GitHub Action)
  python scripts/build_data.py --source retro --season 2025 --asof 2025-09-01 --out backtest/model_2025-09-01.json
"""
import argparse
import datetime as dt
import json
import math
import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(__file__))
from teams import BY_ABBR, TEAMS  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUTCOMES = ["k", "bb", "hbp", "s", "d", "t", "hr"]  # per-PA rates; the remainder is an out in play
EVMAP = {"K": "k", "BB": "bb", "IBB": "bb", "HBP": "hbp", "1B": "s", "2B": "d", "3B": "t", "HR": "hr"}
# Regression strength, in (recency-weighted) plate appearances / batters faced, toward the league mean
PRIOR_BAT = {"k": 70, "bb": 140, "hbp": 300, "s": 450, "d": 800, "t": 1000, "hr": 220, "gb": 150}
PRIOR_PIT = {"k": 90, "bb": 180, "hbp": 400, "s": 900, "d": 1400, "t": 2000, "hr": 650, "gb": 120}
HALF_LIFE = 100  # days
PRIOR_SEASON_W = 0.7


def log(*a):
    print(*a, flush=True)


def pid_str(x):
    if x is None or (isinstance(x, float) and math.isnan(x)):
        return None
    if isinstance(x, (int, np.integer)) or (isinstance(x, float) and x == int(x)):
        return str(int(x))
    return str(x)


def short_name(full):
    parts = str(full).replace(" Jr.", "").replace(" Sr.", "").replace(" II", "").replace(" III", "").split()
    if len(parts) < 2:
        return str(full)
    return f"{parts[0][0]}. {' '.join(parts[1:])}"


# ---------------------------------------------------------------- load
def load(args):
    raw = os.path.join(ROOT, "data_raw")
    seasons = [args.season - 1, args.season]
    frames = {"games": [], "pa": [], "box": []}
    people, rosters, upcoming = {}, None, []
    if args.source == "retro":
        import retro
        if not args.retro_dir:
            retro.fetch(raw, seasons)
        for y in seasons:
            g, p, b, ppl = retro.load_season(args.retro_dir or raw, y)
            frames["games"].append(g); frames["pa"].append(p); frames["box"].append(b)
            for r in ppl.to_dict("records"):
                people[r["pid"]] = r
    else:
        import statsapi
        for y in seasons:
            g, p, b, hands = statsapi.load_season(raw, y, asof=args.asof, log=log)
            if len(g) == 0:
                continue
            frames["games"].append(g); frames["pa"].append(p); frames["box"].append(b)
        ids = set()
        for b in frames["box"]:
            ids |= set(b["pid"].dropna().astype(int))
        people = {str(k): v for k, v in statsapi.people(sorted(ids)).items()}
        today = args.asof or dt.datetime.now(dt.timezone(dt.timedelta(hours=-5))).date().isoformat()
        d0 = (dt.date.fromisoformat(today) - dt.timedelta(days=6)).isoformat()
        d1 = (dt.date.fromisoformat(today) + dt.timedelta(days=8)).isoformat()
        try:
            upcoming = statsapi.schedule(d0, d1)
        except Exception as e:
            log("  upcoming schedule fetch failed:", e)
            upcoming = []
        try:
            rosters = statsapi.rosters(args.season)
        except Exception as e:  # rosters are a nice-to-have
            log("  roster fetch failed:", e)
        newids = set()
        for g in upcoming:
            newids |= {g["a_prob"], g["h_prob"], *g["a_lineup"], *g["h_lineup"]}
        if rosters:
            for t in rosters.values():
                newids |= {r["pid"] for r in t}
        newids = {i for i in newids if i is not None and str(i) not in people}
        if newids:
            people.update({str(k): v for k, v in statsapi.people(sorted(newids)).items()})
    games = pd.concat(frames["games"], ignore_index=True)
    pa = pd.concat(frames["pa"], ignore_index=True)
    box = pd.concat(frames["box"], ignore_index=True)
    for df, cols in ((games, ["game", "a_sp", "h_sp"]), (pa, ["game", "bat", "pit"]), (box, ["game", "pid"])):
        for c in cols:
            df[c] = df[c].map(pid_str)
    return games, pa, box, people, rosters, upcoming


# ---------------------------------------------------------------- helpers
def weights(dates, asof, seasons, cur):
    days = (pd.Timestamp(asof) - pd.to_datetime(dates)).dt.days.clip(lower=0)
    w = np.power(0.5, days / HALF_LIFE)
    return w * np.where(seasons == cur, 1.0, PRIOR_SEASON_W)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", default="statsapi", choices=["statsapi", "retro"])
    ap.add_argument("--season", type=int, default=None)
    ap.add_argument("--asof", default=None, help="only use games before this date (YYYY-MM-DD)")
    ap.add_argument("--out", default=os.path.join(ROOT, "site", "data", "model.json"))
    ap.add_argument("--retro-dir", default=None, help="folder that holds seasons/<year> Retrosheet files")
    ap.add_argument("--refresh", action="store_true", help="(kept for workflow compatibility)")
    args = ap.parse_args()
    now = dt.datetime.now(dt.timezone.utc)
    if args.season is None:
        args.season = now.year if now.month >= 3 else now.year - 1

    games, pa, box, people, rosters, upcoming = load(args)
    if args.asof:
        games = games[games.date < args.asof]
        pa = pa[pa.date < args.asof]
        box = box[box.date < args.asof]
    asof = args.asof or (pd.Timestamp(games.date.max()) + pd.Timedelta(days=1)).date().isoformat()
    cur = args.season if (games.season == args.season).any() else args.season - 1
    log(f"games {len(games)}, PAs {len(pa)}, box rows {len(box)}, current season {cur}, as of {asof}")

    reg = games[games.gtype == "R"]
    regpa = pa[pa.game.isin(reg.game)]
    recent_pa = regpa[regpa.season == regpa.season.max()]

    # ---------- league
    n = len(recent_pa)
    ev = recent_pa.ev.map(EVMAP)
    lg = {k: float((ev == k).sum() / n) for k in OUTCOMES}
    inplay = recent_pa[recent_pa.ev.isin(["OUT", "E", "FC", "CI"])]
    bipouts = recent_pa[recent_pa.ev.isin(["OUT"]) & (recent_pa.bip != "")]
    lg_bip = {t: float((bipouts.bip == t).mean()) for t in "GFLP"}
    allbip = recent_pa[recent_pa.bip != ""]
    lg_gb = float((allbip.bip == "G").mean())
    # outcome mix by batted-ball type (for drawing the play), and the error rate on balls in play
    err_rate = float((inplay.ev == "E").sum() / max(1, len(inplay)))
    # platoon multipliers
    plat = {}
    for bh in "LR":
        for ph in "LR":
            sub = recent_pa[(recent_pa.bhand == bh) & (recent_pa.phand == ph)]
            e2 = sub.ev.map(EVMAP)
            plat[bh + ph] = {k: round(float((e2 == k).sum() / max(1, len(sub)) / lg[k]), 4) for k in OUTCOMES}
    # situational rates
    g1 = recent_pa[(recent_pa.ev == "OUT") & (recent_pa.bip == "G") & (recent_pa.r1 == 1) & (recent_pa.outs < 2)]
    dp_rate = float(g1.dp.mean()) if len(g1) else 0.4
    f3 = recent_pa[(recent_pa.ev == "OUT") & (recent_pa.bip == "F") & (recent_pa.r3 == 1) & (recent_pa.outs < 2)]
    sf_rate = float((f3.runs > 0).mean()) if len(f3) else 0.55
    ppa = {k: float(recent_pa[recent_pa.ev.isin(v)].pitches.mean()) for k, v in
           {"k": ["K"], "bb": ["BB"], "hbp": ["HBP"], "bip": ["OUT", "1B", "2B", "3B", "HR", "E", "FC"]}.items()}
    regbox = box[box.game.isin(reg.game) & (box.season == recent_pa.season.max())]
    on1 = regbox[["H", "BB", "HBP"]].sum().sum() - regbox[["D", "T", "HR"]].sum().sum()
    sb_att = float((regbox.SB.sum() + regbox.CS.sum()) / max(1, on1))
    sb_pct = float(regbox.SB.sum() / max(1, regbox.SB.sum() + regbox.CS.sum()))
    regg = reg[reg.season == reg.season.max()]
    rpg = float((regg.ascore + regg.hscore).mean() / 2)
    home_win = float((regg.hscore > regg.ascore).mean())
    nrfi = float(((regg.a_inn1 + regg.h_inn1) == 0).mean())
    sp_rows = regbox[regbox.GS == 1]
    lg_sp_pitches = float(sp_rows.PIT.mean())
    lg_sp_outs = float(sp_rows.outs.mean())
    # starter vs reliever league rates (reliever priors)
    pit_role = regbox[regbox.BF > 0].assign(role=lambda d: np.where(d.GS == 1, "SP", "RP"))
    role_of = {(r.game, r.pid): r.role for r in pit_role.itertuples()}
    pr = recent_pa.assign(role=[role_of.get((g, p), "RP") for g, p in zip(recent_pa.game, recent_pa.pit)])
    lg_role = {}
    for role in ("SP", "RP"):
        sub = pr[pr.role == role]
        e2 = sub.ev.map(EVMAP)
        lg_role[role] = {k: float((e2 == k).sum() / max(1, len(sub))) for k in OUTCOMES}
    league = {
        "rates": {k: round(v, 5) for k, v in lg.items()}, "bip": {k: round(v, 4) for k, v in lg_bip.items()},
        "gb": round(lg_gb, 4), "platoon": plat, "dp": round(dp_rate, 4), "sf": round(sf_rate, 4),
        "err": round(err_rate, 4), "ppa": {k: round(v, 3) for k, v in ppa.items()},
        "sb_att": round(sb_att, 4), "sb_pct": round(sb_pct, 4), "rpg": round(rpg, 3), "home_win": round(home_win, 4),
        "nrfi": round(nrfi, 4), "sbpg": round(float(regbox.SB.sum() / max(1, 2 * len(regg))), 4),
        "hpg": round(float(regbox.H.sum() / max(1, 2 * len(regg))), 3),
        "spa": round(float(regbox[(regbox.start == 1) & (regbox.slot > 0)].PA.mean()), 3), "hr_pa": round(lg["hr"], 5), "k_pa": round(lg["k"], 5),
        "sp_pitches": round(lg_sp_pitches, 1), "sp_outs": round(lg_sp_outs, 2),
        "role": {r: {k: round(v, 5) for k, v in d.items()} for r, d in lg_role.items()},
    }
    log("league:", {k: league[k] for k in ("rpg", "home_win", "nrfi", "dp", "sf", "sb_att", "sb_pct", "sp_pitches")})

    # ---------- parks (home team), using both seasons of regular-season games at the team's usual site
    main_site = reg.groupby("home").site.agg(lambda s: s.mode().iat[0] if len(s.mode()) else None).to_dict()
    neutral_games = set(reg[[s != main_site.get(h) for s, h in zip(reg.site, reg.home)]].game)
    rp = pa[pa.game.isin(reg.game) & ~pa.game.isin(neutral_games)].copy()
    gm = reg.set_index("game")
    rp["park"] = rp.game.map(gm.home)
    rp["o"] = rp.ev.map(EVMAP)
    parks = {}
    pf_keys = {"s": 0.5, "d": 0.6, "t": 0.7, "hr": 0.6, "k": 0.4, "bb": 0.3, "runs": 0.6}
    for t in BY_ABBR:
        home_pa = rp[rp.park == t]
        road_pa = rp[(rp.park != t) & ((rp.bteam == t) | (rp.pteam == t))]
        if len(home_pa) < 1500 or len(road_pa) < 1500:
            parks[t] = {k: 1.0 for k in pf_keys}
            continue
        f = {}
        for k, keep in pf_keys.items():
            if k == "runs":
                hv, rv = home_pa.runs.sum() / len(home_pa), road_pa.runs.sum() / len(road_pa)
            else:
                hv, rv = (home_pa.o == k).mean(), (road_pa.o == k).mean()
            raw = hv / rv if rv > 0 else 1.0
            f[k] = round(float(1 + (raw - 1) * keep), 3)
        parks[t] = f
    log("parks: COL", parks.get("COL"), "SEA", parks.get("SEA"))

    # ---------- player rates
    pa_w = pa[pa.game.isin(games[games.gtype.isin(["R", "P"])].game)].copy()
    pa_w["w"] = weights(pa_w.date, asof, pa_w.season.values, cur)
    pa_w["o"] = pa_w.ev.map(EVMAP)
    pa_w["gbf"] = (pa_w.bip == "G").astype(float)
    pa_w["isbip"] = (pa_w.bip != "").astype(float)
    # neutralize park: weight each event by 1/park factor of the park it happened in
    pa_w["park"] = pa_w.game.map(games.set_index("game").home)

    def rates(df, key, prior, lgrates):
        out = {}
        g = df.groupby(key)
        W = g.w.sum()
        cnt = {k: df[df.o == k].groupby(key).w.sum() for k in OUTCOMES}
        gbn = df.assign(x=df.w * df.gbf).groupby(key).x.sum()
        bipn = df.assign(x=df.w * df.isbip).groupby(key).x.sum()
        raw_n = g.size()
        for pid in W.index:
            w = W[pid]
            r = {}
            for k in OUTCOMES:
                c = cnt[k].get(pid, 0.0)
                pk = lgrates(pid)[k]
                # undo the average park effect on this player's events
                r[k] = (c + prior[k] * pk) / (w + prior[k])
            b = bipn.get(pid, 0.0)
            r["gb"] = (gbn.get(pid, 0.0) + prior["gb"] * lg_gb) / (b + prior["gb"])
            r["_w"], r["_n"] = float(w), int(raw_n[pid])
            out[pid] = r
        return out

    bat_rates = rates(pa_w, "bat", PRIOR_BAT, lambda pid: lg)
    # pitchers regress toward their role's league rates
    gs_counts = box[box.BF > 0].groupby("pid").GS.agg(["sum", "count"])
    sp_like = {p for p, r in gs_counts.iterrows() if r["sum"] >= max(3, 0.5 * r["count"])}
    pit_rates = rates(pa_w, "pit", PRIOR_PIT, lambda pid: lg_role["SP" if pid in sp_like else "RP"])
    # park-neutralize hitters by their home park (they play about half their games there)
    home_team_of = box.sort_values("date").groupby("pid").team.last().to_dict()
    for pid, r in bat_rates.items():
        pf = parks.get(home_team_of.get(pid), {})
        for k in ("s", "d", "t", "hr"):
            r[k] /= (1 + pf.get(k, 1.0)) / 2
    for pid, r in pit_rates.items():
        pf = parks.get(home_team_of.get(pid), {})
        for k in ("s", "d", "t", "hr"):
            r[k] /= (1 + pf.get(k, 1.0)) / 2

    # ---------- per-player box aggregates
    b = box.copy()
    b["w"] = weights(b.date, asof, b.season.values, cur)
    curbox = b[(b.season == cur) & b.game.isin(reg.game)]
    sb_g = b.assign(on1=(b.H - b.D - b["T"] - b.HR + b.BB + b.HBP).clip(lower=0))
    sbagg = sb_g.assign(att=(sb_g.SB + sb_g.CS) * sb_g.w, sb=sb_g.SB * sb_g.w, o1=sb_g.on1 * sb_g.w).groupby("pid")[["att", "sb", "o1"]].sum()

    # ---------- teams
    last_date = pd.Timestamp(asof)
    win_cut = (last_date - pd.Timedelta(days=45)).date().isoformat()
    teams = {}
    team_of_player = {}
    twoway = {}
    recent = b[b.date >= win_cut]
    if len(recent) == 0 or recent.date.nunique() < 5:  # offseason/early season: fall back to the last 45 days played
        mx = pd.Timestamp(b.date.max())
        recent = b[b.date >= (mx - pd.Timedelta(days=45)).date().isoformat()]
    last_team = b.sort_values("date").groupby("pid").team.last().to_dict()
    roster_status = {}
    if rosters:
        for t, lst in rosters.items():
            for r in lst:
                roster_status[str(r["pid"])] = (t, r["status"], r["status_desc"], r["pos"])

    def hand_of(pid, k):
        p = people.get(pid) or people.get(str(pid)) or {}
        return p.get(k) or "R"

    def player_name(pid):
        p = people.get(pid) or {}
        if p.get("name"):
            return p["name"]
        rows = box[box.pid == pid]
        return rows.name.iat[-1] if len(rows) else pid

    for abbr, tid, _, name, c1, c2 in TEAMS:
        tb = recent[recent.team == abbr]
        tall = b[b.team == abbr]
        # record (current regular season)
        tg = reg[(reg.season == cur) & ((reg.away == abbr) | (reg.home == abbr))]
        wins = int(((tg.away == abbr) & (tg.ascore > tg.hscore)).sum() + ((tg.home == abbr) & (tg.hscore > tg.ascore)).sum())
        losses = len(tg) - wins
        # who's on the team: anyone whose most recent game was for this team (+ 40-man actives)
        # membership: played for the team in its last ~3 weeks of games (position players who pitched stay hitters)
        team_dates = sorted(tall.date.unique())
        cut21 = team_dates[-18] if len(team_dates) >= 18 else (team_dates[0] if team_dates else "0000")
        tw = tall[tall.date >= cut21]
        pa_sum = tall[tall.date >= win_cut].groupby("pid").PA.sum()
        bf_sum = tall[tall.date >= win_cut].groupby("pid").BF.sum()
        hit_ids = [p for p in tw[tw.PA > 0].groupby("pid").PA.sum().sort_values(ascending=False).index
                   if last_team.get(p) == abbr and not (bf_sum.get(p, 0) > 2 * pa_sum.get(p, 0) + 5)]
        pit_ids = [p for p in tw[tw.BF > 0].groupby("pid").BF.sum().sort_values(ascending=False).index
                   if last_team.get(p) == abbr and not (pa_sum.get(p, 0) > 2 * bf_sum.get(p, 0) + 5)]
        if rosters and rosters.get(abbr):
            for r in rosters[abbr]:
                pid = str(r["pid"])
                if r["pos"] in ("P", "TWP") and pid not in pit_ids and r["status"] == "A":
                    pit_ids.append(pid)
                if r["pos"] not in ("P",) and pid not in hit_ids and r["status"] == "A":
                    hit_ids.append(pid)
        status = {}
        for pid in set(hit_ids) | set(pit_ids):
            if pid in roster_status:
                t2, code, desc, _ = roster_status[pid]
                if t2 != abbr:
                    status[pid] = "Traded"
                elif code != "A":
                    status[pid] = desc or code
            elif rosters:
                status[pid] = "Not on 40-man"
        # lineups vs RHP / LHP: most recent starting nine against that hand
        lineups = {}
        tg_all = games[((games.away == abbr) | (games.home == abbr))].sort_values("date", ascending=False)
        for hand in ("R", "L"):
            for g in tg_all.itertuples():
                opp_sp = g.h_sp if g.away == abbr else g.a_sp
                if hand_of(opp_sp, "throws") != hand:
                    continue
                st = tall[(tall.game == g.game) & (tall.start == 1) & (tall.slot > 0)].sort_values("slot")
                if len(st) == 9:
                    lineups[hand] = [{"id": r.pid, "pos": r.pos if r.pos else "DH"} for r in st.itertuples()]
                    break
        # rotation: starters in the window, most recent first
        starts = tall[(tall.GS == 1)].sort_values("date", ascending=False)
        rot = []
        for r in starts.itertuples():
            if r.pid not in rot and last_team.get(r.pid) == abbr:
                rot.append(r.pid)
            if len(rot) >= 5:
                break
        last_start = starts.groupby("pid").date.max().to_dict()
        # bullpen roles
        rel = tb[(tb.GS == 0) & (tb.BF > 0)]
        relagg = rel.groupby("pid").agg(apps=("game", "nunique"), sv=("SV", "sum"), outs=("outs", "sum"), pit=("PIT", "sum"))
        pen = []
        for pid, r in relagg.iterrows():
            if last_team.get(pid) != abbr or pid not in pit_ids or (pid in rot[:5] and r.apps < 3) or status.get(pid):
                continue
            pr_ = pit_rates.get(pid)
            q = (pr_["k"] - pr_["bb"] - 3 * pr_["hr"] - (pr_["s"] + 2 * pr_["d"]) * 0.5) if pr_ else -0.2
            pen.append({"id": pid, "apps": int(r.apps), "sv": int(r.sv), "outs_app": round(r.outs / max(1, r.apps), 2), "q": q})
        pen.sort(key=lambda x: (-x["sv"], -x["q"]))
        closer = pen[0]["id"] if pen and pen[0]["sv"] >= 2 else None
        rest = sorted([p for p in pen if p["id"] != closer], key=lambda x: -(x["q"] + 0.004 * x["apps"]))
        for i, p in enumerate(rest):
            p["role"] = "SU" if i < 2 else ("MID" if i < 5 else "LONG" if p["outs_app"] >= 4 else "LOW")
        bullpen = (([{**[p for p in pen if p["id"] == closer][0], "role": "CL"}] if closer else []) + rest)[:9]
        players = []
        for pid in hit_ids:
            br = bat_rates.get(pid)
            if br is None:
                br = {k: lg[k] * (1.15 if k == "k" else 0.85 if k in ("hr", "d") else 1.0) for k in OUTCOMES}
                br.update({"gb": lg_gb, "_w": 0, "_n": 0})
            cb = curbox[(curbox.pid == pid)]
            gp = int((cb.PA > 0).sum())
            ab, h = int(cb.AB.sum()), int(cb.H.sum())
            tb_ = int((cb.H + cb.D + 2 * cb["T"] + 3 * cb.HR).sum())
            obp_den = int((cb.AB + cb.BB + cb.HBP).sum())
            sa = sbagg.loc[pid] if pid in sbagg.index else None
            att = float((sa.att + 0.6 * sb_att * 6) / (sa.o1 + 6)) if sa is not None else sb_att
            spct = float((sa.sb + 4 * sb_pct) / (sa.att + 4)) if sa is not None else sb_pct
            pos = cb.pos.mode().iat[0] if len(cb) and len(cb.pos.mode()) else (people.get(pid, {}).get("pos") or "")
            if pos in ("PH", "PR", "P", ""):
                pos = (people.get(pid, {}).get("pos") or "DH")
            players.append({
                "id": pid, "name": player_name(pid), "short": short_name(player_name(pid)), "bats": hand_of(pid, "bats"),
                "pos": pos, "role": "B", "mlbam": people.get(pid, {}).get("mlbam"),
                "r": [round(br[k], 5) for k in OUTCOMES], "gb": round(br["gb"], 4), "n": br["_n"],
                "sba": round(att, 4), "sbp": round(spct, 4), "status": status.get(pid, ""),
                "avg": {"g": gp, "avg": round(h / ab, 3) if ab else None,
                        "obp": round(int((cb.H + cb.BB + cb.HBP).sum()) / obp_den, 3) if obp_den else None,
                        "slg": round(tb_ / ab, 3) if ab else None, "hr": int(cb.HR.sum()),
                        "hrr": round(float((cb.H + cb.R + cb.RBI).sum() / gp), 2) if gp else None},
            })
            team_of_player[pid] = abbr
        for pid0 in pit_ids:
            pid = pid0 + "-P" if pid0 in hit_ids else pid0  # two-way player (e.g. Ohtani): separate pitcher entry
            if pid != pid0:
                twoway[pid0] = pid
                rot = [pid if x == pid0 else x for x in rot]
            prr = pit_rates.get(pid0)
            role = "SP" if pid0 in sp_like or pid in rot else "RP"
            if prr is None:
                base = lg_role[role]
                prr = {k: base[k] * (0.9 if k == "k" else 1.1) for k in OUTCOMES}
                prr.update({"gb": lg_gb, "_w": 0, "_n": 0})
            ps = b[(b.pid == pid0) & (b.GS == 1)].sort_values("date", ascending=False).head(10)
            pitches = float(np.average(ps.PIT, weights=np.linspace(1.5, 0.6, len(ps)))) if len(ps) >= 2 else (lg_sp_pitches if role == "SP" else 25)
            ppbf_rows = b[(b.pid == pid0) & (b.BF > 0)]
            ppbf = float((ppbf_rows.PIT.sum() + 300 * 3.9) / (ppbf_rows.BF.sum() + 300))
            cb = curbox[(curbox.pid == pid0) & (curbox.BF > 0)]
            outs = int(cb.outs.sum())
            gs = int(cb.GS.sum())
            players.append({
                "id": pid, "name": player_name(pid0), "short": short_name(player_name(pid0)), "throws": hand_of(pid0, "throws"),
                "pos": "P", "role": role, "mlbam": people.get(pid0, {}).get("mlbam"),
                "r": [round(prr[k], 5) for k in OUTCOMES], "gb": round(prr["gb"], 4), "n": prr["_n"],
                "pc": round(min(110, max(60, pitches)) if role == "SP" else pitches, 1), "ppbf": round(ppbf, 3),
                "last_start": last_start.get(pid0), "status": status.get(pid0, ""),
                "avg": {"g": int(len(cb)), "gs": gs, "ip": f"{outs // 3}.{outs % 3}",
                        "era": round(27 * cb.pER.sum() / outs, 2) if outs else None,
                        "k9": round(27 * cb.pK.sum() / outs, 1) if outs else None,
                        "ipgs": round(cb[cb.GS == 1].outs.sum() / 3 / gs, 1) if gs else None,
                        "w": int(cb.W.sum()), "l": int(cb.L.sum()), "sv": int(cb.SV.sum())},
            })
            team_of_player[pid] = abbr
        bullpen = [dict(p, id=twoway.get(p["id"], p["id"])) for p in bullpen]
        teams[abbr] = {"name": name, "color": c1, "alt": c2, "record": f"{wins}-{losses}", "park": parks.get(abbr),
                       "lineups": lineups, "rotation": rot, "bullpen": [{"id": p["id"], "role": p["role"]} for p in bullpen],
                       "players": players}

    # ---------- schedule
    sched = []
    if args.source == "statsapi" and upcoming:
        for g in upcoming:
            row = {"id": g["game"], "date": g["date"], "start": g["start"], "away": g["away"], "home": g["home"],
                   "away_sp": pid_str(g["a_prob"]), "home_sp": pid_str(g["h_prob"]),
                   "series": g["series"] if g["gtype"] != "R" else ""}
            if g["a_lineup"] and len(g["a_lineup"]) == 9:
                row["away_lineup"] = [pid_str(x) for x in g["a_lineup"]]
            if g["h_lineup"] and len(g["h_lineup"]) == 9:
                row["home_lineup"] = [pid_str(x) for x in g["h_lineup"]]
            if g["state"] == "Final" and g["ascore"] is not None:
                row["away_score"], row["home_score"] = g["ascore"], g["hscore"]
            sched.append(row)
    else:
        # Retrosheet / backtests: last week of played games + the next week's real games (with the real starters)
        allg = pd.concat([games], ignore_index=True)
        future = None
        if args.asof and args.source == "retro":
            import retro
            fg = []
            for y in (args.season,):
                g2, _, b2, _ = retro.load_season(args.retro_dir or os.path.join(ROOT, "data_raw"), y)
                fg.append((g2, b2))
            g2, b2 = fg[0]
            g2["game"] = g2.game.map(pid_str)
            fut = g2[(g2.date >= asof) & (g2.date < (pd.Timestamp(asof) + pd.Timedelta(days=7)).date().isoformat())]
            future = (fut, b2)
        lo = (pd.Timestamp(asof) - pd.Timedelta(days=6)).date().isoformat()
        for g in allg[allg.date >= lo].sort_values(["date", "game"]).itertuples():
            sched.append({"id": g.game, "date": g.date, "start": None, "away": g.away, "home": g.home,
                          "away_sp": g.a_sp, "home_sp": g.h_sp, "away_score": int(g.ascore), "home_score": int(g.hscore)})
        if future is not None:
            fut, b2 = future
            for g in fut.sort_values(["date", "game"]).itertuples():
                st = b2[(b2.game == g.game) & (b2.start == 1) & (b2.slot > 0)].sort_values(["home", "slot"])
                row = {"id": g.game, "date": g.date, "start": None, "away": g.away, "home": g.home,
                       "away_sp": g.a_sp, "home_sp": g.h_sp, "actual": [int(g.ascore), int(g.hscore)]}
                al = list(st[st.home == 0].pid)
                hl = list(st[st.home == 1].pid)
                if len(al) == 9:
                    row["away_lineup"] = al
                if len(hl) == 9:
                    row["home_lineup"] = hl
                sched.append(row)

    # make sure every pitcher/hitter named in the schedule exists in its team's player list
    for g in sched:
        for side in ("away", "home"):
            if g.get(side + "_sp") in twoway:
                g[side + "_sp"] = twoway[g[side + "_sp"]]
        for side in ("away", "home"):
            T = teams[g[side]]
            ids = {p["id"] for p in T["players"]}
            for pid in [g.get(side + "_sp")] + (g.get(side + "_lineup") or []):
                if pid and pid not in ids:
                    is_p = pid == g.get(side + "_sp")
                    src = (pit_rates if is_p else bat_rates).get(pid)
                    base = lg_role["SP"] if is_p else lg
                    r = [round((src or base)[k], 5) for k in OUTCOMES]
                    p = {"id": pid, "name": player_name(pid), "short": short_name(player_name(pid)), "mlbam": people.get(pid, {}).get("mlbam"),
                         "r": r, "gb": round((src or {"gb": lg_gb})["gb"], 4), "n": (src or {}).get("_n", 0), "status": "", "avg": {}}
                    if is_p:
                        p.update({"throws": hand_of(pid, "throws"), "pos": "P", "role": "SP", "pc": lg_sp_pitches, "ppbf": 3.9})
                    else:
                        p.update({"bats": hand_of(pid, "bats"), "pos": people.get(pid, {}).get("pos") or "DH", "role": "B",
                                  "sba": sb_att, "sbp": sb_pct})
                    T["players"].append(p)
                    ids.add(pid)

    model = {
        "season": int(cur), "season_label": str(cur), "through": str(games.date.max()), "asof": asof,
        "generated": now.strftime("%Y-%m-%d %H:%M UTC"), "source": args.source,
        "league": league, "teams": teams, "schedule": sched,
        "consts": {"hfa": 1.01, "adv": 1.0, "bip_hit": 0.97, "tto": 1.06, "sub": 0.06},
    }
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    old = None
    if os.path.exists(args.out):
        try:
            old = json.load(open(args.out)).get("consts")
        except Exception:
            old = None
    if old:
        model["consts"] = old  # keep the calibrated constants until calibrate.js runs again
    with open(args.out, "w") as f:
        json.dump(model, f, separators=(",", ":"))
    log(f"wrote {args.out} ({os.path.getsize(args.out) / 1e6:.2f} MB): {sum(len(t['players']) for t in teams.values())} players, {len(sched)} scheduled games")


if __name__ == "__main__":
    main()
