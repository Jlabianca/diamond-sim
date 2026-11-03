/* Backtest: simulate real games with the lineups and starters that actually played (known before first pitch),
   using a model built only from data before each week, and compare with what happened.
   usage: node scripts/backtest.js backtest/actuals.json backtest/model_*.json */
const fs = require("fs");
const path = require("path");
const S = require(path.join(__dirname, "..", "site", "js", "sim.js"));

const [actFile, ...modelFiles] = process.argv.slice(2);
const NSIM = +(process.env.NSIM || 1000);
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const actual = Object.fromEntries(JSON.parse(fs.readFileSync(actFile)).map((g) => [g.id, g]));
const rows = [];
for (const mf of modelFiles) {
  const model = JSON.parse(fs.readFileSync(mf));
  const L = model.league;
  let n = 0;
  for (const g of model.schedule) {
    if (!g.actual || !g.away_lineup || !g.home_lineup || !g.away_sp || !g.home_sp) continue;
    const A = actual[g.id];
    if (!A) continue;
    const idx = S.index(model);
    if (![...g.away_lineup, ...g.home_lineup, g.away_sp, g.home_sp].every((id) => idx[id])) continue;
    const keep = new Set([...g.away_lineup, ...g.home_lineup, g.away_sp, g.home_sp]);
    const o = { away: g.away, home: g.home, sp: { away: g.away_sp, home: g.home_sp }, lineups: { away: g.away_lineup, home: g.home_lineup }, out: S.defaultOut(model, [g.away, g.home], g.date).filter((id) => !keep.has(id)), seed: 777 };
    const r = S.summarize(S.simulateMany(model, o, NSIM));
    const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    const players = [];
    for (const key in A.players) {
      const ap = A.players[key];
      const pid = ap.kind === "P" ? ap.pid : key;
      let sp = r.players[pid] || r.players[pid + "-P"];
      if (ap.kind === "P") sp = r.players[pid + "-P"] || r.players[pid];
      if (!sp) continue;
      const pred = {}, pover = {};
      for (const k in ap.act) {
        if (!sp.d[k]) continue;
        pred[k] = mean(sp.d[k]);
        const line = k === "hrr" ? 1.5 : k === "tb" ? 1.5 : ["pk", "outs", "ph"].includes(k) ? Math.floor(pred[k]) + 0.5 : 0.5;
        pover[k] = [line, sp.d[k].filter((x) => x > line).length / sp.d[k].length];
      }
      players.push({ kind: ap.kind, act: ap.act, base: ap.base, pred, pover });
    }
    // same-game combos: is the model's joint probability right, and is it better than multiplying the legs?
    const combos = [];
    const act = (pid, k) => (A.players[pid] ? A.players[pid].act[k] : null);
    for (const side of ["away", "home"]) {
      const lu = side === "away" ? g.away_lineup : g.home_lineup;
      const won = side === "home" ? A.hscore > A.ascore : A.ascore > A.hscore;
      const runs = side === "home" ? A.hscore : A.ascore;
      const mk = (name, legs, hit) => { const p = S.parlayProb(r, legs); if (p.single.every((x) => x != null) && hit != null) combos.push({ name, joint: p.joint, naive: p.single.reduce((a, b) => a * b, 1), hit: hit ? 1 : 0 }); };
      for (let k = 0; k < 8; k++) {
        const a = act(lu[k], "hrr"), b = act(lu[k + 1], "hrr");
        if (a != null && b != null) mk("Teammates batting back to back, both H+R+RBI o1.5", [{ type: "prop", pid: lu[k], stat: "hrr", side: "o", line: 1.5 }, { type: "prop", pid: lu[k + 1], stat: "hrr", side: "o", line: 1.5 }], a > 1.5 && b > 1.5);
      }
      for (const k of [1, 2, 3]) { const a = act(lu[k], "hrr"); if (a != null) mk("Team ML + one of its 2-4 hitters H+R+RBI o1.5", [{ type: "ml", team: side }, { type: "prop", pid: lu[k], stat: "hrr", side: "o", line: 1.5 }], won && a > 1.5); }
      const t3 = [1, 2, 3].map((k) => act(lu[k], "hrr"));
      if (t3.every((x) => x != null)) mk("Team ML + its 2-3-4 hitters all H+R+RBI o1.5 (4 legs)", [{ type: "ml", team: side }, ...[1, 2, 3].map((k) => ({ type: "prop", pid: lu[k], stat: "hrr", side: "o", line: 1.5 }))], won && t3.every((x) => x > 1.5));
      const oppSp = side === "away" ? g.home_sp : g.away_sp, k = act(oppSp + "|P", "pk");
      if (k != null) { const line = Math.floor(mean(Array.from(r.players[oppSp] ? r.players[oppSp].raw.pk : r.players[oppSp + "-P"].raw.pk))) + 0.5; mk("Team ML + opposing starter's K over", [{ type: "ml", team: side }, { type: "prop", pid: r.players[oppSp] ? oppSp : oppSp + "-P", stat: "pk", side: "o", line }], won && k > line); }
      void runs;
    }
    combos.push(...(() => { const p = S.parlayProb(r, [{ type: "total", side: "u", line: 8.5 }, { type: "nrfi" }]); return [{ name: "Game under 8.5 + NRFI", joint: p.joint, naive: p.single[0] * p.single[1], hit: A.hscore + A.ascore < 8.5 && A.inn1 === 0 ? 1 : 0 }]; })());
    rows.push({ combos, id: g.id, date: g.date, pHome: r.wins.home / r.n, total: mean(r.home) + mean(r.away), nrfi: r.inn1.filter((x) => x === 0).length / r.n,
      homeWin: A.hscore > A.ascore ? 1 : 0, actTotal: A.hscore + A.ascore, actNrfi: A.inn1 === 0 ? 1 : 0, lgTotal: 2 * L.rpg, lgNrfi: L.nrfi, players });
    n++;
  }
  console.error(`${path.basename(mf)}: ${n} games`);
}

