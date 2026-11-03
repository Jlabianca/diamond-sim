# Diamond Sim

A pitch-by-pitch MLB game simulator that runs in the browser. It's the baseball sibling of [Gridiron Sim](https://github.com/Jlabianca/gridiron-sim) and [Hardwood Sim](https://github.com/Jlabianca/hardwood-sim).

https://jlabianca.github.io/diamond-sim/

Pick a matchup and you can:

- **Watch a sim**: an animated replay of one simulated game. It shows the scoreboard with inning, outs and count, and a field view with runners, fielders and the batted-ball path. Alongside are the pitch sequence for each at-bat, the pitcher-vs-batter matchup with live stat lines, a line score (R/H/E), a half-inning strip and a full box score at the end. Every game comes from a seed, and *Copy link* shares that exact game (for example `#NYY@BOS/42`).
- **Projections & props**: re-run the game 1,000–20,000 times. You get win probability, fair moneylines, run line, total, team totals, first-5-innings result and total, NRFI/YRFI and extra-innings odds. Each is checked against the market lines you type in.
  - **Batter props**: H+R+RBI, hits, total bases, home runs, runs, RBIs, singles, doubles, walks, strikeouts, stolen bases and times on base.
  - **Pitcher props**: strikeouts, outs recorded, hits allowed, earned runs, walks, pitch count, home runs allowed and the win.
  - Type a sportsbook line to get the model's over/under probability and fair odds. *Download CSV* exports every player and every stat.
- **Parlay builder**: add legs with the **+** buttons on any game line or prop: moneyline, run line, totals, F5, NRFI/YRFI, team totals and any batter or pitcher prop at any line. Legs can come from several games. The slip at the bottom of the screen shows:
  - **All legs hit**: how often every leg wins together. Legs from the same game are scored together inside each simulated game, so correlation is built in. Different games multiply.
  - **Legs multiplied**: the naive number you'd get treating the legs as unrelated.
  - **Correlation**: the ratio of the two. Above 1× means the legs help each other (a team's ML and its hitters' overs); below 1× means they work against each other (a team's ML and the opposing starter's strikeouts).
  - **Fair odds and expected value** against each leg's book odds, or the book's same-game parlay price.
  - **Sharpen** re-runs every game 20,000 times for a tighter estimate. The slip is saved in your browser.
- **Lineups & pitchers**: the posted lineup when it's out, otherwise each team's most recent lineup against a pitcher of that hand. Reorder it, swap hitters, change the starting pitcher, or mark hitters and relievers unavailable (a closer who threw three days in a row, say). Changes apply to both tabs.

The site is fully static: one JSON model file and plain JavaScript, with no server. It's hosted on GitHub Pages, and a scheduled GitHub Action rebuilds the model from fresh MLB data three times a day.

## How the model works

`scripts/build_data.py` downloads the play-by-play and box score of every finished game this season and last from the public MLB Stats API, plus the upcoming schedule (probable pitchers, posted lineups) and the 40-man rosters with injured-list status. It writes `site/data/model.json`:

- **Hitters and pitchers**: per-plate-appearance rates of strikeouts, walks, hit-by-pitches, singles, doubles, triples and home runs, plus ground-ball rate.
  - Rates are recency-weighted (half-life of 100 days), and last season counts at 70% weight.
  - Each rate is pulled toward the league average by a stat-specific amount, so strikeout rate trusts a small sample and home-run rate needs a big one. Pitchers are pulled toward the starter or reliever average.
  - Home-park effects are removed from each player's rates and added back for the park of the game being simmed.
- **Base stealing**: each runner's attempt rate and success rate.
- **Starters**: average pitch count. **Relievers**: role (closer, setup, middle, long, low-leverage), from saves and run prevention.
- **League**: platoon splits (L/R batter × L/R pitcher), double-play, sacrifice-fly and error rates, pitches per plate appearance, and park factors for each stadium.

