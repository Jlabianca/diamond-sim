/* Diamond Sim — UI: game picker, pitch-by-pitch replay of one simulated game, projections & props, lineups. */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);

  let model = null, idx = null, cur = { away: null, home: null, sched: null };
  let outSet = new Set(), lineups = { away: [], home: [] }, sps = { away: null, home: null }, posOver = {};
  let seed = 1, game = null, frames = [], fi = -1, playing = false, timer = null, speed = 1;
  let projResult = null, projStale = true, worker = null;
  const lines = {};
  const colCache = {};

  // ---------------- colors ----------------
  const lumOf = (hex) => { const n = parseInt(String(hex).replace("#", ""), 16); return isNaN(n) ? 0 : (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255; };
  function bright(hex) {
    const n = parseInt(String(hex).replace("#", ""), 16);
    if (isNaN(n)) return "#9aa";
    let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    if (lum < 0.42) { const k = Math.min(0.6, (0.42 - lum) * 1.6 + 0.15); r += (255 - r) * k; g += (255 - g) * k; b += (255 - b) * k; }
    return `rgb(${r | 0},${g | 0},${b | 0})`;
  }
  function teamColor(T) {
    if (lumOf(T.color) < 0.25 && T.alt && lumOf(T.alt) > 0.3 && lumOf(T.alt) < 0.9) return bright(T.alt);
    return bright(T.color);
  }
  const col = (t) => colCache[t] || (colCache[t] = model && model.teams[t] ? teamColor(model.teams[t]) : "#9aa");

  // ---------------- boot ----------------
  fetch("data/model.json").then((r) => r.json()).then((m) => {
    model = m;
    idx = MLBSim.index(m);
    const src = m.source === "retro" ? "Retrosheet" : "MLB Stats API";
    $("dataLine").textContent = `${m.season_label} season · data through ${fmtDate(m.through)} · built ${m.generated}`;
    $("srcNote").textContent = `DATA: ${src.toUpperCase()}`;
    initPicker(); initTabs(); initControls();
    fromHash() || selectGame(defaultGame());
    renderSlip();
  }).catch((e) => { $("dataLine").textContent = "Could not load data/model.json — serve this folder over http (see README). " + e; console.error(e); });

  const todayET = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
  function fmtDate(d) { const [y, mo, da] = d.split("-").map(Number); return new Date(Date.UTC(y, mo - 1, da, 12)).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }); }
  function fmtDay(d) { const [y, mo, da] = d.split("-").map(Number); return new Date(Date.UTC(y, mo - 1, da, 12)).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }); }
  const startTime = (iso) => { try { return iso ? new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }) : ""; } catch (e) { return ""; } };

  function defaultDate() {
    const dates = [...new Set(model.schedule.map((g) => g.date))];
    if (!dates.length) return null;
    const t = todayET();
    const upcoming = model.schedule.filter((g) => g.away_score == null).map((g) => g.date).sort();
    return dates.find((d) => d >= t) || upcoming[0] || dates[dates.length - 1];
  }
  function defaultGame() {
    const d = defaultDate();
    const g = d && (model.schedule.find((x) => x.date === d && x.away_score == null) || model.schedule.find((x) => x.date === d));
    if (g) return g;
    const t = Object.keys(model.teams).sort();
    return { away: t[0], home: t[1] };
  }

  // ---------------- picker ----------------
  function initPicker() {
    const dates = [...new Set(model.schedule.map((g) => g.date))];
    const def = defaultDate(), t = todayET();
    $("dateSel").innerHTML = dates.map((d) => `<option value="${d}" ${d === def ? "selected" : ""}>${fmtDay(d)}${d === t ? " (today)" : ""}</option>`).join("") || `<option>no games scheduled</option>`;
    $("dateSel").onchange = renderGames;
    const teams = Object.keys(model.teams).sort();
    const opts = teams.map((x) => `<option>${x}</option>`).join("");
    $("awaySel").innerHTML = opts; $("homeSel").innerHTML = opts;
    $("awaySel").onchange = $("homeSel").onchange = () => { if ($("awaySel").value !== $("homeSel").value) selectGame({ away: $("awaySel").value, home: $("homeSel").value }); };
    $("neutralChk").onchange = () => { changed(); };
    renderGames();
  }
  function renderGames() {
    const d = $("dateSel").value;
    $("gameList").innerHTML = model.schedule.filter((g) => g.date === d).map((g) => {
      const tail = g.away_score != null ? ` <span class="fin">${g.away_score}-${g.home_score}</span>` : ` <span class="fin">${startTime(g.start)}</span>`;
      const sel = cur.sched && cur.sched.id === g.id ? "sel" : "";
      return `<button class="${sel}" data-id="${g.id}" title="${g.series || ""}">${g.away} @ ${g.home}${tail}</button>`;
    }).join("") || `<span class="dim">No games on this date — pick any two teams on the right.</span>`;
    $("gameList").querySelectorAll("button").forEach((b) => (b.onclick = () => selectGame(model.schedule.find((g) => g.id === b.dataset.id))));
  }
  function selectGame(g, s) {
    if (!g || !model.teams[g.away] || !model.teams[g.home]) return;
    cur = { away: g.away, home: g.home, sched: g.id ? g : null };
    $("awaySel").value = g.away; $("homeSel").value = g.home;
    $("neutralChk").checked = false;
    outSet = new Set(MLBSim.defaultOut(model, [g.away, g.home], gameDate()));
    resetLineups();
    document.documentElement.style.setProperty("--away", col(g.away));
    document.documentElement.style.setProperty("--home", col(g.home));
    $("mlLblA").textContent = `${g.away} ML`; $("mlLblH").textContent = `${g.home} ML`; $("rlLbl").textContent = `${g.home} run line`;
    $("mMlA").value = ""; $("mMlH").value = ""; $("mTotal").value = ""; $("mF5").value = ""; $("mRl").value = "-1.5";
    renderGames(); renderRoster();
    projStale = true; projResult = null;
    $("projOut").classList.add("hidden"); $("runInfo").textContent = "";
    newGame(s || randSeed());
    if (activeTab() === "proj") runProjections();
  }
  function resetLineups() {
    const d = MLBSim.defaults(model, cur.away, cur.home, cur.sched, [...outSet]);
    lineups = d.lineups; sps = d.sp; posOver = d.pos;
    cur.posted = d.posted;
    // a scheduled lineup may include a player we'd mark out by default: trust the posted lineup
    for (const side of ["away", "home"]) { for (const id of lineups[side]) outSet.delete(id); if (sps[side]) outSet.delete(sps[side]); }
  }
  const randSeed = () => Math.floor(Math.random() * 1e9);
  const gameDate = () => (cur.sched ? cur.sched.date : todayET());

  // ---------------- tabs ----------------
  const activeTab = () => (document.querySelector(".tab.active") || {}).dataset.tab;
  function initTabs() {
    document.querySelectorAll(".tab").forEach((t) => (t.onclick = () => {
      document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === t));
      document.querySelectorAll(".pane").forEach((p) => p.classList.toggle("active", p.id === "tab-" + t.dataset.tab));
      if (t.dataset.tab === "proj" && projStale) runProjections();
    }));
  }

  function initControls() {
    $("btnPlay").onclick = () => (playing ? pause() : play());
    $("btnStep").onclick = () => { pause(); step(); };
    $("btnPA").onclick = () => { pause(); jump((f) => f.final); };
    $("btnInn").onclick = () => { pause(); jump((f) => f.e.kind === "end"); };
    $("btnEnd").onclick = () => { pause(); fi = frames.length - 1; show(fi, false); showFinal(); };
    $("btnNew").onclick = () => newGame(randSeed());
    $("speedSel").onchange = () => (speed = +$("speedSel").value);
    $("pitchChk").onchange = () => { const e = fi >= 0 ? frames[fi].ei : -1; buildFrames(); fi = e < 0 ? -1 : frames.findIndex((f) => f.ei === e && f.final); show(fi, false); };
    $("btnShare").onclick = () => {
      const url = location.href.split("#")[0] + `#${cur.away}@${cur.home}/${seed}`;
      navigator.clipboard && navigator.clipboard.writeText(url);
      $("btnShare").textContent = "Copied"; setTimeout(() => ($("btnShare").textContent = "Copy link"), 1200);
    };
    $("btnRun").onclick = runProjections;
    $("statSel").onchange = $("teamFilter").onchange = $("penChk").onchange = renderProps;
    for (const id of ["mMlA", "mMlH", "mRl", "mTotal", "mF5"]) $(id).onchange = () => projResult && renderProjections();
    $("btnCsv").onclick = downloadCsv;
  }
  function fromHash() {
    const m = location.hash.match(/^#([A-Z]{2,3})@([A-Z]{2,3})(?:\/(\d+))?/);
    if (!m || !model.teams[m[1]] || !model.teams[m[2]]) return false;
    const g = model.schedule.find((x) => x.away === m[1] && x.home === m[2] && x.away_score == null);
    if (g) $("dateSel").value = g.date;
    selectGame(g || { away: m[1], home: m[2] }, m[3] ? +m[3] : undefined);
    return true;
  }

  function simOpts(extra) {
    return Object.assign({ away: cur.away, home: cur.home, out: [...outSet], lineups, sp: sps, pos: posOver, neutral: $("neutralChk").checked }, extra);
  }
  const P = (id) => idx[id] || { name: "?", short: "?" };
  const nm = (id) => P(id).short;
  const teamOf = (side) => (side === 0 ? cur.away : cur.home);

  // ---------------- watch ----------------
  function newGame(s) {
    pause();
    seed = s;
    $("seedLbl").textContent = seed;
    if (lineups.away.length < 9 || lineups.home.length < 9 || !sps.away || !sps.home) {
      game = null; frames = []; $("pDesc").textContent = "Each team needs nine hitters and a starting pitcher — see the Lineups tab."; return;
    }
    game = MLBSim.simulateGame(model, simOpts({ seed, log: true }));
    buildFrames();
    fi = -1;
    $("finalBox").classList.add("hidden");
    drawFieldBase();
    resetBoard();
  }
  function buildFrames() {
    frames = [];
    if (!game) return;
    const every = $("pitchChk").checked;
    game.events.forEach((e, ei) => {
      if (e.kind === "pa" && every) e.seq.forEach((p, j) => frames.push({ ei, e, j, final: j === e.seq.length - 1 }));
      else frames.push({ ei, e, j: e.seq ? e.seq.length - 1 : 0, final: true });
    });
  }
  function resetBoard() {
    setRow("rowAway", cur.away, 0); setRow("rowHome", cur.home, 0);
    $("rowAway").classList.remove("has-ball", "trail"); $("rowHome").classList.remove("has-ball", "trail");
    $("innLbl").textContent = "▲ 1ST"; setOuts(0);
    $("countLbl").textContent = ""; $("pcLbl").textContent = ""; $("sitLbl").textContent = "PLAY BALL"; $("batLbl").textContent = "";
    $("pType").textContent = ""; $("pType").className = "ptype mono";
    const ta = model.teams[cur.away], th = model.teams[cur.home];
    $("pDesc").textContent = `${ta.name} (${ta.record}) at ${th.name} (${th.record}). ${nm(sps.away)} vs ${nm(sps.home)}. Press play to start.`;
    setBadge(null);
    $("abBox").textContent = "AT BAT –";
    renderMatchup(null);
    drawZone(null);
    renderLine(-1); renderStrip(-1);
    drawDyn(null);
  }
  function setRow(id, abbr, pts) {
    const r = $(id);
    r.querySelector(".abbr").textContent = abbr;
    r.querySelector(".pts").textContent = pts;
    r.querySelector(".bar").style.background = col(abbr);
  }
  const setOuts = (n) => $("outsLbl").querySelectorAll("i").forEach((x, i) => x.classList.toggle("on", i < n));
  function setBadge(id, team) {
    const b = $("playerBadge");
    if (!id) { b.innerHTML = ""; b.style.visibility = "hidden"; return; }
    b.style.visibility = "";
    const p = P(id), c = col(team || p.team);
    b.style.borderColor = c; b.style.color = c;
    const ini = p.name.split(/[ .'-]+/).filter(Boolean).map((s) => s[0]).join("").slice(0, 3);
    if (p.mlbam) {
      b.innerHTML = `<img alt="" src="https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_120,q_auto:best/v1/people/${p.mlbam}/headshot/67/current">`;
      b.querySelector("img").onerror = () => (b.textContent = ini);
    } else b.textContent = ini;
  }

  function play() {
    if (!game) return;
    if (fi >= frames.length - 1) newGame(seed);
    playing = true; $("btnPlay").textContent = "❚❚ Pause";
    tick();
  }
  function pause() { playing = false; clearTimeout(timer); $("btnPlay").textContent = "▶ Play"; }
  function tick() {
    if (!playing) return;
    if (!step()) { pause(); return; }
    const f = frames[fi], e = f.e;
    let ms = 900;
    if (e.kind === "pa") ms = f.final ? (e.res === "HR" || e.scored.length ? 2300 : 1500) : 520;
    else if (e.kind === "end") ms = 1500;
    else if (e.kind === "start") ms = 700;
    timer = setTimeout(tick, ms / speed);
  }
  function step() {
    if (!game || fi >= frames.length - 1) { showFinal(); return false; }
    fi++;
    show(fi, true);
    if (fi === frames.length - 1) setTimeout(showFinal, 700 / speed);
    return true;
  }
  function jump(pred) {
    if (!game) return;
    let j = fi + 1;
    while (j < frames.length - 1 && !pred(frames[j])) j++;
    fi = Math.min(j, frames.length - 1);
    show(fi, false);
    if (fi >= frames.length - 1) showFinal();
  }

  const ord = (n) => (n === 1 ? "1ST" : n === 2 ? "2ND" : n === 3 ? "3RD" : n + "TH");
  const baseName = ["first", "second", "third"];
  function spray(e) { // spray angle in degrees (negative = left field) and distance in feet
    const bat = P(e.bat), pit = P(e.pid);
    const hand = bat.bats === "B" ? (pit.throws === "L" ? "R" : "L") : bat.bats || "R";
    const pullSign = hand === "R" ? -1 : 1;
    const pull = e.res === "HR" ? 0.6 : e.bip === "G" ? 0.35 : 0.15;
    let a = (e.dir * 2 - 1) * 44;
    if (Math.abs(a) < 40 && (e.dir * 7) % 1 < pull) a = pullSign * Math.abs(a);
    a = Math.max(-44, Math.min(44, a));
    let d;
    const u = e.dist;
    if (e.res === "HR") d = 360 + u * 85;
    else if (e.res === "3B") d = 330 + u * 60;
    else if (e.res === "2B") d = (e.bip === "G" ? 230 : 270) + u * 90;
    else if (e.res === "1B") d = e.bip === "G" ? 150 + u * 60 : e.bip === "L" ? 160 + u * 90 : 170 + u * 60;
    else if (e.bip === "G") d = 80 + u * 60;
    else if (e.bip === "P") d = 70 + u * 110;
    else if (e.bip === "L") d = 120 + u * 170;
    else d = 230 + u * 150;
    return [a, d];
  }
  const fielderNum = (a, d, bip) => {
    if (bip === "G" || bip === "P" || d < 180) {
      if (d < 75) return Math.abs(a) < 12 ? 1 : a < 0 ? 5 : 3;
      return a < -26 ? 5 : a < -2 ? 6 : a < 22 ? 4 : 3;
    }
    return a < -15 ? 7 : a > 15 ? 9 : 8;
  };
  const POSNAME = { 1: "pitcher", 2: "catcher", 3: "first baseman", 4: "second baseman", 5: "third baseman", 6: "shortstop", 7: "left fielder", 8: "center fielder", 9: "right fielder" };
  const POSSHORT = { 1: "the mound", 3: "first", 4: "second", 5: "third", 6: "short", 7: "left", 8: "center", 9: "right" };
  const field = (a) => (a < -27 ? "left" : a < -9 ? "left-center" : a <= 9 ? "center" : a <= 27 ? "right-center" : "right");
  const field3 = (a) => (a < -15 ? "left" : a > 15 ? "right" : "center");

  function describe(e) {
    const B = nm(e.bat);
    if (e.kind === "start") return { label: `${e.half ? "BOTTOM" : "TOP"} OF THE ${ord(e.inn)}`, cls: "big", desc: `${teamOf(e.side)} batting. ${nm(e.pid)} on the mound for ${teamOf(1 - e.side)}.` };
    if (e.kind === "end") {
      const r = e.score[e.side] - (prevScore(e) || [0, 0])[e.side];
      return { label: `END OF ${e.half ? "THE " + ord(e.inn) : "TOP " + ord(e.inn)}`, cls: "big", desc: `${r} run${r === 1 ? "" : "s"}, ${e.lob} left on base. ${cur.away} ${e.score[0]} – ${cur.home} ${e.score[1]}` };
    }
    if (e.kind === "final") return { label: "FINAL", cls: "big", desc: `${cur.away} ${e.score[0]} – ${cur.home} ${e.score[1]}${e.inn > 9 ? ` (${e.inn} innings)` : ""}` };
    if (e.kind === "ph") return { label: "SUBSTITUTION", cls: "big", desc: `${nm(e.in)} takes over for ${nm(e.out)} in the ${teamOf(e.side)} lineup.` };
    if (e.kind === "pitch") return { label: "PITCHING CHANGE", cls: "big", desc: `${nm(e.in)} replaces ${nm(e.out)} for ${teamOf(e.side)}.` };
    if (e.kind === "ghost") return { label: "EXTRA INNINGS", cls: "big", desc: `${nm(e.runner)} starts the inning on second base.` };
    if (e.kind === "sb") return e.ok ? { label: e.base === 3 ? "STOLEN BASE · 3RD" : "STOLEN BASE", cls: "hit", desc: `${nm(e.runner)} steals ${baseName[e.base - 1]}.` } : { label: "CAUGHT STEALING", cls: "k", desc: `${nm(e.runner)} is thrown out trying to steal ${baseName[e.base - 1]}.` };
    if (e.kind === "wp") return { label: "WILD PITCH", cls: "big", desc: `Wild pitch by ${nm(e.pid)} — the runners move up.` };
    // plate appearance
    const [a, d] = spray(e), f = fielderNum(a, d, e.bip);
    let label = "", cls = "out", desc = "";
    const verb = e.bip === "G" ? "grounds" : e.bip === "L" ? "lines" : e.bip === "P" ? "pops" : "flies";
    switch (e.res) {
      case "K": label = "STRIKEOUT"; cls = "k"; desc = `${B} strikes out ${e.seq[e.seq.length - 1] === "C" ? "looking" : "swinging"}.`; break;
      case "BB": label = "WALK"; cls = "hit"; desc = `${B} walks.`; break;
      case "HBP": label = "HIT BY PITCH"; cls = "hit"; desc = `${B} is hit by a pitch.`; break;
      case "1B": label = "SINGLE"; cls = "hit"; desc = e.bip === "G" ? `${B} grounds a single ${a < -12 ? "through the left side" : a > 12 ? "through the right side" : "up the middle"}.` : e.bip === "F" ? `${B} bloops a single to ${field3(a)}.` : `${B} lines a single to ${field3(a)}.`; break;
      case "2B": label = "DOUBLE"; cls = "hit"; desc = Math.abs(a) > 36 ? `${B} doubles down the ${a < 0 ? "left" : "right"}-field line.` : `${B} doubles to ${field(a)}${d > 330 ? " off the wall" : ""}.`; break;
      case "3B": label = "TRIPLE"; cls = "big"; desc = `${B} triples to ${field(a)}.`; break;
      case "HR": label = e.scored.length === 4 ? "GRAND SLAM" : "HOME RUN"; cls = "big"; desc = `${B} homers to ${field(a)} (${Math.round(d)} ft).`; break;
      case "E": label = "ERROR"; cls = "hit"; desc = `${B} reaches on an error by the ${POSNAME[f]}.`; break;
      default:
        if (e.dp && e.bip === "G") { label = "DOUBLE PLAY"; desc = `${B} grounds into a ${f === 6 ? "6-4-3" : f === 4 ? "4-6-3" : f === 5 ? "5-4-3" : f === 3 ? "3-6-3" : "1-6-3"} double play.`; }
        else if (e.dp) { label = "DOUBLE PLAY"; desc = `${B} lines out to the ${POSNAME[f]}, and the runner is doubled off.`; }
        else if (e.fc) { label = "FIELDER'S CHOICE"; desc = `${B} reaches on a fielder's choice; the lead runner is forced out.`; }
        else if (e.sf) { label = "SACRIFICE FLY"; cls = "hit"; desc = `${B} hits a sacrifice fly to ${field3(a)}.`; }
        else if (e.bip === "G") { label = "GROUNDOUT"; desc = f === 3 ? `${B} grounds out to first, unassisted.` : `${B} grounds out, ${f}-3.`; }
        else if (e.bip === "P") { label = "POP OUT"; desc = `${B} pops out to ${f <= 6 ? POSSHORT[f] === "the mound" ? "the pitcher" : POSNAME[f].replace("baseman", "base").replace("first base", "first").replace("second base", "second").replace("third base", "third") : POSSHORT[f]}.`; }
        else if (e.bip === "L") { label = "LINEOUT"; desc = `${B} lines out to the ${POSNAME[f]}.`; }
        else { label = "FLYOUT"; desc = `${B} flies out to ${POSSHORT[f] || field3(a)}.`; }
    }
    // runner movement
    const moved = [];
    for (const id of e.scored) if (id !== e.bat) moved.push(`${nm(id)} scores.`);
    if (e.res === "HR" && e.scored.length > 1) moved.length = 0, moved.push(e.scored.length === 4 ? "Grand slam!" : `${e.scored.length - 1} on base.`);
    for (let b = 2; b >= 0; b--) {
      const id = e.after[b];
      if (id && id !== e.bat && e.before[b] !== id) moved.push(`${nm(id)} to ${baseName[b]}.`);
    }
    if (e.rbi && e.res !== "HR") moved.push(`${e.rbi} RBI.`);
    if (e.rbi && e.res === "HR") moved.push(`${e.rbi} RBI.`);
    void verb;
    return { label, cls, desc: desc + (moved.length ? " " + moved.join(" ") : "") };
  }
  function prevScore(e) {
    const i = game.events.indexOf(e);
    for (let k = i - 1; k >= 0; k--) if (game.events[k].kind === "start" && game.events[k].inn === e.inn && game.events[k].half === e.half) return game.events[k].score;
    return [0, 0];
  }
  function countAt(seq, j) { // balls/strikes before pitch j (and after it)
    let b = 0, s = 0;
    for (let k = 0; k <= j; k++) {
      const p = seq[k];
      if (p === "B") b = Math.min(4, b + 1);
      else if (p === "C" || p === "S") s = Math.min(3, s + 1);
      else if (p === "F" && s < 2) s++;
    }
    return [b, s];
  }

  function liveBox(ei) {
    const b = {};
    const g = (id) => b[id] || (b[id] = { ab: 0, h: 0, hr: 0, r: 0, rbi: 0, bb: 0, k: 0, sb: 0, pc: 0, pk: 0, outs: 0, ph: 0, pr: 0 });
    for (let k = 0; k <= ei; k++) {
      const e = game.events[k];
      if (e.kind === "pa") {
        const x = g(e.bat), p = g(e.pid);
        if (!["BB", "HBP"].includes(e.res) && !e.sf) x.ab++;
        if (["1B", "2B", "3B", "HR"].includes(e.res)) { x.h++; p.ph++; }
        if (e.res === "HR") x.hr++;
        if (e.res === "BB") x.bb++;
        if (e.res === "K") { x.k++; p.pk++; }
        x.rbi += e.rbi;
        for (const id of e.scored) { g(id).r++; p.pr++; }
        p.pc = e.pc; p.outs += e.outs - e.outsBefore;
      } else if (e.kind === "sb") { if (e.ok) g(e.runner).sb++; }
      else if (e.kind === "wp") { /* runs on wild pitches */ }
    }
    return b;
  }
  const lineStr = (x) => {
    if (!x) return "0-0";
    const extra = [];
    if (x.hr) extra.push(x.hr > 1 ? `${x.hr} HR` : "HR");
    if (x.rbi) extra.push(`${x.rbi} RBI`);
    if (x.r) extra.push(x.r > 1 ? `${x.r} R` : "R");
    if (x.bb) extra.push(x.bb > 1 ? `${x.bb} BB` : "BB");
    if (x.sb) extra.push("SB");
    return `${x.h}-${x.ab}${extra.length ? ", " + extra.join(", ") : ""}`;
  };

  function show(i, animate) {
    if (i < 0) { resetBoard(); return; }
    const f = frames[i], e = f.e;
    const atPitch = e.kind === "pa" && !f.final;
    const sc = atPitch ? (game.events[f.ei - 1] ? lastScore(f.ei - 1) : [0, 0]) : e.score;
    setRow("rowAway", cur.away, sc[0]); setRow("rowHome", cur.home, sc[1]);
    const side = e.side != null ? e.side : -1;
    $("rowAway").classList.toggle("has-ball", side === 0 && e.kind !== "final");
    $("rowHome").classList.toggle("has-ball", side === 1 && e.kind !== "final");
    $("rowAway").classList.toggle("trail", sc[0] < sc[1]);
    $("rowHome").classList.toggle("trail", sc[1] < sc[0]);
    if (e.kind === "final") $("innLbl").textContent = "FINAL";
    else $("innLbl").textContent = `${e.half ? "▼" : "▲"} ${ord(e.inn)}`;
    let outs = 0, basesNow = [null, null, null];
    if (e.kind === "pa") { outs = f.final ? e.outs : e.outsBefore; basesNow = f.final ? e.after : e.before; }
    else if (e.kind === "sb" || e.kind === "wp") { outs = e.outs != null ? e.outs : 0; basesNow = e.bases; }
    else if (e.kind === "ghost") { basesNow = [null, e.runner, null]; }
    else if (e.kind === "end") outs = 3;
    else if (e.kind === "pitch" || e.kind === "ph") { const st = stateBefore(f.ei); outs = st.outs; basesNow = st.bases; }
    setOuts(outs);
    if (e.kind === "pa") {
      const [b, s] = countAt(e.seq, f.j);
      $("countLbl").textContent = `${Math.min(3, b)}-${Math.min(2, s)}`;
      $("pcLbl").textContent = `P ${atPitch ? e.pc - (e.seq.length - 1 - f.j) : e.pc}`;
    } else { $("countLbl").textContent = ""; $("pcLbl").textContent = ""; }
    const diff = sc[0] - sc[1];
    const runners = basesNow.filter(Boolean).length;
    $("sitLbl").textContent = e.kind === "final" ? "FINAL" : runners === 3 ? "BASES LOADED" : runners ? `${basesNow.map((x, k) => (x ? k + 1 : "")).join("").split("").map((k) => ["", "1ST", "2ND", "3RD"][k]).join(" & ")}` : diff === 0 ? "TIED" : `${diff > 0 ? cur.away : cur.home} +${Math.abs(diff)}`;
    $("batLbl").innerHTML = side >= 0 && e.kind !== "final" ? `<span style="color:${col(teamOf(side))}">●</span> ${teamOf(side)} BATTING` : "";
    const lb = liveBox(atPitch ? f.ei - 1 : f.ei);
    // description
    if (atPitch) {
      const p = e.seq[f.j], [b, s] = countAt(e.seq, f.j);
      const word = { B: "Ball", C: "Called strike", S: "Swinging strike", F: "Foul", X: "In play", H: "Hit by pitch" }[p] || p;
      $("pType").textContent = `PITCH ${f.j + 1}`; $("pType").className = "ptype mono " + (p === "B" ? "hit" : "k");
      $("pDesc").textContent = `${nm(e.pid)} to ${nm(e.bat)}: ${word}${p === "B" || p === "C" || p === "S" || p === "F" ? ` — ${Math.min(3, b)}-${Math.min(2, s)}` : ""}.`;
    } else {
      const d = describe(e);
      $("pType").textContent = d.label; $("pType").className = "ptype mono " + d.cls;
      $("pDesc").textContent = d.desc;
    }
    // badge
    const who = e.kind === "pa" ? e.bat : e.kind === "pitch" || e.kind === "ph" ? e.in : e.kind === "sb" || e.kind === "ghost" ? e.runner : e.kind === "wp" ? e.pid : e.kind === "start" ? e.pid : null;
    setBadge(who, who ? P(who).team : null);
    // at-bat box
    const paN = game.events.slice(0, f.ei + 1).filter((x) => x.kind === "pa").length;
    const paTot = game.events.filter((x) => x.kind === "pa").length;
    $("abBox").textContent = e.kind === "final" ? `FINAL · ${paTot} PLATE APPEARANCES` : `AT BAT ${paN} / ${paTot}\n${e.half ? "BOTTOM" : "TOP"} ${ord(e.inn || 1)} · ${outs} OUT${outs === 1 ? "" : "S"}`;
    renderMatchup(e, lb, f);
    drawZone(e.kind === "pa" ? { e, j: f.j } : null);
    renderLine(f.ei); renderStrip(f.ei);
    drawDyn(e, basesNow, atPitch, animate && f.final, lb);
  }
  function lastScore(ei) { for (let k = ei; k >= 0; k--) if (game.events[k].score) return game.events[k].score; return [0, 0]; }
  function stateBefore(ei) {
    for (let k = ei - 1; k >= 0; k--) {
      const e = game.events[k];
      if (e.kind === "pa") return { outs: e.outs >= 3 ? 0 : e.outs, bases: e.outs >= 3 ? [null, null, null] : e.after };
      if (e.kind === "sb" || e.kind === "wp") return { outs: e.outs, bases: e.bases };
      if (e.kind === "start" || e.kind === "end") return { outs: 0, bases: [null, null, null] };
      if (e.kind === "ghost") return { outs: 0, bases: [null, e.runner, null] };
    }
    return { outs: 0, bases: [null, null, null] };
  }

  function currentPitcher(ei, side) { // pitcher for the fielding team `side`
    let p = side === 0 ? sps.away : sps.home;
    for (let k = 0; k <= ei; k++) { const e = game.events[k]; if (e.kind === "pitch" && e.side === side) p = e.in; }
    return p;
  }
  function renderMatchup(e, lb, f) {
    if (!e || e.kind === "final") {
      $("matchup").innerHTML = `<div class="hd">STARTERS</div><div><span class="nm" style="color:${col(cur.away)}">${cur.away}</span> ${P(sps.away).name} ${pitLine(sps.away)}</div><div><span class="nm" style="color:${col(cur.home)}">${cur.home}</span> ${P(sps.home).name} ${pitLine(sps.home)}</div>`;
      return;
    }
    const side = e.side;
    const bat = e.kind === "pa" ? e.bat : null;
    const pit = e.kind === "pa" ? e.pid : currentPitcher(f.ei, 1 - side);
    let lu = lineups[side ? "home" : "away"];
    for (let k = f.ei; k >= 0; k--) { const x = game.events[k]; if (x.kind === "pa" && x.side === side && x.lu) { lu = x.lu; break; } }
    let nextI = 0;
    if (bat) nextI = lu.indexOf(bat);
    else { for (let k = f.ei; k >= 0; k--) { const x = game.events[k]; if (x.kind === "pa" && x.side === side) { nextI = (lu.indexOf(x.bat) + 1) % 9; break; } } }
    const due = [1, 2, 3].map((k) => nm(lu[(nextI + (bat ? k : k - 1)) % 9]));
    const pb = lb[pit] || {};
    const ip = pb.outs != null ? `${Math.floor(pb.outs / 3)}.${pb.outs % 3}` : "0.0";
    $("matchup").innerHTML = `<div class="hd">PITCHING · ${teamOf(1 - side)}</div><div><a href="#" class="nm plink" data-pcard="${pit}">${P(pit).name}</a> ${P(pit).throws || ""}HP · ${ip} IP, ${pb.ph || 0} H, ${pb.pr || 0} R, ${pb.pk || 0} K</div>` +
      (bat ? `<div class="hd" style="margin-top:6px">AT BAT · ${teamOf(side)}</div><div><a href="#" class="nm plink" data-pcard="${bat}">${P(bat).name}</a> ${batHand(bat)} · ${lineStr(lb[bat])}</div><div class="dim small">${seasonLine(bat)}</div>` : "") +
      `<div class="due">${bat ? "On deck" : "Due up"}: ${due.join(", ")}</div>`;
  }
  const batHand = (id) => { const h = P(id).bats; return h === "B" ? "S" : h || ""; };
  function seasonLine(id) {
    const a = P(id).avg || {};
    if (a.avg == null) return "no MLB stats this season";
    const f3 = (x) => (x == null ? "–" : x.toFixed(3).replace(/^0/, ""));
    return `${model.season_label}: ${f3(a.avg)}/${f3(a.obp)}/${f3(a.slg)}, ${a.hr} HR · ${a.hrr} H+R+RBI/G`;
  }
  function pitLine(id) {
    const a = P(id).avg || {};
    if (a.era == null) return "";
    return `<span class="dim">(${a.w}-${a.l}, ${a.era.toFixed(2)} ERA)</span>`;
  }

  function renderLine(ei) {
    const runs = [[], []], hits = [0, 0], errs = [0, 0];
    let maxInn = 9, curInn = 0, curHalf = 0;
    if (ei >= 0) {
      let prev = [0, 0];
      for (let k = 0; k <= ei; k++) {
        const e = game.events[k];
        if (e.kind === "start") { runs[e.side][e.inn - 1] = runs[e.side][e.inn - 1] || 0; curInn = e.inn; curHalf = e.side; }
        if (e.score) {
          for (const s of [0, 1]) if (e.score[s] > prev[s]) runs[s][(e.inn || curInn) - 1] = (runs[s][(e.inn || curInn) - 1] || 0) + e.score[s] - prev[s];
          prev = e.score;
        }
        if (e.hits) { hits[0] = e.hits[0]; hits[1] = e.hits[1]; errs[0] = e.errs[0]; errs[1] = e.errs[1]; }
        if (e.inn) maxInn = Math.max(maxInn, e.inn);
      }
    }
    const heads = []; for (let k = 1; k <= maxInn; k++) heads.push(k);
    const sc = ei >= 0 ? lastScore(ei) : [0, 0];
    const row = (s, t) => `<tr><td style="color:${col(t)}">${t}</td>${heads.map((k) => `<td class="${k === curInn && s === curHalf ? "cur" : ""}">${runs[s][k - 1] != null ? runs[s][k - 1] : "-"}</td>`).join("")}<td><b>${sc[s]}</b></td><td>${hits[s]}</td><td>${errs[1 - s]}</td></tr>`;
    $("lineScore").innerHTML = `<tr><th></th>${heads.map((x) => `<th>${x}</th>`).join("")}<th>R</th><th>H</th><th>E</th></tr>` + row(0, cur.away) + row(1, cur.home);
  }
  function renderStrip(ei) {
    if (!game) { $("strip").innerHTML = ""; return; }
    const halves = [];
    for (const e of game.events) if (e.kind === "start") halves.push({ inn: e.inn, side: e.side, runs: 0, started: false, done: false });
    const find = (inn, side) => halves.find((h) => h.inn === inn && h.side === side);
    let prev = [0, 0];
    game.events.forEach((e, k) => {
      if (k > ei) return;
      if (e.kind === "start") { const h = find(e.inn, e.side); if (h) h.started = true; }
      if (e.kind === "end") { const h = find(e.inn, e.side); if (h) h.done = true; }
      if (e.score && e.inn) { const h = find(e.inn, e.side); if (h && e.score[e.side] > prev[e.side]) h.runs += e.score[e.side] - prev[e.side]; prev = e.score; }
    });
    const curH = ei >= 0 && game.events[frames[fi] ? frames[fi].ei : 0];
    $("strip").innerHTML = halves.map((h) => {
      const isCur = curH && curH.inn === h.inn && curH.side === h.side && curH.kind !== "final";
      const bg = !h.started ? "" : h.runs ? `background:${col(teamOf(h.side))}` : "background:#2a3a4c";
      return `<div class="${h.started ? "" : "empty"} ${isCur ? "cur" : ""}" style="${bg}" title="${h.side ? "Bottom" : "Top"} ${h.inn}: ${h.runs} R">${h.runs || ""}</div>`;
    }).join("");
  }

  // ---------------- field ----------------
  const HX = 450, HY = 515, FT = 1.16; // home plate, px per foot
  const pt = (a, d) => [HX + d * FT * Math.sin((a * Math.PI) / 180), HY - d * FT * Math.cos((a * Math.PI) / 180)];
  const fence = (a) => { const t = Math.abs(a) / 45; return 400 - 70 * t * t; };
  function drawFieldBase() {
    const svg = $("field");
    const fc = col(cur.home);
    let h = `<defs><radialGradient id="grass" cx="50%" cy="92%" r="90%"><stop offset="0" stop-color="#1f5a2c"/><stop offset="1" stop-color="#143d1e"/></radialGradient>
      <pattern id="mow" width="40" height="40" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="40" height="40" fill="url(#grass)"/><rect width="20" height="40" fill="#000" opacity=".06"/></pattern></defs>`;
    h += `<rect width="900" height="560" fill="#0b1a10"/>`;
    // outfield
    let path = `M ${HX} ${HY}`;
    for (let a = -45; a <= 45; a += 3) { const [x, y] = pt(a, fence(a)); path += ` L ${x.toFixed(1)} ${y.toFixed(1)}`; }
    h += `<path d="${path} Z" fill="url(#mow)"/>`;
    // warning track + wall
    let wall = "", track = "";
    for (let a = -45; a <= 45; a += 3) { const [x, y] = pt(a, fence(a)); wall += `${a === -45 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)} `; const [x2, y2] = pt(a, fence(a) - 14); track += `${a === -45 ? "M" : "L"} ${x2.toFixed(1)} ${y2.toFixed(1)} `; }
    h += `<path d="${track}" fill="none" stroke="#5b4630" stroke-width="16" stroke-opacity=".55"/>`;
    h += `<path d="${wall}" fill="none" stroke="${fc}" stroke-width="5" stroke-opacity=".9"/>`;
    // infield dirt
    const [d1x, d1y] = pt(45, 95), [d2x, d2y] = pt(0, 160), [d3x, d3y] = pt(-45, 95);
    h += `<path d="M ${HX} ${HY + 18} L ${d1x} ${d1y} Q ${HX + 120} ${HY - 200} ${d2x} ${d2y} Q ${HX - 120} ${HY - 200} ${d3x} ${d3y} Z" fill="#6b4c2f" opacity=".85"/>`;
    // infield grass
    const b1 = pt(45, 90), b2 = pt(0, 127.3), b3 = pt(-45, 90);
    const g1 = pt(45, 70), g2 = pt(0, 110), g3 = pt(-45, 70), g0 = pt(0, 22);
    h += `<path d="M ${g0[0]} ${g0[1]} L ${g1[0]} ${g1[1]} L ${g2[0]} ${g2[1]} L ${g3[0]} ${g3[1]} Z" fill="#1d5229"/>`;
    // foul lines
    const fl = pt(-45, fence(-45)), fr = pt(45, fence(45));
    h += `<g stroke="#f3efe6" stroke-opacity=".75" stroke-width="2"><line x1="${HX}" y1="${HY}" x2="${fl[0]}" y2="${fl[1]}"/><line x1="${HX}" y1="${HY}" x2="${fr[0]}" y2="${fr[1]}"/></g>`;
    // mound & plate
    const md = pt(0, 60.5);
    h += `<circle cx="${md[0]}" cy="${md[1]}" r="11" fill="#7a5735"/><rect x="${md[0] - 4}" y="${md[1] - 1}" width="8" height="2" fill="#f3efe6"/>`;
    h += `<circle cx="${HX}" cy="${HY}" r="16" fill="#7a5735"/><path d="M ${HX - 5} ${HY - 4} L ${HX + 5} ${HY - 4} L ${HX + 5} ${HY + 1} L ${HX} ${HY + 5} L ${HX - 5} ${HY + 1} Z" fill="#f3efe6"/>`;
    h += `<g id="basesG">`;
    for (const [i, b] of [b1, b2, b3].entries()) h += `<rect id="base${i}" x="${b[0] - 7}" y="${b[1] - 7}" width="14" height="14" transform="rotate(45 ${b[0]} ${b[1]})" fill="#f3efe6"/>`;
    h += `</g>`;
    // distance markers
    for (const a of [-45, 0, 45]) { const [x, y] = pt(a, fence(a) + 16); h += `<text x="${x}" y="${y}" fill="#f3efe6" opacity=".35" font-family="monospace" font-size="12" text-anchor="middle">${Math.round(fence(a))}</text>`; }
    h += `<text x="${HX}" y="${pt(0, 250)[1]}" fill="#f3efe6" opacity=".14" font-family="monospace" font-size="40" font-weight="700" text-anchor="middle">${cur.home}</text>`;
    h += `<g id="fielders"></g><g id="dyn"></g>`;
    svg.innerHTML = h;
  }
  const FPOS = { 1: [0, 60.5], 2: [0, -6], 3: [40, 108], 4: [14, 148], 5: [-38, 106], 6: [-14, 148], 7: [-28, 285], 8: [0, 315], 9: [28, 285] };
  function drawDyn(e, bases, atPitch, animate) {
    const g = $("dyn"); if (!g) return;
    bases = bases || [null, null, null];
    const fieldSide = e && e.side != null ? 1 - e.side : 1;
    const fcol = col(teamOf(fieldSide)), bcol = e && e.side != null ? col(teamOf(e.side)) : "#fff";
    let fh = "";
    for (const k in FPOS) { const [x, y] = pt(...FPOS[k]); fh += `<circle cx="${x}" cy="${y}" r="5.5" fill="${fcol}" stroke="#0b0f14" stroke-width="1.5" opacity=".85"/>`; }
    $("fielders").innerHTML = e && e.kind !== "final" && e.kind !== "end" ? fh : "";
    const bpos = [pt(45, 90), pt(0, 127.3), pt(-45, 90)];
    for (let i = 0; i < 3; i++) { const r = $("base" + i); if (r) r.setAttribute("fill", bases[i] ? bcol : "#f3efe6"); }
    let h = "";
    bases.forEach((id, i) => {
      if (!id) return;
      const [x, y] = bpos[i];
      const dx = i === 0 ? 26 : i === 2 ? -26 : 0, dy = i === 1 ? -20 : -14;
      h += `<text x="${x + dx}" y="${y + dy}" fill="#fff" font-family="monospace" font-size="13" font-weight="700" text-anchor="middle" paint-order="stroke" stroke="#000" stroke-width="3">${nm(id)}</text>`;
    });
    if (e && e.kind === "pa") {
      // batter at the plate
      const bh = batHand(e.bat) === "L" ? 1 : batHand(e.bat) === "S" ? (P(e.pid).throws === "L" ? -1 : 1) : -1;
      const onBase = !atPitch && (e.after || []).includes(e.bat);
      if (!onBase) h += `<circle cx="${HX + bh * 14}" cy="${HY - 2}" r="6.5" fill="${bcol}" stroke="#0b0f14" stroke-width="1.5"/>`;
      if (!onBase) h += `<text x="${HX}" y="${HY + 36}" fill="#fff" font-family="monospace" font-size="13" font-weight="700" text-anchor="middle" paint-order="stroke" stroke="#000" stroke-width="3">${nm(e.bat)}</text>`;
      if (!atPitch && ["1B", "2B", "3B", "HR", "OUT", "E"].includes(e.res)) {
        const [a, d] = spray(e);
        const [x, y] = pt(a, Math.min(d, e.res === "HR" ? d : fence(a) - 8));
        const lift = e.bip === "G" ? 0 : e.bip === "L" ? 40 : e.bip === "P" ? 170 : 120;
        const mx = (HX + x) / 2, my = (HY + y) / 2 - lift;
        h += `<path id="trail" d="M ${HX} ${HY - 4} Q ${mx} ${my} ${x} ${y}" stroke="#fff" stroke-opacity=".45" stroke-width="2" fill="none" stroke-dasharray="${e.bip === "G" ? "2 4" : "5 5"}"/>`;
        h += `<circle cx="${x}" cy="${y}" r="13" fill="none" stroke="${e.res === "OUT" ? "#7d8ea1" : e.res === "HR" ? "#f2c14e" : "#3ecf8e"}" stroke-width="2.5" opacity=".9"/>`;
        h += `<g id="ball"><circle r="5.5" fill="#fff" stroke="#c33" stroke-width="1.2"/></g>`;
        g.innerHTML = h;
        const ball = $("ball"), path = $("trail");
        const len = path.getTotalLength();
        const dur = animate ? (e.bip === "G" ? 650 : 1000) / speed : 0;
        const t0 = performance.now();
        const frame = (t) => {
          const k = dur ? Math.min(1, (t - t0) / dur) : 1;
          const p2 = path.getPointAtLength(len * (e.bip === "G" ? k : 1 - (1 - k) * (1 - k)));
          ball.setAttribute("transform", `translate(${p2.x},${p2.y})`);
          if (k < 1) requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
        return;
      }
      if (atPitch) {
        const md = pt(0, 60.5);
        h += `<circle cx="${md[0]}" cy="${md[1]}" r="6.5" fill="${fcol}" stroke="#fff" stroke-width="1.5"/>`;
      }
    }
    g.innerHTML = h;
  }
  function drawZone(o) {
    const svg = $("zone");
    let h = `<text x="8" y="14" fill="#7d8ea1" font-family="monospace" font-size="10">PITCHES (ILLUSTRATIVE)</text>`;
    const zx = 85, zy = 30, zw = 50, zh = 64;
    h += `<rect x="${zx}" y="${zy}" width="${zw}" height="${zh}" fill="none" stroke="#7d8ea1" stroke-width="1.2"/>`;
    for (let k = 1; k < 3; k++) h += `<line x1="${zx + (zw * k) / 3}" y1="${zy}" x2="${zx + (zw * k) / 3}" y2="${zy + zh}" stroke="#1d2a38"/><line x1="${zx}" y1="${zy + (zh * k) / 3}" x2="${zx + zw}" y2="${zy + (zh * k) / 3}" stroke="#1d2a38"/>`;
    h += `<path d="M ${zx + 5} 128 L ${zx + zw - 5} 128 L ${zx + zw - 5} 133 L ${zx + zw / 2} 138 L ${zx + 5} 133 Z" fill="#c5d1de" opacity=".5"/>`;
    if (o) {
      const e = o.e;
      const R = MLBSim.rng(Math.floor(e.dir * 1e9) + 7);
      e.seq.slice(0, o.j + 1).forEach((p, k) => {
        let x, y;
        if (p === "B" || p === "H") { const side = R() < 0.5 ? -1 : 1; x = zx + zw / 2 + side * (zw / 2 + 4 + R() * 18); y = zy + R() * (zh + 26) - 10; if (R() < 0.4) { x = zx + R() * zw; y = R() < 0.5 ? zy - 6 - R() * 14 : zy + zh + 6 + R() * 14; } }
        else if (p === "S" && R() < 0.35) { x = zx + R() * zw; y = zy + zh + 4 + R() * 14; }
        else { x = zx + 4 + R() * (zw - 8); y = zy + 4 + R() * (zh - 8); }
        const c = p === "B" ? "#3ecf8e" : p === "X" ? "#4aa3ff" : p === "F" ? "#f2c14e" : p === "H" ? "#c084fc" : "#ef5b5b";
        const last = k === o.j;
        h += `<circle cx="${x}" cy="${y}" r="${last ? 8 : 6.5}" fill="${c}" opacity="${last ? 1 : 0.55}" stroke="${last ? "#fff" : "none"}" stroke-width="1.5"/><text x="${x}" y="${y + 3.5}" fill="#0b0f14" font-family="monospace" font-size="9" font-weight="700" text-anchor="middle">${k + 1}</text>`;
      });
      const [b, s] = countAt(e.seq, o.j);
      h += `<text x="212" y="14" fill="#e8eef5" font-family="monospace" font-size="12" text-anchor="end" font-weight="700">${Math.min(3, b)}-${Math.min(2, s)}</text>`;
    }
    h += `<g font-family="monospace" font-size="9" fill="#7d8ea1" transform="translate(30,0)"><circle cx="10" cy="146" r="3.5" fill="#3ecf8e"/><text x="16" y="149">ball</text><circle cx="44" cy="146" r="3.5" fill="#ef5b5b"/><text x="50" y="149">strike</text><circle cx="88" cy="146" r="3.5" fill="#f2c14e"/><text x="94" y="149">foul</text><circle cx="120" cy="146" r="3.5" fill="#4aa3ff"/><text x="126" y="149">play</text></g>`;
    svg.innerHTML = h;
  }

  // ---------------- final box ----------------
  function showFinal() {
    if (!game) return;
    const ip = (o) => `${Math.floor(o / 3)}.${o % 3}`;
    const side = (s) => {
      const t = teamOf(s), lu = lineups[s ? "home" : "away"];
      const bats = Object.values(game.box).filter((b) => b.side === s && b.order > 0 && !b.pitched).sort((x, y) => x.order - y.order || x.sub - y.sub);
      void lu;
      const tot = { ab: 0, r: 0, h: 0, rbi: 0, bb: 0, k: 0, hr: 0, tb: 0, sb: 0 };
      const rows = bats.map((b) => {
        for (const k in tot) tot[k] += b[k];
        return `<tr class="${b.sub ? "bench" : ""}"><td>${b.sub ? "&nbsp;&nbsp;" : b.order + ". "}<a href="#" class="plink" data-pcard="${b.id}">${b.name}</a><span class="pos">${b.sub ? "sub" : posOver[b.id] || P(b.id).pos || ""}</span></td><td>${b.ab}</td><td>${b.r}</td><td><b>${b.h}</b></td><td>${b.rbi}</td><td>${b.bb}</td><td>${b.k}</td><td>${b.hr}</td><td>${b.tb}</td><td>${b.sb}</td><td>${b.h + b.r + b.rbi}</td></tr>`;
      }).join("");
      const pitchers = game.sides[s].map((id) => game.box[id]);
      const prow = pitchers.map((b) => `<tr><td><a href="#" class="plink" data-pcard="${b.id}">${b.name}</a>${b.w ? ' <span class="pos">W</span>' : b.l ? ' <span class="pos">L</span>' : b.sv ? ' <span class="pos">SV</span>' : ""}</td><td>${ip(b.outs)}</td><td>${b.ph}</td><td>${b.pr}</td><td>${b.er}</td><td>${b.pbb}</td><td>${b.pk}</td><td>${b.phr}</td><td>${b.pc}</td></tr>`).join("");
      return `<h4 style="color:${col(t)}">${model.teams[t].name.toUpperCase()}</h4>
        <table><tr><th>BATTING</th><th>AB</th><th>R</th><th>H</th><th>RBI</th><th>BB</th><th>K</th><th>HR</th><th>TB</th><th>SB</th><th>H+R+RBI</th></tr>${rows}
        <tr class="tot"><td>TEAM</td><td>${tot.ab}</td><td>${tot.r}</td><td>${tot.h}</td><td>${tot.rbi}</td><td>${tot.bb}</td><td>${tot.k}</td><td>${tot.hr}</td><td>${tot.tb}</td><td>${tot.sb}</td><td></td></tr></table>
        <table style="margin-top:6px"><tr><th>PITCHING</th><th>IP</th><th>H</th><th>R</th><th>ER</th><th>BB</th><th>K</th><th>HR</th><th>PC</th></tr>${prow}</table>`;
    };
    $("finalBox").innerHTML = `<h2>FINAL${game.innings > 9 ? ` / ${game.innings}` : ""} · ${cur.away} ${game.score.away} – ${cur.home} ${game.score.home}</h2>
      <div class="boxgrid"><div>${side(0)}</div><div>${side(1)}</div></div>`;
    $("finalBox").classList.remove("hidden");
  }

  // ---------------- projections ----------------
  let jobId = 0;
  const jobs = {};
  function simRun(opts, n, onProg) { // queued runs in the web worker; resolves with the summarized result
    return new Promise((resolve) => {
      try {
        if (!worker) {
          worker = new Worker("js/worker.js");
          const m2 = Object.assign({}, model); delete m2._idx;
          worker.postMessage({ model: m2 });
          worker.onmessage = (e) => {
            const j = jobs[e.data.id]; if (!j) return;
            if (e.data.progress != null && j.p) j.p(e.data.progress);
            if (e.data.done) { delete jobs[e.data.id]; j.r(e.data.result); }
          };
        }
        const id = ++jobId; jobs[id] = { r: resolve, p: onProg };
        worker.postMessage({ run: true, id, opts, n });
      } catch (err) { setTimeout(() => resolve(MLBSim.summarize(MLBSim.simulateMany(model, opts, n))), 30); }
    });
  }
  function runProjections() {
    if (!model || !game) { if (model) $("runInfo").textContent = "set lineups and starters first"; return; }
    const n = +$("nSel").value;
    const opts = simOpts({ seed: 12345 });
    const gk = gameKey();
    $("btnRun").disabled = true; $("prog").style.width = "0%";
    $("runInfo").textContent = `simulating ${n.toLocaleString()} games…`;
    const t0 = performance.now();
    simRun(opts, n, (p) => ($("prog").style.width = (p * 100).toFixed(0) + "%")).then((res) => {
      resCache[gk] = res;
      if (slip.groups[gk]) { slip.groups[gk].opts = JSON.parse(JSON.stringify(opts)); saveSlip(); }
      if (gk !== gameKey()) { renderSlip(); return; } // the user switched games meanwhile
      projResult = res; projStale = false; $("btnRun").disabled = false; $("prog").style.width = "100%";
      $("runInfo").textContent = `${res.n.toLocaleString()} games in ${((performance.now() - t0) / 1000).toFixed(1)}s`;
      renderProjections();
      renderSlip();
      if (card) renderCard();
    });
  }

  // ---------------- parlay builder ----------------
  // Legs from the same game are scored together in each simulated game (so correlation is built in);
  // different games are independent, so their probabilities multiply.
  const resCache = {};
  let slip = { legs: [], groups: {}, sgp: null, open: false };
  try { const s = JSON.parse(localStorage.getItem("diamondsim.slip") || "null"); if (s && Array.isArray(s.legs)) slip = Object.assign(slip, s); } catch (e) { /* storage unavailable */ }
  const saveSlip = () => { try { localStorage.setItem("diamondsim.slip", JSON.stringify({ legs: slip.legs, groups: slip.groups, sgp: slip.sgp, open: slip.open })); } catch (e) { /* ignore */ } };
  const gameKey = () => (cur.sched ? cur.sched.id : `${cur.away}@${cur.home}`);
  const STAT_NAME = { hrr: "H+R+RBI", h: "hits", tb: "total bases", hr: "HR", r: "runs", rbi: "RBI", s: "singles", d: "doubles", bb: "walks", k: "batter K", sb: "SB", onbase: "times on base", pk: "K", outs: "outs", ph: "hits allowed", er: "ER", pbb: "walks allowed", pc: "pitches", phr: "HR allowed", w: "win" };
  function legLabel(leg) {
    const T = (t) => (t === "home" ? leg.home : leg.away), ou = (s) => (s === "u" ? "u" : "o");
    switch (leg.type) {
      case "prop": return leg.stat === "w" ? `${leg.name} to get the win` : `${leg.name} ${STAT_NAME[leg.stat] || leg.stat} ${ou(leg.side)}${leg.line}`;
      case "ml": return `${T(leg.team)} ML`;
      case "f5ml": return `${T(leg.team)} F5 ML`;
      case "rl": return `${T(leg.team)} ${fmtLine(leg.line)}`;
      case "total": return `Total ${ou(leg.side)}${leg.line}`;
      case "f5total": return `F5 total ${ou(leg.side)}${leg.line}`;
      case "tt": return `${T(leg.team)} team total ${ou(leg.side)}${leg.line}`;
      case "nrfi": return "NRFI"; case "yrfi": return "YRFI";
    }
    return "?";
  }
  function addLeg(leg) {
    if (!projResult) return;
    const gk = gameKey();
    Object.assign(leg, { gkey: gk, away: cur.away, home: cur.home, book: null });
    const sig = (l) => JSON.stringify([l.gkey, l.type, l.pid, l.stat, l.side, l.line, l.team]);
    if (slip.legs.some((l) => sig(l) === sig(leg))) { flashSlip("Already in the parlay"); return; }
    slip.legs.push(leg);
    if (!slip.groups[gk]) slip.groups[gk] = { label: `${cur.away} @ ${cur.home}${cur.sched ? " · " + fmtDay(cur.sched.date) : ""}`, opts: JSON.parse(JSON.stringify(simOpts({ seed: 12345 }))), n: projResult.n };
    resCache[gk] = resCache[gk] || projResult;
    saveSlip(); renderSlip(); flashSlip(`Added: ${legLabel(leg)}`);
  }
  let flashT = null;
  function flashSlip(msg) { const f = $("slipFlash"); if (!f) return; f.textContent = msg; f.classList.add("on"); clearTimeout(flashT); flashT = setTimeout(() => f.classList.remove("on"), 1600); }
  const decOdds = (am) => (am == null ? null : am > 0 ? 1 + am / 100 : am < 0 ? 1 + 100 / -am : null);
  const amFromDec = (d) => (d == null || d <= 1 ? "–" : d >= 2 ? "+" + Math.round((d - 1) * 100) : String(Math.round(-100 / (d - 1))));
  function slipMath() {
    let joint = 1, naive = 1, relVar = 0, missing = [], legP = {};
    const byG = {};
    for (const l of slip.legs) (byG[l.gkey] = byG[l.gkey] || []).push(l);
    for (const gk in byG) {
      const res = resCache[gk];
      if (!res) { missing.push(gk); continue; }
      const p = MLBSim.parlayProb(res, byG[gk]);
      byG[gk].forEach((l, i) => (legP[slip.legs.indexOf(l)] = p.single[i]));
      const valid = p.single.every((x) => x != null);
      joint *= p.joint;
      for (const x of p.single) if (x != null) naive *= x;
      relVar += p.joint > 0 ? (1 - p.joint) / (p.joint * res.n) : 0;
      if (!valid) missing.push(null);
    }
    let book = slip.legs.length && slip.legs.every((l) => l.book != null) ? slip.legs.reduce((d, l) => d * decOdds(l.book), 1) : null;
    if (slip.sgp != null) book = decOdds(slip.sgp);
    return { joint, naive, se: joint * Math.sqrt(relVar), missing, legP, book, ev: book != null && !missing.length ? joint * book - 1 : null, games: Object.keys(byG).length };
  }
  function renderSlip() {
    const el = $("slip");
    if (!el || !model) return;
    document.body.classList.toggle("has-slip", slip.legs.length > 0);
    if (!slip.legs.length) { el.classList.add("hidden"); return; }
    el.classList.remove("hidden");
    const m = slipMath(), ready = !m.missing.length;
    const lift = m.naive > 0 ? m.joint / m.naive : 0;
    const evTxt = m.ev == null ? "" : ` · EV <b class="${m.ev >= 0 ? "pos" : "neg"}">${m.ev >= 0 ? "+" : ""}${(m.ev * 100).toFixed(1)}%</b>`;
    $("slipBar").innerHTML = `<span class="ttl">PARLAY</span><span>${slip.legs.length} leg${slip.legs.length === 1 ? "" : "s"}${m.games > 1 ? ` · ${m.games} games` : ""}</span>` +
      (ready ? `<span>hits <b>${pct(m.joint)}</b></span><span>fair <b>${amFromDec(m.joint > 0 ? 1 / m.joint : null)}</b></span>${m.book ? `<span>book <b>${amFromDec(m.book)}</b>${evTxt}</span>` : ""}` : `<span class="dim">simulating…</span>`) +
      `<span class="flash" id="slipFlash"></span><button id="slipToggle">${slip.open ? "Hide ▾" : "Show ▴"}</button>`;
    let h = "";
    const byG = {};
    slip.legs.forEach((l, i) => (byG[l.gkey] = byG[l.gkey] || []).push([l, i]));
    for (const gk in byG) {
      h += `<div class="sg"><div class="sgh">${(slip.groups[gk] || {}).label || gk}${resCache[gk] ? ` <span class="dim">· ${resCache[gk].n.toLocaleString()} sims</span>` : ` <span class="dim">· simulating…</span>`}</div>`;
      for (const [l, i] of byG[gk]) {
        const p = m.legP[i];
        h += `<div class="leg"><span>${legLabel(l)}</span><span class="dim">${p == null ? (resCache[gk] ? "not in this lineup" : "") : pct(p)}</span><span class="dim">${p ? american(p) : ""}</span>
          <input type="number" step="1" placeholder="book odds" data-book="${i}" value="${l.book != null ? l.book : ""}"><button class="x" data-rm="${i}" title="Remove leg">×</button></div>`;
      }
      h += `</div>`;
    }
    const sum = ready ? `
      <div class="sumgrid">
        <div><div class="k">All legs hit</div><div class="v">${pct(m.joint)}</div><div class="s">± ${(m.se * 100).toFixed(1)} pts (sim noise) · fair ${amFromDec(m.joint > 0 ? 1 / m.joint : null)}</div></div>
        <div><div class="k">Legs multiplied</div><div class="v">${pct(m.naive)}</div><div class="s">what you'd get treating the legs as unrelated</div></div>
        <div><div class="k">Correlation</div><div class="v ${lift > 1.03 ? "pos" : lift < 0.97 ? "neg" : ""}">${lift.toFixed(2)}×</div><div class="s">${lift > 1.03 ? "these legs help each other" : lift < 0.97 ? "these legs work against each other" : "about independent"}</div></div>
        <div><div class="k">Book price</div><div class="v">${m.book ? amFromDec(m.book) : "–"}</div><div class="s">${slip.sgp != null ? "the book's same-game price you entered" : m.book ? "each leg's odds multiplied" : "enter each leg's odds, or the book's parlay price:"} <label>Parlay price <input type="number" step="1" id="sgpIn" placeholder="+600" value="${slip.sgp != null ? slip.sgp : ""}"></label></div></div>
        <div><div class="k">Expected value</div><div class="v ${m.ev == null ? "" : m.ev >= 0 ? "pos" : "neg"}">${m.ev == null ? "–" : (m.ev >= 0 ? "+" : "") + (m.ev * 100).toFixed(1) + "%"}</div><div class="s">${m.ev == null ? "needs a book price" : `per $1: model says ${m.ev >= 0 ? "profit" : "loss"} of $${Math.abs(m.ev).toFixed(2)} on average`}</div></div>
      </div>` : `<p class="dim">Simulating the games in this parlay…</p>`;
    $("slipBody").innerHTML = h + sum + `<div class="slipbtns"><button id="slipSharpen" title="Re-run every game in the parlay 20,000 times for a tighter estimate">Sharpen (20,000 sims)</button><button id="slipClear">Clear parlay</button>
      <span class="dim small">Same-game legs are scored together inside each simulated game, so correlation is built in. Different games multiply. Pushes count as misses.</span></div>`;
    $("slipBody").classList.toggle("hidden", !slip.open);
    $("slipToggle").onclick = () => { slip.open = !slip.open; saveSlip(); renderSlip(); };
    $("slipBody").querySelectorAll("button[data-rm]").forEach((b) => (b.onclick = () => { slip.legs.splice(+b.dataset.rm, 1); pruneGroups(); saveSlip(); renderSlip(); }));
    $("slipBody").querySelectorAll("input[data-book]").forEach((inp) => (inp.onchange = () => { slip.legs[+inp.dataset.book].book = num(inp.value); saveSlip(); renderSlip(); }));
    const sg = $("sgpIn"); if (sg) sg.onchange = () => { slip.sgp = num(sg.value); saveSlip(); renderSlip(); };
    $("slipClear").onclick = () => { slip.legs = []; slip.groups = {}; slip.sgp = null; saveSlip(); renderSlip(); };
    $("slipSharpen").onclick = () => sharpen(20000);
    if (m.missing.some((x) => x)) simMissing();
  }
  function pruneGroups() { for (const gk in slip.groups) if (!slip.legs.some((l) => l.gkey === gk)) delete slip.groups[gk]; }
  let simBusy = false;
  async function simMissing() {
    if (simBusy) return; simBusy = true;
    for (const gk in slip.groups) {
      const g = slip.groups[gk];
      if (resCache[gk] || !g.opts || !model.teams[g.opts.away] || !model.teams[g.opts.home]) continue;
      resCache[gk] = await simRun(g.opts, g.n || 5000);
    }
    simBusy = false; renderSlip();
  }
  async function sharpen(n) {
    if (simBusy) return; simBusy = true;
    $("slipSharpen").disabled = true; $("slipSharpen").textContent = "Simulating…";
    for (const gk in slip.groups) { const g = slip.groups[gk]; g.n = n; resCache[gk] = await simRun(g.opts, n); }
    simBusy = false; saveSlip(); renderSlip();
  }

  const pct = (x) => (x * 100).toFixed(1) + "%";
  function american(p) {
    if (p <= 0 || p >= 1) return "–";
    return p >= 0.5 ? String(Math.round((-100 * p) / (1 - p))) : "+" + Math.round((100 * (1 - p)) / p);
  }
  const implied = (ml) => (ml == null ? null : ml < 0 ? -ml / (-ml + 100) : 100 / (ml + 100));
  const quant = (arr, q) => arr[Math.min(arr.length - 1, Math.floor(q * arr.length))];
  const meanOf = (arr) => { let s = 0; for (const x of arr) s += x; return s / arr.length; };
  function pOver(sorted, line) { let lo = 0, hi = sorted.length; while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] <= line) lo = m + 1; else hi = m; } return (sorted.length - lo) / sorted.length; }
  function pUnder(sorted, line) { let lo = 0, hi = sorted.length; while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] < line) lo = m + 1; else hi = m; } return lo / sorted.length; }
  const num = (v) => (v === "" || v == null || isNaN(+v) ? null : +v);
  const fmtLine = (x) => (x > 0 ? "+" + x : String(x));

  function renderProjections() {
    const r = projResult, n = r.n, A = cur.away, H = cur.home;
    const margin = r.home.map((h, i) => h - r.away[i]);
    const total = r.home.map((h, i) => h + r.away[i]);
    const f5m = r.f5h.map((h, i) => h - r.f5a[i]);
    const f5t = r.f5h.map((h, i) => h + r.f5a[i]);
    const pH = r.wins.home / n, pA = 1 - pH;
    const sortedTotal = [...total].sort((a, b) => a - b);
    const nrfi = r.inn1.filter((x) => x === 0).length / n;
    const f5H = f5m.filter((x) => x > 0).length / n, f5A = f5m.filter((x) => x < 0).length / n;
    const mlA = num($("mMlA").value), mlH = num($("mMlH").value);
    const edge = (p, ml) => { const q = implied(ml); return q == null ? "" : ` · book ${pct(q)} (${p - q >= 0 ? "+" : ""}${((p - q) * 100).toFixed(1)})`; };
    const L = (o) => JSON.stringify(o).replace(/"/g, "&quot;");
    const add = (lbl, leg) => `<button class="addb" data-leg="${L(leg)}" title="Add to parlay">+ ${lbl}</button>`;
    const totLine = num($("mTotal").value) != null ? num($("mTotal").value) : Math.floor(meanOf(total)) + 0.5;
    const f5Line = num($("mF5").value) != null ? num($("mF5").value) : Math.floor(meanOf(f5t)) + 0.5;
    const cards = [
      [`${A} win`, pct(pA), `fair ${american(pA)}${edge(pA, mlA)}`, add(`${A} ML`, { type: "ml", team: "away" })],
      [`${H} win`, pct(pH), `fair ${american(pH)}${edge(pH, mlH)}`, add(`${H} ML`, { type: "ml", team: "home" })],
      ["Avg score", `${meanOf(r.away).toFixed(2)}–${meanOf(r.home).toFixed(2)}`, `${A}–${H} · median total ${quant(sortedTotal, 0.5)}`, add(`o${totLine}`, { type: "total", side: "o", line: totLine }) + add(`u${totLine}`, { type: "total", side: "u", line: totLine })],
      ["First 5 innings", `${(f5A * 100).toFixed(0)}% / ${(f5H * 100).toFixed(0)}%`, `${A} / ${H} · tie ${pct(1 - f5A - f5H)} · avg total ${meanOf(f5t).toFixed(2)}`, add(`${A} F5`, { type: "f5ml", team: "away" }) + add(`${H} F5`, { type: "f5ml", team: "home" }) + add(`F5 o${f5Line}`, { type: "f5total", side: "o", line: f5Line }) + add(`F5 u${f5Line}`, { type: "f5total", side: "u", line: f5Line })],
      ["NRFI", pct(nrfi), `fair ${american(nrfi)} · YRFI ${pct(1 - nrfi)} (${american(1 - nrfi)})`, add("NRFI", { type: "nrfi" }) + add("YRFI", { type: "yrfi" })],
      ["Extra innings", pct(meanOf(r.extra)), `${Math.round(meanOf(r.extra) * n).toLocaleString()} of ${n.toLocaleString()} games`, ""],
    ];
    const rl = num($("mRl").value);
    if (rl != null) {
      const cover = margin.filter((m) => m + rl > 0).length / n, push = margin.filter((m) => m + rl === 0).length / n;
      cards.push([`${H} ${fmtLine(rl)}`, pct(cover), `${A} ${fmtLine(-rl)} ${pct(1 - cover - push)}${push ? ` · push ${pct(push)}` : ""} · fair ${american(cover)}`, add(`${H} ${fmtLine(rl)}`, { type: "rl", team: "home", line: rl }) + add(`${A} ${fmtLine(-rl)}`, { type: "rl", team: "away", line: -rl })]);
    }
    const tl = num($("mTotal").value);
    if (tl != null) {
      const o = total.filter((t) => t > tl).length / n, u = total.filter((t) => t < tl).length / n;
      cards.push([`Over ${tl}`, pct(o), `under ${pct(u)}${o + u < 0.999 ? ` · push ${pct(1 - o - u)}` : ""} · fair over ${american(o)} / under ${american(u)}`, ""]);
    }
    const f5l = num($("mF5").value);
    if (f5l != null) {
      const o = f5t.filter((t) => t > f5l).length / n, u = f5t.filter((t) => t < f5l).length / n;
      cards.push([`F5 over ${f5l}`, pct(o), `under ${pct(u)} · fair over ${american(o)}`, ""]);
    }
    for (const [t, arr, side] of [[A, r.away, "away"], [H, r.home, "home"]]) {
      const m = meanOf(arr), l = Math.floor(m) + 0.5;
      cards.push([`${t} team total`, m.toFixed(2), `o${l} ${pct(arr.filter((x) => x > l).length / n)}`, add(`o${l}`, { type: "tt", team: side, side: "o", line: l }) + add(`u${l}`, { type: "tt", team: side, side: "u", line: l })]);
    }
    $("gameCards").innerHTML = cards.map(([k, v, s, b]) => `<div class="card"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div>${b ? `<div class="adds">${b}</div>` : ""}</div>`).join("");
    $("gameCards").querySelectorAll("button[data-leg]").forEach((b) => (b.onclick = () => addLeg(JSON.parse(b.dataset.leg))));
    $("marginTitle").textContent = `${H} run margin`;
    hist($("marginChart"), margin, -12, 12, 1, rl != null ? -rl : null, 2, rl != null ? `${H} ${fmtLine(rl)}` : "");
    hist($("totalChart"), total, 0, 24, 1, tl, 2, tl != null ? `o/u ${tl}` : "");
    $("teamFilter").innerHTML = `<option value="">Both</option><option>${A}</option><option>${H}</option>`;
    $("projOut").classList.remove("hidden");
    renderProps();
  }
  function hist(svg, data, lo, hi, bw0, mark, tickEvery, markLabel) {
    const W = 600, Hh = 200, pad = 22, bins = Math.ceil((hi - lo + 1) / bw0), counts = new Array(bins).fill(0);
    for (const x of data) { const c = Math.max(lo, Math.min(hi, x)); counts[Math.floor((c - lo) / bw0)]++; }
    const max = Math.max(...counts, 1), bw = (W - 2 * pad) / bins;
    let h = "";
    counts.forEach((c, i) => {
      const bh = (c / max) * (Hh - 2 * pad), x = pad + i * bw, v = lo + i * bw0;
      const color = mark != null && v > mark ? "#3ecf8e" : "#4aa3ff";
      h += `<rect x="${x + 0.5}" y="${Hh - pad - bh}" width="${Math.max(1, bw - 1)}" height="${bh}" fill="${color}" opacity=".8"><title>${v === lo ? "≤" : v === hi ? "≥" : ""}${v}: ${((c / data.length) * 100).toFixed(1)}%</title></rect>`;
    });
    for (let v = Math.ceil(lo / tickEvery) * tickEvery; v <= hi; v += tickEvery) h += `<text x="${pad + ((v - lo) / bw0 + 0.5) * bw}" y="${Hh - 5}" fill="#7d8ea1" font-size="11" font-family="monospace" text-anchor="middle">${v}</text>`;
    if (mark != null) {
      const x = pad + ((mark - lo) / bw0 + 0.5) * bw;
      h += `<line x1="${x}" x2="${x}" y1="${pad - 6}" y2="${Hh - pad}" stroke="#f2c14e" stroke-dasharray="3 3"/><text x="${x + 4}" y="${pad}" fill="#f2c14e" font-size="11" font-family="monospace">${markLabel}</text>`;
    }
    svg.innerHTML = h;
  }

  const PIT_KEYS = new Set(["pk", "outs", "ph", "er", "pbb", "pc", "phr", "w"]);
  const YESNO = new Set(["w"]);
  function propRows(k, tf, pen) {
    const isP = PIT_KEYS.has(k);
    return Object.values(projResult.players)
      .filter((p) => (!tf || p.team === tf) && (isP ? p.kind === "P" && (p.role === "SP" || (pen && p.apps >= 0.15)) : p.kind === "B"))
      .map((p) => ({ p, d: p.d[k], m: meanOf(p.d[k]) }))
      .sort((a, b) => (isP ? (b.p.role === "SP") - (a.p.role === "SP") || b.p.apps - a.p.apps : a.p.side - b.p.side || a.p.order - b.p.order));
  }
  const defLine = (k, m) => (k === "pc" ? Math.round(m) + 0.5 : Math.max(0.5, Math.floor(m) + 0.5));
  function renderProps() {
    if (!projResult) return;
    const k = $("statSel").value, tf = $("teamFilter").value, pen = $("penChk").checked;
    const rows = propRows(k, tf, pen);
    const isP = PIT_KEYS.has(k);
    const nameCell = (p) => `<td>${isP ? "" : p.order + ". "}<a href="#" class="plink" data-pcard="${p.id}" data-stat="${k}" ${lines[p.id + "|" + k] != null ? `data-line="${lines[p.id + "|" + k]}"` : ""}>${p.name}</a><span class="pos">${isP ? p.role : posOver[p.id] || P(p.id).pos || ""}</span></td><td><span class="teamtag" style="background:${col(p.team)}"></span>${p.team}</td>`;
    if (YESNO.has(k)) {
      $("propTable").innerHTML = `<tr><th>Player</th><th>Team</th><th>Appears</th><th>Probability</th><th>Fair yes</th><th>Fair no</th><th>Parlay</th></tr>` +
        rows.map(({ p, m }) => `<tr>${nameCell(p)}<td>${pct(p.apps)}</td><td>${pct(m)}</td><td>${american(m)}</td><td>${american(1 - m)}</td><td><button class="addb" data-pid="${p.id}" data-side="o" data-line="0.5">+ Yes</button></td></tr>`).join("");
      wireAdds(k);
      return;
    }
    $("propTable").innerHTML = `<tr><th>Player</th><th>Team</th><th>${isP ? "Appears" : "P(≥1)"}</th><th>Mean</th><th>Median</th><th>10th–90th</th><th>Line</th><th>Over</th><th>Under</th><th>Fair over</th><th>Fair under</th><th>Parlay</th></tr>` +
      rows.map(({ p, d, m }) => {
        const key = p.id + "|" + k;
        const user = lines[key] != null;
        const line = user ? lines[key] : defLine(k, m);
        const o = pOver(d, line), u = pUnder(d, line);
        const oc = user && o >= 0.56 ? "edge-hi" : "", uc = user && u >= 0.56 ? "edge-lo" : "";
        return `<tr>${nameCell(p)}<td>${isP ? pct(p.apps) : pct(pOver(d, 0.5))}</td><td>${m.toFixed(2)}</td><td>${quant(d, 0.5)}</td><td>${quant(d, 0.1)}–${quant(d, 0.9)}</td>
          <td><input data-key="${key}" type="number" step="0.5" value="${line}"></td>
          <td class="${oc}">${pct(o)}</td><td class="${uc}">${pct(u)}</td><td>${american(o)}</td><td>${american(u)}</td>
          <td class="adds"><button class="addb" data-pid="${p.id}" data-side="o" data-line="${line}" title="Add the over to the parlay">+ O</button><button class="addb" data-pid="${p.id}" data-side="u" data-line="${line}" title="Add the under to the parlay">+ U</button></td></tr>`;
      }).join("");
    wireAdds(k);
    $("propTable").querySelectorAll("input").forEach((inp) => (inp.onchange = () => {
      if (inp.value === "") delete lines[inp.dataset.key]; else lines[inp.dataset.key] = +inp.value;
      renderProps();
    }));
  }

  // ---------------- player card ----------------
  let logs = null, logsP = null;
  const loadLogs = () => logsP || (logsP = fetch("data/logs.json").then((r) => r.json()).then((x) => (logs = x)).catch(() => (logs = { p: {}, names: {} })));
  const HIT_STATS = { hrr: "H+R+RBI", h: "Hits", tb: "Total bases", hr: "Home runs", r: "Runs", rbi: "RBIs", s: "Singles", bb: "Walks", k: "Strikeouts", sb: "Stolen bases" };
  const PIT_STATS = { pk: "Strikeouts", outs: "Outs", ph: "Hits allowed", er: "Earned runs", pbb: "Walks", pc: "Pitches" };
  function hitVal(g, k) { // g = hitter log row
    const [, , , , , PA, AB, H, D, T, HR, R, RBI, BB, K, SB] = g;
    void PA; void AB;
    return { h: H, tb: H + D + 2 * T + 3 * HR, hr: HR, r: R, rbi: RBI, hrr: H + R + RBI, s: H - D - T - HR, bb: BB, k: K, sb: SB }[k];
  }
  const pitVal = (g, k) => ({ pk: g[8], outs: g[3], ph: g[4], er: g[6], pbb: g[7], pc: g[10] }[k]);
  let card = null; // {id, stat, line}
  function openCard(id, stat, line) {
    const p = P(id); if (!p || !p.name) return;
    const isP = p.pos === "P";
    const st = isP ? (PIT_STATS[stat] ? stat : "pk") : (HIT_STATS[stat] ? stat : "hrr");
    card = { id, stat: st, line: line != null ? line : null };
    $("pcard").classList.remove("hidden"); document.body.classList.add("modal");
    $("pcardBody").innerHTML = `<p class="dim">Loading game logs…</p>`;
    loadLogs().then(renderCard);
  }
  function closeCard() { card = null; $("pcard").classList.add("hidden"); document.body.classList.remove("modal"); }
  function renderCard() {
    if (!card) return;
    const id = card.id, p = P(id), isP = p.pos === "P", L = (logs.p || {})[id] || { logs: [] };
    const k = card.stat, val = (g) => (isP ? pitVal(g, k) : hitVal(g, k));
    const games = L.logs || [];
    const pr = projResult && projResult.players[id] && projResult.players[id].d[k] ? projResult.players[id] : null;
    const projMean = pr ? meanOf(pr.d[k]) : null;
    if (card.line == null) {
      const recent = games.slice(0, 10).map(val);
      const base = projMean != null ? projMean : recent.length ? meanOf(recent) : 0.5;
      card.line = k === "pc" ? Math.round(base) + 0.5 : Math.max(0.5, Math.floor(base) + 0.5);
    }
    const line = card.line;
    const rate = (arr) => { const hit = arr.filter((g) => val(g) > line).length; return arr.length ? `<b>${hit}/${arr.length}</b> <span class="dim">${Math.round((hit / arr.length) * 100)}%</span>` : "–"; };
    const team = p.team, c = col(team);
    const ini = p.name.split(/[ .'-]+/).filter(Boolean).map((s) => s[0]).join("").slice(0, 3);
    const img = p.mlbam ? `<img alt="" src="https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_160,q_auto:best/v1/people/${p.mlbam}/headshot/67/current" onerror="this.replaceWith(document.createTextNode('${ini}'))">` : ini;
    const statOpts = Object.entries(isP ? PIT_STATS : HIT_STATS).map(([kk, nmv]) => `<option value="${kk}" ${kk === k ? "selected" : ""}>${nmv}</option>`).join("");
    let h = `<div class="pc-head"><div class="badge big" style="border-color:${c};color:${c}">${img}</div><div>
      <div class="pc-name">${p.name}</div>
      <div class="dim mono">${model.teams[team] ? model.teams[team].name : team} · ${isP ? `${p.throws || "R"}HP · ${p.role === "SP" ? "starter" : "reliever"}` : `${posOver[id] || p.pos} · bats ${batHand(id)}`}${p.status ? ` · <span class="neg">${p.status}</span>` : ""}</div>
      <div class="mono small" style="margin-top:4px">${isP ? pitSeason(L) : seasonLine(id)}</div></div>
      <button class="pc-x" id="pcClose" title="Close">×</button></div>`;
    h += `<div class="pc-ctl"><label>Stat <select id="pcStat">${statOpts}</select></label><label>Line <input id="pcLine" type="number" step="0.5" value="${line}"></label>`;
    if (pr) {
      const o = pOver(pr.d[k], line), u = pUnder(pr.d[k], line);
      h += `<span class="pc-model">Model (${cur.away} @ ${cur.home}): mean <b>${projMean.toFixed(2)}</b> · over <b>${pct(o)}</b> (${american(o)}) · under ${pct(u)} (${american(u)})</span>
        <button class="addb" id="pcAddO">+ O ${line}</button><button class="addb" id="pcAddU">+ U ${line}</button>`;
    } else h += `<span class="dim small">${projResult ? "Not in this game's lineup." : "Run the projections to see the model's numbers here."}</span>`;
    h += `</div>`;
    const season = games.filter((g) => g[0].slice(0, 4) === String(logs.season));
    h += `<div class="pc-rates"><div><div class="k">Last 5</div><div>${rate(games.slice(0, 5))}</div></div><div><div class="k">Last 10</div><div>${rate(games.slice(0, 10))}</div></div><div><div class="k">Last 20</div><div>${rate(games.slice(0, 20))}</div></div><div><div class="k">Avg last 10</div><div><b>${games.length ? meanOf(games.slice(0, 10).map(val)).toFixed(2) : "–"}</b></div></div><div><div class="k">Over ${line} means</div><div class="dim small">${k === "pc" ? "pitches" : (isP ? PIT_STATS : HIT_STATS)[k].toLowerCase()} ≥ ${Math.floor(line) + 1}</div></div></div>`;
    void season;
    // bar chart oldest -> newest
    const g20 = games.slice(0, 20).reverse();
    if (g20.length) {
      const vals = g20.map(val), mx = Math.max(line + 1, ...vals), W = 760, H = 150, pad = 22, bw = (W - 2 * pad) / g20.length;
      let svg = "";
      g20.forEach((g, i) => {
        const v = vals[i], bh = (v / mx) * (H - 2 * pad - 10), x = pad + i * bw;
        svg += `<rect x="${x + 2}" y="${H - pad - bh}" width="${bw - 4}" height="${Math.max(bh, 1.5)}" fill="${v > line ? "#3ecf8e" : "#4a5a6c"}" rx="2"><title>${g[0]} ${g[1]}: ${v}</title></rect>`;
        svg += `<text x="${x + bw / 2}" y="${H - pad - bh - 4}" fill="#c5d1de" font-size="11" font-family="monospace" text-anchor="middle">${v}</text>`;
        svg += `<text x="${x + bw / 2}" y="${H - 6}" fill="#7d8ea1" font-size="9.5" font-family="monospace" text-anchor="middle">${g[1]}</text>`;
      });
      const ly = H - pad - (line / mx) * (H - 2 * pad - 10);
      svg += `<line x1="${pad}" x2="${W - pad}" y1="${ly}" y2="${ly}" stroke="#f2c14e" stroke-dasharray="4 4"/><text x="${W - pad}" y="${ly - 4}" fill="#f2c14e" font-size="11" font-family="monospace" text-anchor="end">${line}</text>`;
      h += `<svg class="pc-chart" viewBox="0 0 ${W} ${H}">${svg}</svg><div class="dim small" style="margin:-4px 0 8px">Last ${g20.length} games, oldest to newest.</div>`;
    } else h += `<p class="dim">No games in the data yet.</p>`;
    // today's matchup
    if (!isP && game) {
      const side = lineups.away.includes(id) ? "away" : lineups.home.includes(id) ? "home" : null;
      if (side) {
        const sp = sps[side === "away" ? "home" : "away"], raw = sp.replace(/-P$/, "");
        const bv = (L.bvp || {})[raw];
        const spl = (L.split || {})[P(sp).throws || "R"];
        h += `<div class="pc-match"><b>Today vs ${P(sp).name}</b> (${P(sp).throws || "R"}HP): ` +
          (bv ? `${bv[2]}-for-${bv[1]}${bv[4] ? `, ${bv[4]} HR` : ""}${bv[5] ? `, ${bv[5]} BB` : ""}, ${bv[6]} K in ${bv[0]} PA (last two seasons)` : "hasn't faced him in the last two seasons") +
          (spl ? ` · this season vs ${P(sp).throws === "L" ? "lefties" : "righties"}: ${slash(spl)}` : "") + `</div>`;
      }
    }
    // splits
    const sp = L.split || {};
    if (sp.L || sp.R) {
      const row = (hnd, nm) => sp[hnd] ? `<tr><td>${nm}</td><td>${sp[hnd][0]}</td><td>${slash(sp[hnd])}</td><td>${sp[hnd][4]}</td><td>${(sp[hnd][6] / sp[hnd][0] * 100).toFixed(1)}%</td><td>${(sp[hnd][5] / sp[hnd][0] * 100).toFixed(1)}%</td></tr>` : "";
      h += `<h4>${logs.season} SPLITS</h4><table class="pc-t"><tr><th></th><th>${isP ? "BF" : "PA"}</th><th>AVG/OBP/SLG</th><th>HR</th><th>K%</th><th>BB%</th></tr>${isP ? row("L", "vs LHB") + row("R", "vs RHB") : row("L", "vs LHP") + row("R", "vs RHP")}</table>`;
    }
    // game log
    if (games.length) {
      if (isP) {
        h += `<h4>GAME LOG</h4><table class="pc-t"><tr><th>Date</th><th>Opp</th><th></th><th>IP</th><th>H</th><th>R</th><th>ER</th><th>BB</th><th>K</th><th>HR</th><th>PC</th><th>Dec</th></tr>` +
          games.map((g) => `<tr class="${pitVal(g, k) > line ? "hitrow" : ""}"><td>${g[0].slice(5)}</td><td>${g[1]}</td><td class="dim">${g[2] ? "GS" : "RP"}</td><td>${Math.floor(g[3] / 3)}.${g[3] % 3}</td><td>${g[4]}</td><td>${g[5]}</td><td>${g[6]}</td><td>${g[7]}</td><td>${g[8]}</td><td>${g[9]}</td><td>${g[10]}</td><td>${g[11]}</td></tr>`).join("") + `</table>`;
      } else {
        h += `<h4>GAME LOG</h4><table class="pc-t"><tr><th>Date</th><th>Opp</th><th>vs starter</th><th>Bat</th><th>AB</th><th>H</th><th>2B</th><th>HR</th><th>R</th><th>RBI</th><th>BB</th><th>K</th><th>SB</th><th>TB</th><th>H+R+RBI</th></tr>` +
          games.map((g) => `<tr class="${hitVal(g, k) > line ? "hitrow" : ""}"><td>${g[0].slice(5)}</td><td>${g[1]}</td><td class="dim">${g[2] ? `${shortNm((logs.names || {})[g[2]] || (idx[g[2]] || {}).name || "")} ${g[3]}` : ""}</td><td class="dim">${g[4] || "–"}</td><td>${g[6]}</td><td>${g[7]}</td><td>${g[8]}</td><td>${g[10]}</td><td>${g[11]}</td><td>${g[12]}</td><td>${g[13]}</td><td>${g[14]}</td><td>${g[15]}</td><td>${hitVal(g, "tb")}</td><td><b>${hitVal(g, "hrr")}</b></td></tr>`).join("") + `</table>`;
      }
      h += `<div class="dim small">Highlighted games went over ${line}. Includes postseason games.</div>`;
    }
    $("pcardBody").innerHTML = h;
    $("pcClose").onclick = closeCard;
    $("pcStat").onchange = () => { card.stat = $("pcStat").value; card.line = null; renderCard(); };
    $("pcLine").onchange = () => { card.line = num($("pcLine").value); renderCard(); };
    if ($("pcAddO")) {
      const add = (side) => addLeg({ type: "prop", pid: id, name: p.short, stat: k, side, line });
      $("pcAddO").onclick = () => add("o"); $("pcAddU").onclick = () => add("u");
    }
  }
  const shortNm = (n) => { const s = String(n).split(" "); return s.length > 1 ? s[0][0] + ". " + s.slice(1).join(" ") : n; };
  const slash = (s) => { const [PA, AB, H, TB, , , , OB] = s; const f = (x) => x.toFixed(3).replace(/^0/, ""); return AB ? `${f(H / AB)}/${f(OB / PA)}/${f(TB / AB)}` : "–"; };
  function pitSeason(L) {
    const t = L.tot; if (!t || !t[0]) return "";
    const [G, GS, outs, H, ER, BB, K, HR] = t;
    return `${logs.season}: ${G} G (${GS} GS), ${Math.floor(outs / 3)}.${outs % 3} IP, ${(27 * ER / Math.max(outs, 1)).toFixed(2)} ERA, ${K} K, ${BB} BB, ${HR} HR · ${((H + BB) * 3 / Math.max(outs, 1)).toFixed(2)} WHIP`;
  }
  document.addEventListener("click", (e) => {
    const t = e.target.closest("[data-pcard]");
    if (t) { e.preventDefault(); openCard(t.dataset.pcard, t.dataset.stat, t.dataset.line != null ? +t.dataset.line : null); return; }
    if (e.target.id === "pcard") closeCard();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && card) closeCard(); });

  function wireAdds(k) {
    $("propTable").querySelectorAll("button[data-pid]").forEach((b) => (b.onclick = () => {
      const p = projResult.players[b.dataset.pid];
      addLeg({ type: "prop", pid: p.id, name: p.short || p.name, stat: k, side: b.dataset.side, line: +b.dataset.line });
    }));
  }
  function downloadCsv() {
    if (!projResult) return;
    const stats = ["hrr", "h", "tb", "hr", "r", "rbi", "s", "d", "bb", "k", "sb", "onbase", "pk", "outs", "ph", "er", "pbb", "pc", "phr", "w"];
    const out = [["game", "player", "team", "role", "stat", "mean", "median", "p10", "p90", "line", "over", "under", "fair_over", "fair_under"].join(",")];
    for (const k of stats) for (const { p, d, m } of propRows(k, "", true)) {
      const line = YESNO.has(k) ? 0.5 : lines[p.id + "|" + k] != null ? lines[p.id + "|" + k] : defLine(k, m);
      const o = pOver(d, line), u = pUnder(d, line);
      out.push([`${cur.away}@${cur.home}`, `"${p.name}"`, p.team, p.kind === "P" ? p.role : `bat${p.order}`, k, m.toFixed(3), quant(d, 0.5), quant(d, 0.1), quant(d, 0.9), line, o.toFixed(4), u.toFixed(4), american(o), american(u)].join(","));
    }
    const blob = new Blob([out.join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `diamond-sim_${cur.away}-at-${cur.home}_${projResult.n}sims.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ---------------- lineups ----------------
  function renderRoster() {
    const sg = cur.sched;
    const notes = [];
    for (const side of ["away", "home"]) {
      const t = cur[side];
      notes.push(`${t}: ${cur.posted && cur.posted[side] ? "posted lineup" : "projected lineup (their most recent one against a " + (P(sps[side === "away" ? "home" : "away"]).throws === "L" ? "lefty" : "righty") + ")"}, ${sg && sg[side + "_sp"] === sps[side] ? "probable starter" : "starter guessed from the rotation"}`);
    }
    $("lineupNote").textContent = notes.join(" · ") + ". Relievers who are worn out (30+ pitches yesterday, back-to-back days, or 50+ pitches in three days) start unchecked. Change the order, swap hitters or the starter, or mark players unavailable. Changes apply to both tabs.";
    $("rosters").innerHTML = ["away", "home"].map((side) => teamBlock(side)).join("");
    $("rosters").querySelectorAll("select[data-slot]").forEach((s) => (s.onchange = () => {
      const side = s.dataset.side, i = +s.dataset.slot, id = s.value;
      const lu = lineups[side], j = lu.indexOf(id);
      if (j >= 0) lu[j] = lu[i];
      lu[i] = id; outSet.delete(id);
      changed();
    }));
    $("rosters").querySelectorAll("button[data-mv]").forEach((b) => (b.onclick = () => {
      const side = b.dataset.side, i = +b.dataset.slot, d = +b.dataset.mv, lu = lineups[side];
      const j = i + d; if (j < 0 || j > 8) return;
      [lu[i], lu[j]] = [lu[j], lu[i]];
      changed();
    }));
    $("rosters").querySelectorAll("select[data-sp]").forEach((s) => (s.onchange = () => { sps[s.dataset.sp] = s.value; outSet.delete(s.value); changed(); }));
    $("rosters").querySelectorAll("input[data-out]").forEach((c) => (c.onchange = () => {
      const id = c.dataset.out;
      if (c.checked) outSet.delete(id); else {
        outSet.add(id);
        for (const side of ["away", "home"]) {
          const lu = lineups[side], i = lu.indexOf(id);
          if (i >= 0) { // replace with the best available bench bat
            const T = model.teams[cur[side]];
            const rep = T.players.filter((p) => p.pos !== "P" && !outSet.has(p.id) && !lu.includes(p.id)).sort((a, b) => b.n - a.n)[0];
            if (rep) lu[i] = rep.id; else lu.splice(i, 1);
          }
          if (sps[side] === id) sps[side] = MLBSim.guessStarter(model, cur[side], outSet);
        }
      }
      changed();
    }));
    $("rosters").querySelectorAll("button[data-reset]").forEach((b) => (b.onclick = () => {
      const side = b.dataset.reset;
      const d = MLBSim.defaults(model, cur.away, cur.home, cur.sched, [...outSet]);
      lineups[side] = d.lineups[side]; sps[side] = d.sp[side];
      changed();
    }));
  }
  function teamBlock(side) {
    const t = cur[side], T = model.teams[t], lu = lineups[side];
    const hitters = T.players.filter((p) => p.pos !== "P");
    const pitchers = T.players.filter((p) => p.pos === "P");
    const f3 = (x) => (x == null ? "–" : x.toFixed(3).replace(/^0/, ""));
    let h = `<div class="team"><h3 style="color:${col(t)}">${T.name} <span class="dim">${T.record}</span>
      <button class="small" data-reset="${side}" style="float:right">Reset</button></h3>`;
    h += `<div class="spsel">SP <select data-sp="${side}">${pitchers.filter((p) => !p.status && !outSet.has(p.id) || p.id === sps[side]).sort((a, b) => (b.role === "SP") - (a.role === "SP") || b.n - a.n)
      .map((p) => `<option value="${p.id}" ${p.id === sps[side] ? "selected" : ""}>${p.name} (${p.throws}HP${p.avg && p.avg.era != null ? `, ${p.avg.era.toFixed(2)} ERA` : ""}${p.role === "RP" ? ", reliever" : ""})</option>`).join("")}</select></div>`;
    h += `<button class="small" data-pcard="${sps[side]}" style="margin:4px 0">Starter's card</button><h4>BATTING ORDER</h4><div class="lu hdr"><span>#</span><span>Hitter</span><span>AVG</span><span>HR</span><span>H+R+RBI/G</span><span></span></div>`;
    lu.forEach((id, i) => {
      const p = P(id), a = p.avg || {};
      h += `<div class="lu"><span>${i + 1}</span><span><select data-side="${side}" data-slot="${i}">${hitters.filter((x) => !outSet.has(x.id) || x.id === id).map((x) => `<option value="${x.id}" ${x.id === id ? "selected" : ""}>${x.name} · ${x.pos} · ${x.bats === "B" ? "S" : x.bats}</option>`).join("")}</select></span>
        <span>${f3(a.avg)}</span><span>${a.hr != null ? a.hr : "–"}</span><span>${a.hrr != null ? a.hrr : "–"}</span>
        <span class="mv"><button data-pcard="${id}" title="Player card: recent games and hit rates">i</button><button data-side="${side}" data-slot="${i}" data-mv="-1" title="Move up">▲</button><button data-side="${side}" data-slot="${i}" data-mv="1" title="Move down">▼</button></span></div>`;
    });
    // bench & availability
    const bench = hitters.filter((p) => !lu.includes(p.id));
    h += `<h4>BENCH · uncheck = unavailable</h4><div class="bench">` + bench.map((p) => `<label class="${outSet.has(p.id) ? "off" : ""}" title="${p.status || ""}"><input type="checkbox" data-out="${p.id}" ${outSet.has(p.id) ? "" : "checked"}>${p.short}${p.status ? ` <span class="tagpill">${p.status}</span>` : ""}</label>`).join("") + `</div>`;
    const pen = (T.bullpen || []).map((x) => ({ p: P(x.id), role: x.role })).filter((x) => x.p.id);
    h += `<h4>BULLPEN · uncheck = unavailable</h4><div class="pen hdr dim"><span></span><span>Reliever</span><span>Role</span><span>ERA</span><span>K/9</span></div>` +
      pen.map(({ p, role }) => { const tired = MLBSim.fatigue(P(p.id), gameDate()); return `<div class="pen ${outSet.has(p.id) ? "off" : ""}"><span><input type="checkbox" data-out="${p.id}" ${outSet.has(p.id) ? "" : "checked"}></span><span><a href="#" class="plink" data-pcard="${p.id}">${p.name}</a> <span class="dim">${p.throws}</span>${p.status ? ` <span class="tagpill">${p.status}</span>` : ""}${tired ? ` <span class="tagpill tired" title="${tired}">tired · ${tired}</span>` : ""}</span><span>${role}</span><span>${p.avg && p.avg.era != null ? p.avg.era.toFixed(2) : "–"}</span><span>${p.avg && p.avg.k9 != null ? p.avg.k9 : "–"}</span></div>`; }).join("");
    const injured = T.players.filter((p) => p.status && !pen.some((x) => x.p.id === p.id) && !bench.includes(p) && !lu.includes(p.id));
    if (injured.length) h += `<h4>NOT AVAILABLE</h4><div class="bench">` + injured.map((p) => `<label class="${outSet.has(p.id) ? "off" : ""}"><input type="checkbox" data-out="${p.id}" ${outSet.has(p.id) ? "" : "checked"}>${p.short} <span class="tagpill">${p.status}</span></label>`).join("") + `</div>`;
    return h + `</div>`;
  }
  function changed() {
    projStale = true;
    posOver = Object.assign(MLBSim.assignPositions(model, cur.away, lineups.away), MLBSim.assignPositions(model, cur.home, lineups.home));
    renderRoster();
    newGame(seed);
    if (activeTab() === "proj") runProjections();
  }
})();