const corr = (x, y) => { const mx = mean(x), my = mean(y); let a = 0, b = 0, c = 0; for (let i = 0; i < x.length; i++) { a += (x[i] - mx) * (y[i] - my); b += (x[i] - mx) ** 2; c += (y[i] - my) ** 2; } return a / Math.sqrt(b * c); };
const brier = (p, y) => mean(p.map((q, i) => (q - y[i]) ** 2));
const logloss = (p, y) => -mean(p.map((q, i) => (y[i] ? Math.log(q) : Math.log(1 - q))));
const out = [];
const N = rows.length;
const y = rows.map((r) => r.homeWin), p = rows.map((r) => r.pHome);
out.push(`Games: ${N} (${rows[0].date} to ${rows[N - 1].date})`);
out.push(`Winner: model picked the winner ${((mean(rows.map((r) => (r.pHome > 0.5) === !!r.homeWin)) * 100)).toFixed(1)}% · Brier ${brier(p, y).toFixed(4)} vs ${brier(p.map(() => 0.535), y).toFixed(4)} for a flat 53.5% home · log loss ${logloss(p, y).toFixed(4)} vs ${logloss(p.map(() => 0.535), y).toFixed(4)}`);
const bins = [[0, 0.45], [0.45, 0.5], [0.5, 0.55], [0.55, 0.6], [0.6, 0.65], [0.65, 1]];
out.push("Home win calibration: " + bins.map(([a, b]) => { const s = rows.filter((r) => r.pHome >= a && r.pHome < b); return s.length ? `${(a * 100).toFixed(0)}-${(b * 100).toFixed(0)}%: pred ${(mean(s.map((r) => r.pHome)) * 100).toFixed(1)} / act ${(mean(s.map((r) => r.homeWin)) * 100).toFixed(1)} (n=${s.length})` : ""; }).filter(Boolean).join(" · "));
out.push(`Total runs: MAE ${mean(rows.map((r) => Math.abs(r.total - r.actTotal))).toFixed(2)} vs ${mean(rows.map((r) => Math.abs(r.lgTotal - r.actTotal))).toFixed(2)} for the league average · mean ${mean(rows.map((r) => r.total)).toFixed(2)} (actual ${mean(rows.map((r) => r.actTotal)).toFixed(2)}) · corr ${corr(rows.map((r) => r.total), rows.map((r) => r.actTotal)).toFixed(3)}`);
out.push(`NRFI: Brier ${brier(rows.map((r) => r.nrfi), rows.map((r) => r.actNrfi)).toFixed(4)} vs ${brier(rows.map((r) => r.lgNrfi), rows.map((r) => r.actNrfi)).toFixed(4)} league rate · predicted ${(mean(rows.map((r) => r.nrfi)) * 100).toFixed(1)}% / actual ${(mean(rows.map((r) => r.actNrfi)) * 100).toFixed(1)}%`);
out.push("");
out.push("| Stat | n | Model MAE | Season-avg MAE | Model corr | Season-avg corr | Over line: pred / actual |");
out.push("|---|---|---|---|---|---|---|");
const names = { hrr: "Batter H+R+RBI", h: "Batter hits", tb: "Batter total bases", hr: "Batter HR", r: "Batter runs", rbi: "Batter RBI", bb: "Batter walks", k: "Batter strikeouts", pk: "Pitcher strikeouts", outs: "Pitcher outs", er: "Pitcher earned runs", ph: "Pitcher hits allowed", pbb: "Pitcher walks" };
for (const k of Object.keys(names)) {
  const ps = rows.flatMap((r) => r.players).filter((x) => x.pred[k] != null && x.base);
  if (!ps.length) continue;
  const pr = ps.map((x) => x.pred[k]), ac = ps.map((x) => x.act[k]), bs = ps.map((x) => x.base[k]);
  const ov = ps.map((x) => x.pover[k][1]), hit = ps.map((x) => (x.act[k] > x.pover[k][0] ? 1 : 0));
  const lineTxt = ["pk", "outs", "ph"].includes(k) ? "model line" : k === "hrr" || k === "tb" ? "1.5" : "0.5";
  out.push(`| ${names[k]} | ${ps.length} | ${mean(pr.map((v, i) => Math.abs(v - ac[i]))).toFixed(3)} | ${mean(bs.map((v, i) => Math.abs(v - ac[i]))).toFixed(3)} | ${corr(pr, ac).toFixed(3)} | ${corr(bs, ac).toFixed(3)} | o${lineTxt}: ${(mean(ov) * 100).toFixed(1)}% / ${(mean(hit) * 100).toFixed(1)}% |`);
}
// calibration of HRR over 1.5 and hits over 0.5
for (const k of ["hrr", "h", "pk"]) {
  const ps = rows.flatMap((r) => r.players).filter((x) => x.pover[k]);
  const bb = [[0, 0.3], [0.3, 0.4], [0.4, 0.5], [0.5, 0.6], [0.6, 0.7], [0.7, 1]];
  out.push(`${names[k]} over-line calibration: ` + bb.map(([a, b]) => { const s = ps.filter((x) => x.pover[k][1] >= a && x.pover[k][1] < b); return s.length >= 20 ? `${(a * 100).toFixed(0)}-${(b * 100).toFixed(0)}%: ${(mean(s.map((x) => x.pover[k][1])) * 100).toFixed(1)}/${(mean(s.map((x) => (x.act[k] > x.pover[k][0] ? 1 : 0))) * 100).toFixed(1)} (n=${s.length})` : ""; }).filter(Boolean).join(" · "));
}
out.push("");
out.push("Same-game parlays (does the joint probability hold up?)");
out.push("");
out.push("| Combo | n | Model joint | Legs multiplied | Actually hit | Brier: joint / multiplied |");
out.push("|---|---|---|---|---|---|");
const allc = rows.flatMap((r) => r.combos);
for (const name of [...new Set(allc.map((c) => c.name))]) {
  const cs = allc.filter((c) => c.name === name);
  out.push(`| ${name} | ${cs.length} | ${(mean(cs.map((c) => c.joint)) * 100).toFixed(1)}% | ${(mean(cs.map((c) => c.naive)) * 100).toFixed(1)}% | ${(mean(cs.map((c) => c.hit)) * 100).toFixed(1)}% | ${brier(cs.map((c) => c.joint), cs.map((c) => c.hit)).toFixed(4)} / ${brier(cs.map((c) => c.naive), cs.map((c) => c.hit)).toFixed(4)} |`);
}
console.log(out.join("\n"));
