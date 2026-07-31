export const seedPlayers = [
  ["demo-rowan-blaze", "Rowan Blaze", "WR", "FA", 56],
  ["demo-marcus-vale", "Marcus Vale", "RB", "FA", 55],
  ["demo-eli-mercer", "Eli Mercer", "WR", "FA", 52],
  ["demo-dante-rivers", "Dante Rivers", "RB", "FA", 51],
  ["demo-owen-cross", "Owen Cross", "RB", "FA", 50],
  ["demo-julian-stone", "Julian Stone", "WR", "FA", 48],
  ["demo-cameron-fox", "Cameron Fox", "WR", "FA", 45],
  ["demo-noah-wilder", "Noah Wilder", "WR", "FA", 42],
  ["demo-miles-hart", "Miles Hart", "RB", "FA", 41],
  ["demo-isaiah-knox", "Isaiah Knox", "RB", "FA", 40],
  ["demo-theo-banks", "Theo Banks", "WR", "FA", 37],
  ["demo-adrian-cole", "Adrian Cole", "WR", "FA", 36],
  ["demo-devin-price", "Devin Price", "RB", "FA", 35],
  ["demo-kai-bishop", "Kai Bishop", "WR", "FA", 34],
  ["demo-leo-porter", "Leo Porter", "RB", "FA", 33],
  ["demo-grant-hayes", "Grant Hayes", "WR", "FA", 32],
  ["demo-silas-reed", "Silas Reed", "RB", "FA", 30],
  ["demo-jace-monroe", "Jace Monroe", "QB", "FA", 29],
  ["demo-roman-brooks", "Roman Brooks", "QB", "FA", 27],
  ["demo-finn-carter", "Finn Carter", "TE", "FA", 26],
  ["demo-andre-lane", "Andre Lane", "QB", "FA", 25],
  ["demo-caleb-north", "Caleb North", "TE", "FA", 23],
  ["demo-nolan-west", "Nolan West", "QB", "FA", 20],
  ["demo-emmett-shaw", "Emmett Shaw", "TE", "FA", 18]
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

export function parseTeamSetupLines(value = "") {
  return String(value)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const separatorIndex = line.indexOf("|");
      if (separatorIndex === -1) return { name: line, manager: "" };
      return {
        name: line.slice(0, separatorIndex).trim(),
        manager: line.slice(separatorIndex + 1).trim()
      };
    });
}

export function makeTeams(count = 8, budget = 200) {
  return Array.from({ length: count }, (_, index) => ({
    id: `team-${index + 1}`,
    name: ["Fourth & Long", "Sunday Scaries", "Gridiron Club", "The Audible", "Red Zone", "Waiver Wire", "Goal Line", "Two Minute Drill"][index] || `Team ${index + 1}`,
    manager: ["Alex", "Jordan", "Sam", "Taylor", "Casey", "Morgan", "Riley", "Jamie"][index] || `Manager ${index + 1}`,
    color: teamPalette[index % teamPalette.length],
    controller: { type: "human", strategy: "balanced", aggressiveness: 1 },
    budget,
    roster: []
  }));
}
