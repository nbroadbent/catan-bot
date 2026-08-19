/**
 * Colonist.io outbound action codes, reverse-engineered by correlating raw
 * outbound frames with the resulting inbound state diffs (see the capture in
 * .context). Each game action is msgpack `{ action, payload, sequence }` inside
 * the envelope `[0x03, 0x01, serverIdLen, ...serverId, ...msgpack]`.
 *
 * sequence is a single per-client counter that increments by 1 on every
 * outbound game frame; inject.ts owns it (tracks the max seen, sends max+1).
 */
export const ACTION = {
  ROLL: 2, // payload: true
  MOVE_ROBBER: 3, // payload: tile (hex) index
  STEAL: 5, // payload: victim color id
  END_TURN: 6, // payload: true
  BUY_DEV: 9, // payload: true — buy a development card
  BUILD_ROAD: 11, // payload: edge index
  BUILD_SETTLEMENT_INTENT: 14, // payload: true — enter build-settlement mode (main game)
  BUILD_SETTLEMENT: 15, // payload: corner index
  PRESELECT: 66, // payload: corner/edge index (UI hover) or null to clear
} as const;

export interface ColonistAction {
  action: number;
  payload: unknown;
}

/** Roll the dice. */
export function rollAction(): ColonistAction[] {
  return [{ action: ACTION.ROLL, payload: true }];
}

/** End the turn. */
export function endTurnAction(): ColonistAction[] {
  return [{ action: ACTION.END_TURN, payload: true }];
}

/** Buy a development card. */
export function buyDevAction(): ColonistAction[] {
  return [{ action: ACTION.BUY_DEV, payload: true }];
}

/**
 * Place a SETUP settlement (free, forced-placement phase): the client's real
 * gesture is hover the corner, clear the hover, then place.
 */
export function settlementActions(cornerIndex: number): ColonistAction[] {
  return [
    { action: ACTION.PRESELECT, payload: cornerIndex },
    { action: ACTION.PRESELECT, payload: null },
    { action: ACTION.BUILD_SETTLEMENT, payload: cornerIndex },
  ];
}

/**
 * Build a settlement during the MAIN game. Unlike setup, you must first enter
 * build-settlement mode (action 14) — which also pays the cost — and then
 * place at the corner (action 15). Skipping the intent is why mid-game
 * settlements silently failed.
 */
export function buildSettlementActions(cornerIndex: number): ColonistAction[] {
  return [
    { action: ACTION.BUILD_SETTLEMENT_INTENT, payload: true },
    { action: ACTION.BUILD_SETTLEMENT, payload: cornerIndex },
  ];
}

/** Place a road at an edge index (same hover-then-place gesture). */
export function roadActions(edgeIndex: number): ColonistAction[] {
  return [
    { action: ACTION.PRESELECT, payload: edgeIndex },
    { action: ACTION.PRESELECT, payload: null },
    { action: ACTION.BUILD_ROAD, payload: edgeIndex },
  ];
}

/** Move the robber to a tile, then (optionally) steal from a victim color. */
export function robberActions(tileIndex: number, victimColor: number | null): ColonistAction[] {
  const out: ColonistAction[] = [{ action: ACTION.MOVE_ROBBER, payload: tileIndex }];
  if (victimColor !== null) out.push({ action: ACTION.STEAL, payload: victimColor });
  return out;
}
