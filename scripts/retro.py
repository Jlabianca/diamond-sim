"""Retrosheet event-file adapter.

Parses Retrosheet play-by-play event files (https://www.retrosheet.org, mirrored by the Chadwick
Bureau on GitHub) into the same three tables the MLB Stats API adapter produces:

  games  one row per game (teams, final score, starting pitchers, first-inning runs)
  pa     one row per plate appearance (batter, pitcher, hands, outcome, batted-ball type, base/out state)
  box    one row per player per game (batting and pitching lines, decisions)

Retrosheet is used for development and for backtests (it covers every season through the last
completed one). The live site is built from the MLB Stats API (statsapi.py).
"""
import glob
import os
import re
import subprocess

import pandas as pd

from teams import BY_RETRO

PITCH_CHARS = set("BCFHIKLMOPQRSTUVXY")
RETRO_GIT = "https://github.com/chadwickbureau/retrosheet"


def fetch(raw_dir, years):
    """Sparse-clone the Chadwick Retrosheet mirror for the given seasons."""
    repo = os.path.join(raw_dir, "retrosheet")
    if not os.path.isdir(os.path.join(repo, ".git")):
        subprocess.run(["git", "clone", "--depth", "1", "--filter=blob:none", "--sparse", RETRO_GIT, repo], check=True)
    subprocess.run(["git", "-C", repo, "sparse-checkout", "set"] + [f"seasons/{y}" for y in years], check=True)
    return repo


def season_dir(raw_dir, year):
    for base in (os.path.join(raw_dir, "retrosheet", "seasons", str(year)), os.path.join(raw_dir, str(year))):
        if os.path.isdir(base):
            return base
    raise FileNotFoundError(f"no Retrosheet files for {year} under {raw_dir}")


def read_rosters(d):
    people = {}
    for f in glob.glob(os.path.join(d, "*.ROS")):
        for line in open(f, encoding="latin-1"):
            p = line.strip().split(",")
            if len(p) >= 7:
                people[p[0]] = {"pid": p[0], "name": f"{p[2]} {p[1]}".strip(), "bats": p[3], "throws": p[4], "pos": p[6]}
    return people


def split_event(ev):
    """'S8/G.2-H;1-3' -> ('S8', ['G'], ['2-H', '1-3'])"""
    adv = []
    if "." in ev:
        ev, a = ev.split(".", 1)
        adv = [x for x in a.split(";") if x]
    parts = ev.split("/")
    return parts[0], parts[1:], adv


def bip_type(mods):
    for m in mods:
        m2 = m.rstrip("+-#?!")
        for code, t in (("BG", "G"), ("BP", "P"), ("BL", "L"), ("BF", "F"), ("GDP", "G"), ("LDP", "L"), ("FDP", "F")):
            if m2.startswith(code):
                return t
        if m2[:1] in ("G", "F", "L", "P") and not m2.startswith("FO") and not m2.startswith("FL") and not m2.startswith("FINT"):
            return m2[0]
        if m2.startswith("FL"):
            return "P"  # foul pop/fly out
    return ""


