"""MLB Stats API adapter (statsapi.mlb.com, public, no key needed).

Produces the same tables as retro.py from each final game's play-by-play and box score, plus the
upcoming schedule (probable pitchers, posted lineups) and the teams' current rosters. Each finished
game is condensed to a small JSON file under data_raw/statsapi/<season>/ so later runs only download
new games.
"""
import json
import os
import time
from concurrent.futures import ThreadPoolExecutor

import pandas as pd
import requests

from teams import BY_MLBAM, TEAMS

API = "https://statsapi.mlb.com/api"
S = requests.Session()
S.headers["User-Agent"] = "diamond-sim (github.com/Jlabianca/diamond-sim)"

EV = {
    "single": "1B", "double": "2B", "triple": "3B", "home_run": "HR",
    "walk": "BB", "intent_walk": "IBB", "hit_by_pitch": "HBP",
    "strikeout": "K", "strike_out": "K", "strikeout_double_play": "K", "strikeout_triple_play": "K",
    "field_error": "E", "fielders_choice": "FC", "fielders_choice_out": "FC",
    "catcher_interf": "CI", "batter_interference": "OUT", "fan_interference": "OUT",
    "field_out": "OUT", "force_out": "OUT", "grounded_into_double_play": "OUT", "double_play": "OUT",
    "triple_play": "OUT", "sac_fly": "OUT", "sac_bunt": "OUT", "sac_fly_double_play": "OUT",
    "sac_bunt_double_play": "OUT",
}
DP = {"grounded_into_double_play", "double_play", "triple_play", "sac_fly_double_play", "sac_bunt_double_play", "strikeout_double_play"}
TRAJ = {"ground_ball": "G", "bunt_grounder": "G", "fly_ball": "F", "line_drive": "L", "bunt_line_drive": "L", "popup": "P", "bunt_popup": "P"}
POS = {"P", "C", "1B", "2B", "3B", "SS", "LF", "CF", "RF", "DH", "PH", "PR"}


def get(path, params=None, tries=4):
    for k in range(tries):
        try:
            r = S.get(API + path, params=params, timeout=30)
            if r.status_code == 200:
                return r.json()
            if r.status_code == 404:
                return None
        except requests.RequestException:
            pass
        time.sleep(1.5 * (k + 1))
    raise RuntimeError(f"MLB Stats API request failed: {path} {params}")


# ---------------------------------------------------------------- schedule
def schedule(start, end, hydrate="probablePitcher,lineups"):
    js = get("/v1/schedule", {"sportId": 1, "startDate": start, "endDate": end, "gameType": "R,F,D,L,W",
                              "hydrate": hydrate})
    out = []
    for d in (js or {}).get("dates", []):
        for g in d.get("games", []):
            a, h = g["teams"]["away"], g["teams"]["home"]
            aa, hh = BY_MLBAM.get(a["team"]["id"]), BY_MLBAM.get(h["team"]["id"])
            if not aa or not hh:
                continue
            st = g.get("status", {})
            lu = g.get("lineups") or {}
            out.append({
                "game": str(g["gamePk"]), "date": g.get("officialDate") or d["date"], "start": g.get("gameDate"),
                "gtype": g.get("gameType", "R"), "away": aa, "home": hh,
                "state": st.get("abstractGameState", ""), "detail": st.get("detailedState", ""),
                "ascore": a.get("score"), "hscore": h.get("score"),
                "a_prob": (a.get("probablePitcher") or {}).get("id"), "h_prob": (h.get("probablePitcher") or {}).get("id"),
                "a_lineup": [p["id"] for p in lu.get("awayPlayers", [])], "h_lineup": [p["id"] for p in lu.get("homePlayers", [])],
                "venue": (g.get("venue") or {}).get("id"), "series": g.get("seriesDescription", ""),
                "dh": g.get("doubleHeader", "N"), "num": g.get("gameNumber", 1),
            })
    return out


def season_schedule(season):
    return schedule(f"{season}-02-15", f"{season}-11-30", hydrate="")


