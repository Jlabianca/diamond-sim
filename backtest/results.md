Games: 751 (2025-08-04 to 2025-09-28)
Winner: model picked the winner 56.1% · Brier 0.2436 vs 0.2492 for a flat 53.5% home · log loss 0.6801 vs 0.6916
Home win calibration: 0-45%: pred 42.7 / act 43.6 (n=55) · 45-50%: pred 47.8 / act 44.6 (n=166) · 50-55%: pred 52.5 / act 50.7 (n=268) · 55-60%: pred 57.1 / act 60.7 (n=196) · 60-65%: pred 61.9 / act 62.7 (n=51) · 65-100%: pred 66.8 / act 80.0 (n=15)
Total runs: MAE 3.52 vs 3.53 for the league average · mean 8.94 (actual 9.07) · corr 0.095
NRFI: Brier 0.2501 vs 0.2506 league rate · predicted 49.5% / actual 46.2%

| Stat | n | Model MAE | Season-avg MAE | Model corr | Season-avg corr | Over line: pred / actual |
|---|---|---|---|---|---|---|
| Batter H+R+RBI | 12967 | 1.520 | 1.529 | 0.137 | 0.116 | o1.5: 46.9% / 46.6% |
| Batter hits | 12967 | 0.682 | 0.688 | 0.121 | 0.107 | o0.5: 61.7% / 61.4% |
| Batter total bases | 12967 | 1.366 | 1.382 | 0.122 | 0.111 | o1.5: 35.9% / 36.0% |
| Batter HR | 12967 | 0.225 | 0.226 | 0.132 | 0.137 | o0.5: 11.9% / 12.5% |
| Batter runs | 12967 | 0.582 | 0.582 | 0.150 | 0.113 | o0.5: 38.9% / 38.4% |
| Batter RBI | 12967 | 0.640 | 0.638 | 0.110 | 0.097 | o0.5: 30.4% / 30.1% |
| Batter walks | 12967 | 0.465 | 0.461 | 0.195 | 0.190 | o0.5: 29.4% / 28.3% |
| Batter strikeouts | 12967 | 0.667 | 0.674 | 0.257 | 0.233 | o0.5: 63.1% / 63.0% |
| Pitcher strikeouts | 1313 | 1.799 | 1.840 | 0.381 | 0.334 | omodel line: 48.9% / 50.1% |
| Pitcher outs | 1313 | 2.870 | 2.898 | 0.260 | 0.257 | omodel line: 53.5% / 52.5% |
| Pitcher earned runs | 1313 | 1.647 | 1.622 | 0.142 | 0.142 | o0.5: 86.8% / 84.5% |
| Pitcher hits allowed | 1313 | 1.722 | 1.787 | 0.214 | 0.161 | omodel line: 49.0% / 44.6% |
| Pitcher walks | 1313 | 0.985 | 0.988 | 0.227 | 0.214 | o0.5: 84.2% / 82.3% |
Batter H+R+RBI over-line calibration: 30-40%: 38.1/37.4 (n=1758) · 40-50%: 45.0/43.8 (n=7538) · 50-60%: 53.2/54.1 (n=4152) · 60-70%: 61.1/59.1 (n=66)
Batter hits over-line calibration: 40-50%: 49.3/40.0 (n=45) · 50-60%: 56.4/55.8 (n=5224) · 60-70%: 64.6/64.1 (n=7846) · 70-100%: 71.0/70.5 (n=400)
Pitcher strikeouts over-line calibration: 30-40%: 38.5/37.9 (n=87) · 40-50%: 45.1/47.1 (n=736) · 50-60%: 54.3/53.0 (n=679)

Same-game parlays (does the joint probability hold up?)

| Combo | n | Model joint | Legs multiplied | Actually hit | Brier: joint / multiplied |
|---|---|---|---|---|---|
| Teammates batting back to back, both H+R+RBI o1.5 | 12013 | 25.4% | 22.1% | 25.5% | 0.1868 / 0.1880 |
| Team ML + one of its 2-4 hitters H+R+RBI o1.5 | 4506 | 31.1% | 25.5% | 31.7% | 0.2137 / 0.2174 |
| Team ML + its 2-3-4 hitters all H+R+RBI o1.5 (4 legs) | 1502 | 13.5% | 6.7% | 15.6% | 0.1315 / 0.1391 |
| Team ML + opposing starter's K over | 1498 | 20.7% | 24.4% | 20.7% | 0.1627 / 0.1642 |
| Game under 8.5 + NRFI | 751 | 29.7% | 24.7% | 29.3% | 0.2065 / 0.2084 |