class Game:
    def __init__(self, gid, people):
        self.gid = gid
        self.people = people
        self.info = {}
        self.lineup = [dict(), dict()]  # side -> slot -> pid
        self.pos = {}
        self.pitcher = [None, None]  # pitcher on the mound for each side (side 0 = visitors)
        self.sp = [None, None]
        self.slot_of = {}
        self.order = {}  # pid -> starting slot
        self.box = {}
        self.pa = []
        self.er = {}
        self.half = None
        self.bases = {}
        self.reached_on_err = set()
        self.score = [0, 0]
        self.inn_runs = {}
        self.outs = 0
        self.sub_order = [[], []]
        self.first_side_seen = {}

    def b(self, pid, side):
        if pid not in self.box:
            self.box[pid] = {"pid": pid, "side": side, "PA": 0, "AB": 0, "H": 0, "D": 0, "T": 0, "HR": 0, "R": 0, "RBI": 0,
                             "BB": 0, "K": 0, "HBP": 0, "SB": 0, "CS": 0, "GS": 0, "outs": 0, "BF": 0, "pH": 0, "pR": 0,
                             "pER": 0, "pBB": 0, "pK": 0, "pHR": 0, "pHBP": 0, "PIT": 0, "W": 0, "L": 0, "SV": 0,
                             "slot": 0, "start": 0, "pos": ""}
        return self.box[pid]

    # ---------- records ----------
    def start(self, pid, side, slot, pos, sub=False):
        side, slot, pos = int(side), int(slot), int(pos)
        bx = self.b(pid, side)
        if pos == 12 and slot > 0:  # pinch runner: replace the runner on base
            old = self.lineup[side].get(slot)
            for k, v in list(self.bases.items()):
                if v == old:
                    self.bases[k] = pid
                    if old in self.reached_on_err:
                        self.reached_on_err.add(pid)
        if slot > 0:
            self.lineup[side][slot] = pid
            if not sub:
                bx["slot"], bx["start"] = slot, 1
        if pos == 1:
            fside = side  # the pitcher's own team
            if self.pitcher[fside] is None:
                self.sp[fside] = pid
                bx["GS"] = 1
            self.pitcher[fside] = pid
        if not bx["pos"] and pos not in (11, 12):
            bx["pos"] = {1: "P", 2: "C", 3: "1B", 4: "2B", 5: "3B", 6: "SS", 7: "LF", 8: "CF", 9: "RF", 10: "DH"}.get(pos, "")
        elif not bx["pos"]:
            bx["pos"] = "PH" if pos == 11 else "PR"

    def run_scored(self, pid, rbi_ok, batter, bat_side, credit):
        self.score[bat_side] += 1
        key = (self.cur_inn, bat_side)
        self.inn_runs[key] = self.inn_runs.get(key, 0) + 1
        self.b(pid, bat_side)["R"] += 1
        p = self.pitcher[1 - bat_side]
        if p:
            self.b(p, 1 - bat_side)["pR"] += 1
        if rbi_ok and credit:
            self.b(batter, bat_side)["RBI"] += 1

    def play(self, inn, side, batter, count, pitches, ev):
        inn, side = int(inn), int(side)
        self.cur_inn = inn
        if (inn, side) != self.half:
            self.half = (inn, side)
            self.bases = {}
            self.outs = 0
            self.reached_on_err = set()
        if ev == "NP" or ev.startswith("NP"):
            return
        fside = 1 - side
        pitcher = self.pitcher[fside]
        basic, mods, adv = split_event(ev)
        before = dict(self.bases)
        outs_before = self.outs
        # explicit advances
        explicit = {}
        for a in adv:
            m = re.match(r"([B123])([-X])([123H])(.*)", a)
            if not m:
                continue
            src, op, dst, rest = m.groups()
            safe = op == "-" or ("E" in rest and op == "X" and not re.search(r"\(\d*E\d*/TH\)|\(TH\)", rest) and re.search(r"\(\d*E\d+", rest) is not None)
            explicit[src] = {"dst": dst, "safe": safe, "nr": ("NR" in rest or "NORBI" in rest), "rbi": "(RBI)" in rest, "ur": "UR" in rest}

        pa_end = True
        kind = ""
        bat_dst = None  # where the batter ends up by default (None = out)
        ev_outs_runners = set()
        dp = any(m.startswith(("GDP", "DP", "LDP", "FDP", "BGDP", "BPDP", "TP", "GTP", "LTP")) for m in mods)
        sf = any(m.startswith("SF") for m in mods)
        sh = any(m.startswith("SH") for m in mods)
        extra = []  # secondary runner events (K+SB2, W+WP...)
        b0 = basic
        if "+" in basic and not basic.startswith("+"):
            b0, *extra = basic.split("+")

        def runner_events(code):
            # returns list of (src, dst, safe)
            out = []
            for c in code.split(";"):
                c = c.strip()
                m = re.match(r"SB([23H])", c)
                if m:
                    d = m.group(1)
                    src = {"2": "1", "3": "2", "H": "3"}[d]
                    out.append((src, d, True, "SB"))
                    continue
                m = re.match(r"(?:PO)?CS([23H])(\(.*\))?", c)
                if m:
                    d = m.group(1)
                    src = {"2": "1", "3": "2", "H": "3"}[d]
                    safe = bool(m.group(2) and "E" in m.group(2))
                    out.append((src, d if safe else d, safe, "CS"))
                    continue
                m = re.match(r"PO([123])(\(.*\))?", c)
                if m:
                    safe = bool(m.group(2) and "E" in m.group(2))
                    if not safe:
                        out.append((m.group(1), m.group(1), False, "PO"))
            return out

        rev = []
        if re.match(r"^K", b0) and not b0.startswith("KK"):
            kind = "K"
        elif b0 in ("W",) or (b0.startswith("W") and not b0.startswith("WP")):
            kind, bat_dst = "BB", "1"
        elif b0.startswith("IW") or b0 == "I":
            kind, bat_dst = "IBB", "1"
        elif b0.startswith("HP"):
            kind, bat_dst = "HBP", "1"
        elif re.match(r"^(HR|H)(\d|$)", b0):
            kind, bat_dst = "HR", "H"
        elif b0.startswith("DGR") or re.match(r"^D(\d|$)", b0):
            kind, bat_dst = "2B", "2"
        elif re.match(r"^T(\d|$)", b0):
            kind, bat_dst = "3B", "3"
        elif re.match(r"^S(\d|$)", b0):
            kind, bat_dst = "1B", "1"
        elif re.match(r"^E\d", b0):
            kind, bat_dst = "E", "1"
        elif b0.startswith("FC"):
            kind, bat_dst = "FC", "1"
        elif b0.startswith("C") and not b0.startswith("CS"):
            kind, bat_dst = "CI", "1"
        elif re.match(r"^\d", b0):
            kind = "OUT"
            # runners forced out are marked "(n)"; batter safe if the sequence ends with ")" and no "(B)"
            for r in re.findall(r"\(([B123])\)", b0):
                if r != "B":
                    ev_outs_runners.add(r)
            if b0.endswith(")") and "(B)" not in b0:
                bat_dst = "1"
            else:
                bat_dst = None
        elif b0.startswith(("SB", "CS", "PO", "POCS")):
            pa_end = False
            rev = runner_events(basic)
        elif b0.startswith(("WP", "PB", "BK", "DI", "OA", "FLE", "OBS", "OB")):
            pa_end = False
        else:
            pa_end = False
        for x in extra:
            rev += runner_events(x)
        if kind == "OUT" and "E" in b0 and bat_dst is None and "B" not in explicit:
            pass

        if kind == "FLE" or (not pa_end and b0.startswith("FLE")):
            return

        bside = side
        bx_bat = self.b(batter, bside)
        new = {}
        moved = set()
        scorers = []  # (pid, src, rbi_flag)
        outs_now = 0

        # runner events from SB/CS/PO
        for src, dst, safe, tag in rev:
            pid = before.get(int(src))
            if pid is None or src in explicit:
                if pid is not None and src in explicit:
                    if tag == "SB" and explicit[src]["safe"]:
                        self.b(pid, bside)["SB"] += 1
                    if tag == "CS":
                        self.b(pid, bside)["CS"] += 1
                continue
            moved.add(src)
            if tag == "SB":
                self.b(pid, bside)["SB"] += 1
            if tag == "CS":
                self.b(pid, bside)["CS"] += 1
            if safe:
                if dst == "H":
                    scorers.append((pid, src, False))
                else:
                    new[int(dst)] = pid
            else:
                outs_now += 1
        # runners named in the fielding string as forced out
        for r in ev_outs_runners:
            if r not in explicit and int(r) in before:
                moved.add(r)
                outs_now += 1
        # explicit advances
        for src, e in explicit.items():
            pid = batter if src == "B" else before.get(int(src))
            if pid is None:
                continue
            moved.add(src)
            if e["safe"]:
                if e["dst"] == "H":
                    scorers.append((pid, src, (not e["nr"]) or e["rbi"]))
                else:
                    new[int(e["dst"])] = pid
            else:
                outs_now += 1
        # implicit batter movement
        if pa_end and "B" not in explicit:
            if kind == "K" and bat_dst is None:
                outs_now += 1
            elif bat_dst == "H":
                scorers.append((batter, "B", True))
            elif bat_dst is not None:
                new[int(bat_dst)] = batter
            else:
                outs_now += 1
        # forced runners on walks / HBP / interference, and leftover runners on HR
        if kind in ("BB", "IBB", "HBP", "CI") and "B" not in explicit:
            for base in (1, 2, 3):
                if str(base) in moved or base not in before:
                    continue
                # forced if all bases behind are (now) occupied
                if all((b in before) for b in range(1, base)):
                    dst = base + 1
                    moved.add(str(base))
                    if dst == 4:
                        scorers.append((before[base], str(base), True))
                    else:
                        new[dst] = before[base]
        if kind == "HR":
            for base in (1, 2, 3):
                if str(base) not in moved and base in before:
                    moved.add(str(base))
                    scorers.append((before[base], str(base), True))
        # runners who didn't move stay
        for base, pid in before.items():
            if str(base) not in moved and base not in new:
                new[base] = pid
        self.bases = new
        self.outs += outs_now

        # RBI rules
        rbi_event = kind in ("1B", "2B", "3B", "HR", "BB", "IBB", "HBP", "OUT", "FC", "CI") and not dp
        if kind == "K":
            rbi_event = False
        for pid, src, flag in scorers:
            credit = rbi_event and flag
            if src in explicit and explicit[src]["rbi"]:
                credit = True
            self.run_scored(pid, True, batter, bside, credit if pa_end else False)
            if pitcher and pid in self.reached_on_err:
                pass

        if not pa_end:
            return
        if kind == "":
            return
        if kind == "E":
            self.reached_on_err.add(batter)
        # batter/pitcher lines
        pit_side = fside
        if pitcher is None:
            return
        pb = self.b(pitcher, pit_side)
        npitch = sum(1 for c in (pitches or "") if c in PITCH_CHARS)
        pb["PIT"] += npitch
        pb["BF"] += 1
        pb["outs"] += outs_now
        bx_bat["PA"] += 1
        ab = kind in ("1B", "2B", "3B", "HR", "K", "OUT", "E", "FC") and not sf and not sh
        if ab:
            bx_bat["AB"] += 1
        if kind in ("1B", "2B", "3B", "HR"):
            bx_bat["H"] += 1
            pb["pH"] += 1
        if kind == "2B":
            bx_bat["D"] += 1
        if kind == "3B":
            bx_bat["T"] += 1
        if kind == "HR":
            bx_bat["HR"] += 1
            pb["pHR"] += 1
        if kind in ("BB", "IBB"):
            bx_bat["BB"] += 1
            pb["pBB"] += 1
        if kind == "HBP":
            bx_bat["HBP"] += 1
            pb["pHBP"] += 1
        if kind == "K":
            bx_bat["K"] += 1
            pb["pK"] += 1
        bats = self.people.get(batter, {}).get("bats", "R")
        throws = self.people.get(pitcher, {}).get("throws", "R")
        if bats == "B":
            bats = "L" if throws == "R" else "R"
        self.pa.append({
            "game": self.gid, "inn": inn, "top": int(side == 0), "bat": batter, "pit": pitcher,
            "bhand": bats, "phand": throws, "ev": kind, "bip": bip_type(mods) if kind in ("OUT", "1B", "2B", "3B", "HR", "E", "FC") else "",
            "dp": int(dp), "sf": int(sf), "sh": int(sh), "pitches": npitch, "outs": outs_before,
            "r1": int(1 in before), "r2": int(2 in before), "r3": int(3 in before),
            "runs": len(scorers), "outs_on_play": outs_now,
        })

    def finish(self, date, season):
        gid = self.gid
        vis, home = BY_RETRO.get(self.info.get("visteam")), BY_RETRO.get(self.info.get("hometeam"))
        gtype = self.info.get("gametype", "regular")
        for pid, n in self.er.items():
            if pid in self.box:
                self.box[pid]["pER"] = n
        for key, k in (("wp", "W"), ("lp", "L"), ("save", "SV")):
            pid = self.info.get(key)
            if pid and pid in self.box:
                self.box[pid][k] = 1
        g = {
            "game": gid, "date": date, "season": season, "gtype": "R" if gtype == "regular" else "P",
            "away": vis, "home": home, "ascore": self.score[0], "hscore": self.score[1],
            "a_sp": self.sp[0], "h_sp": self.sp[1], "site": self.info.get("site", ""),
            "a_inn1": self.inn_runs.get((1, 0), 0), "h_inn1": self.inn_runs.get((1, 1), 0),
            "innings": max([k[0] for k in self.inn_runs] + [9]),
        }
        rows = []
        for pid, bx in self.box.items():
            side = bx["side"]
            r = dict(bx)
            r.update({"game": gid, "date": date, "season": season, "team": vis if side == 0 else home,
                      "opp": home if side == 0 else vis, "home": side, "name": self.people.get(pid, {}).get("name", pid)})
            rows.append(r)
        return g, rows


