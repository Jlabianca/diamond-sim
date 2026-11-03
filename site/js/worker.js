/* Runs many simulations off the main thread and returns per-player distributions (Diamond Sim).
   Jobs are queued: each message {run, id, opts, n} gets {id, progress} updates and a final {id, done, result}. */
importScripts("sim.js");
let model = null;
self.onmessage = (e) => {
  const m = e.data;
  if (m.model) model = m.model;
  if (!m.run) return;
  const agg = MLBSim.simulateMany(model, m.opts, m.n, (p) => self.postMessage({ id: m.id, progress: p }));
  self.postMessage({ id: m.id, done: true, result: MLBSim.summarize(agg) });
};
