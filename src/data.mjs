export const seedPlayers = [
  ["puka-nacua", "Puka Nacua", "WR", "LAR", 42],
  ["ja-marr-chase", "Ja'Marr Chase", "WR", "CIN", 56],
  ["bijan-robinson", "Bijan Robinson", "RB", "ATL", 55],
  ["saquon-barkley", "Saquon Barkley", "RB", "PHI", 51],
  ["justin-jefferson", "Justin Jefferson", "WR", "MIN", 52],
  ["ceedee-lamb", "CeeDee Lamb", "WR", "DAL", 48],
  ["jahmyr-gibbs", "Jahmyr Gibbs", "RB", "DET", 50],
  ["amon-ra-st-brown", "Amon-Ra St. Brown", "WR", "DET", 45],
  ["breece-hall", "Breece Hall", "RB", "NYJ", 40],
  ["nico-collins", "Nico Collins", "WR", "HOU", 37],
  ["josh-allen", "Josh Allen", "QB", "BUF", 29],
  ["lamar-jackson", "Lamar Jackson", "QB", "BAL", 27],
  ["jalen-hurts", "Jalen Hurts", "QB", "PHI", 25],
  ["brock-bowers", "Brock Bowers", "TE", "LV", 26],
  ["trey-mcbride", "Trey McBride", "TE", "ARI", 23],
  ["drake-london", "Drake London", "WR", "ATL", 34],
  ["malik-nabers", "Malik Nabers", "WR", "NYG", 41],
  ["derrick-henry", "Derrick Henry", "RB", "BAL", 35],
  ["devon-achane", "De'Von Achane", "RB", "MIA", 33],
  ["aj-brown", "A.J. Brown", "WR", "PHI", 36],
  ["george-kittle", "George Kittle", "TE", "SF", 18],
  ["patrick-mahomes", "Patrick Mahomes", "QB", "KC", 20],
  ["chase-brown", "Chase Brown", "RB", "CIN", 30],
  ["ladd-mcconkey", "Ladd McConkey", "WR", "LAC", 32]
].map(([id, name, position, nflTeam, suggestedValue]) => ({
  id,
  name,
  position,
  nflTeam,
  suggestedValue,
  status: "available"
}));

export const teamPalette = [
  "#f05d23",
  "#5b8def",
  "#58b487",
  "#b881e8",
  "#e3b341",
  "#e36d8f",
  "#40aeb8",
  "#9eaa55",
  "#df7955",
  "#7891cb",
  "#57a671",
  "#ae73bd"
];

export function makeTeams(count = 8, budget = 200) {
  return Array.from({ length: count }, (_, index) => ({
    id: `team-${index + 1}`,
    name: ["Fourth & Long", "Sunday Scaries", "Gridiron Club", "The Audible", "Red Zone", "Waiver Wire", "Goal Line", "Two Minute Drill"][index] || `Team ${index + 1}`,
    manager: ["Alex", "Jordan", "Sam", "Taylor", "Casey", "Morgan", "Riley", "Jamie"][index] || `Manager ${index + 1}`,
    color: teamPalette[index % teamPalette.length],
    budget,
    roster: []
  }));
}