def parse_file(path, people, season):
    games, boxes, pas = [], [], []
    g = None
    date = None

    def close():
        if g is not None and g.info.get("visteam") in BY_RETRO and g.info.get("hometeam") in BY_RETRO:
            gr, rows = g.finish(date, season)
            games.append(gr)
            boxes.extend(rows)
            for p in g.pa:
                p["date"] = date
                p["season"] = season
                p["bteam"] = gr["away"] if p["top"] else gr["home"]
                p["pteam"] = gr["home"] if p["top"] else gr["away"]
            pas.extend(g.pa)

    for line in open(path, encoding="latin-1"):
        line = line.rstrip("\r\n")
        if not line:
            continue
        rec, _, rest = line.partition(",")
        if rec == "id":
            close()
            g = Game(rest, people)
        elif g is None:
            continue
        elif rec == "info":
            k, _, v = rest.partition(",")
            g.info[k] = v
            if k == "date":
                date = v.replace("/", "-")
        elif rec in ("start", "sub"):
            m = re.match(r'([^,]+),"?(.*?)"?,(\d),(\d+),(\d+)$', rest)
            if m:
                pid, name, side, slot, pos = m.groups()
                if pid not in people:
                    people[pid] = {"pid": pid, "name": name, "bats": "R", "throws": "R", "pos": ""}
                g.start(pid, side, slot, pos, sub=(rec == "sub"))
        elif rec == "play":
            p = rest.split(",")
            if len(p) >= 6:
                g.play(p[0], p[1], p[2], p[3], p[4], ",".join(p[5:]))
        elif rec == "radj":
            p = rest.split(",")
            if len(p) >= 2 and g.half is not None:
                pass
            # extra-inning automatic runner: placed before the half-inning's first play
            g._radj = (p[0], int(p[1])) if len(p) >= 2 else None
        elif rec == "data":
            p = rest.split(",")
            if p[0] == "er" and len(p) >= 3:
                g.er[p[1]] = g.er.get(p[1], 0) + int(p[2])
    close()
    return games, boxes, pas