# ---------------------------------------------------------------- one game
def condense(sched_row):
    pk = sched_row["game"]
    pbp = get(f"/v1/game/{pk}/playByPlay")
    box = get(f"/v1/game/{pk}/boxscore")
    if not pbp or not box:
        return None
    side_team = {0: sched_row["away"], 1: sched_row["home"]}
    pas, inn_runs = [], {}
    hands = {}
    for p in pbp.get("allPlays", []):
        res, about, mu = p.get("result", {}), p.get("about", {}), p.get("matchup", {})
        et = res.get("eventType", "")
        top = 1 if about.get("isTopInning", about.get("halfInning") == "top") else 0
        inn = about.get("inning", 0)
        runners = p.get("runners", []) or []
        runs = sum(1 for r in runners if (r.get("movement") or {}).get("end") == "score" and not (r.get("movement") or {}).get("isOut"))
        if runs:
            inn_runs[(inn, top)] = inn_runs.get((inn, top), 0) + runs
        if et not in EV:
            continue
        bat, pit = (mu.get("batter") or {}).get("id"), (mu.get("pitcher") or {}).get("id")
        bh, ph = (mu.get("batSide") or {}).get("code", "R"), (mu.get("pitchHand") or {}).get("code", "R")
        hands[pit] = ph
        evs = p.get("playEvents", []) or []
        traj = ""
        for e in evs:
            hd = e.get("hitData")
            if hd and hd.get("trajectory"):
                traj = TRAJ.get(hd["trajectory"], "")
        outs_on = len({(r.get("details") or {}).get("runner", {}).get("id") for r in runners if (r.get("movement") or {}).get("isOut")})
        first = {}
        for r in runners:
            rid = ((r.get("details") or {}).get("runner") or {}).get("id")
            idx = (r.get("details") or {}).get("playIndex", 0)
            if rid is not None and rid != bat and (rid not in first or idx < first[rid][0]):
                first[rid] = (idx, (r.get("movement") or {}).get("start"))
        on = {v[1] for v in first.values()}
        end_outs = (p.get("count") or {}).get("outs", 0)
        pas.append({
            "game": pk, "inn": inn, "top": top, "bat": bat, "pit": pit, "bhand": bh, "phand": ph,
            "ev": EV[et], "bip": traj if EV[et] in ("OUT", "1B", "2B", "3B", "HR", "E", "FC") else "",
            "dp": int(et in DP), "sf": int(et.startswith("sac_fly")), "sh": int(et.startswith("sac_bunt")),
            "pitches": sum(1 for e in evs if e.get("isPitch")),
            "outs": max(0, min(2, end_outs - outs_on)), "r1": int("1B" in on), "r2": int("2B" in on), "r3": int("3B" in on),
            "runs": runs, "outs_on_play": outs_on,
            "bteam": side_team[0 if top else 1], "pteam": side_team[1 if top else 0],
        })
    rows = []
    sp = {}
    for s, key in ((0, "away"), (1, "home")):
        T = box["teams"][key]
        order = T.get("battingOrder", []) or []
        pitchers = T.get("pitchers", []) or []
        sp[s] = pitchers[0] if pitchers else None
        for _, pl in (T.get("players") or {}).items():
            pid = pl["person"]["id"]
            st = pl.get("stats") or {}
            bt, pt = st.get("batting") or {}, st.get("pitching") or {}
            if not bt and not pt:
                continue
            bo = str(pl.get("battingOrder") or "")
            slot = int(bo[0]) if bo[:1].isdigit() and bo.endswith("00") else 0
            pos = (pl.get("position") or {}).get("abbreviation", "")
            rows.append({
                "pid": pid, "name": pl["person"].get("fullName", str(pid)), "side": s, "home": s,
                "team": side_team[s], "opp": side_team[1 - s], "slot": slot, "start": int(slot > 0),  # battingOrder "N00" = started in slot N (subs are "N01"...)
                "pos": pos if pos in POS else ("P" if pt else ""),
                "PA": bt.get("plateAppearances", 0), "AB": bt.get("atBats", 0), "H": bt.get("hits", 0),
                "D": bt.get("doubles", 0), "T": bt.get("triples", 0), "HR": bt.get("homeRuns", 0),
                "R": bt.get("runs", 0), "RBI": bt.get("rbi", 0), "BB": bt.get("baseOnBalls", 0),
                "K": bt.get("strikeOuts", 0), "HBP": bt.get("hitByPitch", 0), "SB": bt.get("stolenBases", 0),
                "CS": bt.get("caughtStealing", 0),
                "GS": int(pid == sp[s]), "outs": pt.get("outs", 0), "BF": pt.get("battersFaced", 0),
                "pH": pt.get("hits", 0), "pR": pt.get("runs", 0), "pER": pt.get("earnedRuns", 0),
                "pBB": pt.get("baseOnBalls", 0), "pK": pt.get("strikeOuts", 0), "pHR": pt.get("homeRuns", 0),
                "pHBP": pt.get("hitByPitch", 0), "PIT": pt.get("numberOfPitches", pt.get("pitchesThrown", 0)) or 0,
                "W": pt.get("wins", 0), "L": pt.get("losses", 0), "SV": pt.get("saves", 0),
            })
    ls = (pbp.get("allPlays") or [{}])[-1].get("result", {})
    game = {
        "game": pk, "date": sched_row["date"], "gtype": "R" if sched_row["gtype"] == "R" else "P",
        "away": sched_row["away"], "home": sched_row["home"],
        "ascore": sched_row["ascore"] if sched_row["ascore"] is not None else ls.get("awayScore", 0),
        "hscore": sched_row["hscore"] if sched_row["hscore"] is not None else ls.get("homeScore", 0),
        "a_sp": sp.get(0), "h_sp": sp.get(1), "site": sched_row.get("venue"),
        "a_inn1": inn_runs.get((1, 1), 0), "h_inn1": inn_runs.get((1, 0), 0),
        "innings": max([k[0] for k in inn_runs] + [9]),
    }
    return {"game": game, "pa": pas, "box": rows, "hands": hands}


