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
