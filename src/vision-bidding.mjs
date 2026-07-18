export const VISUAL_BID_WINDOW_MS = 300;
export const VISION_SCAN_PROFILES = Object.freeze({
  normal: Object.freeze({ key: "normal", width: 640, fps: 8 }),
  far: Object.freeze({ key: "far", width: 1024, fps: 5 })
});

export function visionScanProfile(farRoomEnabled = false) {
  return farRoomEnabled ? VISION_SCAN_PROFILES.far : VISION_SCAN_PROFILES.normal;
}

export function teamForMarkerId(teams, markerId) {
  const id = Number(markerId);
  if (!Number.isInteger(id) || id < 0 || id >= teams.length) return null;
  return teams[id] || null;
}

export function markerIdForTeam(teams, teamId) {
  const index = teams.findIndex((team) => team.id === teamId);
  return index >= 0 ? index : null;
}

export function nextVisualBidAmount(state) {
  return Math.max(1, state.auction.amount + state.config.increment);
}

export function classifyVisualBidBatch(teamIds) {
  const uniqueTeamIds = [...new Set(teamIds.filter(Boolean))];
  if (!uniqueTeamIds.length) return { kind: "none", teamIds: [] };
  if (uniqueTeamIds.length === 1) return { kind: "bid", teamIds: uniqueTeamIds, teamId: uniqueTeamIds[0] };
  return { kind: "tie", teamIds: uniqueTeamIds };
}

export function bidsShareWindow(firstReceivedAt, nextReceivedAt, windowMs = VISUAL_BID_WINDOW_MS) {
  const first = Number(firstReceivedAt);
  const next = Number(nextReceivedAt);
  return Number.isFinite(first)
    && Number.isFinite(next)
    && next >= first
    && next - first <= windowMs;
}

export class MarkerRaiseLatch {
  constructor({ stableMs = 90, releaseMs = 550 } = {}) {
    this.stableMs = stableMs;
    this.releaseMs = releaseMs;
    this.records = new Map();
  }

  update(markerIds, now = performance.now()) {
    const visible = new Set(
      markerIds
        .map(Number)
        .filter((id) => Number.isInteger(id) && id >= 0)
    );
    const raised = [];

    for (const id of visible) {
      let record = this.records.get(id);
      if (!record || now - record.lastSeen >= this.releaseMs) {
        record = { firstSeen: now, lastSeen: now, latched: false };
        this.records.set(id, record);
      } else {
        record.lastSeen = now;
      }

      if (!record.latched && now - record.firstSeen >= this.stableMs) {
        record.latched = true;
        raised.push(id);
      }
    }

    for (const [id, record] of this.records) {
      if (!visible.has(id) && now - record.lastSeen >= this.releaseMs) {
        this.records.delete(id);
      }
    }

    return raised;
  }

  reset() {
    this.records.clear();
  }
}