# radj must be applied when the next half-inning starts; patch Game.play to do that.
_orig_play = Game.play


def _play_with_radj(self, inn, side, batter, count, pitches, ev):
    radj = getattr(self, "_radj", None)
    if radj is not None:
        if (int(inn), int(side)) != self.half:
            _orig_play(self, inn, side, batter, count, pitches, "NP")  # roll over the half-inning
        self.bases[radj[1]] = radj[0]
        self._radj = None
    return _orig_play(self, inn, side, batter, count, pitches, ev)


Game.play = _play_with_radj


def load_season(raw_dir, year):
    d = season_dir(raw_dir, year)
    people = read_rosters(d)
    games, boxes, pas = [], [], []
    files = sorted(glob.glob(os.path.join(d, f"{year}*.EV*")))
    for f in files:
        if re.search(r"AS\.EVE$", f):  # All-Star Game
            continue
        g, b, p = parse_file(f, people, year)
        games += g
        boxes += b
        pas += p
    games = pd.DataFrame(games).drop_duplicates("game")
    box = pd.DataFrame(boxes)
    pa = pd.DataFrame(pas)
    ppl = pd.DataFrame(list(people.values()))
    # Retrosheet ids aren't MLBAM ids; the site falls back to initials instead of headshots.
    ppl["mlbam"] = None
    return games, pa, box, ppl
