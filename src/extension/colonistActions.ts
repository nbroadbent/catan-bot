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
  DISCARD_CONFIRM: 7, // payload: full array of card ids to discard
  DISCARD_SELECT: 8, // payload: cumulative selection array (one card added each time)
  BUY_DEV: 9, // payload: true — buy a development card
  // Each build is [intent, place] as consecutive codes: road 10/11,
  // settlement 14/15, city 17/18. Settlement and city intents are confirmed
  // from captures; ROAD_INTENT (10) is inferred from that pattern (no normal
  // paid road appears in any capture yet) — it fails safe if wrong.
  BUILD_ROAD_INTENT: 10, // payload: true — enter build-road mode (main game, INFERRED)
  BUILD_ROAD: 11, // payload: edge index
  BUILD_SETTLEMENT_INTENT: 14, // payload: true — enter build-settlement mode (main game)
  BUILD_SETTLEMENT: 15, // payload: corner index
  BUILD_CITY_INTENT: 17, // payload: true — enter build-city mode (main game)
  BUILD_CITY: 18, // payload: corner index of the settlement to upgrade
  PLAY_DEV: 48, // payload: dev-card type id (e.g. 13 = monopoly, 11 = road building)
  CREATE_TRADE: 49, // payload: { creator, isBankTrade, offeredResources[], wantedResources[] }
  PRESELECT: 66, // payload: corner/edge index (UI hover) or null to clear
} as const;

/** dev-card type ids (from captures) */
export const DEV_CARD = { MONOPOLY: 13 } as const;

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

/** Place a SETUP road (free): the hover-then-place gesture. */
export function roadActions(edgeIndex: number): ColonistAction[] {
  return [
    { action: ACTION.PRESELECT, payload: edgeIndex },
    { action: ACTION.PRESELECT, payload: null },
    { action: ACTION.BUILD_ROAD, payload: edgeIndex },
  ];
}

/**
 * Build a road during the MAIN game: enter build-road mode (intent) then place
 * at the edge, mirroring settlement (14→15) and city (17→18). The intent code
 * (10) is inferred from that pattern — if colonist rejects it the road simply
 * won't build (no worse than before), and a capture of a paid road confirms it.
 */
export function buildRoadActions(edgeIndex: number): ColonistAction[] {
  return [
    { action: ACTION.BUILD_ROAD_INTENT, payload: true },
    { action: ACTION.BUILD_ROAD, payload: edgeIndex },
  ];
}

/** Build a city: enter build-city mode, then upgrade the settlement at corner. */
export function buildCityActions(cornerIndex: number): ColonistAction[] {
  return [
    { action: ACTION.BUILD_CITY_INTENT, payload: true },
    { action: ACTION.BUILD_CITY, payload: cornerIndex },
  ];
}

/**
 * Play a monopoly: play the card (action 48 = play dev, id 13), then select
 * and confirm the resource to steal from everyone (action 8 select, action 7
 * confirm — the same pattern as discards). `resourceId` is 1-5.
 */
export function monopolyActions(resourceId: number): ColonistAction[] {
  return [
    { action: ACTION.PLAY_DEV, payload: DEV_CARD.MONOPOLY },
    { action: ACTION.DISCARD_SELECT, payload: [resourceId] },
    { action: ACTION.DISCARD_CONFIRM, payload: [resourceId] },
  ];
}

/**
 * Bank/port trade: give `giveCount` cards of `giveId` for one `getId`. Format
 * from a captured bank trade: action 49 with isBankTrade true and the offered
 * cards repeated to match the ratio.
 */
export function bankTradeActions(
  myColor: number,
  giveId: number,
  giveCount: number,
  getId: number,
): ColonistAction[] {
  return [
    {
      action: ACTION.CREATE_TRADE,
      payload: {
        creator: myColor,
        isBankTrade: true,
        counterOfferInResponseToTradeId: null,
        offeredResources: Array.from({ length: giveCount }, () => giveId),
        wantedResources: [getId],
      },
    },
  ];
}

/** Move the robber to a tile, then (optionally) steal from a victim color. */
export function robberActions(tileIndex: number, victimColor: number | null): ColonistAction[] {
  const out: ColonistAction[] = [{ action: ACTION.MOVE_ROBBER, payload: tileIndex }];
  if (victimColor !== null) out.push({ action: ACTION.STEAL, payload: victimColor });
  return out;
}

/**
 * Discard cards after a 7. Mirrors the client: select each card in turn with a
 * cumulative array (action 8), then confirm the full list (action 7).
 * cardIds are colonist resource ids (1-5 = wood/brick/sheep/wheat/ore).
 */
export function discardActions(cardIds: number[]): ColonistAction[] {
  if (cardIds.length === 0) return [];
  const out: ColonistAction[] = [];
  for (let i = 1; i <= cardIds.length; i++) {
    out.push({ action: ACTION.DISCARD_SELECT, payload: cardIds.slice(0, i) });
  }
  out.push({ action: ACTION.DISCARD_CONFIRM, payload: cardIds.slice() });
  return out;
}
