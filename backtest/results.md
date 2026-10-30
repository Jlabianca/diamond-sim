Games: 751 (2025-08-04 to 2025-09-28)
Winner: model picked the winner 55.4% · Brier 0.2441 vs 0.2492 for a flat 53.5% home · log loss 0.6812 vs 0.6916
Home win calibration: 0-45%: pred 42.8 / act 40.6 (n=64) · 45-50%: pred 48.0 / act 47.4 (n=156) · 50-55%: pred 52.5 / act 50.4 (n=262) · 55-60%: pred 57.1 / act 59.5 (n=200) · 60-65%: pred 61.9 / act 62.7 (n=51) · 65-100%: pred 66.8 / act 77.8 (n=18)
Total runs: MAE 3.51 vs 3.53 for the league average · mean 8.95 (actual 9.07) · corr 0.103
NRFI: Brier 0.2496 vs 0.2506 league rate · predicted 48.8% / actual 46.2%

| Stat | n | Model MAE | Season-avg MAE | Model corr | Season-avg corr | Over line: pred / actual |
|---|---|---|---|---|---|---|
| Batter H+R+RBI | 12967 | 1.520 | 1.529 | 0.137 | 0.116 | o1.5: 46.9% / 46.6% |
| Batter hits | 12967 | 0.682 | 0.688 | 0.119 | 0.107 | o0.5: 61.7% / 61.4% |
| Batter total bases | 12967 | 1.366 | 1.382 | 0.121 | 0.111 | o1.5: 35.9% / 36.0% |
| Batter HR | 12967 | 0.225 | 0.226 | 0.130 | 0.137 | o0.5: 11.9% / 12.5% |
| Batter runs | 12967 | 0.582 | 0.582 | 0.148 | 0.113 | o0.5: 39.0% / 38.4% |
| Batter RBI | 12967 | 0.639 | 0.638 | 0.110 | 0.097 | o0.5: 30.5% / 30.1% |
| Batter walks | 12967 | 0.465 | 0.461 | 0.193 | 0.190 | o0.5: 29.4% / 28.3% |
| Batter strikeouts | 12967 | 0.667 | 0.674 | 0.256 | 0.233 | o0.5: 63.1% / 63.0% |
| Pitcher strikeouts | 1313 | 1.803 | 1.840 | 0.377 | 0.334 | omodel line: 48.9% / 50.3% |
| Pitcher outs | 1313 | 2.873 | 2.898 | 0.258 | 0.257 | omodel line: 53.5% / 52.9% |
| Pitcher earned runs | 1313 | 1.648 | 1.622 | 0.137 | 0.142 | o0.5: 86.8% / 84.5% |
| Pitcher hits allowed | 1313 | 1.724 | 1.787 | 0.211 | 0.161 | omodel line: 49.0% / 44.7% |
| Pitcher walks | 1313 | 0.986 | 0.988 | 0.223 | 0.214 | o0.5: 84.1% / 82.3% |
Batter H+R+RBI over-line calibration: 30-40%: 37.8/37.3 (n=1819) · 40-50%: 45.0/44.0 (n=7373) · 50-60%: 53.3/53.7 (n=4241) · 60-70%: 61.5/56.3 (n=80)
Batter hits over-line calibration: 40-50%: 48.9/35.7 (n=70) · 50-60%: 56.3/56.0 (n=5184) · 60-70%: 64.6/64.1 (n=7767) · 70-100%: 71.2/68.6 (n=494)
Pitcher strikeouts over-line calibration: 30-40%: 38.3/40.4 (n=94) · 40-50%: 45.2/47.5 (n=731) · 50-60%: 54.2/52.9 (n=673)
