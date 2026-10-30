"""The 30 MLB clubs: our abbreviation, MLB Stats API team id, Retrosheet code(s), name and colors."""

TEAMS = [
    # abbr, mlbam id, retrosheet codes, name, primary, secondary
    ("ARI", 109, ["ARI"], "Arizona Diamondbacks", "#A71930", "#E3D4AD"),
    ("ATH", 133, ["ATH", "OAK"], "Athletics", "#003831", "#EFB21E"),
    ("ATL", 144, ["ATL"], "Atlanta Braves", "#CE1141", "#13274F"),
    ("BAL", 110, ["BAL"], "Baltimore Orioles", "#DF4601", "#000000"),
    ("BOS", 111, ["BOS"], "Boston Red Sox", "#BD3039", "#0C2340"),
    ("CHC", 112, ["CHN"], "Chicago Cubs", "#0E3386", "#CC3433"),
    ("CWS", 145, ["CHA"], "Chicago White Sox", "#27251F", "#C4CED4"),
    ("CIN", 113, ["CIN"], "Cincinnati Reds", "#C6011F", "#000000"),
    ("CLE", 114, ["CLE"], "Cleveland Guardians", "#00385D", "#E50022"),
    ("COL", 115, ["COL"], "Colorado Rockies", "#333366", "#C4CED4"),
    ("DET", 116, ["DET"], "Detroit Tigers", "#0C2340", "#FA4616"),
    ("HOU", 117, ["HOU"], "Houston Astros", "#002D62", "#EB6E1F"),
    ("KC", 118, ["KCA"], "Kansas City Royals", "#004687", "#BD9B60"),
    ("LAA", 108, ["ANA"], "Los Angeles Angels", "#BA0021", "#003263"),
    ("LAD", 119, ["LAN"], "Los Angeles Dodgers", "#005A9C", "#EF3E42"),
    ("MIA", 146, ["MIA"], "Miami Marlins", "#00A3E0", "#EF3340"),
    ("MIL", 158, ["MIL"], "Milwaukee Brewers", "#12284B", "#FFC52F"),
    ("MIN", 142, ["MIN"], "Minnesota Twins", "#002B5C", "#D31145"),
    ("NYM", 121, ["NYN"], "New York Mets", "#002D72", "#FF5910"),
    ("NYY", 147, ["NYA"], "New York Yankees", "#0C2340", "#C4CED3"),
    ("PHI", 143, ["PHI"], "Philadelphia Phillies", "#E81828", "#002D72"),
    ("PIT", 134, ["PIT"], "Pittsburgh Pirates", "#27251F", "#FDB827"),
    ("SD", 135, ["SDN"], "San Diego Padres", "#2F241D", "#FFC425"),
    ("SF", 137, ["SFN"], "San Francisco Giants", "#FD5A1E", "#27251F"),
    ("SEA", 136, ["SEA"], "Seattle Mariners", "#0C2C56", "#005C5C"),
    ("STL", 138, ["SLN"], "St. Louis Cardinals", "#C41E3A", "#0C2340"),
    ("TB", 139, ["TBA"], "Tampa Bay Rays", "#092C5C", "#8FBCE6"),
    ("TEX", 140, ["TEX"], "Texas Rangers", "#003278", "#C0111F"),
    ("TOR", 141, ["TOR"], "Toronto Blue Jays", "#134A8E", "#E8291C"),
    ("WSH", 120, ["WAS"], "Washington Nationals", "#AB0003", "#14225A"),
]

BY_ABBR = {t[0]: t for t in TEAMS}
BY_MLBAM = {t[1]: t[0] for t in TEAMS}
BY_RETRO = {code: t[0] for t in TEAMS for code in t[2]}