`site/js/sim.js` then plays the game one plate appearance at a time:

- **Matchup**: the outcome comes from the batter's rates against the pitcher's (a log5 / odds-ratio blend), adjusted for platoon, park and home field. Hitters do better against a starter the third time through the order.
- **Balls in play**: outs split into grounders, flies, liners and pop-ups. Grounders can turn into double plays or fielder's choices, fly balls score runners from third, and liners can double a runner off.
- **Baserunning**: runner advancement on hits and outs depends on the runner's speed and the number of outs. Steals, wild pitches, errors and the automatic runner in extra innings are all modeled.
- **Pitchers**: each at-bat has a pitch sequence consistent with its result. The starter comes out when he reaches his pitch limit (drawn around his recent average) or gets hit hard. Relievers come in by role and situation: closer in a save spot, setup men in the 8th, long men after an early exit, mop-up arms in blowouts.
- **Late game**: pinch-hitters and defensive subs, walk-offs, and wins, losses and saves decided the way the scorer would.

`scripts/calibrate.js` tunes six global constants so the simulated league matches the real one: hits per game, runs per game, home-team win rate, stolen bases per game, starters' pitch counts, and starters' plate appearances per game.

### Backtest (2025, Aug 4 – Sep 28, 751 games, each week using only data available before it)

The lineups and starting pitchers that actually played were used, since they're known before first pitch. Historical play-by-play for backtests comes from Retrosheet (`--source retro`).

| | Model | Baseline |
|---|---|---|
| Picks the winner | 55.4% | – |
| Win probability Brier score (lower is better) | 0.2441 | 0.2492 (home team 53.5%) |
| Total runs error (MAE) | 3.51 | 3.53 (league average) |
| NRFI Brier score | 0.2496 | 0.2506 (league rate) |

Player props compare the model's mean with each player's season-to-date average in his earlier starts:

| Stat | Model MAE | Season-avg MAE | Model corr | Season-avg corr | Over: predicted / actual |
|---|---|---|---|---|---|
| Batter H+R+RBI | 1.520 | 1.529 | 0.137 | 0.116 | o1.5: 46.9% / 46.6% |
| Batter hits | 0.682 | 0.688 | 0.119 | 0.107 | o0.5: 61.7% / 61.4% |
| Batter total bases | 1.366 | 1.382 | 0.121 | 0.111 | o1.5: 35.9% / 36.0% |
| Batter home runs | 0.225 | 0.226 | 0.130 | 0.137 | o0.5: 11.9% / 12.5% |
| Batter runs | 0.582 | 0.582 | 0.148 | 0.113 | o0.5: 39.0% / 38.4% |
| Batter RBIs | 0.639 | 0.638 | 0.110 | 0.097 | o0.5: 30.5% / 30.1% |
| Pitcher strikeouts | 1.803 | 1.840 | 0.377 | 0.334 | model line: 48.9% / 50.3% |
| Pitcher outs | 2.873 | 2.898 | 0.258 | 0.257 | model line: 53.5% / 52.9% |
| Pitcher hits allowed | 1.724 | 1.787 | 0.211 | 0.161 | model line: 49.0% / 44.7% |
| Pitcher earned runs | 1.648 | 1.622 | 0.137 | 0.142 | o0.5: 86.8% / 84.5% |

The probabilities are well calibrated for batter props: when the model says 45% for H+R+RBI over 1.5, it happens about 44% of the time. Pitcher strikeouts are the strongest prop. Hits allowed by starters run about 4 points too high.

**Same-game parlays.** The parlay builder's joint probabilities hold up. Across the same 751 games, the model's chance that a combo hits matched how often it really hit. Multiplying the legs as if they were unrelated was badly off:

