/**
 * Rush mode detection + preference. Rush is colonist's real-time variant: no
 * turns, the dice roll on a timer for everyone, and players build whenever
 * they can afford to. Everything here is kept apart from the turn-based
 * autopilot so Rush can never change how 1v1 / 4-player games are played.
 */

/**
 * Known gameSettings.modeSetting values that mean Rush. Every capture so far
 * is a normal game (modeSetting 0); add Rush's value here once a Rush game
 * has been captured (the overlay shows the live value next to the toggle).
 */
export const RUSH_MODE_SETTINGS: ReadonlySet<number> = new Set<number>([]);

const PREF_KEY = "catanCopilot:rushMode";

export type RushPref = "auto" | "on" | "off";

export function loadRushPref(): RushPref {
  try {
    const v = localStorage.getItem(PREF_KEY);
    return v === "on" || v === "off" ? v : "auto";
  } catch {
    return "auto";
  }
}

export function saveRushPref(pref: RushPref): void {
  try {
    localStorage.setItem(PREF_KEY, pref);
  } catch {
    /* storage unavailable — session-only */
  }
}

/** Is this game Rush? A manual on/off wins; "auto" trusts the settings. */
export function isRushMode(modeSetting: number | null, pref: RushPref): boolean {
  if (pref === "on") return true;
  if (pref === "off") return false;
  return modeSetting !== null && RUSH_MODE_SETTINGS.has(modeSetting);
}
