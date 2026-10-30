/* Tune a few global constants so the simulated league matches the real one:
   runs per game, home-field win rate, stolen bases per game and starters' workload.
   usage: node scripts/calibrate.js [site/data/model.json] [games per round] */
const fs = require("fs");
const path = require("path");
const S = require(path.join(__dirname, "..", "site", "js", "sim.js"));

const file = process.argv[2] || path.join(__dirname, "..", "site", "data", "model.json");
const N = +(process.argv[3] || 3000);
const model = JSON.parse(fs.readFileSync(file));
const L = model.league;
const teams = Object.keys(model.teams).filter((t) => model.teams[t].players.length > 15);

function measure(nGames, seed) {
  const R = S.rng(seed);
  const m = { runs: 0, games: 0, homeW: 0, nrfi: 0, sb: 0, hr: 0, k: 0, pa: 0, spOuts: 0, spPc: 0, sps: 0, extra: 0, h: 0, stPA: 0, st: 0 };
  for (let i = 0; i < nGames; i++) {
    const a = teams[Math.floor(R() * teams.length)];
    let h = teams[Math.floor(R() * teams.length)];
    if (h === a) h = teams[(teams.indexOf(a) + 1) % teams.length];
    const out = S.defaultOut(model, [a, h]);
    const outSet = new Set(out);
    const pickSP = (t) => { const rot = (model.teams[t].rotation || []).filter((id) => !outSet.has(id)); return rot.length ? rot[Math.floor(R() * rot.length)] : S.guessStarter(model, t, outSet); };
    const sp = { away: pickSP(a), home: pickSP(h) };
    const idx = S.index(model);
    const lineups = { away: S.guessLineup(model, a, idx[sp.home].throws || "R", outSet), home: S.guessLineup(model, h, idx[sp.away].throws || "R", outSet) };
    if (lineups.away.length < 9 || lineups.home.length < 9) continue;
    model._idx = null; // constants change between rounds
    const g = S.simulateGame(model, { away: a, home: h, sp, lineups, out, seed: Math.floor(R() * 1e9) });
    m.games++; m.runs += g.score.away + g.score.home; m.homeW += g.score.home > g.score.away ? 1 : 0;
    m.nrfi += (g.innRuns[0][0] || 0) + (g.innRuns[1][0] || 0) === 0 ? 1 : 0;
    m.extra += g.innings > 9 ? 1 : 0;
    for (const id in g.box) {
      const b = g.box[id];
      m.sb += b.sb; m.hr += b.hr; m.k += b.k; m.pa += b.pa; m.h += b.h;
      if (b.order && !b.sub) { m.stPA += b.pa; m.st++; }
      if (id === sp.away || id === sp.home) { m.spOuts += b.outs; m.spPc += b.pc; m.sps++; }
    }
  }
  return { rpg: m.runs / m.games / 2, home_win: m.homeW / m.games, nrfi: m.nrfi / m.games, sbpg: m.sb / m.games / 2,
    hr_pa: m.hr / m.pa, k_pa: m.k / m.pa, hpg: m.h / m.games / 2, spa: m.stPA / m.st, sp_outs: m.spOuts / m.sps, sp_pc: m.spPc / m.sps, extra: m.extra / m.games };
}

const target = { rpg: L.rpg, home_win: 0.535, sbpg: null, sp_outs: L.sp_outs, sp_pitches: L.sp_pitches };
// stolen bases per team-game, from the league rates: attempts per time on first * success
const C = model.consts = Object.assign({ hfa: 1.01, adv: 1, bip_hit: 0.97, tto: 1.06, sb: 0.62, pc_adj: 0, wp: 0.024, sub: 0.06 }, model.consts || {});
console.log("targets", target);
for (let round = 0; round < 8; round++) {
  const r = measure(N, 1000); // same matchups every round (common random numbers)
  console.log(`round ${round}`, Object.fromEntries(Object.entries(r).map(([k, v]) => [k, +v.toFixed(4)])), "consts", { ...C });
  if (round === 7) break;
  // hits per game set the hit rate; runs per game then set how aggressively runners advance
  C.bip_hit *= Math.pow((L.hpg || 8.3) / r.hpg, 0.9);
  C.adv *= Math.pow(target.rpg / r.rpg, 2.5); // runs respond weakly to baserunning aggressiveness
  C.adv = Math.max(0.7, Math.min(1.6, C.adv));
  C.sub *= Math.exp((r.spa - (L.spa || 4.02)) * 5); // too many PAs for starters -> more late subs
  C.sub = Math.max(0.005, Math.min(0.4, C.sub));
  C.hfa *= Math.pow(target.home_win / r.home_win, 0.2); // very sensitive: 1% on every home hit is ~2pp of home wins
  C.pc_adj += (target.sp_pitches - r.sp_pc) * 0.8;
  const sbTarget = L.sbpg || 0.7;
  C.sb *= Math.pow(sbTarget / Math.max(0.05, r.sbpg), 0.9);
  for (const k of ["bip_hit", "hfa", "sb", "adv", "sub"]) C[k] = +C[k].toFixed(4);
  C.pc_adj = +C.pc_adj.toFixed(1);
}
fs.writeFileSync(file, JSON.stringify(model));
console.log("saved constants to", file, C);