def load_season(raw_dir, season, asof=None, workers=12, log=print):
    d = os.path.join(raw_dir, "statsapi", str(season))
    os.makedirs(d, exist_ok=True)
    sched = [g for g in season_schedule(season)
             if g["state"] == "Final" and g["detail"] not in ("Postponed", "Cancelled", "Suspended")
             and (asof is None or g["date"] < asof)]
    todo = [g for g in sched if not os.path.exists(os.path.join(d, g["game"] + ".json"))]
    log(f"  statsapi {season}: {len(sched)} final games, {len(todo)} to download")

    def work(g):
        try:
            c = condense(g)
        except Exception as e:  # keep going; a missing game just isn't used
            log(f"    skip {g['game']}: {e}")
            return
        if c:
            with open(os.path.join(d, g["game"] + ".json"), "w") as f:
                json.dump(c, f, separators=(",", ":"))

    with ThreadPoolExecutor(workers) as ex:
        for i, _ in enumerate(ex.map(work, todo)):
            if i and i % 250 == 0:
                log(f"    {i}/{len(todo)}")
    games, pas, boxes, hands = [], [], [], {}
    keep = {g["game"] for g in sched}
    for f in os.listdir(d):
        if not f.endswith(".json") or f[:-5] not in keep:
            continue
        c = json.load(open(os.path.join(d, f)))
        c["game"]["season"] = season
        games.append(c["game"])
        for p in c["pa"]:
            p["date"], p["season"] = c["game"]["date"], season
        pas += c["pa"]
        for b in c["box"]:
            b.update({"game": c["game"]["game"], "date": c["game"]["date"], "season": season, "start": int(b["slot"] > 0)})
        boxes += c["box"]
        hands.update({int(k): v for k, v in c["hands"].items()})
    return pd.DataFrame(games), pd.DataFrame(pas), pd.DataFrame(boxes), hands


def people(ids):
    """Bats/throws for player ids (switch hitters -> 'B')."""
    out = {}
    ids = [int(i) for i in ids if i is not None]
    for k in range(0, len(ids), 150):
        js = get("/v1/people", {"personIds": ",".join(map(str, ids[k:k + 150]))}) or {}
        for p in js.get("people", []):
            bats = (p.get("batSide") or {}).get("code", "R")
            out[p["id"]] = {"pid": p["id"], "name": p.get("fullName", ""), "bats": "B" if bats == "S" else bats,
                            "throws": (p.get("pitchHand") or {}).get("code", "R"),
                            "pos": (p.get("primaryPosition") or {}).get("abbreviation", ""), "mlbam": p["id"]}
    return out


def rosters(season):
    """Current 40-man rosters with status: {abbr: [{pid, name, pos, status}]}. Active roster players have status 'A'."""
    out = {}
    for abbr, tid, *_ in TEAMS:
        js = get(f"/v1/teams/{tid}/roster", {"rosterType": "40Man", "season": season}) or {}
        out[abbr] = [{"pid": r["person"]["id"], "name": r["person"].get("fullName", ""),
                      "pos": (r.get("position") or {}).get("abbreviation", ""),
                      "status": (r.get("status") or {}).get("code", ""),
                      "status_desc": (r.get("status") or {}).get("description", "")} for r in js.get("roster", [])]
    return out
