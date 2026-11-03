Games: 751 (2025-08-04 to 2025-09-28)
Winner: model picked the winner 55.4% · Brier 0.2443 vs 0.2492 for a flat 53.5% home · log loss 0.6817 vs 0.6916
Home win calibration: 0-45%: pred 42.9 / act 41.3 (n=46) · 45-50%: pred 47.8 / act 46.4 (n=153) · 50-55%: pred 52.5 / act 50.2 (n=287) · 55-60%: pred 57.2 / act 58.9 (n=190) · 60-65%: pred 62.0 / act 66.7 (n=63) · 65-100%: pred 67.4 / act 75.0 (n=12)
Total runs: MAE 3.51 vs 3.53 for the league average · mean 8.92 (actual 9.07) · corr 0.104
NRFI: Brier 0.2504 vs 0.2506 league rate · predicted 49.5% / actual 46.2%

| Stat | n | Model MAE | Season-avg MAE | Model corr | Season-avg corr | Over line: pred / actual |
|---|---|---|---|---|---|---|
| Batter H+R+RBI | 12967 | 1.519 | 1.529 | 0.141 | 0.116 | o1.5: 46.8% / 46.6% |
| Batter hits | 12967 | 0.682 | 0.688 | 0.123 | 0.107 | o0.5: 61.6% / 61.4% |
| Batter total bases | 12967 | 1.365 | 1.382 | 0.124 | 0.111 | o1.5: 35.8% / 36.0% |
| Batter HR | 12967 | 0.224 | 0.226 | 0.132 | 0.137 | o0.5: 11.9% / 12.5% |
| Batter runs | 12967 | 0.581 | 0.582 | 0.155 | 0.113 | o0.5: 38.9% / 38.4% |
| Batter RBI | 12967 | 0.639 | 0.638 | 0.113 | 0.097 | o0.5: 30.4% / 30.1% |
| Batter walks | 12967 | 0.465 | 0.461 | 0.197 | 0.190 | o0.5: 29.4% / 28.3% |
| Batter strikeouts | 12967 | 0.667 | 0.674 | 0.256 | 0.233 | o0.5: 63.1% / 63.0% |
| Pitcher strikeouts | 1313 | 1.801 | 1.840 | 0.380 | 0.334 | omodel line: 49.0% / 51.0% |
| Pitcher outs | 1313 | 2.873 | 2.898 | 0.272 | 0.257 | omodel line: 53.5% / 53.9% |
| Pitcher earned runs | 1313 | 1.644 | 1.622 | 0.145 | 0.142 | o0.5: 86.4% / 84.5% |
| Pitcher hits allowed | 1313 | 1.719 | 1.787 | 0.214 | 0.161 | omodel line: 48.8% / 45.9% |
| Pitcher walks | 1313 | 0.984 | 0.988 | 0.226 | 0.214 | o0.5: 83.8% / 82.3% |
Batter H+R+RBI over-line calibration: 30-40%: 38.0/37.3 (n=1776) · 40-50%: 45.0/44.2 (n=7606) · 50-60%: 53.2/53.8 (n=4075) · 60-70%: 61.0/56.1 (n=57)
Batter hits over-line calibration: 40-50%: 48.8/43.2 (n=37) · 50-60%: 56.3/55.5 (n=5284) · 60-70%: 64.5/64.3 (n=7803) · 70-100%: 71.0/71.4 (n=391)
Pitcher strikeouts over-line calibration: 30-40%: 38.2/43.0 (n=107) · 40-50%: 45.2/48.8 (n=703) · 50-60%: 54.3/55.1 (n=671)

Same-game parlays (does the joint probability hold up?)

| Combo | n | Model joint | Legs multiplied | Actually hit | Brier: joint / multiplied |
|---|---|---|---|---|---|
| Teammates batting back to back, both H+R+RBI o1.5 | 12013 | 25.4% | 22.0% | 25.5% | 0.1867 / 0.1880 |
| Team ML + one of its 2-4 hitters H+R+RBI o1.5 | 4506 | 31.1% | 25.5% | 31.7% | 0.2138 / 0.2176 |
| Team ML + its 2-3-4 hitters all H+R+RBI o1.5 (4 legs) | 1502 | 13.4% | 6.7% | 15.6% | 0.1312 / 0.1391 |
| Team ML + opposing starter's K over | 1498 | 20.8% | 24.4% | 22.0% | 0.1707 / 0.1715 |
| Game under 8.5 + NRFI | 751 | 29.8% | 24.8% | 29.3% | 0.2064 / 0.2084 |