| Combo | Times tested | Model (joint) | Legs multiplied | Actually hit |
|---|---|---|---|---|
| Teammates batting back to back, both H+R+RBI o1.5 | 12,013 | 25.4% | 22.1% | 25.5% |
| Team ML + one of its 2–4 hitters H+R+RBI o1.5 | 4,506 | 31.1% | 25.5% | 31.7% |
| Team ML + its 2-3-4 hitters all H+R+RBI o1.5 | 1,502 | 13.5% | 6.7% | 15.6% |
| Team ML + opposing starter's strikeouts over | 1,498 | 20.7% | 24.4% | 20.7% |
| Game under 8.5 + NRFI | 751 | 29.7% | 24.7% | 29.3% |

The model is only slightly better than simple baselines on single bets. Baseball is noisy, and closing lines weren't available to compare against here. **Bottom line: it's a sensible simulation, not a proven edge.** Treat a gap between the model and the market as a reason to dig in, not as a bet. The full output is in `backtest/results.md`. To rerun the backtest:

```bash
git clone --depth 1 --filter=blob:none --sparse https://github.com/chadwickbureau/retrosheet data_raw/retrosheet
git -C data_raw/retrosheet sparse-checkout set seasons/2024 seasons/2025
python scripts/export_actuals.py --season 2025 --start 2025-08-04 --end 2025-09-29 --retro-dir data_raw/retrosheet/seasons
for d in 2025-08-04 2025-08-11 2025-08-18 2025-08-25 2025-09-01 2025-09-08 2025-09-15 2025-09-22; do
  python scripts/build_data.py --source retro --season 2025 --asof $d --retro-dir data_raw/retrosheet/seasons --out backtest/model_$d.json
  node scripts/calibrate.js backtest/model_$d.json 2000
done
node scripts/backtest.js backtest/actuals.json backtest/model_*.json
```

## Run locally

```bash
pip install -r requirements.txt
python scripts/build_data.py           # downloads MLB Stats API data into data_raw/, writes site/data/model.json
node scripts/calibrate.js              # tunes hits, runs, home field, steals and pitcher usage
cd site && python -m http.server 8000  # open http://localhost:8000
```

The first build downloads two seasons of games (about 10,000 small requests, several minutes). Later builds only fetch new games. Opening `index.html` straight from disk won't work, because the page has to fetch the JSON file. Use the local server above.

## Deploy on GitHub Pages

1. In the repo, go to **Settings → Pages → Build and deployment → Source** and choose **GitHub Actions**.
2. The workflow in `.github/workflows/update.yml` runs on every push and three times a day: about 9am ET for last night's results and probable pitchers, and 3:40pm and 5:40pm ET for posted lineups. You can also run it on demand from the **Actions** tab. It rebuilds the model and deploys the site to `https://<you>.github.io/<repo>/`. If the MLB Stats API is unreachable, it deploys the model already in the repo.

## Known limitations / ideas

- No pitch-type, velocity or Statcast quality-of-contact data. Hitters' platoon splits are the league's, not individual. There's no team defense or catcher framing, and no weather or wind.
- The bullpen doesn't know who's tired. Uncheck a reliever on the Lineups tab if he's unavailable.
- Pinch-hitters and defensive subs are generic (a random bench bat late in the game), and there's no bunting or intentional walking.
- Pitch locations and ball flight in the replay are illustrative, not tracking data.
- Early in the season, last season carries more weight, and players who changed teams bring their old rates with them.
- Market lines aren't in the data. Type them in on the Projections tab.
- Ideas: pull live prop lines from an odds API, add a slate view for every game of the day, use Statcast batted-ball quality, and track the model's results over the season.

## Data and credits

Live data comes from the public [MLB Stats API](https://statsapi.mlb.com). Historical play-by-play for development and backtests comes from [Retrosheet](https://www.retrosheet.org) via the [Chadwick Bureau mirror](https://github.com/chadwickbureau/retrosheet): *The information used here was obtained free of charge from and is copyrighted by Retrosheet. Interested parties may contact Retrosheet at www.retrosheet.org.* This project isn't affiliated with MLB. It's for entertainment and research.
