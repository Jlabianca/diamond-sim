/* Diamond Sim — plate-appearance / pitch-by-pitch MLB game simulator.
   Works in the browser (window.MLBSim), in a web worker and in Node (module.exports). */
(function (root) {
  "use strict";
  const K = 0, BB = 1, HBP = 2, S1 = 3, S2 = 4, S3 = 5, HR = 6; // order of the rate arrays in model.json
  const KEYS = ["k", "bb", "hbp", "s", "d", "t", "hr"];

  function rng(seed) { // mulberry32
    let a = seed >>> 0 || 1;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const oddsMix = (b, p, l) => { // generalized log5
    b = Math.min(0.97, Math.max(1e-5, b)); p = Math.min(0.97, Math.max(1e-5, p)); l = Math.min(0.97, Math.max(1e-5, l));
    const x = (b / (1 - b)) * (p / (1 - p)) / (l / (1 - l));
    return x / (1 + x);
  };

  // ------------------------------------------------------------ setup
  function index(model) {
    if (model._idx) return model._idx;
    const idx = {};
    for (const t in model.teams) for (const p of model.teams[t].players) idx[p.id] = Object.assign({ team: t }, p);
    model._idx = idx;
    return idx;
  }
  const isPitcher = (p) => p && p.pos === "P";

  function guessStarter(model, team, out) {
    const T = model.teams[team], idx = index(model);
    const rot = (T.rotation || []).filter((id) => idx[id] && !out.has(id));
    if (!rot.length) {
      const sp = T.players.filter((p) => p.role === "SP" && !out.has(p.id));
      return sp.length ? sp[0].id : (T.players.find((p) => isPitcher(p) && !out.has(p.id)) || {}).id;
    }
    let best = rot[0], bestDate = "9999";
    for (const id of rot) { const d = idx[id].last_start || "0000"; if (d < bestDate) { bestDate = d; best = id; } }
    return best;
  }

  function defaultOut(model, teams) {
    const out = [];
    for (const t of teams) for (const p of model.teams[t].players) if (p.status) out.push(p.id);
    return out;
  }

  function guessLineup(model, team, oppHand, out) {
    const T = model.teams[team], idx = index(model);
    const base = (T.lineups && (T.lineups[oppHand] || T.lineups[oppHand === "R" ? "L" : "R"])) || [];
    const lu = base.map((x) => x.id).filter((id) => idx[id] && !out.has(id));
    const pos = {};
    base.forEach((x) => (pos[x.id] = x.pos));
    const pool = T.players.filter((p) => !isPitcher(p) && !out.has(p.id) && !lu.includes(p.id)).sort((a, b) => b.n - a.n);
    while (lu.length < 9 && pool.length) { const p = pool.shift(); lu.push(p.id); }
    return lu.slice(0, 9);
  }

  function defaults(model, away, home, sched, outArr) {
    const out = new Set(outArr || defaultOut(model, [away, home]));
    const idx = index(model);
    const ok = (id, t) => id && idx[id] && idx[id].team === t;
    const sp = {
      away: sched && ok(sched.away_sp, away) ? sched.away_sp : guessStarter(model, away, out),
      home: sched && ok(sched.home_sp, home) ? sched.home_sp : guessStarter(model, home, out),
    };
    const hand = (id) => (idx[id] && idx[id].throws) || "R";
    const lineups = {
      away: sched && sched.away_lineup && sched.away_lineup.every((id) => ok(id, away)) ? sched.away_lineup.slice() : guessLineup(model, away, hand(sp.home), out),
      home: sched && sched.home_lineup && sched.home_lineup.every((id) => ok(id, home)) ? sched.home_lineup.slice() : guessLineup(model, home, hand(sp.away), out),
    };
    const pos = {};
    for (const side of ["away", "home"]) Object.assign(pos, assignPositions(model, side === "away" ? away : home, lineups[side]));
    return { sp, lineups, pos, posted: { away: !!(sched && sched.away_lineup), home: !!(sched && sched.home_lineup) } };
  }

  // give each hitter in a lineup a distinct defensive position (or DH)
  function assignPositions(model, team, lineup) {
    const T = model.teams[team], idx = index(model);
    const hint = {};
    const lus = ["R", "L"].map((h) => (T.lineups && T.lineups[h]) || []).sort((a, b) => b.filter((x) => lineup.includes(x.id)).length - a.filter((x) => lineup.includes(x.id)).length);
    for (const l of lus) for (const x of l) if (!hint[x.id]) hint[x.id] = x.pos;
    const want = lineup.map((id) => { let p = hint[id] || (idx[id] && idx[id].pos) || "DH"; if (p === "OF") p = "LF"; if (p === "IF") p = "2B"; if (p === "TWP") p = "DH"; return p; });
    const all = ["C", "1B", "2B", "3B", "SS", "LF", "CF", "RF", "DH"];
    const used = new Set(), out = {}, left = [];
    lineup.forEach((id, i) => { if (all.includes(want[i]) && !used.has(want[i])) { used.add(want[i]); out[id] = want[i]; } else left.push(id); });
    const free = all.filter((p) => !used.has(p));
    const near = { LF: ["RF", "CF", "DH"], RF: ["LF", "CF", "DH"], CF: ["LF", "RF", "DH"], SS: ["2B", "3B", "DH"], "2B": ["SS", "3B", "DH"], "3B": ["SS", "1B", "DH"], "1B": ["DH", "3B"], C: ["DH", "1B"], DH: ["1B", "LF", "RF"] };
    for (const id of left) {
      const w = (hint[id] || (idx[id] && idx[id].pos) || "DH");
      const pick = (near[w] || []).find((p) => free.includes(p)) || free[0] || "DH";
      out[id] = pick; free.splice(free.indexOf(pick), 1);
    }
    return out;
  }

  function prepare(model, o) {
    const idx = index(model);
    const out = new Set(o.out || []);
    const L = model.league, C = model.consts || {};
    const sides = [o.away, o.home].map((team, s) => {
      const T = model.teams[team];
      const lineup = o.lineups[s ? "home" : "away"].map((id) => idx[id]).filter(Boolean);
      const sp = idx[o.sp[s ? "home" : "away"]];
      const pen = (T.bullpen || []).map((x) => ({ p: idx[x.id], role: x.role })).filter((x) => x.p && !out.has(x.p.id) && (!sp || x.p.id !== sp.id));
      // relievers with no role (rookies, recent call-ups)
      if (pen.length < 7) for (const p of T.players) if (p.role === "RP" && !p.status && !out.has(p.id) && !pen.some((x) => x.p.id === p.id) && (!sp || p.id !== sp.id)) pen.push({ p: idx[p.id], role: "LOW" });
      if (pen.length < 4) for (const p of T.players) if (p.role === "SP" && !out.has(p.id) && (!sp || p.id !== sp.id) && !pen.some((x) => x.p.id === p.id) && !(T.rotation || []).slice(0, 4).includes(p.id)) pen.push({ p: idx[p.id], role: "LONG" });
      const bench = T.players.filter((p) => p.pos !== "P" && !p.status && !out.has(p.id) && !lineup.some((x) => x.id === p.id)).map((p) => idx[p.id]);
      return { team, lineup, sp, pen, bench };
    });
    const park = o.neutral ? null : model.teams[o.home].park;
    return { sides, L, C, park, cache: new Map() };
  }

  // probabilities of [K, BB, HBP, 1B, 2B, 3B, HR] for this batter vs this pitcher
  function paProbs(G, bat, pit, side, tto) {
    const key = bat.id + "|" + pit.id + "|" + side + "|" + tto;
    let pr = G.cache.get(key);
    if (pr) return pr;
    const L = G.L, C = G.C;
    const bh = bat.bats === "B" ? (pit.throws === "L" ? "R" : "L") : bat.bats || "R";
    const plat = L.platoon[bh + (pit.throws || "R")];
    pr = new Float64Array(8);
    let sum = 0;
    for (let k = 0; k < 7; k++) {
      const key2 = KEYS[k];
      let p = oddsMix(bat.r[k], pit.r[k], L.rates[key2]);
      p *= plat[key2];
      if (G.park) p *= G.park[key2] || 1;
      if (k >= S1) p *= C.bip_hit || 1;
      if (k === HR) p *= C.hr || 1;
      if (k === K) p *= C.k || 1;
      const hf = C.hfa || 1;
      if (k === BB || k >= S1) p *= side === 1 ? hf : 1 / hf;
      if (tto >= 3) { if (k === K) p /= C.tto || 1; else if (k !== HBP) p *= C.tto || 1; }
      pr[k] = p; sum += p;
    }
    if (sum > 0.92) for (let k = 0; k < 7; k++) pr[k] *= 0.92 / sum;
    // ground-ball share of balls in play
    pr[7] = oddsMix(bat.gb != null ? bat.gb : L.gb, pit.gb != null ? pit.gb : L.gb, L.gb);
    G.cache.set(key, pr);
    return pr;
  }

  // ------------------------------------------------------------ one game
  const BAT_STATS = ["pa", "ab", "h", "s", "d", "t", "hr", "r", "rbi", "bb", "k", "hbp", "sb", "cs", "tb"];
  const PIT_STATS = ["outs", "bf", "ph", "pr", "er", "pbb", "pk", "phr", "pc", "w", "l", "sv"];

  function simulateGame(model, o, preparedG) {
    const G = preparedG || prepare(model, o);
    const R = rng(o.seed || 1);
    const L = G.L, C = G.C;
    const log = !!o.log;
    const events = log ? [] : null;
    const score = [0, 0], innRuns = [[], []], hits = [0, 0], errs = [0, 0];
    const box = {};
    const bx = (p, s) => box[p.id] || (box[p.id] = { id: p.id, side: s, name: p.name, short: p.short, pos: p.pos, order: 0, sub: false, pa: 0, ab: 0, h: 0, s: 0, d: 0, t: 0, hr: 0, r: 0, rbi: 0, bb: 0, k: 0, hbp: 0, sb: 0, cs: 0, tb: 0, outs: 0, bf: 0, ph: 0, pr: 0, er: 0, pbb: 0, pk: 0, phr: 0, pc: 0, w: 0, l: 0, sv: 0, pitched: false, entered: null });
    const st = G.sides.map((S, s) => {
      S.lineup.forEach((p, i) => { const b = bx(p, s); b.order = i + 1; b.pos = (o.pos && o.pos[p.id]) || b.pos; });
      return { S, up: 0, cur: S.lineup.slice(), subbed: new Array(9).fill(false), bench: S.bench.slice(), pitcher: S.sp, pitchers: [S.sp], used: new Set([S.sp.id]), pcLimit: 0, stint: null, faced: {} };
    });
    for (let s = 0; s < 2; s++) {
      const sp = st[s].pitcher;
      const b = bx(sp, s); b.pitched = true; b.entered = { inn: 1, lead: 0 };
      const mean = sp.pc || L.sp_pitches || 88;
      st[s].pcLimit = Math.max(45, Math.min(115, mean + (C.pc_adj || 0) + gauss(R) * 8));
    }
    let lead = [], decided = null; // track lead changes for W/L
    let inn = 1, half = 0, f5 = null, ended = false, lastInn = 1;

    function gauss(r) { let u = 0, v = 0; while (u === 0) u = r(); v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
    const pickPitches = (mean, min) => { // rough count distribution
      const lam = Math.max(0.2, mean - min);
      let n = min, l = Math.exp(-lam), p = 1;
      do { n++; p *= R(); } while (p > l);
      return n - 1;
    };

    function chooseReliever(s, fieldLead, inning) {
      const T = st[s];
      const avail = T.S.pen.filter((x) => !T.used.has(x.p.id));
      if (!avail.length) return null;
      const by = (roles) => avail.find((x) => roles.includes(x.role));
      let pick = null;
      if (inning >= 9 && fieldLead >= 1 && fieldLead <= 3) pick = by(["CL"]) || by(["SU"]);
      else if (inning >= 9 && fieldLead === 0) pick = by(["CL", "SU"]);
      else if (inning >= 8 && fieldLead >= -1 && fieldLead <= 4) pick = by(["SU"]) || by(["CL"]) || by(["MID"]);
      else if (inning >= 7 && Math.abs(fieldLead) <= 2) pick = by(["SU", "MID"]);
      else if (Math.abs(fieldLead) >= 5 || inning <= 4) pick = by(["LONG", "LOW", "MID"]);
      if (!pick) pick = by(["MID", "LOW", "LONG"]) || by(["SU"]) || avail[0];
      if (pick.role === "CL" && !(inning >= 9 && fieldLead >= 0 && fieldLead <= 3)) {
        const alt = avail.find((x) => x.role !== "CL"); if (alt) pick = alt;
      }
      return pick;
    }
    function changePitcher(s, why) {
      const fieldLead = score[s] - score[1 - s];
      const pick = chooseReliever(s, fieldLead, inn);
      if (!pick) return false;
      const T = st[s];
      const old = T.pitcher;
      T.pitcher = pick.p; T.used.add(pick.p.id); T.pitchers.push(pick.p);
      const b = bx(pick.p, s); b.pitched = true; b.entered = { inn, lead: fieldLead, outsAtEntry: 0 };
      const longMan = pick.role === "LONG" || (inn <= 5);
      T.stint = { outs: 0, runs: 0, pc: 0, maxOuts: longMan ? 6 + Math.floor(R() * 4) : (R() < 0.18 ? 4 + Math.floor(R() * 2) : 3), role: pick.role };
      if (log) events.push({ kind: "pitch", inn, half, side: s, out: old.id, in: pick.p.id, why, score: score.slice() });
      return true;
    }

    // base state: array of {p, err(bool: reached on error), resp(pitcher responsible)}
    let bases = [null, null, null], outs = 0;

    function scoreRun(runner, batSide, rbiTo, earnedOk) {
      score[batSide]++;
      innRuns[batSide][inn - 1] = (innRuns[batSide][inn - 1] || 0) + 1;
      bx(runner.p, batSide).r++;
      if (rbiTo) bx(rbiTo, batSide).rbi++;
      const resp = runner.resp || st[1 - batSide].pitcher;
      const rb = bx(resp, 1 - batSide);
      rb.pr++;
      if (!runner.err && earnedOk) rb.er++;
      if (st[1 - batSide].stint) st[1 - batSide].stint.runs++;
      // lead tracking for decisions
      const a = score[0], h = score[1];
      const leader = a > h ? 0 : h > a ? 1 : -1;
      const prevLeader = lead.length ? lead[lead.length - 1].leader : -1;
      if (leader !== prevLeader) lead.push({ leader, winP: leader >= 0 ? st[leader].pitcher : null, loseP: leader >= 0 ? resp : null });
    }

    function paceSteal(batSide, pit) {
      // stolen-base attempts before the pitch to this batter
      if (bases[0] && !bases[1] && outs < 3) {
        const r = bases[0].p;
        const att = (r.sba != null ? r.sba : L.sb_att) * (C.sb || 0.62);
        if (R() < att) {
          const pct = Math.max(0.4, Math.min(0.97, (r.sbp != null ? r.sbp : L.sb_pct) - (pit.throws === "L" ? 0.03 : 0)));
          const ok = R() < pct;
          const runner = bases[0]; bases[0] = null;
          if (ok) { bases[1] = runner; bx(r, batSide).sb++; }
          else { outs++; bx(r, batSide).cs++; bx(st[1 - batSide].pitcher, 1 - batSide).outs++; if (st[1 - batSide].stint) st[1 - batSide].stint.outs++; }
          if (log) events.push({ kind: "sb", inn, half, side: batSide, runner: r.id, base: 2, ok, outs, bases: bases.map((x) => x && x.p.id), score: score.slice(), pid: st[1 - batSide].pitcher.id });
          return;
        }
      }
      if (bases[1] && !bases[2] && outs < 2) {
        const r = bases[1].p;
        const att = (r.sba != null ? r.sba : L.sb_att) * (C.sb || 0.62) * 0.15;
        if (R() < att) {
          const ok = R() < Math.min(0.95, (r.sbp != null ? r.sbp : L.sb_pct) + 0.03);
          const runner = bases[1]; bases[1] = null;
          if (ok) { bases[2] = runner; bx(r, batSide).sb++; }
          else { outs++; bx(r, batSide).cs++; bx(st[1 - batSide].pitcher, 1 - batSide).outs++; if (st[1 - batSide].stint) st[1 - batSide].stint.outs++; }
          if (log) events.push({ kind: "sb", inn, half, side: batSide, runner: r.id, base: 3, ok, outs, bases: bases.map((x) => x && x.p.id), score: score.slice(), pid: st[1 - batSide].pitcher.id });
        }
      }
    }

    function makeSeq(res, n) { // pitch-by-pitch sequence consistent with the result and pitch count
      const seq = [];
      let b = 0, s = 0;
      const strikeKind = () => { const u = R(); return u < 0.4 ? "C" : u < 0.75 ? "S" : "F"; };
      const last = res === "K" ? (R() < 0.27 ? "C" : "S") : res === "BB" ? "B" : res === "HBP" ? "H" : "X";
      const pre = n - 1;
      // choose how many balls/strikes come before the final pitch
      let balls, strikes;
      if (res === "K") { strikes = 2; balls = Math.min(3, Math.max(0, pre - 2 - Math.floor(R() * 2))); }
      else if (res === "BB") { balls = 3; strikes = Math.min(2, Math.max(0, pre - 3)); }
      else { balls = Math.min(3, Math.floor(R() * Math.min(4, pre + 1))); strikes = Math.min(2, Math.max(0, pre - balls)); }
      let fouls = Math.max(0, pre - balls - strikes);
      // emit in random order; extra fouls only come with two strikes
      while (b < balls || s < strikes || fouls > 0) {
        const canB = b < balls, canS = s < strikes, canF = s === 2 && fouls > 0;
        const tot = (canB ? balls - b : 0) + (canS ? strikes - s : 0) + (canF ? fouls : 0);
        if (tot === 0) { if (fouls > 0 && s < 2) { s++; seq.push("F"); fouls--; continue; } break; }
        let u = R() * tot;
        if (canB && u < balls - b) { seq.push("B"); b++; continue; }
        if (canB) u -= balls - b;
        if (canS && u < strikes - s) { seq.push(strikeKind()); s++; continue; }
        seq.push("F"); fouls--;
      }
      seq.push(last);
      return seq;
    }

    function maybeSub(T, slot, batSide) { // late-game pinch hitters / defensive replacements / blowout rest
      if (inn < 7 || T.subbed[slot] || !T.bench.length) return;
      const diff = Math.abs(score[0] - score[1]);
      const q = (C.sub != null ? C.sub : 0.06) * (diff >= 6 ? 3.5 : diff >= 4 ? 1.6 : 1) * (slot >= 6 ? 1.6 : slot <= 2 ? 0.5 : 1);
      if (R() >= q) return;
      const k = Math.floor(R() * Math.min(4, T.bench.length));
      const sub = T.bench.splice(k, 1)[0];
      const old = T.cur[slot];
      T.cur[slot] = sub; T.subbed[slot] = true;
      const b = bx(sub, batSide); b.order = slot + 1; b.sub = true;
      for (let i = 0; i < 3; i++) if (bases[i] && bases[i].p === old) bases[i] = Object.assign({}, bases[i], { p: sub });
      if (log) events.push({ kind: "ph", inn, half, side: batSide, out: old.id, in: sub.id, score: score.slice() });
    }

    function plateAppearance(batSide) {
      const T = st[batSide], F = st[1 - batSide];
      maybeSub(T, T.up % 9, batSide);
      const bat = T.cur[T.up % 9];
      const pit = F.pitcher;
      const fb = bx(pit, 1 - batSide), bb_ = bx(bat, batSide);
      F.faced[bat.id] = (F.faced[bat.id] || 0) + 1;
      const tto = pit === F.S.sp ? F.faced[bat.id] : 1;
      const pr = paProbs(G, bat, pit, batSide, tto);
      let u = R(), res = "OUT", acc = 0;
      const names = ["K", "BB", "HBP", "1B", "2B", "3B", "HR"];
      for (let k = 0; k < 7; k++) { acc += pr[k]; if (u < acc) { res = names[k]; break; } }
      let bip = "";
      if (res !== "K" && res !== "BB" && res !== "HBP") {
        if (res === "HR") bip = R() < 0.25 ? "L" : "F";
        else if (res === "1B") bip = R() < pr[7] * 1.05 ? "G" : R() < 0.72 ? "L" : "F";
        else if (res === "2B" || res === "3B") bip = R() < 0.18 ? "G" : R() < 0.55 ? "L" : "F";
        else {
          if (R() < pr[7]) bip = "G";
          else { const v = R() * (L.bip.F + L.bip.L + L.bip.P); bip = v < L.bip.F ? "F" : v < L.bip.F + L.bip.L ? "L" : "P"; }
          if (R() < L.err) res = "E";
        }
      }
      // pitch count
      const ppf = (pit.ppbf || 3.9) / 3.9;
      const meanP = (res === "K" ? L.ppa.k : res === "BB" ? L.ppa.bb : res === "HBP" ? L.ppa.hbp : L.ppa.bip) * ppf;
      const n = pickPitches(meanP, res === "K" ? 3 : res === "BB" ? 4 : 1);
      fb.pc += n; fb.bf++; if (F.stint) F.stint.pc += n;
      bb_.pa++;
      const before = bases.map((x) => x && x.p.id), outsBefore = outs;
      const scored = [];
      let rbi = 0, dp = false, sf = false, fc = false, adv = "";
      const runnerObj = { p: bat, err: res === "E", resp: pit };
      const spd = (r) => (r && r.p.sba != null ? Math.max(0.75, Math.min(1.3, 0.85 + r.p.sba * 1.6)) : 1);
      const score1 = (r, credit, earned) => { scored.push(r.p.id); scoreRun(r, batSide, credit ? bat : null, earned !== false); if (credit) rbi++; };
      const A = C.adv || 1;
      if (res === "K") { bb_.k++; bb_.ab++; fb.pk++; outs++; }
      else if (res === "BB" || res === "HBP") {
        if (res === "BB") { bb_.bb++; fb.pbb++; } else { bb_.hbp++; fb.phbp = (fb.phbp || 0) + 1; }
        if (bases[0]) { if (bases[1]) { if (bases[2]) score1(bases[2], true); bases[2] = bases[1]; } bases[1] = bases[0]; }
        bases[0] = runnerObj;
      } else if (res === "HR") {
        bb_.ab++; bb_.h++; bb_.hr++; bb_.tb += 4; fb.ph++; fb.phr++; hits[batSide]++;
        for (let b = 2; b >= 0; b--) if (bases[b]) score1(bases[b], true);
        bases = [null, null, null];
        score1(runnerObj, true);
      } else if (res === "3B") {
        bb_.ab++; bb_.h++; bb_.t++; bb_.tb += 3; fb.ph++; hits[batSide]++;
        for (let b = 2; b >= 0; b--) if (bases[b]) score1(bases[b], true);
        bases = [null, null, runnerObj];
      } else if (res === "2B") {
        bb_.ab++; bb_.h++; bb_.d++; bb_.tb += 2; fb.ph++; hits[batSide]++;
        if (bases[2]) score1(bases[2], true);
        if (bases[1]) score1(bases[1], true);
        let r1 = bases[0], nb = [null, runnerObj, null];
        if (r1) { if (R() < Math.min(0.95, (outs === 2 ? 0.6 : 0.42) * spd(r1) * A)) score1(r1, true); else nb[2] = r1; }
        bases = nb;
      } else if (res === "1B") {
        bb_.ab++; bb_.h++; bb_.s++; bb_.tb += 1; fb.ph++; hits[batSide]++;
        const nb = [runnerObj, null, null];
        if (bases[2]) score1(bases[2], true);
        if (bases[1]) {
          const p2 = (bip === "G" ? 0.42 : outs === 2 ? 0.82 : 0.62) * spd(bases[1]) * A;
          if (R() < Math.min(0.97, p2)) score1(bases[1], true); else nb[2] = bases[1];
        }
        if (bases[0]) {
          const p13 = (bip === "G" ? 0.15 : outs === 2 ? 0.36 : 0.28) * spd(bases[0]) * A;
          if (!nb[2] && R() < Math.min(0.9, p13)) nb[2] = bases[0]; else nb[1] = bases[0];
        }
        bases = nb;
      } else if (res === "E") {
        bb_.ab++; errs[1 - batSide]++;
        // reached on error: everyone moves up a base; a run that scores this way is unearned
        if (bases[2]) score1(bases[2], false, false);
        bases = [runnerObj, bases[0], bases[1]];
      } else { // out in play
        bb_.ab++;
        if (bip === "G") {
          if (bases[0] && outs < 2 && R() < (L.dp || 0.43) / spd({ p: bat })) {
            dp = true; outs += 2;
            const nb = [null, null, null];
            if (outs < 3) { if (bases[2]) score1(bases[2], false); if (bases[1]) nb[2] = bases[1]; }
            bases = nb;
          } else if (bases[0] && R() < 0.42) { // fielder's choice: lead runner forced, batter safe
            fc = true; outs++;
            const nb = [runnerObj, null, null];
            if (outs < 3) {
              if (bases[1] && bases[2]) { score1(bases[2], true); nb[2] = bases[1]; } // forced home? (simplified: runner from 3rd scores)
              else if (bases[2]) { if (R() < 0.45) score1(bases[2], true); else nb[2] = bases[2]; }
              else if (bases[1]) nb[2] = bases[1];
            }
            bases = nb;
          } else {
            outs++;
            if (outs < 3) {
              const [r1, r2, r3] = bases;
              const nb = [null, null, null];
              if (r3) { if ((r1 && r2) || R() < 0.5 * A) score1(r3, true); else nb[2] = r3; }
              if (r2) { if (r1 || (!nb[2] && R() < 0.55 * A)) { if (!nb[2]) nb[2] = r2; else nb[1] = r2; } else nb[1] = r2; }
              if (r1) { if (!nb[1]) nb[1] = r1; else if (!nb[2]) { nb[2] = nb[1]; nb[1] = r1; } }
              bases = nb;
            } else bases = [null, null, null];
          }
        } else if (bip === "F") {
          outs++;
          if (outs < 3) {
            if (bases[2] && R() < Math.min(0.97, (L.sf || 0.6) * spd(bases[2]) * Math.sqrt(A))) { sf = true; bb_.ab--; score1(bases[2], true); bases[2] = null; }
            if (bases[1] && !bases[2] && R() < 0.24 * A) { bases[2] = bases[1]; bases[1] = null; }
          }
        } else if (bip === "L") {
          outs++;
          if (outs < 3 && (bases[0] || bases[1]) && R() < 0.05) { // doubled off
            outs++; if (bases[1]) bases[1] = null; else bases[0] = null;
            dp = true;
          }
        } else outs++;
      }
      // pitcher outs
      const outsMade = Math.min(3, outs) - outsBefore;
      fb.outs += outsMade; if (F.stint) F.stint.outs += outsMade;
      if (dp && rbi && res === "OUT") { bb_.rbi -= rbi; rbi = 0; } // no RBI on a double play
      T.up++;
      if (log) {
        events.push({
          kind: "pa", inn, half, side: batSide, bat: bat.id, pid: pit.id, res, bip, dp, sf, fc, seq: makeSeq(res === "E" || res === "OUT" ? "X" : res, n),
          before, after: bases.map((x) => x && x.p.id), outsBefore, outs: Math.min(3, outs), scored, rbi,
          score: score.slice(), pc: fb.pc, dir: R(), dist: R(), hits: hits.slice(), errs: errs.slice(), lu: T.cur.map((p) => p.id),
        });
      }
    }

    function halfInning(batSide) {
      bases = [null, null, null]; outs = 0; lastInn = inn;
      const F = st[1 - batSide];
      if (inn >= 10) { // automatic runner on second
        const T = st[batSide];
        const ghost = T.cur[(T.up + 8) % 9];
        bases[1] = { p: ghost, err: true, resp: F.pitcher };
        if (log) events.push({ kind: "ghost", inn, half, side: batSide, runner: ghost.id, score: score.slice() });
      }
      // pitching change between innings
      const fieldLead = score[1 - batSide] - score[batSide];
      if (F.pitcher === F.S.sp) {
        const b = bx(F.pitcher, 1 - batSide);
        const limit = F.pcLimit - 10;
        if (b.pc >= limit || (b.pr >= 5 && inn >= 3) || inn >= 10) changePitcher(1 - batSide, "between");
      } else if (F.stint && (F.stint.outs >= F.stint.maxOuts || F.stint.pc > 32 || (inn >= 8 && F.stint.role !== "CL" && chooseRole(1 - batSide, fieldLead)))) {
        changePitcher(1 - batSide, "between");
      }
      if (log) events.push({ kind: "start", inn, half, side: batSide, pid: F.pitcher.id, score: score.slice() });
      while (outs < 3) {
        // walk-off check
        if (batSide === 1 && inn >= 9 && score[1] > score[0]) break;
        // mid-inning hook
        const pb = bx(F.pitcher, 1 - batSide);
        if (F.pitcher === F.S.sp) {
          if (pb.pc >= F.pcLimit + 3 || (pb.pr >= 6) || (pb.pr >= 4 && pb.pc >= 70 && R() < 0.25)) changePitcher(1 - batSide, "hook");
        } else if (F.stint && (F.stint.pc > 38 || F.stint.runs >= 3 || (F.stint.runs >= 2 && R() < 0.15))) changePitcher(1 - batSide, "hook");
        paceSteal(batSide, F.pitcher);
        if (outs >= 3) break;
        if ((bases[0] || bases[1] || bases[2]) && R() < (C.wp || 0.024)) { // wild pitch / passed ball
          const nb = [null, null, null];
          if (bases[2]) scoreRun(bases[2], batSide, null, true);
          nb[2] = bases[1]; nb[1] = bases[0];
          bases = nb;
          if (log) events.push({ kind: "wp", inn, half, side: batSide, bases: bases.map((x) => x && x.p.id), outs, score: score.slice(), pid: F.pitcher.id });
          if (batSide === 1 && inn >= 9 && score[1] > score[0]) break;
        }
        plateAppearance(batSide);
      }
      if (log) events.push({ kind: "end", inn, half, side: batSide, score: score.slice(), lob: bases.filter(Boolean).length, hits: hits.slice(), errs: errs.slice() });
    }
    function chooseRole(s, fieldLead) { // should we bring in the 9th-inning guy?
      const T = st[s];
      if (inn >= 9 && fieldLead >= 1 && fieldLead <= 3) return T.S.pen.some((x) => x.role === "CL" && !T.used.has(x.p.id));
      return false;
    }

    while (!ended) {
      halfInning(0);
      if (inn >= 9 && score[1] > score[0]) { ended = true; break; }
      half = 1;
      halfInning(1);
      if (inn === 5) f5 = score.slice();
      if (inn >= 9 && score[0] !== score[1]) ended = true;
      if (inn >= 20) ended = true;
      inn++; half = 0;
    }
    if (!f5) f5 = score.slice();
    // decisions
    const winner = score[1] > score[0] ? 1 : score[0] > score[1] ? 0 : -1;
    if (winner >= 0) {
      let last = null;
      for (let i = lead.length - 1; i >= 0; i--) { if (lead[i].leader !== winner) break; last = lead[i]; }
      if (last) {
        let wp = last.winP;
        const wb = bx(wp, winner);
        if (wp === st[winner].S.sp && wb.outs < 15) wp = st[winner].pitchers[1] || wp;
        bx(wp, winner).w = 1;
        if (last.loseP) bx(last.loseP, 1 - winner).l = 1;
        const fin = st[winner].pitchers[st[winner].pitchers.length - 1];
        const fb = bx(fin, winner);
        if (fin !== wp && fb.entered && fb.entered.lead >= 1 && fb.entered.lead <= 3 && fb.outs >= 1) fb.sv = 1;
        else if (fin !== wp && fb.entered && fb.outs >= 9) fb.sv = 1;
      }
    }
    if (log) events.push({ kind: "final", inn: lastInn, score: score.slice(), hits: hits.slice(), errs: errs.slice() });
    return { score: { away: score[0], home: score[1] }, f5, innRuns, hits, errs, box, events, innings: lastInn, sides: st.map((x) => x.pitchers.map((p) => p.id)) };
  }

  // ------------------------------------------------------------ many games
  const PB = ["h", "tb", "hr", "r", "rbi", "hrr", "s", "d", "bb", "k", "sb", "onbase", "pa"];
  const PP = ["pk", "outs", "ph", "er", "pbb", "pc", "w", "phr", "pr"];

  function simulateMany(model, o, n, progress) {
    const G = prepare(model, o);
    const away = new Int16Array(n), home = new Int16Array(n), f5a = new Int16Array(n), f5h = new Int16Array(n), inn1 = new Int8Array(n);
    const extra = new Uint8Array(n);
    const players = {};
    const regB = (p, team, s) => (players[p.id] = { id: p.id, name: p.name, short: p.short, team, side: s, kind: "B", pos: p.pos, order: 0, d: {} });
    G.sides.forEach((S, s) => {
      S.lineup.forEach((p, i) => { const r = regB(p, S.team, s); r.order = i + 1; for (const k of PB) r.d[k] = new Uint8Array(n); });
      const pitchers = [S.sp, ...S.pen.map((x) => x.p)];
      pitchers.forEach((p) => {
        const r = players[p.id] = { id: p.id, name: p.name, short: p.short, team: S.team, side: s, kind: "P", pos: "P", role: p === S.sp ? "SP" : (S.pen.find((x) => x.p === p) || {}).role, d: {} };
        for (const k of PP) r.d[k] = new Uint8Array(n);
        r.d.app = new Uint8Array(n);
      });
    });
    const base = (o.seed || 12345) >>> 0;
    for (let i = 0; i < n; i++) {
      const g = simulateGame(model, Object.assign({}, o, { seed: (base + i * 2654435761) >>> 0, log: false }), G);
      away[i] = g.score.away; home[i] = g.score.home; f5a[i] = g.f5[0]; f5h[i] = g.f5[1];
      inn1[i] = (g.innRuns[0][0] || 0) + (g.innRuns[1][0] || 0);
      extra[i] = g.innings > 9 ? 1 : 0;
      for (const id in g.box) {
        const b = g.box[id], P = players[id];
        if (!P) continue;
        if (P.kind === "B") {
          const d = P.d;
          d.h[i] = b.h; d.tb[i] = b.tb; d.hr[i] = b.hr; d.r[i] = b.r; d.rbi[i] = b.rbi; d.hrr[i] = b.h + b.r + b.rbi;
          d.s[i] = b.s; d.d[i] = b.d; d.bb[i] = b.bb; d.k[i] = b.k; d.sb[i] = b.sb; d.onbase[i] = b.h + b.bb + b.hbp; d.pa[i] = b.pa;
        } else if (b.pitched) {
          const d = P.d;
          d.pk[i] = b.pk; d.outs[i] = b.outs; d.ph[i] = b.ph; d.er[i] = b.er; d.pbb[i] = b.pbb; d.pc[i] = Math.min(255, b.pc); d.w[i] = b.w; d.phr[i] = b.phr; d.pr[i] = b.pr; d.app[i] = 1;
        }
      }
      if (progress && (i + 1) % 250 === 0) progress((i + 1) / n);
    }
    return { n, away, home, f5a, f5h, inn1, extra, players };
  }

  function summarize(agg) {
    const n = agg.n;
    let homeWins = 0, ties5 = 0;
    for (let i = 0; i < n; i++) if (agg.home[i] > agg.away[i]) homeWins++;
    const players = {};
    for (const id in agg.players) {
      const P = agg.players[id];
      const d = {};
      for (const k in P.d) d[k] = Array.from(P.d[k]).sort((a, b) => a - b);
      let apps = 0; if (P.d.app) for (const x of P.d.app) apps += x;
      players[id] = { id: P.id, name: P.name, short: P.short, team: P.team, side: P.side, kind: P.kind, pos: P.pos, order: P.order, role: P.role, apps: P.d.app ? apps / n : 1, d };
    }
    return { n, wins: { home: homeWins, away: n - homeWins }, away: Array.from(agg.away), home: Array.from(agg.home), f5a: Array.from(agg.f5a), f5h: Array.from(agg.f5h), inn1: Array.from(agg.inn1), extra: Array.from(agg.extra), players, ties5 };
  }

  const API = { assignPositions, simulateGame, simulateMany, summarize, prepare, defaults, defaultOut, guessStarter, guessLineup, index, rng, BAT_STATS, PIT_STATS };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  else root.MLBSim = API;
})(typeof self !== "undefined" ? self : this);
