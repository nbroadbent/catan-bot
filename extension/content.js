var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
(function() {
  "use strict";
  const ALT_TO_RESOURCE = {
    grain: "wheat",
    wool: "sheep",
    lumber: "wood",
    brick: "brick",
    ore: "ore"
  };
  const RESOURCE_IMG_SELECTOR = Object.keys(ALT_TO_RESOURCE).flatMap((a) => [`img[alt="${a}"]`, `img[alt="${cap$1(a)}"]`]).join(", ");
  function cap$1(s) {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  function resourceFromAlt(alt) {
    if (!alt) return null;
    return ALT_TO_RESOURCE[alt.toLowerCase()] ?? null;
  }
  function getPlayerName(el) {
    var _a;
    const span = el.querySelector(
      'span[style*="font-weight:600"], span[style*="font-weight: 600"]'
    );
    return ((_a = span == null ? void 0 : span.textContent) == null ? void 0 : _a.trim()) || null;
  }
  function getPlayerColor(el) {
    const span = el.querySelector(
      'span[style*="font-weight:600"], span[style*="font-weight: 600"]'
    );
    return (span == null ? void 0 : span.style.color) || "#888";
  }
  function getSecondPlayerName(el) {
    var _a;
    const spans = el.querySelectorAll(
      'span[style*="font-weight:600"], span[style*="font-weight: 600"]'
    );
    return spans.length > 1 ? ((_a = spans[1].textContent) == null ? void 0 : _a.trim()) || null : null;
  }
  function countResources(root) {
    const out = {};
    root.querySelectorAll(RESOURCE_IMG_SELECTOR).forEach((img) => {
      const res = resourceFromAlt(img.getAttribute("alt"));
      if (res) out[res] = (out[res] ?? 0) + 1;
    });
    return out;
  }
  function countAroundMarker(el, marker) {
    const html = el.innerHTML;
    const idx = html.indexOf(marker);
    if (idx === -1) return null;
    const mk = (fragment) => {
      const div = el.ownerDocument.createElement("div");
      div.innerHTML = fragment;
      return countResources(div);
    };
    return { before: mk(html.slice(0, idx)), after: mk(html.slice(idx + marker.length)) };
  }
  function sum(d) {
    return Object.values(d).reduce((s, n) => s + (n ?? 0), 0);
  }
  function negate(d) {
    const out = {};
    for (const [k, v] of Object.entries(d)) out[k] = -(v ?? 0);
    return out;
  }
  function merge(a, b) {
    const out = { ...a };
    for (const [k, v] of Object.entries(b)) {
      out[k] = (out[k] ?? 0) + (v ?? 0);
    }
    return out;
  }
  function hasImg(el, names) {
    return names.some(
      (n) => el.querySelector(`img[alt="${n}"], img[alt="${cap$1(n)}"]`)
    );
  }
  function parseLogRow(el) {
    var _a;
    const text = ((_a = el.textContent) == null ? void 0 : _a.replace(/\s+/g, " ").trim()) || "";
    const player = getPlayerName(el);
    if (!text || text.includes("has disconnected") || text.includes("has reconnected") || text.includes("will take over") || text.includes("left the game") || text.includes("Learn how to play") || el.querySelector("hr")) {
      return { type: "ignored" };
    }
    if (text.includes("won the game")) {
      return { type: "game-over", winner: player };
    }
    if (text.includes("rolled")) {
      const dice = el.querySelectorAll('img[alt^="dice_"]');
      if (dice.length === 2 && player) {
        const total = parseInt(dice[0].getAttribute("alt").replace("dice_", ""), 10) + parseInt(dice[1].getAttribute("alt").replace("dice_", ""), 10);
        return { type: "roll", player, total };
      }
      return { type: "ignored" };
    }
    if (text.includes("blocked by the Robber")) {
      const probImg = el.querySelector('img[alt^="prob_"]');
      const tileImg = el.querySelector('img[alt$=" tile"]');
      const total = probImg ? parseInt(probImg.getAttribute("alt").replace("prob_", ""), 10) : NaN;
      const res = tileImg ? resourceFromAlt(tileImg.getAttribute("alt").replace(" tile", "")) : null;
      if (!Number.isNaN(total) && res) return { type: "blocked-roll", total, resource: res };
      return { type: "ignored" };
    }
    if (text.includes("received starting resources") && player) {
      return { type: "starting-resources", player, resources: countResources(el) };
    }
    if (text.includes("placed a") && player) {
      if (hasImg(el, ["settlement"])) {
        return { type: "place", player, color: getPlayerColor(el), what: "settlement" };
      }
      if (hasImg(el, ["road"])) {
        return { type: "place", player, color: getPlayerColor(el), what: "road" };
      }
      if (hasImg(el, ["city"])) {
        return { type: "place", player, color: getPlayerColor(el), what: "city" };
      }
    }
    if (text.includes("built a") && player) {
      if (hasImg(el, ["settlement"])) return { type: "build", player, what: "settlement" };
      if (hasImg(el, ["city"])) return { type: "build", player, what: "city" };
      if (hasImg(el, ["road"])) return { type: "build", player, what: "road" };
    }
    if (text.includes("bought") && el.querySelector(
      'img[alt="development card"], img[alt="Development card"], img[alt="Development Card"]'
    ) && player) {
      return { type: "buy-dev", player };
    }
    if (text.includes("gave bank") && text.includes("took") && player) {
      const parts = countAroundMarker(el, " and took ");
      if (parts) {
        return {
          type: "bank-trade",
          player,
          delta: merge(negate(parts.before), parts.after),
          gave: sum(parts.before),
          took: sum(parts.after)
        };
      }
    }
    if (text.includes("gave") && text.includes("got") && text.includes("from")) {
      const html = el.innerHTML;
      const gotIdx = html.indexOf(" and got ");
      const fromIdx = html.lastIndexOf(" from ");
      if (gotIdx !== -1 && fromIdx > gotIdx && player) {
        const mk = (fragment) => {
          const div = el.ownerDocument.createElement("div");
          div.innerHTML = fragment;
          return countResources(div);
        };
        const gave = mk(html.slice(0, gotIdx));
        const got = mk(html.slice(gotIdx + " and got ".length, fromIdx));
        return {
          type: "player-trade",
          player,
          partner: getSecondPlayerName(el),
          delta: merge(negate(gave), got)
        };
      }
    }
    if (/stole \d+/.test(text) && player) {
      const res = countResources(el);
      const kind = Object.keys(res)[0];
      const m = text.match(/stole (\d+)/);
      if (kind && m) {
        return { type: "monopoly-steal", player, resource: kind, count: parseInt(m[1], 10) };
      }
    }
    if (text.includes("stole") && text.includes("from")) {
      const res = countResources(el);
      const kind = Object.keys(res)[0] ?? null;
      const isYouThief = /^You stole/i.test(text);
      const isYouVictim = / from you/i.test(text);
      const first = player;
      const second = getSecondPlayerName(el);
      const thief = isYouThief ? null : first;
      const victim = isYouVictim ? null : isYouThief ? first : second;
      if (kind) return { type: "steal-known", thief, victim, resource: kind };
      return { type: "steal-unknown", thief, victim };
    }
    if (text.includes("took from bank") && player) {
      return { type: "take-from-bank", player, resources: countResources(el) };
    }
    if (text.includes("discarded") && player) {
      return { type: "discard", player, resources: countResources(el) };
    }
    if (text.includes("used") && player) {
      if (text.includes("Knight")) return { type: "use-knight", player };
      if (text.includes("Year of Plenty")) return { type: "use-dev", player, card: "year-of-plenty" };
      if (text.includes("Road Building")) return { type: "use-dev", player, card: "road-building" };
      if (text.includes("Monopoly")) return { type: "use-dev", player, card: "monopoly" };
    }
    if (text.includes("moved Robber") && player) {
      return { type: "move-robber", player };
    }
    if (text.includes("got") && player) {
      const resources = countResources(el);
      if (sum(resources) > 0) return { type: "got", player, resources };
    }
    return { type: "ignored" };
  }
  const RESOURCES = ["wood", "brick", "sheep", "wheat", "ore"];
  function pips(token) {
    if (token === null) return 0;
    return 6 - Math.abs(7 - token);
  }
  const DECK_CYCLE = 32;
  function createTracker(youName) {
    return {
      players: /* @__PURE__ */ new Map(),
      youName,
      rolls: [],
      rollsThisDeck: [],
      lastRoll: null,
      gameOver: false,
      discardLimit: 9
    };
  }
  function emptyHand$1() {
    return Object.fromEntries(RESOURCES.map((r) => [r, 0]));
  }
  function getPlayer(state, name, color = "#888") {
    let p = state.players.get(name);
    if (!p) {
      p = {
        name,
        color,
        hand: emptyHand$1(),
        uncertainty: 0,
        settlements: 0,
        cities: 0,
        roads: 0,
        devCards: 0,
        knightsPlayed: 0,
        incomeByNumber: /* @__PURE__ */ new Map(),
        bankRatio: {},
        serverCards: null
      };
      state.players.set(name, p);
    }
    if (color !== "#888") p.color = color;
    return p;
  }
  function applyDelta(p, delta) {
    for (const [res, n] of Object.entries(delta)) {
      const r = res;
      const next = p.hand[r] + (n ?? 0);
      if (next < 0) {
        p.uncertainty += -next;
        p.hand[r] = 0;
      } else {
        p.hand[r] = next;
      }
    }
  }
  const COSTS$2 = {
    road: { wood: -1, brick: -1 },
    settlement: { wood: -1, brick: -1, sheep: -1, wheat: -1 },
    city: { ore: -3, wheat: -2 },
    dev: { ore: -1, sheep: -1, wheat: -1 }
  };
  function resolveYou(state, name) {
    return name ?? state.youName;
  }
  function applyEvent(state, ev) {
    switch (ev.type) {
      case "ignored":
        break;
      case "game-over":
        state.gameOver = ev.winner;
        break;
      case "roll": {
        getPlayer(state, ev.player);
        state.rolls.push(ev.total);
        const full = ev.total === 7 ? 6 : pips(ev.total);
        const seen = state.rollsThisDeck.filter((t) => t === ev.total).length;
        if (seen >= full) state.rollsThisDeck = [];
        state.rollsThisDeck.push(ev.total);
        if (state.rollsThisDeck.length >= DECK_CYCLE) state.rollsThisDeck = [];
        state.lastRoll = { player: ev.player, total: ev.total };
        break;
      }
      case "got": {
        const p = getPlayer(state, ev.player);
        applyDelta(p, ev.resources);
        if (state.lastRoll) {
          p.incomeByNumber.set(state.lastRoll.total, { ...ev.resources });
        }
        break;
      }
      case "starting-resources": {
        const p = getPlayer(state, ev.player);
        applyDelta(p, ev.resources);
        break;
      }
      case "place": {
        const p = getPlayer(state, ev.player, ev.color);
        if (ev.what === "settlement") p.settlements++;
        if (ev.what === "city") p.cities++;
        if (ev.what === "road") p.roads++;
        break;
      }
      case "build": {
        const p = getPlayer(state, ev.player);
        applyDelta(p, COSTS$2[ev.what]);
        if (ev.what === "settlement") p.settlements++;
        if (ev.what === "road") p.roads++;
        if (ev.what === "city") {
          p.cities++;
          p.settlements = Math.max(0, p.settlements - 1);
        }
        break;
      }
      case "buy-dev": {
        const p = getPlayer(state, ev.player);
        applyDelta(p, COSTS$2.dev);
        p.devCards++;
        break;
      }
      case "bank-trade": {
        const p = getPlayer(state, ev.player);
        const gaveEntries = Object.entries(ev.delta).filter(([, v]) => (v ?? 0) < 0);
        if (gaveEntries.length === 1 && ev.took === 1) {
          const [res, v] = gaveEntries[0];
          const ratio = -(v ?? 0);
          const r = res;
          p.bankRatio[r] = Math.min(p.bankRatio[r] ?? 4, ratio);
        }
        applyDelta(p, ev.delta);
        break;
      }
      case "player-trade": {
        const p = getPlayer(state, ev.player);
        applyDelta(p, ev.delta);
        if (ev.partner) {
          const partner = getPlayer(state, ev.partner);
          const inverse = {};
          for (const [r, v] of Object.entries(ev.delta)) {
            inverse[r] = -(v ?? 0);
          }
          applyDelta(partner, inverse);
        }
        break;
      }
      case "steal-known": {
        const thief = resolveYou(state, ev.thief);
        const victim = resolveYou(state, ev.victim);
        if (thief) applyDelta(getPlayer(state, thief), { [ev.resource]: 1 });
        if (victim) applyDelta(getPlayer(state, victim), { [ev.resource]: -1 });
        break;
      }
      case "steal-unknown": {
        const thief = resolveYou(state, ev.thief);
        const victim = resolveYou(state, ev.victim);
        if (thief) getPlayer(state, thief).uncertainty++;
        if (victim) {
          const v = getPlayer(state, victim);
          v.uncertainty++;
          const biggest = RESOURCES.reduce((a, b) => v.hand[a] >= v.hand[b] ? a : b);
          if (v.hand[biggest] > 0) v.hand[biggest]--;
        }
        break;
      }
      case "monopoly-steal": {
        const p = getPlayer(state, ev.player);
        applyDelta(p, { [ev.resource]: ev.count });
        for (const other of state.players.values()) {
          if (other.name !== ev.player) other.hand[ev.resource] = 0;
        }
        break;
      }
      case "take-from-bank": {
        applyDelta(getPlayer(state, ev.player), ev.resources);
        break;
      }
      case "discard": {
        const p = getPlayer(state, ev.player);
        const inverse = {};
        for (const [r, v] of Object.entries(ev.resources)) {
          inverse[r] = -(v ?? 0);
        }
        applyDelta(p, inverse);
        break;
      }
      case "use-knight": {
        const p = getPlayer(state, ev.player);
        p.knightsPlayed++;
        p.devCards = Math.max(0, p.devCards - 1);
        break;
      }
      case "use-dev": {
        const p = getPlayer(state, ev.player);
        p.devCards = Math.max(0, p.devCards - 1);
        break;
      }
    }
  }
  function ensurePlayer(state, name, color = "#888") {
    getPlayer(state, name, color);
  }
  const RESOURCE_TO_CARD_ID = {
    wood: 1,
    brick: 2,
    sheep: 3,
    wheat: 4,
    ore: 5
  };
  function handTotal(p) {
    return RESOURCES.reduce((s, r) => s + p.hand[r], 0);
  }
  function visibleVp(p) {
    return p.settlements + p.cities * 2;
  }
  function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
      a |= 0;
      a = a + 1831565813 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  const SQRT3$1 = Math.sqrt(3);
  function hexCenter(q, r) {
    return { x: SQRT3$1 * q + SQRT3$1 / 2 * r, y: 1.5 * r };
  }
  function hexCorner(cx, cy, i) {
    const angle = Math.PI / 180 * (60 * i - 30);
    return { x: cx + Math.cos(angle), y: cy + Math.sin(angle) };
  }
  function vkey(x, y) {
    const rx = Math.round(x * 100) || 0;
    const ry = Math.round(y * 100) || 0;
    return `${rx},${ry}`;
  }
  function buildBoard(seed, tiles) {
    const hexes = tiles.map((t, id) => {
      const { x, y } = hexCenter(t.q, t.r);
      return { id, q: t.q, r: t.r, kind: t.kind, token: t.token, cx: x, cy: y };
    });
    const vertexByKey = /* @__PURE__ */ new Map();
    const vertices = [];
    const cornerIds = [];
    for (const h of hexes) {
      const ids = [];
      for (let i = 0; i < 6; i++) {
        const { x, y } = hexCorner(h.cx, h.cy, i);
        const key = vkey(x, y);
        let v = vertexByKey.get(key);
        if (!v) {
          v = { id: vertices.length, x, y, hexIds: [], adjacent: [], port: null };
          vertexByKey.set(key, v);
          vertices.push(v);
        }
        v.hexIds.push(h.id);
        ids.push(v.id);
      }
      cornerIds.push(ids);
    }
    const edgeByKey = /* @__PURE__ */ new Map();
    const edges = [];
    for (const ids of cornerIds) {
      for (let i = 0; i < 6; i++) {
        const a = ids[i];
        const b = ids[(i + 1) % 6];
        const key = a < b ? `${a}-${b}` : `${b}-${a}`;
        if (!edgeByKey.has(key)) {
          const e = { id: edges.length, a, b };
          edgeByKey.set(key, e);
          edges.push(e);
          vertices[a].adjacent.push(b);
          vertices[b].adjacent.push(a);
        }
      }
    }
    return { seed, hexes, vertices, edges };
  }
  function hexCornerPoints(hex) {
    return Array.from({ length: 6 }, (_, i) => hexCorner(hex.cx, hex.cy, i));
  }
  function colonistCornerToPixel(c) {
    const { x, y } = hexCenter(c.x, c.y);
    return hexCorner(x, y, c.z === 1 ? 2 : 5);
  }
  function colonistEdgeToPixels(e) {
    const { x, y } = hexCenter(e.x, e.y);
    const i = 5 - e.z;
    return [hexCorner(x, y, i), hexCorner(x, y, i - 1)];
  }
  function findVertexAt(board, x, y) {
    let best = null;
    let bestD = 0.05;
    for (const v of board.vertices) {
      const d = Math.hypot(v.x - x, v.y - y);
      if (d < bestD) {
        best = v;
        bestD = d;
      }
    }
    return best;
  }
  function findEdgeBetween(board, a, b) {
    return board.edges.find(
      (e) => e.a === a && e.b === b || e.a === b && e.b === a
    ) ?? null;
  }
  function vertexPips(board, vertexId) {
    return board.vertices[vertexId].hexIds.reduce(
      (sum2, hid) => sum2 + pips(board.hexes[hid].token),
      0
    );
  }
  function resourceAbundance(board) {
    const out = Object.fromEntries(RESOURCES.map((r) => [r, 0]));
    for (const h of board.hexes) {
      if (h.kind !== "desert") out[h.kind] += pips(h.token);
    }
    return out;
  }
  function scarcityWeights(board) {
    const abundance = resourceAbundance(board);
    const avg = RESOURCES.reduce((s, r) => s + abundance[r], 0) / RESOURCES.length;
    const out = {};
    for (const r of RESOURCES) {
      out[r] = Math.min(1.8, Math.max(0.6, avg / Math.max(1, abundance[r])));
    }
    return out;
  }
  function playerProduction(state, player) {
    const out = Object.fromEntries(RESOURCES.map((r) => [r, 0]));
    for (const b of state.buildings) {
      if (b.player !== player) continue;
      const mult = b.kind === "city" ? 2 : 1;
      for (const hid of state.board.vertices[b.vertexId].hexIds) {
        const h = state.board.hexes[hid];
        if (h.kind !== "desert" && h.token !== null) {
          out[h.kind] += pips(h.token) / 36 * mult;
        }
      }
    }
    return out;
  }
  function isVertexBuildable(state, vertexId) {
    const occupied = new Set(state.buildings.map((b) => b.vertexId));
    if (occupied.has(vertexId)) return false;
    return !state.board.vertices[vertexId].adjacent.some((n) => occupied.has(n));
  }
  function scoreVertex(board, vertexId, weights) {
    const v = board.vertices[vertexId];
    const notes = [];
    const resources = [];
    let score = 0;
    let totalPips = 0;
    for (const hid of v.hexIds) {
      const h = board.hexes[hid];
      if (h.kind === "desert" || h.token === null) continue;
      const p = pips(h.token);
      totalPips += p;
      score += p * weights[h.kind];
      if (!resources.includes(h.kind)) resources.push(h.kind);
    }
    score += (resources.length - 1) * 1.2;
    if (resources.length >= 3) notes.push("3-resource diversity");
    if (v.port) {
      const bonus = v.port.ratio === 2 ? 2 : 1;
      score += bonus;
      notes.push(v.port.ratio === 2 ? `2:1 ${v.port.kind} port` : "3:1 port");
    }
    if (totalPips >= 10) notes.push(`strong production (${totalPips} pips)`);
    return { vertexId, score, pips: totalPips, resources, notes };
  }
  function rankVertices(state, weights, limit = 5) {
    return state.board.vertices.filter((v) => isVertexBuildable(state, v.id)).map((v) => scoreVertex(state.board, v.id, weights)).sort((a, b) => b.score - a.score).slice(0, limit);
  }
  function combineWeights(a, b) {
    const out = {};
    for (const r of RESOURCES) out[r] = a[r] * b[r];
    return out;
  }
  function buildingsOf(state, player) {
    return state.buildings.filter((b) => b.player === player);
  }
  function distanceFromPlayer(state, player, vertexId) {
    const sources = buildingsOf(state, player).map((b) => b.vertexId);
    if (sources.length === 0) return Infinity;
    const dist = /* @__PURE__ */ new Map();
    const queue = [];
    for (const s of sources) {
      dist.set(s, 0);
      queue.push(s);
    }
    while (queue.length) {
      const cur = queue.shift();
      const d = dist.get(cur);
      if (cur === vertexId) return d;
      for (const n of state.board.vertices[cur].adjacent) {
        if (!dist.has(n)) {
          dist.set(n, d + 1);
          queue.push(n);
        }
      }
    }
    return dist.get(vertexId) ?? Infinity;
  }
  const STRATEGIES = [
    {
      id: "road-expand",
      name: "Road & Expand",
      tagline: "Wood + brick: settle fast, take Longest Road",
      weights: { wood: 1.5, brick: 1.5, sheep: 0.9, wheat: 0.9, ore: 0.5 },
      buildOrder: ["road", "settlement", "road", "settlement", "city"]
    },
    {
      id: "city-dev",
      name: "Cities & Development",
      tagline: "Ore + wheat: cities, dev cards, Largest Army",
      weights: { wood: 0.5, brick: 0.5, sheep: 1, wheat: 1.5, ore: 1.6 },
      buildOrder: ["city", "dev", "city", "dev", "settlement"]
    },
    {
      id: "port-trade",
      name: "Port Monopoly",
      tagline: "Overload one abundant resource and trade through a 2:1 port",
      weights: { wood: 1, brick: 1, sheep: 1, wheat: 1, ore: 1 },
      buildOrder: ["settlement", "city", "settlement", "dev", "city"]
    },
    {
      id: "balanced",
      name: "Balanced",
      tagline: "No strong lean yet — take the highest-production spots and stay flexible",
      weights: { wood: 1, brick: 1, sheep: 1, wheat: 1, ore: 1 },
      buildOrder: ["settlement", "road", "city", "dev", "settlement"]
    }
  ];
  function rankStrategies(state, player) {
    const prod = playerProduction(state, player);
    const scarcity = scarcityWeights(state.board);
    const totalProd = RESOURCES.reduce((s, r) => s + prod[r], 0);
    const fits = STRATEGIES.map((strategy) => {
      const rationale = [];
      let alignment = 0;
      for (const r of RESOURCES) alignment += prod[r] * strategy.weights[r];
      const alignScore = alignment * 36;
      const spots = rankVertices(state, combineWeights(strategy.weights, scarcity), 3);
      const boardScore = spots.reduce((s, v) => s + v.score, 0) * 0.25;
      let score = alignScore + boardScore;
      if (strategy.id === "port-trade") {
        const ports = state.buildings.filter((b) => b.player === player).map((b) => state.board.vertices[b.vertexId].port).filter((p) => p !== null);
        const twoToOne = ports.find((p) => p.ratio === 2);
        if (twoToOne) {
          const feed = prod[twoToOne.kind] * 36;
          score += feed * 1.5;
          rationale.push(`You hold a 2:1 ${twoToOne.kind} port with ${feed.toFixed(0)} pips feeding it`);
        } else if (ports.length > 0) {
          score += 3;
          rationale.push("You hold a 3:1 port");
        } else {
          score *= 0.6;
          rationale.push("No port yet — grab one before committing to this");
        }
      }
      const keyRes = RESOURCES.filter((r) => strategy.weights[r] >= 1.4);
      if (keyRes.length > 0) {
        const keyProd = keyRes.reduce((s, r) => s + prod[r], 0) * 36;
        if (totalProd > 0 && keyProd >= totalProd * 36 * 0.45) {
          rationale.push(`Strong ${keyRes.join("+")} base (${keyProd.toFixed(0)} of your pips)`);
        } else if (totalProd > 0) {
          rationale.push(`Needs more ${keyRes.join("/")} than you currently produce`);
        }
      }
      if (spots.length > 0 && spots[0].score > 10) {
        rationale.push(`Board still has strong expansion spots for this plan`);
      }
      return { strategy, score, rationale };
    });
    return fits.sort((a, b) => b.score - a.score);
  }
  class BalancedDice {
    /**
     * discardAt > 0 mimics colonist.io: the deck reshuffles with a few cards
     * still unplayed, so counting cards never becomes fully deterministic.
     */
    constructor(rand, discardAt = 0) {
      __publicField(this, "deck", []);
      this.rand = rand;
      this.discardAt = discardAt;
    }
    refill() {
      this.deck = [];
      for (let d1 = 1; d1 <= 6; d1++) {
        for (let d2 = 1; d2 <= 6; d2++) this.deck.push(d1 + d2);
      }
      for (let i = this.deck.length - 1; i > 0; i--) {
        const j = Math.floor(this.rand() * (i + 1));
        [this.deck[i], this.deck[j]] = [this.deck[j], this.deck[i]];
      }
    }
    roll() {
      if (this.deck.length <= this.discardAt) this.refill();
      return this.deck.pop();
    }
  }
  const COSTS$1 = {
    road: { wood: 1, brick: 1 },
    settlement: { wood: 1, brick: 1, sheep: 1, wheat: 1 },
    city: { ore: 3, wheat: 2 },
    dev: { ore: 1, sheep: 1, wheat: 1 }
  };
  function emptyHand() {
    return Object.fromEntries(RESOURCES.map((r) => [r, 0]));
  }
  function simulateStrategy(state, player, strategy, opts = {}) {
    const { rounds = 25, trials = 40, seed = 1 } = opts;
    const totals = { roads: 0, settlements: 0, cities: 0, devs: 0, vp: 0 };
    const scarcity = scarcityWeights(state.board);
    const weights = combineWeights(strategy.weights, scarcity);
    for (let t = 0; t < trials; t++) {
      const rand = mulberry32(seed + t * 7919);
      const dice = new BalancedDice(rand, 4);
      const hand = emptyHand();
      const sim = {
        board: state.board,
        buildings: state.buildings.map((b) => ({ ...b })),
        roads: state.roads.map((r) => ({ ...r }))
      };
      let reach = sim.roads.filter((r) => r.player === player).length;
      const built = { roads: 0, settlements: 0, cities: 0, devs: 0 };
      let orderIdx = 0;
      const bestRatio = (res) => {
        let ratio = 4;
        for (const b of sim.buildings) {
          if (b.player !== player) continue;
          const port = sim.board.vertices[b.vertexId].port;
          if (!port) continue;
          if (port.kind === "any") ratio = Math.min(ratio, 3);
          else if (port.kind === res) ratio = Math.min(ratio, 2);
        }
        return ratio;
      };
      const tryBuy = (item) => {
        const cost = COSTS$1[item];
        const missing = {};
        let missingTotal = 0;
        for (const r of RESOURCES) {
          const need = (cost[r] ?? 0) - hand[r];
          if (need > 0) {
            missing[r] = need;
            missingTotal += need;
          }
        }
        if (missingTotal > 0) {
          for (const give of RESOURCES) {
            if (missingTotal === 0) break;
            const surplus = hand[give] - (cost[give] ?? 0);
            const ratio = bestRatio(give);
            let tradeable = Math.floor(Math.max(0, surplus) / ratio);
            while (tradeable > 0 && missingTotal > 0) {
              const wanted = RESOURCES.find((r) => (missing[r] ?? 0) > 0);
              hand[give] -= ratio;
              hand[wanted] += 1;
              missing[wanted] -= 1;
              missingTotal -= 1;
              tradeable -= 1;
            }
          }
          for (const r of RESOURCES) if ((cost[r] ?? 0) > hand[r]) return false;
        }
        if (item === "settlement") {
          const spots = sim.board.vertices.filter((v) => isVertexBuildable(sim, v.id)).filter((v) => distanceFromPlayer(sim, player, v.id) <= Math.max(1, reach)).map((v) => scoreVertex(sim.board, v.id, weights)).sort((a, b) => b.score - a.score);
          if (spots.length === 0) return false;
          sim.buildings.push({ vertexId: spots[0].vertexId, player, kind: "settlement" });
          built.settlements++;
        } else if (item === "city") {
          const target = sim.buildings.find((b) => b.player === player && b.kind === "settlement");
          if (!target) return false;
          target.kind = "city";
          built.cities++;
        } else if (item === "road") {
          reach++;
          built.roads++;
        } else {
          built.devs++;
        }
        for (const r of RESOURCES) hand[r] -= COSTS$1[item][r] ?? 0;
        return true;
      };
      for (let round = 0; round < rounds; round++) {
        const roll = dice.roll();
        if (roll !== 7) {
          for (const b of sim.buildings) {
            if (b.player !== player) continue;
            const mult = b.kind === "city" ? 2 : 1;
            for (const hid of sim.board.vertices[b.vertexId].hexIds) {
              const h = sim.board.hexes[hid];
              if (h.kind !== "desert" && h.token === roll) hand[h.kind] += mult;
            }
          }
        } else {
          let count = RESOURCES.reduce((s, r) => s + hand[r], 0);
          if (count > 7) {
            let toDiscard = Math.floor(count / 2);
            while (toDiscard > 0) {
              const biggest = RESOURCES.reduce((a, b) => hand[a] >= hand[b] ? a : b);
              hand[biggest]--;
              toDiscard--;
            }
          }
        }
        const order = strategy.buildOrder;
        if (tryBuy(order[orderIdx % order.length])) {
          orderIdx++;
        } else {
          for (const alt of ["city", "settlement", "dev", "road"]) {
            if (alt !== order[orderIdx % order.length] && tryBuy(alt)) break;
          }
        }
      }
      totals.roads += built.roads;
      totals.settlements += built.settlements;
      totals.cities += built.cities;
      totals.devs += built.devs;
      totals.vp += built.settlements + built.cities + built.devs * 0.3 + (built.devs >= 5 ? 2 : 0);
    }
    return {
      strategy,
      meanVp: totals.vp / trials,
      meanBuilds: {
        roads: totals.roads / trials,
        settlements: totals.settlements / trials,
        cities: totals.cities / trials,
        devs: totals.devs / trials
      }
    };
  }
  function deckStatus(state) {
    const remaining = /* @__PURE__ */ new Map();
    for (let n = 2; n <= 12; n++) remaining.set(n, n === 7 ? 6 : pips(n));
    for (const roll of state.rollsThisDeck) {
      remaining.set(roll, Math.max(0, (remaining.get(roll) ?? 0) - 1));
    }
    const totalRemaining = [...remaining.values()].reduce((a, b) => a + b, 0);
    const prob = /* @__PURE__ */ new Map();
    const due = [];
    const cold = [];
    for (let n = 2; n <= 12; n++) {
      const base = (n === 7 ? 6 : pips(n)) / 36;
      const p = totalRemaining > 0 ? (remaining.get(n) ?? 0) / totalRemaining : base;
      prob.set(n, p);
      if (p >= base * 1.35 && (remaining.get(n) ?? 0) > 0) due.push(n);
      if ((remaining.get(n) ?? 0) === 0) cold.push(n);
    }
    return { remaining, totalRemaining, prob, due, cold, rollsIntoDeck: state.rollsThisDeck.length };
  }
  function expectedProduction(p, probOf) {
    const out = Object.fromEntries(RESOURCES.map((r) => [r, 0]));
    for (const [n, delta] of p.incomeByNumber) {
      const prob = pips(n) / 36;
      for (const [res, count] of Object.entries(delta)) {
        out[res] += prob * (count ?? 0);
      }
    }
    return out;
  }
  function productionTotal(prod) {
    return RESOURCES.reduce((s, r) => s + prod[r], 0);
  }
  const BUILD_COSTS$1 = {
    road: { wood: 1, brick: 1 },
    settlement: { wood: 1, brick: 1, sheep: 1, wheat: 1 },
    city: { ore: 3, wheat: 2 },
    dev: { ore: 1, sheep: 1, wheat: 1 }
  };
  function simulateLive(p, strategy, seed, discardLimit = 9, rounds = 25, trials = 30) {
    const buildingCount = Math.max(1, p.settlements + p.cities);
    const baseProd = expectedProduction(p);
    const perBuilding = productionTotal(baseProd) / buildingCount;
    const mixTotal = productionTotal(baseProd) || 1;
    let vpSum = 0;
    for (let t = 0; t < trials; t++) {
      const rand = mulberry32(seed + t * 104729);
      const dice = new BalancedDice(rand, 4);
      const hand = { ...p.hand };
      let extraBuildings = 0;
      let orderIdx = 0;
      const built = { settlements: 0, cities: 0, devs: 0, roads: 0 };
      const ratioFor = (res) => p.bankRatio[res] ?? 4;
      const tryBuy = (item) => {
        const cost = BUILD_COSTS$1[item];
        let missing = 0;
        const need = {};
        for (const r of RESOURCES) {
          const gap = (cost[r] ?? 0) - hand[r];
          if (gap > 0) {
            need[r] = gap;
            missing += gap;
          }
        }
        if (missing > 0) {
          for (const give of RESOURCES) {
            if (missing === 0) break;
            const ratio = ratioFor(give);
            let spare = Math.floor(Math.max(0, hand[give] - (cost[give] ?? 0)) / ratio);
            while (spare > 0 && missing > 0) {
              const wanted = RESOURCES.find((r) => (need[r] ?? 0) > 0);
              hand[give] -= ratio;
              hand[wanted] += 1;
              need[wanted] -= 1;
              missing--;
              spare--;
            }
          }
          for (const r of RESOURCES) if ((cost[r] ?? 0) > hand[r]) return false;
        }
        for (const r of RESOURCES) hand[r] -= cost[r] ?? 0;
        if (item === "settlement") {
          built.settlements++;
          extraBuildings++;
        } else if (item === "city") {
          if (p.settlements + built.settlements === 0) return false;
          built.cities++;
          extraBuildings++;
        } else if (item === "dev") built.devs++;
        else built.roads++;
        return true;
      };
      for (let round = 0; round < rounds; round++) {
        const roll = dice.roll();
        if (roll !== 7) {
          const income = p.incomeByNumber.get(roll);
          if (income) {
            for (const [res, count] of Object.entries(income)) {
              hand[res] += count ?? 0;
            }
          }
          if (extraBuildings > 0 && mixTotal > 0) {
            for (const r of RESOURCES) {
              hand[r] += baseProd[r] / mixTotal * perBuilding * extraBuildings;
            }
          }
        } else if (handTotal({ ...p, hand }) > discardLimit) {
          for (const r of RESOURCES) hand[r] = Math.floor(hand[r] * 0.55);
        }
        const order = strategy.buildOrder;
        if (tryBuy(order[orderIdx % order.length])) orderIdx++;
        else {
          for (const alt of ["city", "settlement", "dev", "road"]) {
            if (alt !== order[orderIdx % order.length] && tryBuy(alt)) break;
          }
        }
      }
      vpSum += built.settlements + built.cities + built.devs * 0.3 + (built.devs >= 5 ? 2 : 0);
    }
    return vpSum / trials;
  }
  function rankLiveStrategies(state, name, priors) {
    const p = state.players.get(name);
    if (!p) return [];
    const prod = expectedProduction(p);
    const total = productionTotal(prod);
    const fits = STRATEGIES.map((strategy, i) => {
      const rationale = [];
      let score = 0;
      for (const r of RESOURCES) score += prod[r] * strategy.weights[r] * 36;
      const keyRes = RESOURCES.filter((r) => strategy.weights[r] >= 1.4);
      if (keyRes.length > 0 && total > 0) {
        const keyShare = keyRes.reduce((s, r) => s + prod[r], 0) / total;
        if (keyShare >= 0.45) {
          rationale.push(`${Math.round(keyShare * 100)}% of your income is ${keyRes.join("+")}`);
        } else {
          rationale.push(`only ${Math.round(keyShare * 100)}% of your income is ${keyRes.join("/")}`);
        }
      }
      if (strategy.id === "port-trade") {
        const port = RESOURCES.find((r) => (p.bankRatio[r] ?? 4) === 2);
        if (port) {
          score += prod[port] * 36 * 1.5;
          rationale.push(`2:1 ${port} port confirmed from your bank trades`);
        } else {
          score *= 0.6;
          rationale.push("no 2:1 port observed yet");
        }
      }
      if (strategy.id === "city-dev" && p.knightsPlayed >= 2) {
        score += 3;
        rationale.push(`${p.knightsPlayed} knights played — Largest Army is in reach`);
      }
      if (strategy.id === "road-expand" && p.roads >= 6) {
        score += 3;
        rationale.push(`${p.roads} roads down — press for Longest Road`);
      }
      const simVp = simulateLive(p, strategy, 1e3 + i * 31, state.discardLimit);
      score *= (priors == null ? void 0 : priors[strategy.id]) ?? 1;
      return { strategy, score, simVp, rationale };
    });
    const maxScore = Math.max(...fits.map((f) => f.score), 1);
    const maxVp = Math.max(...fits.map((f) => f.simVp), 0.1);
    return fits.sort(
      (a, b) => 0.45 * (b.score / maxScore) + 0.55 * (b.simVp / maxVp) - (0.45 * (a.score / maxScore) + 0.55 * (a.simVp / maxVp))
    );
  }
  function bestFitWeights(p) {
    const prod = expectedProduction(p);
    let best = STRATEGIES[0];
    let bestScore = -Infinity;
    for (const s of STRATEGIES) {
      const score = RESOURCES.reduce((sum2, r) => sum2 + prod[r] * s.weights[r], 0);
      if (score > bestScore) {
        bestScore = score;
        best = s;
      }
    }
    return best.weights;
  }
  function robberAdvice(state) {
    var _a;
    const you = state.youName;
    const opponents = [...state.players.values()].filter((p2) => p2.name !== you);
    if (opponents.length === 0) return null;
    const scored = opponents.map((p2) => {
      const prod = productionTotal(expectedProduction(p2));
      return { p: p2, threat: visibleVp(p2) * 1.2 + prod * 36 * 0.6 + handTotal(p2) * 0.15 };
    }).sort((a, b) => b.threat - a.threat);
    const { p } = scored[0];
    const needs = bestFitWeights(p);
    const yourIncome = you ? (_a = state.players.get(you)) == null ? void 0 : _a.incomeByNumber : void 0;
    let best = null;
    for (const [n, delta] of p.incomeByNumber) {
      let value = 0;
      for (const [res, count] of Object.entries(delta)) {
        value += (count ?? 0) * pips(n) * needs[res];
      }
      if (yourIncome == null ? void 0 : yourIncome.has(n)) value *= 0.5;
      if (!best || value > best.value) best = { n, value };
    }
    let blockHint = "";
    if (best) {
      const payout = describeDelta(p.incomeByNumber.get(best.n));
      const alsoYours = (yourIncome == null ? void 0 : yourIncome.has(best.n)) ? " (careful: a tile on that number may pay you too)" : "";
      blockHint = ` Block their ${best.n} — it pays them ${payout}, which their plan needs most${alsoYours}.`;
    }
    const friendly = visibleVp(p) < 3 ? ` They're under 3 VP, so with friendly robber you can't steal — blocking the tile still works.` : "";
    return {
      target: p.name,
      reason: `${p.name} leads the threat board: ${visibleVp(p)} visible VP, ~${(productionTotal(expectedProduction(p)) * 36).toFixed(0)} pips of income, ${handTotal(p)}${p.uncertainty ? `±${p.uncertainty}` : ""} cards in hand.` + blockHint + friendly
    };
  }
  function describeDelta(d) {
    return Object.entries(d).filter(([, v]) => (v ?? 0) > 0).map(([r, v]) => `${v} ${r}`).join(", ");
  }
  function isOneVsOne(state) {
    return state.players.size === 2;
  }
  function tradeTips$1(state, name, fit) {
    const p = state.players.get(name);
    if (!p || !fit) return [];
    const tips = [];
    const w = fit.strategy.weights;
    const prod = expectedProduction(p);
    const oneVsOne = isOneVsOne(state);
    for (const item of fit.strategy.buildOrder) {
      const cost = BUILD_COSTS$1[item];
      const missing = RESOURCES.filter((r) => (cost[r] ?? 0) > p.hand[r]);
      const missingCount = missing.reduce((s, r) => s + (cost[r] ?? 0) - p.hand[r], 0);
      if (missingCount === 0) break;
      if (missingCount <= 2) {
        const surplus = RESOURCES.filter(
          (r) => p.hand[r] - (cost[r] ?? 0) >= (p.bankRatio[r] ?? 4)
        );
        if (oneVsOne) {
          if (surplus.length) {
            tips.push({
              text: `${missingCount} card${missingCount > 1 ? "s" : ""} short of a ${item}: bank-trade ${surplus[0]} (${p.bankRatio[surplus[0]] ?? 4}:1) for ${missing.join(" + ")}.`
            });
          }
        } else {
          tips.push({
            text: `One trade from a ${item}: get ${missing.join(" + ")}` + (surplus.length ? `, offer ${surplus.join(" or ")}` : "") + "."
          });
        }
        break;
      }
    }
    const surplusRes = [...RESOURCES].sort(
      (a, b) => prod[b] * (2 - w[b]) - prod[a] * (2 - w[a])
    )[0];
    const neededRes = [...RESOURCES].sort((a, b) => w[b] - w[a]).find((r) => prod[r] < 0.05);
    if (surplusRes && neededRes && surplusRes !== neededRes) {
      tips.push({
        text: oneVsOne ? `Long-term: you produce almost no ${neededRes}. No player trades in 1v1 — funnel surplus ${surplusRes} through the bank or grab a ${neededRes} port.` : `Long-term: your ${surplusRes} income is expendable for ${fit.strategy.name}; you produce almost no ${neededRes} — trade or port toward it.`
      });
    }
    const ratio = RESOURCES.find((r) => (p.bankRatio[r] ?? 4) <= 3);
    if (ratio && !oneVsOne) {
      tips.push({
        text: `Never accept a worse deal than your ${p.bankRatio[ratio]}:1 bank rate on ${ratio}.`
      });
    }
    return tips;
  }
  function planDiscard(hand, count, fit) {
    const keep = fit ? { ...BUILD_COSTS$1[fit.strategy.buildOrder[0]] } : {};
    const pool = { ...hand };
    const out = {};
    for (let i = 0; i < count; i++) {
      const avail = RESOURCES.filter((r) => pool[r] > 0);
      if (avail.length === 0) break;
      const pick = avail.sort(
        (a, b) => pool[b] - (keep[b] ?? 0) - (pool[a] - (keep[a] ?? 0)) || (fit ? fit.strategy.weights[a] - fit.strategy.weights[b] : 0)
      )[0];
      pool[pick]--;
      out[pick] = (out[pick] ?? 0) + 1;
    }
    return out;
  }
  function nextMoves(state, name, fit, facts) {
    const p = state.players.get(name);
    if (!p || !fit) return [];
    const actions = [];
    const hand = { ...p.hand };
    const total = RESOURCES.reduce((s, r) => s + hand[r], 0);
    if (total > state.discardLimit) {
      const keepFor = fit.strategy.buildOrder[0];
      const plan = planDiscard(hand, Math.floor(total / 2), fit);
      actions.push({
        text: `If a 7 rolls, discard ${Object.entries(plan).map(([r, n]) => `${n} ${r}`).join(" + ")} — keep the makings of a ${keepFor}.`,
        primary: false
      });
    }
    const canAfford = (item) => RESOURCES.every((r) => hand[r] >= (BUILD_COSTS$1[item][r] ?? 0));
    const pay = (item) => {
      for (const r of RESOURCES) hand[r] -= BUILD_COSTS$1[item][r] ?? 0;
    };
    const tried = /* @__PURE__ */ new Set();
    for (const item of [...fit.strategy.buildOrder, "city", "settlement", "dev", "road"]) {
      if (tried.has(item)) continue;
      tried.add(item);
      if (!canAfford(item)) continue;
      if (item === "city") {
        if (p.settlements > 0) {
          actions.push({
            text: (facts == null ? void 0 : facts.cityUpgradeLabel) ? `Build a city: upgrade your settlement at ${facts.cityUpgradeLabel}.` : "Build a city on your best-producing settlement.",
            primary: true
          });
          pay(item);
        }
      } else if (item === "settlement") {
        if (!facts || facts.canPlaceSettlement) {
          actions.push({
            text: (facts == null ? void 0 : facts.bestSpotLabel) ? `Build a settlement at ① ${facts.bestSpotLabel}.` : "Build a settlement at the marked spot.",
            primary: true
          });
          pay(item);
        } else {
          actions.push({
            text: `You can afford a settlement but nowhere legal is connected — build the dashed road toward ① first.`,
            primary: !actions.some((a) => a.primary)
          });
        }
      } else if (item === "dev") {
        actions.push({ text: "Buy a development card.", primary: true });
        pay(item);
      } else if (item === "road") {
        if (!facts || facts.hasRoadSuggestion) {
          actions.push({
            text: "Build a road along the dashed segment toward ①.",
            primary: true
          });
          pay(item);
        }
      }
    }
    if (!actions.some((a) => a.primary)) {
      let bestItem = fit.strategy.buildOrder[0];
      let bestMissing = Infinity;
      for (const item of fit.strategy.buildOrder) {
        const missing = RESOURCES.reduce(
          (s, r) => s + Math.max(0, (BUILD_COSTS$1[item][r] ?? 0) - hand[r]),
          0
        );
        if (missing < bestMissing) {
          bestMissing = missing;
          bestItem = item;
        }
      }
      const missingList = RESOURCES.filter((r) => (BUILD_COSTS$1[bestItem][r] ?? 0) > hand[r]).map((r) => `${(BUILD_COSTS$1[bestItem][r] ?? 0) - hand[r]} ${r}`).join(" + ");
      actions.push({
        text: `Nothing to build yet — save for a ${bestItem} (need ${missingList || "nothing"}).`,
        primary: true
      });
    }
    return actions;
  }
  function analyzeBoard(state) {
    const abundance = resourceAbundance(state.board);
    const scarcity = scarcityWeights(state.board);
    const sorted = [...RESOURCES].sort((a, b) => abundance[a] - abundance[b]);
    const scarcest = sorted[0];
    const richest = sorted[sorted.length - 1];
    const notes = [];
    notes.push(
      `${cap(richest)} is plentiful (${abundance[richest]} pips) — it will trade poorly, don't over-invest.`
    );
    notes.push(
      `${cap(scarcest)} is scarce (${abundance[scarcest]} pips) — corner it and everyone trades with you.`
    );
    const roadRes = abundance.wood + abundance.brick;
    const cityRes = abundance.ore + abundance.wheat;
    if (roadRes > cityRes + 4) {
      notes.push("Board favors road/settlement builds over city builds.");
    } else if (cityRes > roadRes + 4) {
      notes.push("Board favors ore+wheat city/dev-card play.");
    } else {
      notes.push("Road and city resources are evenly matched — placement decides it.");
    }
    return { abundance, scarcity, scarcest, richest, notes };
  }
  function advisePlayer(state, player) {
    const strategies = rankStrategies(state, player);
    const hasBuildings = buildingsOf(state, player).length > 0;
    const simulations = hasBuildings ? strategies.map(
      (f) => simulateStrategy(state, player, f.strategy, {
        rounds: 25,
        trials: 30,
        seed: state.board.seed + player
      })
    ) : [];
    let recommended = strategies[0];
    if (simulations.length > 0) {
      const maxFit = Math.max(...strategies.map((s) => s.score), 1);
      const maxVp = Math.max(...simulations.map((s) => s.meanVp), 0.1);
      let best = -Infinity;
      for (const fit of strategies) {
        const sim = simulations.find((s) => s.strategy.id === fit.strategy.id);
        const blended = 0.45 * (fit.score / maxFit) + 0.55 * (sim.meanVp / maxVp);
        if (blended > best) {
          best = blended;
          recommended = fit;
        }
      }
    }
    const scarcity = scarcityWeights(state.board);
    const weights = combineWeights(recommended.strategy.weights, scarcity);
    const expansion = state.board.vertices.filter((v) => isVertexBuildable(state, v.id)).map((v) => ({
      score: scoreVertex(state.board, v.id, weights),
      dist: distanceFromPlayer(state, player, v.id)
    })).filter((x) => x.dist <= 3).sort((a, b) => b.score.score - b.dist * 1.5 - (a.score.score - a.dist * 1.5)).slice(0, 3).map((x) => x.score);
    const trades = tradeTips(state, player, recommended);
    return { strategies, simulations, recommended, expansion, trades };
  }
  function tradeTips(state, player, fit) {
    const prod = playerProduction(state, player);
    const w = fit.strategy.weights;
    const tips = [];
    const surplus = [...RESOURCES].sort(
      (a, b) => prod[b] * (2 - w[b]) - prod[a] * (2 - w[a])
    )[0];
    const needed = [...RESOURCES].sort(
      (a, b) => w[b] * (1 - Math.min(1, prod[b] * 12)) - w[a] * (1 - Math.min(1, prod[a] * 12))
    )[0];
    if (surplus && needed && surplus !== needed && prod[surplus] > 0) {
      tips.push({
        give: surplus,
        get: needed,
        reason: `${cap(surplus)} is your most expendable income; ${cap(needed)} is the bottleneck for ${fit.strategy.name}.`
      });
    }
    const scarcest = analyzeBoard(state).scarcest;
    if (prod[scarcest] > 0.08) {
      tips.push({
        give: scarcest,
        get: needed === scarcest ? surplus : needed,
        reason: `You produce scarce ${scarcest} — demand steep prices (2:1 or better) from other players.`
      });
    }
    return tips;
  }
  function cap(s) {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  const COLONIST_COLORS = {
    1: "#E27174",
    2: "#223697",
    3: "#E09742",
    4: "#62B95D",
    5: "#9B6EA9",
    6: "#F5D442",
    7: "#5FB3B3",
    8: "#8B5A2B"
  };
  function describeVertex(state, vertexId) {
    const v = state.board.vertices[vertexId];
    const parts = v.hexIds.map((hid) => state.board.hexes[hid]).filter((h) => h.kind !== "desert" && h.token !== null).sort((a, b) => pips(b.token) - pips(a.token)).map((h) => `${h.token}-${h.kind}`);
    const total = vertexPips(state.board, vertexId);
    const port = v.port ? v.port.ratio === 2 ? `, 2:1 ${v.port.kind} port` : ", 3:1 port" : "";
    return `${parts.join(" + ") || "coastal"} (${total} pips${port})`;
  }
  function roadPathTo(state, player, target, fromVertices) {
    const sources = /* @__PURE__ */ new Set();
    if (fromVertices) {
      for (const v of fromVertices) sources.add(v);
    } else {
      for (const b of state.buildings) if (b.player === player) sources.add(b.vertexId);
      for (const r of state.roads) {
        if (r.player === player) {
          const e = state.board.edges[r.edgeId];
          sources.add(e.a);
          sources.add(e.b);
        }
      }
    }
    if (sources.size === 0) return [];
    const blocked = new Set(
      state.buildings.filter((b) => b.player !== player).map((b) => b.vertexId)
    );
    const takenEdges = new Set(state.roads.map((r) => r.edgeId));
    const prev = /* @__PURE__ */ new Map();
    const queue = [...sources];
    const seen = new Set(queue);
    while (queue.length) {
      const cur2 = queue.shift();
      if (cur2 === target) break;
      if (blocked.has(cur2) && !sources.has(cur2)) continue;
      for (const n of state.board.vertices[cur2].adjacent) {
        if (seen.has(n)) continue;
        const edge = state.board.edges.find(
          (e) => e.a === cur2 && e.b === n || e.a === n && e.b === cur2
        );
        if (!edge || takenEdges.has(edge.id)) continue;
        seen.add(n);
        prev.set(n, { vertex: cur2, edge: edge.id });
        queue.push(n);
      }
    }
    if (!seen.has(target)) return [];
    const path = [];
    let cur = target;
    while (prev.has(cur)) {
      const p = prev.get(cur);
      path.unshift(p.edge);
      cur = p.vertex;
    }
    return path;
  }
  function advisePlacement(state, youPlayer) {
    if (youPlayer === null) {
      const scarcity = scarcityWeights(state.board);
      const neutral = Object.fromEntries(RESOURCES.map((r) => [r, 1]));
      const top = rankVertices(state, combineWeights(neutral, scarcity), 3);
      return {
        phase: "setup",
        heading: "Best open spots",
        spots: top.map((s, i) => ({
          vertexId: s.vertexId,
          rank: i + 1,
          label: describeVertex(state, s.vertexId)
        })),
        roadEdges: [],
        note: null
      };
    }
    const yourBuildings = state.buildings.filter((b) => b.player === youPlayer);
    const yourRoads = state.roads.filter((r) => r.player === youPlayer);
    const setup = yourBuildings.length < 2 && state.buildings.length < 8;
    if (yourBuildings.length > yourRoads.length && (setup || yourBuildings.length <= 2)) {
      return adviseSetupRoad(state, youPlayer, yourBuildings, yourRoads);
    }
    if (setup) {
      const scarcity = scarcityWeights(state.board);
      const neutral = Object.fromEntries(RESOURCES.map((r) => [r, 1]));
      const base = combineWeights(neutral, scarcity);
      let weights = base;
      let note2 = null;
      if (yourBuildings.length === 1) {
        const covered = new Set(
          state.board.vertices[yourBuildings[0].vertexId].hexIds.map((h) => state.board.hexes[h].kind).filter((k) => k !== "desert")
        );
        weights = { ...base };
        for (const r of RESOURCES) if (!covered.has(r)) weights[r] *= 1.35;
        const missing = RESOURCES.filter((r) => !covered.has(r));
        if (missing.length) note2 = `Your first spot lacks ${missing.join(", ")} — these picks fill the gap.`;
      }
      const top = rankVertices(state, weights, 3);
      return {
        phase: "setup",
        heading: yourBuildings.length === 0 ? "Place your 1st settlement here" : "Place your 2nd settlement here",
        spots: top.map((s, i) => ({
          vertexId: s.vertexId,
          rank: i + 1,
          label: describeVertex(state, s.vertexId)
        })),
        roadEdges: [],
        note: note2
      };
    }
    const advice = advisePlayer(state, youPlayer);
    const spots = advice.expansion.slice(0, 3).map((s, i) => ({
      vertexId: s.vertexId,
      rank: i + 1,
      label: describeVertex(state, s.vertexId)
    }));
    let roadEdges = [];
    let note = null;
    if (spots.length > 0) {
      const path = roadPathTo(state, youPlayer, spots[0].vertexId);
      roadEdges = path.slice(0, 2);
      if (path.length > 0) {
        note = `${path.length} road${path.length > 1 ? "s" : ""} to reach spot ①${path.length > 2 ? " — dashed segments are the next two" : ""}.`;
      }
    }
    return {
      phase: "main",
      heading: `Expand toward (${advice.recommended.strategy.name})`,
      spots,
      roadEdges,
      note
    };
  }
  function adviseSetupRoad(state, youPlayer, yourBuildings, yourRoads) {
    const pending = yourBuildings.find((b) => {
      return !yourRoads.some((r) => {
        const e = state.board.edges[r.edgeId];
        return e.a === b.vertexId || e.b === b.vertexId;
      });
    }) ?? yourBuildings[yourBuildings.length - 1];
    const scarcity = scarcityWeights(state.board);
    const neutral = Object.fromEntries(RESOURCES.map((r) => [r, 1]));
    const weights = combineWeights(neutral, scarcity);
    const candidates = rankVertices(state, weights, 10).map((s) => {
      const path = roadPathTo(state, youPlayer, s.vertexId, [pending.vertexId]);
      return { s, path };
    }).filter((c) => c.path.length > 0 && c.path.length <= 4).sort((a, b) => b.s.score - b.path.length * 1.5 - (a.s.score - a.path.length * 1.5));
    if (candidates.length === 0) {
      return {
        phase: "setup",
        heading: "Place your road",
        spots: [],
        roadEdges: [],
        note: "No strong expansion direction — any coastal-facing road is fine."
      };
    }
    const best = candidates[0];
    return {
      phase: "setup",
      heading: "Place your road here (dashed)",
      spots: candidates.slice(0, 2).map((c, i) => ({
        vertexId: c.s.vertexId,
        rank: i + 1,
        label: `${describeVertex(state, c.s.vertexId)} — ${c.path.length} road${c.path.length > 1 ? "s" : ""} away`
      })),
      roadEdges: [best.path[0]],
      note: "The dashed edge points toward your best future settlement ①."
    };
  }
  function placementFacts(state, youPlayer, advice) {
    var _a;
    const network = /* @__PURE__ */ new Set();
    for (const b of state.buildings) if (b.player === youPlayer) network.add(b.vertexId);
    for (const r of state.roads) {
      if (r.player === youPlayer) {
        const e = state.board.edges[r.edgeId];
        network.add(e.a);
        network.add(e.b);
      }
    }
    const canPlaceSettlement = [...network].some((v) => isVertexBuildable(state, v));
    const yourSettlements = state.buildings.filter(
      (b) => b.player === youPlayer && b.kind === "settlement"
    );
    let cityUpgradeLabel = null;
    if (yourSettlements.length > 0) {
      const best = yourSettlements.reduce(
        (a, b) => vertexPips(state.board, a.vertexId) >= vertexPips(state.board, b.vertexId) ? a : b
      );
      cityUpgradeLabel = describeVertex(state, best.vertexId);
    }
    return {
      canPlaceSettlement,
      bestSpotLabel: ((_a = advice == null ? void 0 : advice.spots[0]) == null ? void 0 : _a.label) ?? null,
      hasRoadSuggestion: ((advice == null ? void 0 : advice.roadEdges.length) ?? 0) > 0,
      cityUpgradeLabel
    };
  }
  const TILE_FILL = {
    brick: "var(--brick)",
    wheat: "var(--wheat)",
    sheep: "var(--sheep)",
    ore: "var(--ore)",
    wood: "var(--wood)",
    desert: "var(--desert, #d8cba0)"
  };
  function renderMiniMap(state, marks) {
    const b = state.board;
    const S = 26;
    const xs = b.vertices.map((v) => v.x);
    const ys = b.vertices.map((v) => v.y);
    const minX = Math.min(...xs) - 0.5;
    const minY = Math.min(...ys) - 0.5;
    const w = Math.max(...xs) - minX + 0.5;
    const h = Math.max(...ys) - minY + 0.5;
    const px = (x) => ((x - minX) * S).toFixed(1);
    const py = (y) => ((y - minY) * S).toFixed(1);
    const parts = [];
    parts.push(
      `<svg viewBox="0 0 ${(w * S).toFixed(0)} ${(h * S).toFixed(0)}" style="width:100%;display:block" role="img" aria-label="board map with recommended placements">`
    );
    for (const hex of b.hexes) {
      const pts = hexCornerPoints(hex).map((p) => `${px(p.x)},${py(p.y)}`).join(" ");
      parts.push(`<polygon points="${pts}" fill="${TILE_FILL[hex.kind]}" stroke="var(--surface)" stroke-width="1.5" opacity="0.85"/>`);
      if (hex.token !== null) {
        const hot = hex.token === 6 || hex.token === 8;
        parts.push(
          `<circle cx="${px(hex.cx)}" cy="${py(hex.cy)}" r="7.5" fill="var(--surface)"/><text x="${px(hex.cx)}" y="${py(hex.cy)}" text-anchor="middle" dominant-baseline="central" font-size="9" font-weight="${hot ? 700 : 500}" fill="${hot ? "var(--brick)" : "var(--ink)"}">${hex.token}</text>`
        );
      }
    }
    for (const v of b.vertices) {
      if (v.port) {
        const label = v.port.ratio === 2 ? `2:1` : `3:1`;
        parts.push(
          `<text x="${px(v.x)}" y="${py(v.y)}" text-anchor="middle" dominant-baseline="central" font-size="5.5" fill="var(--ink-3)">${label}</text>`
        );
      }
    }
    for (const r of marks.roads) {
      const e = b.edges[r.edgeId];
      parts.push(
        `<line x1="${px(b.vertices[e.a].x)}" y1="${py(b.vertices[e.a].y)}" x2="${px(b.vertices[e.b].x)}" y2="${py(b.vertices[e.b].y)}" stroke="${COLONIST_COLORS[r.colorId] ?? "#888"}" stroke-width="3" stroke-linecap="round"/>`
      );
    }
    for (const edgeId of marks.roadEdges) {
      const e = b.edges[edgeId];
      parts.push(
        `<line x1="${px(b.vertices[e.a].x)}" y1="${py(b.vertices[e.a].y)}" x2="${px(b.vertices[e.b].x)}" y2="${py(b.vertices[e.b].y)}" stroke="var(--gold, #b8860b)" stroke-width="3.5" stroke-dasharray="4 3" stroke-linecap="round"/>`
      );
    }
    for (const bd of marks.buildings) {
      const v = b.vertices[bd.vertexId];
      const c = COLONIST_COLORS[bd.colorId] ?? "#888";
      if (bd.kind === "city") {
        parts.push(`<rect x="${(parseFloat(px(v.x)) - 4.5).toFixed(1)}" y="${(parseFloat(py(v.y)) - 4.5).toFixed(1)}" width="9" height="9" fill="${c}" stroke="var(--surface)" stroke-width="1.2"/>`);
      } else {
        parts.push(`<circle cx="${px(v.x)}" cy="${py(v.y)}" r="4" fill="${c}" stroke="var(--surface)" stroke-width="1.2"/>`);
      }
    }
    for (const s of marks.spots) {
      const v = b.vertices[s.vertexId];
      parts.push(
        `<circle cx="${px(v.x)}" cy="${py(v.y)}" r="7" fill="var(--gold, #b8860b)" stroke="var(--surface)" stroke-width="1.5"/><text x="${px(v.x)}" y="${py(v.y)}" text-anchor="middle" dominant-baseline="central" font-size="8.5" font-weight="700" fill="#fff">${s.rank}</text>`
      );
    }
    parts.push("</svg>");
    return parts.join("");
  }
  const STORAGE_KEY$1 = "catanCopilot:games";
  function loadRecords() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY$1) ?? "[]");
    } catch {
      return [];
    }
  }
  function recordGameEnd(state) {
    if (state.gameOver === false || !state.youName) return null;
    const you = state.players.get(state.youName);
    if (!you) return null;
    const prod = expectedProduction(you);
    let best = STRATEGIES[0];
    let bestScore = -Infinity;
    for (const s of STRATEGIES) {
      const score = RESOURCES.reduce((sum2, r) => sum2 + prod[r] * s.weights[r], 0);
      if (score > bestScore) {
        bestScore = score;
        best = s;
      }
    }
    const rec = {
      at: Date.now(),
      win: state.gameOver === state.youName,
      strategyId: best.id,
      players: state.players.size
    };
    try {
      const all = loadRecords();
      all.push(rec);
      localStorage.setItem(STORAGE_KEY$1, JSON.stringify(all.slice(-100)));
    } catch {
    }
    return rec;
  }
  function strategyPriors(records) {
    const out = {};
    for (const s of STRATEGIES) {
      const rel = records.filter((r) => r.strategyId === s.id);
      const wins = rel.filter((r) => r.win).length;
      const losses = rel.length - wins;
      const nudge = 0.08 * (wins - losses) / Math.max(3, rel.length);
      out[s.id] = Math.min(1.15, Math.max(0.85, 1 + nudge));
    }
    return out;
  }
  function recordSummary(records) {
    if (records.length === 0) return null;
    const wins = records.filter((r) => r.win).length;
    return `${records.length} game${records.length > 1 ? "s" : ""} recorded, ${wins}W-${records.length - wins}L — results feed back into strategy scores.`;
  }
  const CSS = `
#catan-copilot {
  --surface: #fcfcfb; --ink: #0b0b0b; --ink-2: #52514e; --ink-3: #898781;
  --hairline: #e1e0d9; --accent: #4a3aa7; --bar: #2a78d6;
  --brick: #b5432a; --wheat: #e2a41a; --sheep: #58b47a; --ore: #4f6bb0; --wood: #268c46;
  --desert: #d8cba0; --gold: #b8860b;
  position: fixed; top: 70px; right: 12px; width: 320px; max-height: 82vh;
  z-index: 2147483000; background: var(--surface); color: var(--ink);
  border: 1px solid var(--hairline); border-radius: 10px;
  box-shadow: 0 6px 24px rgba(0,0,0,0.25);
  font: 12px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
  display: flex; flex-direction: column;
}
@media (prefers-color-scheme: dark) {
  #catan-copilot {
    --surface: #1a1a19; --ink: #ffffff; --ink-2: #c3c2b7; --ink-3: #898781;
    --hairline: #2c2c2a; --accent: #9085e9; --bar: #3987e5;
    --brick: #df6350; --wheat: #8d610b; --sheep: #47a76b; --ore: #6f89cc; --wood: #2f9e55;
    --desert: #55503e; --gold: #d4a017;
  }
}
#catan-copilot header {
  display: flex; align-items: center; gap: 8px; padding: 8px 12px;
  border-bottom: 1px solid var(--hairline); cursor: grab; user-select: none;
}
#catan-copilot header strong { font-size: 13px; flex: 1; }
#catan-copilot header button {
  background: none; border: none; color: var(--ink-2); cursor: pointer;
  font-size: 13px; padding: 2px 6px;
}
#catan-copilot .cc-body { overflow-y: auto; padding: 10px 12px 12px; }
#catan-copilot h4 {
  margin: 12px 0 6px; font-size: 11px; text-transform: uppercase;
  letter-spacing: .06em; color: var(--ink-3);
}
#catan-copilot h4:first-child { margin-top: 0; }
#catan-copilot .cc-note { color: var(--ink-2); margin: 3px 0; }
#catan-copilot .cc-muted { color: var(--ink-3); }
#catan-copilot .cc-deck { display: grid; grid-template-columns: repeat(11, 1fr); gap: 3px; align-items: end; }
#catan-copilot .cc-deck .col { text-align: center; }
#catan-copilot .cc-deck .bar {
  width: 100%; background: var(--bar); border-radius: 3px 3px 0 0; margin: 0 auto;
  min-height: 2px;
}
#catan-copilot .cc-deck .bar.cold { opacity: .25; }
#catan-copilot .cc-deck .n { color: var(--ink-2); margin-top: 2px; }
#catan-copilot .cc-deck .n.due { color: var(--ink); font-weight: 700; }
#catan-copilot .cc-deck .c { color: var(--ink-3); font-variant-numeric: tabular-nums; }
#catan-copilot table { width: 100%; border-collapse: collapse; }
#catan-copilot td, #catan-copilot th {
  padding: 2px 4px; text-align: right; font-variant-numeric: tabular-nums;
}
#catan-copilot th { color: var(--ink-3); font-weight: 500; }
#catan-copilot td:first-child, #catan-copilot th:first-child { text-align: left; }
#catan-copilot .dot {
  display: inline-block; width: 8px; height: 8px; border-radius: 50%;
  margin-right: 5px; border: 1px solid rgba(128,128,128,.5); vertical-align: 0;
}
#catan-copilot .cc-card {
  border: 1px solid var(--hairline); border-radius: 8px; padding: 8px 10px; margin: 6px 0;
}
#catan-copilot .cc-card.rec { border-color: var(--accent); border-width: 2px; }
#catan-copilot .cc-card .t { font-weight: 600; display: flex; justify-content: space-between; }
#catan-copilot .cc-card .tag { color: var(--ink-2); }
#catan-copilot .cc-card ul { margin: 4px 0 0; padding-left: 16px; color: var(--ink-2); }
#catan-copilot .cc-badge {
  background: var(--accent); color: #fff; border-radius: 8px; padding: 0 6px;
  font-size: 10px; font-weight: 700;
}
/* Resource chip: a labeled pill — colour AND a 2-letter code, so it reads the
   same with any colour vision (dual-encoded, not colour-alone). */
#catan-copilot .res {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 22px; height: 17px; padding: 0 4px; margin: 0 1px;
  border-radius: 5px; border: 1px solid rgba(0,0,0,.22);
  font-size: 11px; font-weight: 800; letter-spacing: .02em; line-height: 1;
  color: #fff; text-shadow: 0 1px 1px rgba(0,0,0,.35); vertical-align: -4px;
}
#catan-copilot .res::before { content: ""; }
#catan-copilot .res.wood  { background: var(--wood); }
#catan-copilot .res.wood::before  { content: "Wd"; }
#catan-copilot .res.brick { background: var(--brick); }
#catan-copilot .res.brick::before { content: "Br"; }
#catan-copilot .res.sheep { background: var(--sheep); }
#catan-copilot .res.sheep::before { content: "Sh"; }
#catan-copilot .res.wheat { background: var(--wheat); }
#catan-copilot .res.wheat::before { content: "Wh"; }
#catan-copilot .res.ore   { background: var(--ore); }
#catan-copilot .res.ore::before   { content: "Or"; }
/* light chips (wheat/sheep) read better with dark ink */
#catan-copilot .res.wheat, #catan-copilot .res.sheep {
  color: #0b0b0b; text-shadow: none; border-color: rgba(0,0,0,.3);
}
#catan-copilot-toggle {
  position: fixed; top: 70px; right: 12px; z-index: 2147483001;
  background: #4a3aa7; color: #fff; border: none; border-radius: 16px;
  padding: 5px 12px; font: 600 12px system-ui, sans-serif; cursor: pointer;
  display: none;
}
#catan-copilot .cc-hist {
  max-height: 176px; overflow-y: auto; border: 1px solid var(--hairline);
  border-radius: 8px; padding: 2px 8px; margin-top: 4px;
}
#catan-copilot .cc-hist .row {
  display: flex; gap: 6px; padding: 2px 4px; font-size: 12px; line-height: 1.35;
  border-bottom: 1px solid var(--hairline);
}
#catan-copilot .cc-hist .row:last-child { border-bottom: none; }
#catan-copilot .cc-hist .who { color: var(--ink-2); font-weight: 600; white-space: nowrap; }
#catan-copilot .cc-hist .row.mine { border-radius: 4px; background: rgba(74,58,167,.08); }
#catan-copilot .cc-hist .row.mine .who { color: var(--accent); }
#catan-copilot .cc-hist .what { color: var(--ink-2); }
#catan-copilot .cc-h4row { display: flex; align-items: baseline; justify-content: space-between; }
#catan-copilot .cc-h4row button { font-size: 11px; padding: 1px 7px; }
`;
  function esc(s) {
    return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  }
  class Overlay {
    constructor(doc, hooks = {}) {
      __publicField(this, "root");
      __publicField(this, "body");
      __publicField(this, "toggle");
      __publicField(this, "hooks");
      this.hooks = hooks;
      const style = doc.createElement("style");
      style.textContent = CSS;
      doc.head.appendChild(style);
      this.root = doc.createElement("div");
      this.root.id = "catan-copilot";
      this.root.innerHTML = `
      <header>
        <strong>Catan Copilot</strong>
        <button data-act="hide" title="Hide">–</button>
      </header>
      <div class="cc-body"><p class="cc-note">Waiting for game log…</p></div>`;
      doc.body.appendChild(this.root);
      this.toggle = doc.createElement("button");
      this.toggle.id = "catan-copilot-toggle";
      this.toggle.textContent = "Copilot";
      doc.body.appendChild(this.toggle);
      this.body = this.root.querySelector(".cc-body");
      this.root.querySelector('[data-act="hide"]').addEventListener("click", () => {
        this.root.style.display = "none";
        this.toggle.style.display = "block";
      });
      this.root.addEventListener("click", (e) => {
        var _a, _b, _c, _d, _e, _f;
        const target = e.target;
        if (target.closest('[data-act="download-capture"]')) {
          (_b = (_a = this.hooks).onDownloadCapture) == null ? void 0 : _b.call(_a);
        }
        if (target.closest('[data-act="download-history"]')) {
          (_d = (_c = this.hooks).onDownloadHistory) == null ? void 0 : _d.call(_c);
        }
        const toggle = target.closest('[data-act="toggle-autopilot"]');
        if (toggle) {
          (_f = (_e = this.hooks).onToggleAutopilot) == null ? void 0 : _f.call(_e, toggle.checked);
        }
      });
      this.toggle.addEventListener("click", () => {
        this.root.style.display = "flex";
        this.toggle.style.display = "none";
      });
      this.makeDraggable(doc);
    }
    makeDraggable(doc) {
      const header = this.root.querySelector("header");
      let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
      header.addEventListener("mousedown", (e) => {
        dragging = true;
        sx = e.clientX;
        sy = e.clientY;
        const rect = this.root.getBoundingClientRect();
        ox = rect.left;
        oy = rect.top;
        e.preventDefault();
      });
      doc.addEventListener("mousemove", (e) => {
        if (!dragging) return;
        this.root.style.left = `${ox + e.clientX - sx}px`;
        this.root.style.top = `${oy + e.clientY - sy}px`;
        this.root.style.right = "auto";
      });
      doc.addEventListener("mouseup", () => dragging = false);
    }
    render(state, bridge2) {
      var _a, _b;
      const parts = [];
      let gs = null;
      let advice = null;
      if (bridge2 == null ? void 0 : bridge2.board) {
        gs = bridge2.toGameState();
        if (gs) advice = advisePlacement(gs.state, gs.youPlayer);
      }
      const you = state.youName;
      const fits = you && state.players.has(you) ? rankLiveStrategies(state, you, strategyPriors(loadRecords())) : [];
      if (you && fits.length > 0) {
        let facts = null;
        if (gs && gs.youPlayer !== null) {
          facts = placementFacts(gs.state, gs.youPlayer, advice);
        }
        const inSetup = (advice == null ? void 0 : advice.phase) === "setup" || state.rolls.length === 0;
        if (!inSetup) {
          parts.push(this.renderYourMove(nextMoves(state, you, fits[0], facts)));
        }
      }
      parts.push(this.renderWhereToBuild(bridge2 ?? null, gs, advice));
      parts.push(this.renderDeck(deckStatus(state), state));
      parts.push(this.renderPlayers(state));
      if (you && fits.length > 0) {
        parts.push(this.renderStrategies(fits));
        const robber = robberAdvice(state);
        if (robber) {
          parts.push(`<h4>Robber</h4><p class="cc-note">${esc(robber.reason)}</p>`);
        }
        const tips = tradeTips$1(state, you, fits[0]);
        if (tips.length) parts.push(this.renderTrades(tips, isOneVsOne(state)));
      } else {
        parts.push(
          `<h4>You</h4><p class="cc-note cc-muted">Sign-in name not detected yet — strategy advice appears once you're identified.</p>`
        );
      }
      if (state.gameOver) {
        parts.unshift(`<p class="cc-note"><strong>${esc(state.gameOver)}</strong> won the game.</p>`);
      }
      if ((_b = (_a = this.hooks).needsRefresh) == null ? void 0 : _b.call(_a)) {
        parts.unshift(
          `<p class="cc-note" style="color:var(--brick);font-weight:600">⟳ Reload this tab! The game socket isn't captured — exact hands, the board map and full autopilot need it. (Colonist resends everything on refresh.)</p>`
        );
      }
      parts.push(this.renderHistory());
      parts.push(this.renderAutopilot());
      this.body.innerHTML = parts.join("");
    }
    renderHistory() {
      var _a, _b;
      const hist = ((_b = (_a = this.hooks).getHistory) == null ? void 0 : _b.call(_a)) ?? [];
      if (hist.length === 0) return "";
      const rows = hist.slice(-60).reverse().map(
        (e) => `<div class="row${e.mine ? " mine" : ""}"><span class="who">${esc(e.player ?? "?")}</span><span class="what">${esc(e.text)}</span></div>`
      ).join("");
      return `
      <div class="cc-h4row">
        <h4>Move history (${hist.length})</h4>
        <button data-act="download-history" title="Save as text">save</button>
      </div>
      <div class="cc-hist">${rows}</div>`;
    }
    renderAutopilot() {
      var _a, _b, _c, _d;
      const ap = (_b = (_a = this.hooks).getAutopilotView) == null ? void 0 : _b.call(_a);
      if (!ap) return "";
      const record = recordSummary(loadRecords());
      const captured = ((_d = (_c = this.hooks).captureCount) == null ? void 0 : _d.call(_c)) ?? 0;
      return `
      <h4>Autopilot</h4>
      <p class="cc-note">
        <label><input type="checkbox" data-act="toggle-autopilot" ${ap.enabled ? "checked" : ""}/>
        <strong>Play my turns</strong></label>
        <span class="cc-muted"> — ${esc(ap.note)}</span>
      </p>
      <p class="cc-note cc-muted">Plays your turn through colonist's own protocol: rolls, builds
      settlements, roads and cities (setup and mid-game), buys dev cards, bank-trades toward builds,
      plays a monopoly when opponents are card-rich, moves the robber and steals, discards on a 7,
      ends the turn. Knights and other dev cards still fall back to advice you act on. Use in bot
      matches or games where everyone consents — automation can get accounts banned on ranked
      play.</p>
      ${record ? `<p class="cc-note cc-muted">${esc(record)}</p>` : ""}
      ${captured > 0 ? `<p class="cc-note cc-muted">${captured} protocol frames captured — <button data-act="download-capture" style="font-size:11px;padding:1px 7px">download</button> for debugging.</p>` : ""}`;
    }
    renderYourMove(actions) {
      if (actions.length === 0) return "";
      const items = actions.map(
        (a) => `<p class="cc-note${a.primary ? "" : " cc-muted"}">${a.primary ? "▶ " : ""}${esc(a.text)}</p>`
      ).join("");
      return `<div class="cc-card rec"><div class="t"><span>Your move</span></div>${items}</div>`;
    }
    renderWhereToBuild(bridge2, gs, advice) {
      if (!bridge2 || !bridge2.board) {
        return `<h4>Where to build</h4><p class="cc-note cc-muted">Board not captured yet — refresh the page during the game so the copilot can read the board state.</p>`;
      }
      if (!gs || !advice) return "";
      const map = renderMiniMap(gs.state, {
        spots: advice.spots,
        roadEdges: advice.roadEdges,
        buildings: bridge2.buildings,
        roads: bridge2.roads
      });
      const circled = ["①", "②", "③"];
      const list = advice.spots.map((s) => `<p class="cc-note">${circled[s.rank - 1] ?? s.rank} ${esc(s.label)}</p>`).join("");
      return `
      <h4>${esc(advice.heading)}</h4>
      ${map}
      ${list}
      ${advice.note ? `<p class="cc-note cc-muted">${esc(advice.note)}</p>` : ""}`;
    }
    renderDeck(deck, state) {
      const cols = [];
      const maxCards = 6;
      for (let n = 2; n <= 12; n++) {
        const left = deck.remaining.get(n) ?? 0;
        const h = Math.round(left / maxCards * 34);
        const due = deck.due.includes(n);
        cols.push(`
        <div class="col">
          <div class="c">${left}</div>
          <div class="bar${left === 0 ? " cold" : ""}" style="height:${Math.max(2, h)}px"></div>
          <div class="n${due ? " due" : ""}">${n}</div>
        </div>`);
      }
      const yourNumbers = [];
      if (state.youName) {
        const you = state.players.get(state.youName);
        if (you) yourNumbers.push(...[...you.incomeByNumber.keys()].sort((a, b) => a - b));
      }
      let hitLine = "";
      if (yourNumbers.length > 0) {
        const pHit = yourNumbers.reduce((s, n) => s + (deck.prob.get(n) ?? 0), 0);
        hitLine = `<p class="cc-note">Your numbers (${yourNumbers.join(", ")}) hit the next roll with <strong>${Math.round(pHit * 100)}%</strong>.</p>`;
      }
      const dueLine = deck.due.length ? `<p class="cc-note">Over-due: <strong>${deck.due.join(", ")}</strong>. Exhausted: ${deck.cold.length ? deck.cold.join(", ") : "none"}.</p>` : "";
      return `
      <h4>Balanced-dice deck <span class="cc-muted">(${36 - deck.rollsIntoDeck} cards left, count above each bar)</span></h4>
      <div class="cc-deck">${cols.join("")}</div>
      ${hitLine}${dueLine}`;
    }
    renderPlayers(state) {
      if (state.players.size === 0) return "";
      const rows = [...state.players.values()].sort((a, b) => visibleVp(b) - visibleVp(a)).map((p) => {
        const prodPips = Math.round(productionTotal(expectedProduction(p)) * 36);
        const total = p.serverCards ?? handTotal(p);
        const cards = `${total}${p.uncertainty && p.serverCards === null ? `±${p.uncertainty}` : ""}`;
        const hand = RESOURCES.filter((r) => p.hand[r] > 0).map((r) => `<span class="res ${r}"></span>&#8202;${p.hand[r]}`).join(" &nbsp; ");
        return `
          <tr>
            <td><span class="dot" style="background:${esc(p.color)}"></span>${esc(p.name)}${state.youName === p.name ? " <span class='cc-muted'>(you)</span>" : ""}</td>
            <td>${visibleVp(p)}</td>
            <td title="known hand">${cards}</td>
            <td>${prodPips}</td>
            <td>${p.devCards}/${p.knightsPlayed}</td>
          </tr>
          ${hand ? `<tr><td colspan="5" class="cc-muted" style="text-align:left;padding-left:18px">${hand}</td></tr>` : ""}`;
      });
      const mode = isOneVsOne(state) ? ` <span class="cc-muted">(1v1 — first to 15 VP)</span>` : "";
      return `
      <h4>Players${mode}</h4>
      <table>
        <tr><th>Player</th><th>VP</th><th>Cards</th><th>Pips</th><th>Dev/Kn</th></tr>
        ${rows.join("")}
      </table>`;
    }
    renderStrategies(fits) {
      if (fits.length === 0) return "";
      const cards = fits.slice(0, 3).map((f, i) => {
        const rec = i === 0;
        return `
        <div class="cc-card${rec ? " rec" : ""}">
          <div class="t"><span>${esc(f.strategy.name)}</span>${rec ? '<span class="cc-badge">RECOMMENDED</span>' : `<span class="cc-muted">~${f.simVp.toFixed(1)} VP</span>`}</div>
          <div class="tag">${esc(f.strategy.tagline)}</div>
          ${rec ? `<div class="cc-muted">Simulated ~${f.simVp.toFixed(1)} VP added over the next 25 turns (balanced dice, 30 trials)</div>` : ""}
          ${f.rationale.length ? `<ul>${f.rationale.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>` : ""}
        </div>`;
      });
      return `<h4>Your strategy</h4>${cards.join("")}`;
    }
    renderTrades(tips, oneVsOne) {
      const heading = oneVsOne ? "Bank & ports (no player trades in 1v1)" : "Trading";
      return `<h4>${heading}</h4>${tips.map((t) => `<p class="cc-note">${esc(t.text)}</p>`).join("")}`;
    }
  }
  const STATE_EVENT = { GAME_META: 1, INIT: 4, DIFF: 91 };
  const TILE_TYPE = {
    0: "desert",
    1: "wood",
    2: "brick",
    3: "sheep",
    4: "wheat",
    5: "ore"
  };
  const CARD_ID = {
    1: "wood",
    2: "brick",
    3: "sheep",
    4: "wheat",
    5: "ore"
  };
  const PORT_TYPE = {
    1: "any",
    2: "wood",
    3: "brick",
    4: "sheep",
    5: "wheat",
    6: "ore"
  };
  const TURN_ROLL = 1;
  const TURN_MAIN = 2;
  function deepMerge(target, src) {
    for (const key of Object.keys(src)) {
      const v = src[key];
      const cur = target[key];
      if (v && typeof v === "object" && !Array.isArray(v) && cur && typeof cur === "object" && !Array.isArray(cur)) {
        deepMerge(cur, v);
      } else {
        target[key] = v;
      }
    }
  }
  class StateBridge {
    constructor() {
      __publicField(this, "state", {});
      __publicField(this, "myColor", null);
      __publicField(this, "colorToName", /* @__PURE__ */ new Map());
      __publicField(this, "colorIsBot", /* @__PURE__ */ new Map());
      __publicField(this, "board", null);
      __publicField(this, "robberHex", null);
      /** colonist send-channel id (serverId), needed to build outbound frames */
      __publicField(this, "serverId", null);
      /** friendly robber: can't rob a player with < 3 public VP */
      __publicField(this, "friendlyRobber", false);
      __publicField(this, "boardTilesKey", "");
      /** engine vertex id -> colonist corner index, and edge id -> edge index */
      __publicField(this, "vertexToCorner", /* @__PURE__ */ new Map());
      __publicField(this, "edgeToIndex", /* @__PURE__ */ new Map());
    }
    reset() {
      this.state = {};
      this.myColor = null;
      this.colorToName.clear();
      this.colorIsBot.clear();
      this.board = null;
      this.robberHex = null;
      this.friendlyRobber = false;
      this.boardTilesKey = "";
      this.vertexToCorner.clear();
      this.edgeToIndex.clear();
    }
    /** Feed a decoded frame. Returns true if it advanced game state. */
    apply(type, payload) {
      var _a, _b, _c;
      if (type === STATE_EVENT.GAME_META) {
        const id = payload == null ? void 0 : payload.serverId;
        if (id) this.serverId = id;
        return false;
      }
      if (type === STATE_EVENT.INIT) {
        const p = payload;
        this.reset();
        if (typeof (p == null ? void 0 : p.playerColor) === "number") this.myColor = p.playerColor;
        this.friendlyRobber = ((_a = p == null ? void 0 : p.gameSettings) == null ? void 0 : _a.friendlyRobber) === true;
        for (const u of (p == null ? void 0 : p.playerUserStates) ?? []) {
          if ((u == null ? void 0 : u.username) && typeof u.selectedColor === "number") {
            this.colorToName.set(u.selectedColor, u.username);
            this.colorIsBot.set(u.selectedColor, !!u.isBot);
          }
        }
        this.state = (p == null ? void 0 : p.gameState) ?? {};
        this.rebuildBoard();
        this.syncRobber();
        return true;
      }
      if (type === STATE_EVENT.DIFF) {
        const diff = payload == null ? void 0 : payload.diff;
        if (!diff) return false;
        deepMerge(this.state, diff);
        if ((_b = diff.mapState) == null ? void 0 : _b.tileHexStates) this.rebuildBoard();
        if (diff.mechanicRobberState || ((_c = diff.mapState) == null ? void 0 : _c.tileHexStates)) this.syncRobber();
        return true;
      }
      return false;
    }
    // ---------------------------------------------------------------- turn/roll
    get currentTurnColor() {
      var _a;
      return ((_a = this.state.currentState) == null ? void 0 : _a.currentTurnPlayerColor) ?? null;
    }
    get turnState() {
      var _a;
      return ((_a = this.state.currentState) == null ? void 0 : _a.turnState) ?? null;
    }
    get diceThrown() {
      var _a;
      return ((_a = this.state.diceState) == null ? void 0 : _a.diceThrown) === true;
    }
    /** dev cards left in the bank, or null if the state hasn't shown them yet */
    get bankDevCards() {
      var _a, _b;
      const cards = (_b = (_a = this.state.mechanicDevelopmentCardsState) == null ? void 0 : _a.bankDevelopmentCards) == null ? void 0 : _b.cards;
      return Array.isArray(cards) ? cards.length : null;
    }
    /** a player's total public victory points (sum of victoryPointsState). */
    publicVp(color) {
      var _a, _b;
      const vp = (_b = (_a = this.state.playerStates) == null ? void 0 : _a[String(color)]) == null ? void 0 : _b.victoryPointsState;
      if (!vp) return 0;
      return Object.values(vp).reduce((s, n) => s + (n ?? 0), 0);
    }
    /** our own dev-card type ids (playable ones we hold), e.g. 13 = monopoly */
    myDevCardIds() {
      var _a, _b, _c, _d;
      if (this.myColor === null) return [];
      const cards = (_d = (_c = (_b = (_a = this.state.mechanicDevelopmentCardsState) == null ? void 0 : _a.players) == null ? void 0 : _b[String(this.myColor)]) == null ? void 0 : _c.developmentCards) == null ? void 0 : _d.cards;
      return Array.isArray(cards) ? cards.slice() : [];
    }
    /** Building pieces still in a player's supply (null = state not seen yet). */
    piecesLeft(color) {
      var _a, _b, _c, _d, _e, _f;
      const key = String(color);
      return {
        settlements: ((_b = (_a = this.state.mechanicSettlementState) == null ? void 0 : _a[key]) == null ? void 0 : _b.bankSettlementAmount) ?? null,
        cities: ((_d = (_c = this.state.mechanicCityState) == null ? void 0 : _c[key]) == null ? void 0 : _d.bankCityAmount) ?? null,
        roads: ((_f = (_e = this.state.mechanicRoadState) == null ? void 0 : _e[key]) == null ? void 0 : _f.bankRoadAmount) ?? null
      };
    }
    get isMyTurn() {
      return this.myColor !== null && this.currentTurnColor === this.myColor;
    }
    /** My turn, in the roll phase, dice not yet thrown → I must roll now. */
    get needsRoll() {
      return this.isMyTurn && this.turnState === TURN_ROLL && !this.diceThrown;
    }
    /** My turn, past the roll (build/trade phase). */
    get inMainPhase() {
      return this.isMyTurn && (this.turnState === TURN_MAIN || this.diceThrown);
    }
    // ---------------------------------------------------------------- board
    rebuildBoard() {
      var _a, _b, _c, _d;
      const tiles = (_a = this.state.mapState) == null ? void 0 : _a.tileHexStates;
      if (!tiles) return;
      const key = Object.values(tiles).map((t) => `${t.x},${t.y},${t.type},${t.diceNumber}`).join("|");
      if (key === this.boardTilesKey && this.board) return;
      this.boardTilesKey = key;
      this.board = buildBoard(
        0,
        Object.values(tiles).map((t) => {
          const kind = TILE_TYPE[t.type] ?? "desert";
          return { q: t.x, r: t.y, kind, token: kind === "desert" || !t.diceNumber ? null : t.diceNumber };
        })
      );
      for (const pe of Object.values(((_b = this.state.mapState) == null ? void 0 : _b.portEdgeStates) ?? {})) {
        const kind = PORT_TYPE[pe.type] ?? "any";
        const port = { kind, ratio: kind === "any" ? 3 : 2 };
        for (const pt of colonistEdgeToPixels(pe)) {
          const v = findVertexAt(this.board, pt.x, pt.y);
          if (v) v.port = { ...port };
        }
      }
      this.vertexToCorner.clear();
      this.edgeToIndex.clear();
      for (const [idx, c] of Object.entries(((_c = this.state.mapState) == null ? void 0 : _c.tileCornerStates) ?? {})) {
        const pt = colonistCornerToPixel(c);
        const v = findVertexAt(this.board, pt.x, pt.y);
        if (v) this.vertexToCorner.set(v.id, Number(idx));
      }
      for (const [idx, e] of Object.entries(((_d = this.state.mapState) == null ? void 0 : _d.tileEdgeStates) ?? {})) {
        const [p1, p2] = colonistEdgeToPixels(e);
        const va = findVertexAt(this.board, p1.x, p1.y);
        const vb = findVertexAt(this.board, p2.x, p2.y);
        if (!va || !vb) continue;
        const edge = findEdgeBetween(this.board, va.id, vb.id);
        if (edge) this.edgeToIndex.set(edge.id, Number(idx));
      }
    }
    /** colonist corner index for an engine vertex (settlement/city payload). */
    cornerIndexForVertex(vertexId) {
      return this.vertexToCorner.get(vertexId) ?? null;
    }
    /** colonist edge index for an engine edge (road payload). */
    edgeIndexForEdge(edgeId) {
      return this.edgeToIndex.get(edgeId) ?? null;
    }
    /** colonist tile (hex) index at axial q,r (robber payload). */
    tileIndexForHex(q, r) {
      var _a;
      for (const [idx, t] of Object.entries(((_a = this.state.mapState) == null ? void 0 : _a.tileHexStates) ?? {})) {
        if (t.x === q && t.y === r) return Number(idx);
      }
      return null;
    }
    /** corner index whose stored {x,y,z} equals the given colonist coord. */
    cornerIndexForCoord(c) {
      var _a;
      for (const [idx, s] of Object.entries(((_a = this.state.mapState) == null ? void 0 : _a.tileCornerStates) ?? {})) {
        if (s.x === c.x && s.y === c.y && s.z === (c.z ?? s.z)) return Number(idx);
      }
      return null;
    }
    /** edge index whose stored {x,y,z} equals the given colonist coord. */
    edgeIndexForCoord(c) {
      var _a;
      for (const [idx, s] of Object.entries(((_a = this.state.mapState) == null ? void 0 : _a.tileEdgeStates) ?? {})) {
        if (s.x === c.x && s.y === c.y && s.z === (c.z ?? s.z)) return Number(idx);
      }
      return null;
    }
    /** Opponent colors with a building on the given tile index, richest first. */
    opponentsOnTile(tileIndex) {
      var _a, _b;
      if (!this.board) return [];
      const tile = (_b = (_a = this.state.mapState) == null ? void 0 : _a.tileHexStates) == null ? void 0 : _b[String(tileIndex)];
      if (!tile) return [];
      const hex = this.board.hexes.find((h) => h.q === tile.x && h.r === tile.y);
      if (!hex) return [];
      return this.buildings.filter(
        (b) => b.colorId !== this.myColor && this.board.vertices[b.vertexId].hexIds.includes(hex.id)
      ).sort((a, b) => this.handOf(b.colorId).total - this.handOf(a.colorId).total).map((b) => b.colorId);
    }
    syncRobber() {
      var _a, _b;
      const idx = (_a = this.state.mechanicRobberState) == null ? void 0 : _a.locationTileIndex;
      const tiles = (_b = this.state.mapState) == null ? void 0 : _b.tileHexStates;
      if (idx === void 0 || !tiles) return;
      const tile = tiles[String(idx)];
      if (tile) this.robberHex = { x: tile.x, y: tile.y };
    }
    get buildings() {
      var _a;
      if (!this.board) return [];
      const out = [];
      for (const c of Object.values(((_a = this.state.mapState) == null ? void 0 : _a.tileCornerStates) ?? {})) {
        if (c.owner === void 0 || c.buildingType === void 0) continue;
        const pt = colonistCornerToPixel(c);
        const v = findVertexAt(this.board, pt.x, pt.y);
        if (v) out.push({ vertexId: v.id, colorId: c.owner, kind: c.buildingType === 2 ? "city" : "settlement" });
      }
      return out;
    }
    get roads() {
      var _a;
      if (!this.board) return [];
      const out = [];
      for (const e of Object.values(((_a = this.state.mapState) == null ? void 0 : _a.tileEdgeStates) ?? {})) {
        if (e.owner === void 0) continue;
        const [p1, p2] = colonistEdgeToPixels(e);
        const va = findVertexAt(this.board, p1.x, p1.y);
        const vb = findVertexAt(this.board, p2.x, p2.y);
        if (!va || !vb) continue;
        const edge = findEdgeBetween(this.board, va.id, vb.id);
        if (edge) out.push({ edgeId: edge.id, colorId: e.owner });
      }
      return out;
    }
    // ---------------------------------------------------------------- hands
    /** Exact resource counts for a color; opponents' cards are masked (id 0). */
    handOf(color) {
      var _a, _b, _c;
      const cards = ((_c = (_b = (_a = this.state.playerStates) == null ? void 0 : _a[String(color)]) == null ? void 0 : _b.resourceCards) == null ? void 0 : _c.cards) ?? [];
      const known = {};
      for (const id of cards) {
        const r = CARD_ID[id];
        if (r) known[r] = (known[r] ?? 0) + 1;
      }
      return { total: cards.length, known };
    }
    discardLimit(color) {
      var _a, _b;
      return ((_b = (_a = this.state.playerStates) == null ? void 0 : _a[String(color)]) == null ? void 0 : _b.cardDiscardLimit) ?? null;
    }
    bankRatios(color) {
      var _a, _b;
      const raw = ((_b = (_a = this.state.playerStates) == null ? void 0 : _a[String(color)]) == null ? void 0 : _b.bankTradeRatiosState) ?? {};
      const out = {};
      for (const [id, ratio] of Object.entries(raw)) {
        const r = CARD_ID[Number(id)];
        if (r) out[r] = ratio;
      }
      return out;
    }
    // ---------------------------------------------------------------- engine view
    colorOrder() {
      return [...this.colorToName.keys()].sort((a, b) => a - b);
    }
    toGameState() {
      if (!this.board) return null;
      const order = this.colorOrder();
      const toPid = (c) => Math.min(3, Math.max(0, order.indexOf(c)));
      const state = {
        board: this.board,
        buildings: this.buildings.map((b) => ({ vertexId: b.vertexId, player: toPid(b.colorId), kind: b.kind })),
        roads: this.roads.map((r) => ({ edgeId: r.edgeId, player: toPid(r.colorId) }))
      };
      const youPlayer = this.myColor !== null && order.includes(this.myColor) ? toPid(this.myColor) : null;
      return { state, youPlayer };
    }
  }
  const ACTION_KINDS = [
    "build-settlement",
    "build-road",
    "build-city",
    "buy-dev",
    "roll",
    "end-turn",
    "move-robber",
    "discard",
    "play-knight",
    "play-monopoly",
    "bank-trade"
  ];
  const HEXFACE_ACTIONS = /* @__PURE__ */ new Set(["move-robber"]);
  const CARDS_ACTIONS = /* @__PURE__ */ new Set(["discard"]);
  const COORD_ACTIONS = /* @__PURE__ */ new Set([
    "build-settlement",
    "build-road",
    "build-city",
    "move-robber"
  ]);
  const STORAGE_KEY = "catanCopilot:protocol";
  const PAIR_WINDOW_MS = 5e3;
  function isCoordObject(v, hexFace) {
    if (typeof v !== "object" || v === null) return false;
    const o = v;
    if (!Number.isInteger(o.x) || !Number.isInteger(o.y)) return false;
    if (hexFace) {
      return o.z === void 0 && Object.keys(v).length <= 3;
    }
    return Number.isInteger(o.z) && Object.keys(v).length <= 4;
  }
  function findCoordPath(frame, hexFace, path = []) {
    if (isCoordObject(frame, hexFace)) return path;
    if (Array.isArray(frame)) {
      for (let i = 0; i < frame.length; i++) {
        const found = findCoordPath(frame[i], hexFace, [...path, String(i)]);
        if (found) return found;
      }
    } else if (typeof frame === "object" && frame !== null) {
      for (const [k, v] of Object.entries(frame)) {
        const found = findCoordPath(v, hexFace, [...path, k]);
        if (found) return found;
      }
    }
    return null;
  }
  function isCardIdArray(v) {
    return Array.isArray(v) && v.length > 0 && v.every((x) => Number.isInteger(x) && x >= 1 && x <= 5);
  }
  function findCardsPath(frame, path = []) {
    if (isCardIdArray(frame)) return path;
    if (Array.isArray(frame)) {
      for (let i = 0; i < frame.length; i++) {
        const found = findCardsPath(frame[i], [...path, String(i)]);
        if (found) return found;
      }
    } else if (typeof frame === "object" && frame !== null) {
      for (const [k, v] of Object.entries(frame)) {
        const found = findCardsPath(v, [...path, k]);
        if (found) return found;
      }
    }
    return null;
  }
  function getAtPath(obj, path) {
    let cur = obj;
    for (const key of path) {
      if (cur === null || typeof cur !== "object") return void 0;
      cur = cur[key];
    }
    return cur;
  }
  class ProtocolLearner {
    constructor() {
      __publicField(this, "templates", {});
      __publicField(this, "outbox", []);
      /** stats for shallow integer fields, to find sequence counters */
      __publicField(this, "seqStats", /* @__PURE__ */ new Map());
    }
    recordOutbound(frame, t = Date.now()) {
      this.outbox.push({ t, frame, used: false });
      if (this.outbox.length > 200) this.outbox.shift();
      this.trackSeqFields(frame);
    }
    trackSeqFields(frame, prefix = [], depth = 0) {
      if (depth > 2 || typeof frame !== "object" || frame === null || Array.isArray(frame)) return;
      for (const [k, v] of Object.entries(frame)) {
        if (typeof v === "number" && Number.isInteger(v)) {
          const key = [...prefix, k].join(".");
          const stat = this.seqStats.get(key);
          if (!stat) {
            this.seqStats.set(key, { last: v, seen: 1, increasing: true });
          } else {
            stat.increasing = stat.increasing && v > stat.last;
            stat.last = v;
            stat.seen++;
          }
        } else if (typeof v === "object" && v !== null && !Array.isArray(v)) {
          this.trackSeqFields(v, [...prefix, k], depth + 1);
        }
      }
    }
    /**
     * An action was confirmed (seen in the log / board events). Pair it with
     * the most recent unpaired outbound frame in the window; that frame is the
     * message that caused it. Later confirmations overwrite earlier templates,
     * so quality improves over a session.
     */
    confirm(kind, t = Date.now()) {
      for (let i = this.outbox.length - 1; i >= 0; i--) {
        const o = this.outbox[i];
        if (o.used || o.t > t || t - o.t > PAIR_WINDOW_MS) continue;
        o.used = true;
        const wantsCoord = COORD_ACTIONS.has(kind);
        const coordPath = wantsCoord ? findCoordPath(o.frame, HEXFACE_ACTIONS.has(kind)) : null;
        if (wantsCoord && !coordPath) continue;
        const wantsCards = CARDS_ACTIONS.has(kind);
        const cardsPath = wantsCards ? findCardsPath(o.frame) : null;
        if (wantsCards && !cardsPath) continue;
        this.templates[kind] = {
          frame: JSON.parse(JSON.stringify(o.frame)),
          coordPath,
          cardsPath,
          learnedAt: t
        };
        this.save();
        return;
      }
    }
    /** Produce a sendable frame for an action, or null if not learned yet. */
    buildFrame(kind, coord, cards) {
      const tpl = this.templates[kind];
      if (!tpl) return null;
      const frame = JSON.parse(JSON.stringify(tpl.frame));
      if (tpl.cardsPath) {
        if (!cards || cards.length === 0) return null;
        if (tpl.cardsPath.length === 0) return [...cards];
        const leaf = tpl.cardsPath[tpl.cardsPath.length - 1];
        const parent = getAtPath(frame, tpl.cardsPath.slice(0, -1));
        if (!parent || typeof parent !== "object") return null;
        parent[leaf] = [...cards];
      }
      if (tpl.coordPath) {
        if (!coord) return null;
        const target = getAtPath(frame, tpl.coordPath);
        if (!target) return null;
        target.x = coord.x;
        target.y = coord.y;
        if ("z" in target && coord.z !== void 0) target.z = coord.z;
      }
      for (const [key, stat] of this.seqStats) {
        if (!stat.increasing || stat.seen < 3) continue;
        const path = key.split(".");
        const parent = path.length === 1 ? frame : getAtPath(frame, path.slice(0, -1));
        const leaf = path[path.length - 1];
        if (parent && typeof parent === "object" && typeof parent[leaf] === "number") {
          parent[leaf] = stat.last + 1;
          stat.last = stat.last + 1;
        }
      }
      return frame;
    }
    /** Self-correction: a template that produced no confirmed effect is wrong. */
    discard(kind) {
      delete this.templates[kind];
      this.save();
    }
    status() {
      return Object.fromEntries(
        ACTION_KINDS.map((k) => [k, this.templates[k] !== void 0])
      );
    }
    learnedCount() {
      return ACTION_KINDS.filter((k) => this.templates[k]).length;
    }
    save() {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.templates));
      } catch {
      }
    }
    load() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) this.templates = JSON.parse(raw);
      } catch {
      }
    }
  }
  const MOVE_ROBBER_BANNER = /^(you (must|have to) )?((move|place|drop)( the)? robber|select .{0,20}robber)/i;
  const YOUR_TURN_BANNER = /\b(your turn|roll dice|build or trade|trade or build)\b/i;
  const DISCARD_BANNER = /^(select|choose).{0,25}discard|^discard (\d|cards|resources)/i;
  const PATTERNS = {
    // (?<![a-z]) keeps "roll" from matching inside scroll/scrollbar class names.
    roll: new RegExp("dice|(?<![a-z])roll", "i"),
    "end-turn": /end[_\s-]?turn|pass[_\s-]?turn|hourglass|fast[_\s-]?forward|skip/i,
    "buy-dev": /development|dev[_\s-]?card|card[_\s-]?back|buy[_\s-]?card/i
  };
  function rollPromptVisible(doc = document) {
    const controls = doc.querySelectorAll('button, [role="button"]');
    for (const el of controls) {
      if (el.closest("[data-index]") || el.closest("#catan-copilot")) continue;
      if (!PATTERNS.roll.test(labelOf(el))) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) return true;
    }
    return false;
  }
  function labelOf(el) {
    const img = el instanceof HTMLImageElement ? el : el.querySelector("img");
    return [
      el.getAttribute("aria-label"),
      el.getAttribute("title"),
      img == null ? void 0 : img.getAttribute("alt"),
      img == null ? void 0 : img.getAttribute("src"),
      el.id,
      el.className && typeof el.className === "string" ? el.className : ""
    ].filter(Boolean).join(" ");
  }
  function realClick(el) {
    const opts = { bubbles: true, cancelable: true };
    el.dispatchEvent(new PointerEvent("pointerdown", opts));
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    el.dispatchEvent(new PointerEvent("pointerup", opts));
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.click();
  }
  function tryDomAction(kind, doc = document, exclude) {
    const pattern = PATTERNS[kind];
    const attempt = (el, allowText) => {
      if (el.closest("[data-index]")) return null;
      if (el.closest("#catan-copilot")) return null;
      if (el.matches('button:disabled, [aria-disabled="true"]')) return null;
      const text = (el.textContent ?? "").trim();
      const label = [labelOf(el), text.length <= 30 ? text : ""].filter(Boolean).join(" ");
      if (!pattern.test(label)) return null;
      const id = label.slice(0, 60);
      if (exclude == null ? void 0 : exclude.has(id)) return null;
      const clickable = el.closest('button, [role="button"]') ?? el.parentElement ?? el;
      const rect = clickable.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;
      realClick(clickable);
      return id;
    };
    for (const el of [
      ...doc.querySelectorAll('button, [role="button"]'),
      ...doc.querySelectorAll("img")
    ]) {
      const id = attempt(el);
      if (id) return id;
    }
    for (const el of doc.querySelectorAll("div, span, a")) {
      if (el.children.length > 2) continue;
      const text = (el.textContent ?? "").trim();
      if (text.length === 0 || text.length > 20) continue;
      const id = attempt(el);
      if (id) return id;
    }
    return null;
  }
  const RESOURCE_LABELS = {
    wood: /lumber|wood/i,
    brick: /brick/i,
    sheep: /wool|sheep/i,
    wheat: /grain|wheat/i,
    ore: /ore/i
  };
  function findDiscardDialog(doc) {
    let best = null;
    for (const el of doc.querySelectorAll("div, section, dialog")) {
      if (el.closest("[data-index]") || el.closest("#catan-copilot")) continue;
      const text = el.textContent ?? "";
      if (text.length > 300 || !/discard/i.test(text)) continue;
      if (!el.querySelector("img")) continue;
      if (!best || best.contains(el)) best = el;
    }
    return best;
  }
  function tryDomDiscard(cards, doc = document) {
    const dialog = findDiscardDialog(doc);
    if (!dialog) return null;
    const used = /* @__PURE__ */ new Set();
    let clicked = 0;
    for (const [res, n] of Object.entries(cards)) {
      const pattern = RESOURCE_LABELS[res];
      if (!pattern || !n) continue;
      const imgs = [...dialog.querySelectorAll("img")].filter(
        (el) => !used.has(el) && pattern.test(labelOf(el))
      );
      for (let i = 0; i < n && i < imgs.length; i++) {
        used.add(imgs[i]);
        realClick(imgs[i].closest('button, [role="button"]') ?? imgs[i]);
        clicked++;
      }
    }
    if (clicked === 0) return null;
    const confirm = [...dialog.querySelectorAll('button, [role="button"], img')].find(
      (el) => {
        if (used.has(el)) return false;
        const label = `${labelOf(el)} ${(el.textContent ?? "").trim().slice(0, 30)}`;
        return /confirm|check|submit|\bok\b|✓|discard/i.test(label);
      }
    );
    if (confirm) realClick(confirm.closest('button, [role="button"]') ?? confirm);
    return `selected ${clicked} card${clicked === 1 ? "" : "s"}${confirm ? " + confirm" : ""}`;
  }
  const SQRT3 = Math.sqrt(3);
  function faceFromCenter(cx, cy) {
    const y = cy / 1.5;
    const x = (cx - SQRT3 / 2 * y) / SQRT3;
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (Math.abs(x - xi) > 0.02 || Math.abs(y - yi) > 0.02) return null;
    return { x: xi, y: yi };
  }
  function pixelToColonistCorner(px, py) {
    const top = faceFromCenter(px, py + 1);
    if (top) return { x: top.x, y: top.y, z: 0 };
    const bottom = faceFromCenter(px, py - 1);
    if (bottom) return { x: bottom.x, y: bottom.y, z: 1 };
    return null;
  }
  const EDGE_CORNER_ANGLES = [0, 1, 2].map((z) => [
    60 * (5 - z) - 30,
    60 * (4 - z) - 30
  ]);
  function pixelsToColonistEdge(p1, p2) {
    const mx = (p1.x + p2.x) / 2;
    const my = (p1.y + p2.y) / 2;
    for (let z = 0; z < 3; z++) {
      const [a1, a2] = EDGE_CORNER_ANGLES[z];
      const ox = (Math.cos(Math.PI / 180 * a1) + Math.cos(Math.PI / 180 * a2)) / 2;
      const oy = (Math.sin(Math.PI / 180 * a1) + Math.sin(Math.PI / 180 * a2)) / 2;
      const face = faceFromCenter(mx - ox, my - oy);
      if (face) {
        const c1 = {
          x: SQRT3 * face.x + SQRT3 / 2 * face.y + Math.cos(Math.PI / 180 * a1),
          y: 1.5 * face.y + Math.sin(Math.PI / 180 * a1)
        };
        const c2 = {
          x: SQRT3 * face.x + SQRT3 / 2 * face.y + Math.cos(Math.PI / 180 * a2),
          y: 1.5 * face.y + Math.sin(Math.PI / 180 * a2)
        };
        const close = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) < 0.05;
        if (close(c1, p1) && close(c2, p2) || close(c1, p2) && close(c2, p1)) {
          return { x: face.x, y: face.y, z };
        }
      }
    }
    return null;
  }
  const BUILD_COSTS = {
    road: { wood: 1, brick: 1 },
    settlement: { wood: 1, brick: 1, sheep: 1, wheat: 1 },
    city: { ore: 3, wheat: 2 },
    dev: { ore: 1, sheep: 1, wheat: 1 }
  };
  function affordableWithTrades(hand, ratios, cost) {
    let missing = 0;
    for (const r of RESOURCES) missing += Math.max(0, (cost[r] ?? 0) - hand[r]);
    if (missing === 0) return true;
    let power = 0;
    for (const r of RESOURCES) {
      const spare = hand[r] - (cost[r] ?? 0);
      if (spare > 0) power += Math.floor(spare / (ratios[r] ?? 4));
    }
    return power >= missing;
  }
  function tradeTowardCost(hand, ratios, cost, weights) {
    let need = null;
    let needGap = 0;
    for (const r of RESOURCES) {
      const gap = (cost[r] ?? 0) - hand[r];
      if (gap > needGap) {
        needGap = gap;
        need = r;
      }
    }
    if (!need) return null;
    let best = null;
    for (const g of RESOURCES) {
      if (g === need) continue;
      const ratio = ratios[g] ?? 4;
      const surplus = hand[g] - (cost[g] ?? 0);
      if (surplus < ratio) continue;
      const score = surplus - weights[g] * ratio;
      if (!best || score > best.score) best = { give: g, ratio, score };
    }
    return best ? { give: best.give, get: need, giveCount: best.ratio } : null;
  }
  function planBankTrade(hand, ratios, fit, canBuild = () => true) {
    for (const item of fit.strategy.buildOrder) {
      if (!canBuild(item)) continue;
      const cost = BUILD_COSTS[item];
      const short = RESOURCES.some((r) => (cost[r] ?? 0) > hand[r]);
      if (!short) return null;
      const trade = tradeTowardCost(hand, ratios, cost, fit.strategy.weights);
      if (trade) return trade;
    }
    return null;
  }
  function cardsToIds(cards) {
    const ids = [];
    for (const [r, n] of Object.entries(cards)) {
      for (let i = 0; i < (n ?? 0); i++) ids.push(RESOURCE_TO_CARD_ID[r]);
    }
    return ids;
  }
  function describeCards(cards) {
    return Object.entries(cards).map(([r, n]) => `${n} ${r}`).join(" + ");
  }
  function bestRobberHex(state, youPlayer, current, canRob = () => true) {
    var _a;
    const oppOnTile = (hexId) => state.buildings.filter(
      (b) => b.player !== youPlayer && state.board.vertices[b.vertexId].hexIds.includes(hexId)
    );
    const tileLegal = (hexId) => oppOnTile(hexId).every((b) => canRob(b.player));
    let best = null;
    for (const hex of state.board.hexes) {
      if (hex.kind === "desert" || hex.token === null) continue;
      if (current && hex.q === current.x && hex.r === current.y) continue;
      if (!tileLegal(hex.id)) continue;
      let opp = 0;
      let mine = 0;
      for (const b of state.buildings) {
        if (!state.board.vertices[b.vertexId].hexIds.includes(hex.id)) continue;
        const value = pips(hex.token) * (b.kind === "city" ? 2 : 1);
        if (b.player === youPlayer) mine += value;
        else opp += value;
      }
      const score = opp - mine * 1.5;
      if (opp > 0 && (!best || score > best.score)) best = { score, hexId: hex.id };
    }
    if (best) {
      const hex = state.board.hexes[best.hexId];
      const victim = ((_a = oppOnTile(best.hexId)[0]) == null ? void 0 : _a.player) ?? null;
      return { hex: { x: hex.q, y: hex.r }, victim, describe: `robber to the ${hex.token}-${hex.kind} tile` };
    }
    const neutral = state.board.hexes.find(
      (h) => h.kind !== "desert" && !(current && h.q === current.x && h.r === current.y) && state.buildings.every((b) => !state.board.vertices[b.vertexId].hexIds.includes(h.id))
    ) ?? state.board.hexes.find((h) => h.kind !== "desert" && tileLegal(h.id));
    if (!neutral) return null;
    return {
      hex: { x: neutral.q, y: neutral.r },
      victim: null,
      describe: `robber to a neutral tile (friendly robber — no one has 3+ points to rob)`
    };
  }
  const COSTS = {
    road: { wood: 1, brick: 1 },
    settlement: { wood: 1, brick: 1, sheep: 1, wheat: 1 },
    city: { ore: 3, wheat: 2 },
    dev: { ore: 1, sheep: 1, wheat: 1 }
  };
  function bestPlaceableNow(state, player) {
    const network = /* @__PURE__ */ new Set();
    for (const b of state.buildings) if (b.player === player) network.add(b.vertexId);
    for (const r of state.roads) {
      if (r.player === player) {
        const e = state.board.edges[r.edgeId];
        network.add(e.a);
        network.add(e.b);
      }
    }
    let best = null;
    let bestPips = -1;
    for (const v of network) {
      if (!isVertexBuildable(state, v)) continue;
      const p = vertexPips(state.board, v);
      if (p > bestPips) {
        bestPips = p;
        best = v;
      }
    }
    return best;
  }
  function decideNext(opts) {
    const { tracker: tracker2, youName, fit, gs, advice, rolledThisTurn, robberPending, robberHex, discardPending } = opts;
    const you = tracker2.players.get(youName);
    if (!you) return null;
    const board = gs == null ? void 0 : gs.state.board;
    const limit = opts.discardLimit ?? tracker2.discardLimit;
    const handSize = handTotal(you);
    if (discardPending && handSize > limit) {
      const cards = planDiscard(you.hand, Math.floor(handSize / 2), fit);
      return {
        kind: "discard",
        cards,
        describe: `discard ${describeCards(cards)} (keeping the next build)`
      };
    }
    if (robberPending && gs && gs.youPlayer !== null && board) {
      const target = bestRobberHex(gs.state, gs.youPlayer, robberHex ?? null, opts.canRob);
      if (target) {
        return {
          kind: "move-robber",
          coord: { x: target.hex.x, y: target.hex.y },
          describe: target.describe
        };
      }
      return null;
    }
    if ((advice == null ? void 0 : advice.phase) === "setup" && board && gs && gs.youPlayer !== null) {
      if (advice.roadEdges.length > 0) {
        const e = board.edges[advice.roadEdges[0]];
        const coord = pixelsToColonistEdge(board.vertices[e.a], board.vertices[e.b]);
        if (coord) return { kind: "build-road", coord, describe: "setup road (dashed edge)" };
        return null;
      }
      if (advice.spots.length > 0) {
        const v = board.vertices[advice.spots[0].vertexId];
        const coord = pixelToColonistCorner(v.x, v.y);
        if (coord) return { kind: "build-settlement", coord, describe: `settlement at ① ${advice.spots[0].label}` };
      }
      return null;
    }
    const knightReason = (() => {
      if (!opts.knightAvailable) return null;
      const blockedMine = !!robberHex && !!gs && gs.youPlayer !== null && !!board && gs.state.buildings.some(
        (b) => b.player === gs.youPlayer && board.vertices[b.vertexId].hexIds.some(
          (h) => board.hexes[h].q === robberHex.x && board.hexes[h].r === robberHex.y
        )
      );
      if (blockedMine) return "the robber is on your tile";
      if (fit && fit.strategy.id === "city-dev") return "building toward Largest Army";
      return null;
    })();
    const overLimit = handSize > limit;
    if (knightReason && !rolledThisTurn && !overLimit) {
      return { kind: "play-knight", describe: `play a knight before rolling — ${knightReason}` };
    }
    if (!rolledThisTurn) return { kind: "roll", describe: "roll the dice" };
    if (!fit) return null;
    if (knightReason) {
      return { kind: "play-knight", describe: `play a knight — ${knightReason}` };
    }
    const devAvailable = opts.bankDevCards !== 0;
    const pieces = opts.piecesLeft;
    const hasPiece = (item) => {
      if (!pieces) return true;
      const left = item === "settlement" ? pieces.settlements : item === "city" ? pieces.cities : pieces.roads;
      return left === null || left > 0;
    };
    const canBuild = (item) => item === "dev" ? devAvailable : hasPiece(item);
    const afford = (item) => RESOURCES.every((r) => you.hand[r] >= (COSTS[item][r] ?? 0));
    if (opts.hasMonopoly) {
      const opponents = [...tracker2.players.values()].filter((p) => p.name !== youName);
      const oppCards = opponents.reduce((s, p) => s + (p.serverCards ?? handTotal(p)), 0);
      if (oppCards >= 5) {
        const prodByRes = Object.fromEntries(RESOURCES.map((r) => [r, 0]));
        for (const p of opponents) {
          const prod = expectedProduction(p);
          for (const r of RESOURCES) prodByRes[r] += prod[r];
        }
        const totalProd = RESOURCES.reduce((s, r) => s + prodByRes[r], 0);
        const estHeld = (r) => totalProd > 0 ? prodByRes[r] / totalProd * oppCards : oppCards / RESOURCES.length;
        const shortForBuild = (r) => fit.strategy.buildOrder.some((item) => (BUILD_COSTS[item][r] ?? 0) > you.hand[r]);
        let bestRes = null;
        let bestScore = 0;
        for (const r of RESOURCES) {
          const score = estHeld(r) + (shortForBuild(r) ? 0.75 : 0);
          if (score > bestScore) {
            bestScore = score;
            bestRes = r;
          }
        }
        if (bestRes && estHeld(bestRes) >= 2) {
          return {
            kind: "play-monopoly",
            resource: bestRes,
            describe: `play monopoly on ${bestRes} (~${estHeld(bestRes).toFixed(0)} cards from opponents)`
          };
        }
      }
    }
    const advisedRoadOpensSpot = !!(advice && advice.roadEdges.length > 0 && board && gs && gs.youPlayer !== null && (() => {
      const e = board.edges[advice.roadEdges[0]];
      return isVertexBuildable(gs.state, e.a) || isVertexBuildable(gs.state, e.b);
    })());
    const canRoadThenSettle = you.hand.wood >= 2 && you.hand.brick >= 2 && you.hand.sheep >= 1 && you.hand.wheat >= 1;
    const buildDecision = (item) => {
      if (item === "dev") {
        if (!devAvailable) return null;
        return { kind: "buy-dev", describe: "buy a development card" };
      }
      if (!hasPiece(item)) return null;
      if (!gs || gs.youPlayer === null || !board) return null;
      if (item === "city") {
        const settlements = gs.state.buildings.filter(
          (b) => b.player === gs.youPlayer && b.kind === "settlement"
        );
        if (settlements.length === 0) return null;
        const target = settlements.reduce(
          (a, b) => vertexPips(board, a.vertexId) >= vertexPips(board, b.vertexId) ? a : b
        );
        const v = board.vertices[target.vertexId];
        const coord = pixelToColonistCorner(v.x, v.y);
        if (coord) return { kind: "build-city", coord, describe: "upgrade best settlement to a city" };
      } else if (item === "settlement") {
        const spot = bestPlaceableNow(gs.state, gs.youPlayer);
        if (spot === null) return null;
        const v = board.vertices[spot];
        const coord = pixelToColonistCorner(v.x, v.y);
        if (coord) return { kind: "build-settlement", coord, describe: "settlement on your network" };
      } else if (item === "road") {
        if (advice && advice.roadEdges.length > 0 && advisedRoadOpensSpot && canRoadThenSettle) {
          const e = board.edges[advice.roadEdges[0]];
          const coord = pixelsToColonistEdge(board.vertices[e.a], board.vertices[e.b]);
          if (coord) {
            return { kind: "build-road", coord, describe: "road to open a settlement spot (settling it this turn)" };
          }
        }
      }
      return null;
    };
    for (const item of fit.strategy.buildOrder) {
      if (!afford(item)) continue;
      const d = buildDecision(item);
      if (d) return d;
    }
    if (handSize >= limit) {
      for (const item of ["city", "settlement", "dev", "road"]) {
        if (!afford(item)) continue;
        const d = buildDecision(item);
        if (d) {
          return { ...d, describe: `${d.describe} (dumping cards — at the ${limit}-card limit)` };
        }
      }
    }
    for (const item of fit.strategy.buildOrder) {
      if (item === "road") continue;
      if (!canBuild(item)) continue;
      const cost = BUILD_COSTS[item];
      if (afford(item)) continue;
      if (!affordableWithTrades(you.hand, you.bankRatio, cost)) continue;
      const trade = tradeTowardCost(you.hand, you.bankRatio, cost, fit.strategy.weights);
      if (trade) {
        return {
          kind: "bank-trade",
          trade,
          describe: `bank-trade ${trade.giveCount} ${trade.give} for ${trade.get} toward a ${item}`
        };
      }
    }
    if (handSize >= limit) {
      const trade = planBankTrade(you.hand, you.bankRatio, fit, canBuild);
      if (trade) {
        return {
          kind: "bank-trade",
          trade,
          describe: `bank-trade ${trade.giveCount} ${trade.give} for ${trade.get} (at the ${limit}-card limit)`
        };
      }
    }
    return { kind: "end-turn", describe: "end the turn" };
  }
  class Autopilot {
    constructor(learner2, dispatch = () => false, domAct = (kind, exclude) => tryDomAction(kind, document, exclude), domDiscard = tryDomDiscard) {
      __publicField(this, "enabled", false);
      __publicField(this, "wsTurnSeen", false);
      __publicField(this, "robberPending", false);
      __publicField(this, "discardPending", false);
      __publicField(this, "myTurn", false);
      /** the two independent turn signals; myTurn is their OR */
      __publicField(this, "wsMine", false);
      __publicField(this, "domMine", false);
      __publicField(this, "rolledThisTurn", false);
      /** dev-card rules: one play per turn, none the turn it was bought */
      __publicField(this, "devPlayedThisTurn", false);
      __publicField(this, "devsBoughtThisTurn", 0);
      __publicField(this, "pending", null);
      /** DOM controls (per action) we clicked but the game never confirmed. */
      __publicField(this, "domFailed", /* @__PURE__ */ new Map());
      __publicField(this, "note", "off");
      this.learner = learner2;
      this.dispatch = dispatch;
      this.domAct = domAct;
      this.domDiscard = domDiscard;
    }
    setEnabled(on) {
      this.enabled = on;
      this.note = on ? "on — waiting for your turn" : "off";
      if (!on) this.pending = null;
    }
    onTurnState(currentColor, myColor) {
      this.wsTurnSeen = true;
      this.wsMine = myColor !== null && currentColor === myColor;
      this.recomputeTurn();
    }
    /**
     * DOM turn signal from colonist's "Your Turn" banner. Runs EVERY tick, not
     * only as a WS fallback: colonist's turn-state color ids don't always line
     * up with our detected `myColor` (or myColor may never arrive), and when
     * they don't, the WS signal alone would leave autopilot thinking it's never
     * our turn. The banner is authoritative for the local player — colonist only
     * shows it to you on your own turn — so we OR it with the WS signal.
     */
    noteDomTurn(mine) {
      this.domMine = mine;
      this.recomputeTurn();
    }
    /** Fold the WS and DOM turn signals; reset per-turn state on the rising edge. */
    recomputeTurn() {
      var _a;
      const mine = this.wsMine || this.domMine;
      if (mine && !this.myTurn) {
        this.rolledThisTurn = false;
        this.devPlayedThisTurn = false;
        this.devsBoughtThisTurn = 0;
        this.domFailed.clear();
      }
      if (!mine && this.myTurn && ((_a = this.pending) == null ? void 0 : _a.kind) === "end-turn") this.pending = null;
      this.myTurn = mine;
    }
    onYouRolled() {
      var _a;
      this.rolledThisTurn = true;
      if (((_a = this.pending) == null ? void 0 : _a.kind) === "roll") this.pending = null;
    }
    onConfirm(kind) {
      var _a;
      if (((_a = this.pending) == null ? void 0 : _a.kind) === kind) this.pending = null;
      if (kind === "move-robber") this.robberPending = false;
      if (kind === "discard") this.discardPending = false;
      if (kind === "play-knight" || kind === "play-monopoly") this.devPlayedThisTurn = true;
      if (kind === "buy-dev") this.devsBoughtThisTurn++;
    }
    /** A non-knight dev card was played manually (YoP, Monopoly, Road Building). */
    markDevPlayed() {
      this.devPlayedThisTurn = true;
    }
    /** A 7 was rolled or a knight played — the current player must move the robber. */
    setRobberPending(pending) {
      this.robberPending = pending;
    }
    /** The game is asking for discards (a 7 while someone is over the limit). */
    setDiscardPending(pending) {
      this.discardPending = pending;
    }
    view() {
      return { enabled: this.enabled, status: this.learner.status(), note: this.note };
    }
    tick(ctx) {
      var _a, _b;
      if (!this.enabled) return;
      const now = ctx.now ?? Date.now();
      if (this.pending) {
        if (now - this.pending.t > 8e3) {
          if (this.pending.via === "ws") {
            this.learner.discard(this.pending.kind);
            this.note = `"${this.pending.kind}" wasn't confirmed — template discarded, do it manually once to re-learn`;
          } else {
            if (this.pending.label && this.pending.kind !== "discard") {
              const kind = this.pending.kind;
              const failed = this.domFailed.get(kind) ?? /* @__PURE__ */ new Set();
              failed.add(this.pending.label);
              this.domFailed.set(kind, failed);
            }
            this.note = `clicked "${this.pending.label ?? this.pending.kind}" but the game didn't react — trying another control`;
          }
          this.pending = null;
        }
        return;
      }
      const robberMine = this.robberPending && (this.myTurn || !this.wsTurnSeen);
      const you = ((_a = ctx.tracker) == null ? void 0 : _a.youName) ? ctx.tracker.players.get(ctx.tracker.youName) : void 0;
      const mustDiscard = this.discardPending && !!you && handTotal(you) > (((_b = ctx.tracker) == null ? void 0 : _b.discardLimit) ?? 9);
      if (!robberMine && !mustDiscard && (!this.myTurn || !ctx.tracker || !ctx.tracker.youName)) {
        const sig = this.domMine ? "banner" : this.wsMine ? "ws" : "none";
        this.note = `on — waiting for your turn (signal: ${sig})`;
        return;
      }
      if (!ctx.tracker || !ctx.tracker.youName) return;
      const decision = decideNext({
        tracker: ctx.tracker,
        youName: ctx.tracker.youName,
        fit: ctx.fit,
        gs: ctx.gs,
        advice: ctx.advice,
        rolledThisTurn: this.rolledThisTurn,
        robberPending: robberMine,
        robberHex: ctx.robberHex,
        discardPending: mustDiscard,
        // Knights held (dev-card id 11, from ground-truth state) beyond any dev
        // bought this turn (a fresh buy can't be played), and no dev played yet.
        knightAvailable: !this.devPlayedThisTurn && ((ctx.myDevCardIds ?? []).filter((id) => id === 11).length || (ctx.knightsInHand ?? 0)) > this.devsBoughtThisTurn,
        bankDevCards: ctx.bankDevCards,
        piecesLeft: ctx.piecesLeft,
        // Playable only if we hold a monopoly (id 13), haven't played a dev this
        // turn, and hold more than we bought this turn (a fresh buy can't be played).
        hasMonopoly: !this.devPlayedThisTurn && (ctx.myDevCardIds ?? []).filter((id) => id === 13).length > this.devsBoughtThisTurn,
        canRob: ctx.canRob
      });
      if (!decision) {
        this.note = robberMine ? "on — move the robber manually (board not captured or no good tile)" : "on — nothing to do";
        return;
      }
      if (this.dispatch(decision)) {
        this.pending = { kind: decision.kind, t: now, via: "ws" };
        this.note = `acting: ${decision.describe}`;
        return;
      }
      if (decision.kind === "roll" || decision.kind === "end-turn" || decision.kind === "buy-dev") {
        const clicked = this.domAct(decision.kind, this.domFailed.get(decision.kind));
        if (clicked) {
          this.pending = { kind: decision.kind, t: now, via: "dom", label: clicked };
          this.note = `acting: ${decision.describe} (clicked game button)`;
          return;
        }
      }
      if (decision.kind === "discard" && decision.cards) {
        const clicked = this.domDiscard(decision.cards);
        if (clicked) {
          this.pending = { kind: "discard", t: now, via: "dom" };
          this.note = `acting: ${decision.describe} (clicked the discard dialog)`;
          return;
        }
      }
      const spatial = decision.kind === "build-settlement" || decision.kind === "build-road" || decision.kind === "build-city" || decision.kind === "move-robber";
      this.note = spatial ? `▶ Your click: ${decision.describe} — highlighted ① on the map above (board clicks aren't automated)` : decision.kind === "discard" ? `on — pick the discards manually once (${decision.describe}) so I can learn it` : decision.kind === "play-knight" ? `on — play a knight manually once so I can learn it (${decision.describe})` : `on — "${decision.kind}" not learned yet, do it manually once`;
    }
  }
  const ACTION = {
    ROLL: 2,
    // payload: true
    MOVE_ROBBER: 3,
    // payload: tile (hex) index
    STEAL: 5,
    // payload: victim color id
    END_TURN: 6,
    // payload: true
    DISCARD_CONFIRM: 7,
    // payload: full array of card ids to discard
    DISCARD_SELECT: 8,
    // payload: cumulative selection array (one card added each time)
    BUY_DEV: 9,
    // payload: true — buy a development card
    // Each build is [intent, place] as consecutive codes: road 10/11,
    // settlement 14/15, city 17/18. Settlement and city intents are confirmed
    // from captures; ROAD_INTENT (10) is inferred from that pattern (no normal
    // paid road appears in any capture yet) — it fails safe if wrong.
    BUILD_ROAD_INTENT: 10,
    // payload: true — enter build-road mode (main game, INFERRED)
    BUILD_ROAD: 11,
    // payload: edge index
    BUILD_SETTLEMENT_INTENT: 14,
    // payload: true — enter build-settlement mode (main game)
    BUILD_SETTLEMENT: 15,
    // payload: corner index
    BUILD_CITY_INTENT: 17,
    // payload: true — enter build-city mode (main game)
    BUILD_CITY: 18,
    // payload: corner index of the settlement to upgrade
    PLAY_DEV: 48,
    // payload: dev-card type id (e.g. 13 = monopoly, 11 = road building)
    CREATE_TRADE: 49,
    // payload: { creator, isBankTrade, offeredResources[], wantedResources[] }
    PRESELECT: 66
    // payload: corner/edge index (UI hover) or null to clear
  };
  const DEV_CARD = { KNIGHT: 11, MONOPOLY: 13 };
  function rollAction() {
    return [{ action: ACTION.ROLL, payload: true }];
  }
  function endTurnAction() {
    return [{ action: ACTION.END_TURN, payload: true }];
  }
  function buyDevAction() {
    return [{ action: ACTION.BUY_DEV, payload: true }];
  }
  function settlementActions(cornerIndex) {
    return [
      { action: ACTION.PRESELECT, payload: cornerIndex },
      { action: ACTION.PRESELECT, payload: null },
      { action: ACTION.BUILD_SETTLEMENT, payload: cornerIndex }
    ];
  }
  function buildSettlementActions(cornerIndex) {
    return [
      { action: ACTION.BUILD_SETTLEMENT_INTENT, payload: true },
      { action: ACTION.BUILD_SETTLEMENT, payload: cornerIndex }
    ];
  }
  function roadActions(edgeIndex) {
    return [
      { action: ACTION.PRESELECT, payload: edgeIndex },
      { action: ACTION.PRESELECT, payload: null },
      { action: ACTION.BUILD_ROAD, payload: edgeIndex }
    ];
  }
  function buildRoadActions(edgeIndex) {
    return [
      { action: ACTION.BUILD_ROAD_INTENT, payload: true },
      { action: ACTION.BUILD_ROAD, payload: edgeIndex }
    ];
  }
  function buildCityActions(cornerIndex) {
    return [
      { action: ACTION.BUILD_CITY_INTENT, payload: true },
      { action: ACTION.BUILD_CITY, payload: cornerIndex }
    ];
  }
  function knightActions() {
    return [{ action: ACTION.PLAY_DEV, payload: DEV_CARD.KNIGHT }];
  }
  function monopolyActions(resourceId) {
    return [
      { action: ACTION.PLAY_DEV, payload: DEV_CARD.MONOPOLY },
      { action: ACTION.DISCARD_SELECT, payload: [resourceId] },
      { action: ACTION.DISCARD_CONFIRM, payload: [resourceId] }
    ];
  }
  function bankTradeActions(myColor, giveId, giveCount, getId) {
    return [
      {
        action: ACTION.CREATE_TRADE,
        payload: {
          creator: myColor,
          isBankTrade: true,
          counterOfferInResponseToTradeId: null,
          offeredResources: Array.from({ length: giveCount }, () => giveId),
          wantedResources: [getId]
        }
      }
    ];
  }
  function robberActions(tileIndex, victimColor) {
    const out = [{ action: ACTION.MOVE_ROBBER, payload: tileIndex }];
    if (victimColor !== null) out.push({ action: ACTION.STEAL, payload: victimColor });
    return out;
  }
  function discardActions(cardIds) {
    if (cardIds.length === 0) return [];
    const out = [];
    for (let i = 1; i <= cardIds.length; i++) {
      out.push({ action: ACTION.DISCARD_SELECT, payload: cardIds.slice(0, i) });
    }
    out.push({ action: ACTION.DISCARD_CONFIRM, payload: cardIds.slice() });
    return out;
  }
  const SEND_MARKER = "__catan_copilot_send__";
  function dispatchDecision(d) {
    if (!bridge.serverId) return false;
    const send = (actions) => {
      if (actions.length === 0) return false;
      window.postMessage({ [SEND_MARKER]: true, actions }, "*");
      return true;
    };
    switch (d.kind) {
      case "roll":
        return send(rollAction());
      case "end-turn":
        return send(endTurnAction());
      case "buy-dev":
        return send(buyDevAction());
      case "build-settlement": {
        const idx = d.coord ? bridge.cornerIndexForCoord(d.coord) : null;
        if (idx === null) return false;
        return send(bridge.turnState === 2 ? buildSettlementActions(idx) : settlementActions(idx));
      }
      case "build-road": {
        const idx = d.coord ? bridge.edgeIndexForCoord(d.coord) : null;
        if (idx === null) return false;
        return send(bridge.turnState === 2 ? buildRoadActions(idx) : roadActions(idx));
      }
      case "build-city": {
        const idx = d.coord ? bridge.cornerIndexForCoord(d.coord) : null;
        return idx !== null ? send(buildCityActions(idx)) : false;
      }
      case "move-robber": {
        if (!d.coord) return false;
        const tile = bridge.tileIndexForHex(d.coord.x, d.coord.y);
        if (tile === null) return false;
        const victim = bridge.opponentsOnTile(tile)[0] ?? null;
        return send(robberActions(tile, victim));
      }
      case "discard": {
        const ids = cardsToIds(d.cards ?? {});
        return ids.length > 0 ? send(discardActions(ids)) : false;
      }
      case "bank-trade": {
        if (!d.trade || bridge.myColor === null) return false;
        const giveId = RESOURCE_TO_CARD_ID[d.trade.give];
        const getId = RESOURCE_TO_CARD_ID[d.trade.get];
        return send(bankTradeActions(bridge.myColor, giveId, d.trade.giveCount, getId));
      }
      case "play-monopoly": {
        if (!d.resource) return false;
        return send(monopolyActions(RESOURCE_TO_CARD_ID[d.resource]));
      }
      case "play-knight":
        return send(knightActions());
      default:
        return false;
    }
  }
  let tracker = null;
  let overlay = null;
  const bridge = new StateBridge();
  const learner = new ProtocolLearner();
  learner.load();
  const autopilot = new Autopilot(learner, dispatchDecision);
  const AUTOPILOT_PREF = "catanCopilot:autopilotOn";
  function loadAutopilotPref() {
    try {
      const v = localStorage.getItem(AUTOPILOT_PREF);
      return v === null ? true : v === "1";
    } catch {
      return true;
    }
  }
  autopilot.setEnabled(loadAutopilotPref());
  let prevTurnColor = null;
  let prevMyBuildings = 0;
  let prevMyCities = 0;
  let prevMyRoads = 0;
  let gameRecorded = false;
  const capture = [];
  const CAPTURE_LIMIT = 5e3;
  function downloadCapture() {
    const blob = new Blob([JSON.stringify(capture, null, 1)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `catan-copilot-capture-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }
  let observer = null;
  let lastProcessedIndex = -1;
  let renderTimer;
  const moveHistory = [];
  const HISTORY_LIMIT = 400;
  function fmtRes(res) {
    return RESOURCES.filter((r) => (res[r] ?? 0) > 0).map((r) => `${res[r]} ${r}`).join(" + ");
  }
  function fmtDelta(d) {
    const gave = RESOURCES.filter((r) => (d[r] ?? 0) < 0).map((r) => `${-(d[r] ?? 0)} ${r}`);
    const got = RESOURCES.filter((r) => (d[r] ?? 0) > 0).map((r) => `${d[r]} ${r}`);
    return [gave.length ? `gave ${gave.join(" + ")}` : "", got.length ? `got ${got.join(" + ")}` : ""].filter(Boolean).join(", ");
  }
  function describeMove(ev, you) {
    const meName = you ?? "you";
    switch (ev.type) {
      case "roll":
        return { player: ev.player, text: `rolled ${ev.total}` };
      case "place":
        return { player: ev.player, text: `placed a ${ev.what}` };
      case "build":
        return { player: ev.player, text: `built a ${ev.what}` };
      case "buy-dev":
        return { player: ev.player, text: "bought a development card" };
      case "bank-trade":
        return { player: ev.player, text: `bank-traded — ${fmtDelta(ev.delta)}` };
      case "player-trade":
        return {
          player: ev.player,
          text: `traded${ev.partner ? ` with ${ev.partner}` : ""} — ${fmtDelta(ev.delta)}`
        };
      case "steal-known":
        return { player: ev.thief ?? meName, text: `stole from ${ev.victim ?? meName}` };
      case "steal-unknown":
        return { player: ev.thief ?? meName, text: `stole from ${ev.victim ?? meName}` };
      case "monopoly-steal":
        return { player: ev.player, text: `monopoly — took ${ev.count} ${ev.resource}` };
      case "discard":
        return { player: ev.player, text: `discarded ${fmtRes(ev.resources)}` };
      case "use-knight":
        return { player: ev.player, text: "played a knight" };
      case "use-dev":
        return { player: ev.player, text: `played ${ev.card.replace(/-/g, " ")}` };
      case "move-robber":
        return { player: ev.player, text: "moved the robber" };
      case "game-over":
        return { player: ev.winner, text: "won the game 🏆" };
      default:
        return null;
    }
  }
  function recordMove(ev) {
    const m = describeMove(ev, (tracker == null ? void 0 : tracker.youName) ?? null);
    if (!m) return;
    moveHistory.push({
      t: Date.now(),
      player: m.player,
      text: m.text,
      mine: m.player !== null && m.player === (tracker == null ? void 0 : tracker.youName)
    });
    if (moveHistory.length > HISTORY_LIMIT) moveHistory.shift();
  }
  function downloadHistory() {
    const lines = moveHistory.map((e) => {
      const clock = new Date(e.t).toLocaleTimeString();
      return `${clock}  ${e.player ?? "?"}${e.mine ? " (you)" : ""}: ${e.text}`;
    });
    const blob = new Blob([lines.join("\n")], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `catan-copilot-history-${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
  }
  function getYouName() {
    var _a;
    const el = document.getElementsByClassName("web-header-username")[0];
    return ((_a = el == null ? void 0 : el.textContent) == null ? void 0 : _a.trim()) || null;
  }
  const BRIDGE_URL = "http://127.0.0.1:8137/state";
  let lastBridgePost = 0;
  function buildLiveSummary() {
    if (!tracker) return null;
    const you = tracker.youName;
    const deck = deckStatus(tracker);
    const players = [...tracker.players.values()].map((p) => ({
      name: p.name,
      isYou: p.name === you,
      vp: visibleVp(p),
      cards: p.serverCards ?? handTotal(p),
      pips: Math.round(productionTotal(expectedProduction(p)) * 36),
      devCards: p.devCards,
      knightsPlayed: p.knightsPlayed,
      hand: p.name === you ? p.hand : void 0
      // only our own cards are known
    }));
    const fits = you ? rankLiveStrategies(tracker, you, strategyPriors(loadRecords())) : [];
    const gs = bridge.board ? bridge.toGameState() : null;
    const advice = gs ? advisePlacement(gs.state, gs.youPlayer) : null;
    return {
      at: (/* @__PURE__ */ new Date()).toISOString(),
      you,
      turn: {
        isMyTurn: bridge.isMyTurn,
        needsRoll: bridge.needsRoll,
        phase: bridge.turnState,
        currentPlayerColor: bridge.currentTurnColor
      },
      players,
      deck: {
        cardsLeft: 36 - deck.rollsIntoDeck,
        due: deck.due,
        cold: deck.cold,
        prob: Object.fromEntries([...deck.prob.entries()].map(([n, p]) => [n, +(p * 100).toFixed(0)]))
      },
      recommendedStrategy: fits[0] ? { name: fits[0].strategy.name, rationale: fits[0].rationale, simVp: +fits[0].simVp.toFixed(1) } : null,
      whereToBuild: advice ? { heading: advice.heading, spots: advice.spots.map((s) => s.label) } : null,
      autopilot: autopilot.view(),
      recentMoves: moveHistory.slice(-25).map((m) => ({ player: m.player, text: m.text, mine: m.mine }))
    };
  }
  function postLiveState() {
    const now = Date.now();
    if (now - lastBridgePost < 1500) return;
    lastBridgePost = now;
    try {
      const summary = buildLiveSummary();
      if (!summary) return;
      fetch(BRIDGE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(summary),
        keepalive: true
      }).catch(() => void 0);
    } catch {
    }
  }
  function syncTrackerFromState() {
    if (!tracker) return;
    const myColor = bridge.myColor;
    if (myColor !== null && !tracker.youName) {
      tracker.youName = bridge.colorToName.get(myColor) ?? tracker.youName;
    }
    for (const [color, name] of bridge.colorToName) {
      ensurePlayer(tracker, name, COLONIST_COLORS[color] ?? "#888");
      const p = tracker.players.get(name);
      const hand = bridge.handOf(color);
      p.serverCards = hand.total;
      if (color === myColor) {
        for (const r of RESOURCES) p.hand[r] = hand.known[r] ?? 0;
        p.uncertainty = 0;
      }
      for (const [r, ratio] of Object.entries(bridge.bankRatios(color))) {
        p.bankRatio[r] = Math.min(p.bankRatio[r] ?? 4, ratio);
      }
    }
    if (myColor !== null) {
      const limit = bridge.discardLimit(myColor);
      if (limit !== null) tracker.discardLimit = limit;
    }
  }
  function domSaysYourTurn() {
    return domHasText(YOUR_TURN_BANNER) || rollPromptVisible();
  }
  function domSaysMoveRobber() {
    return domHasText(MOVE_ROBBER_BANNER);
  }
  function domSaysDiscard() {
    return domHasText(DISCARD_BANNER);
  }
  function domHasText(pattern) {
    try {
      const nodes = document.evaluate(
        `//*[not(ancestor::*[@data-index]) and not(ancestor::*[@id="catan-copilot"])]`,
        document.body,
        null,
        XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
        null
      );
      for (let i = 0; i < nodes.snapshotLength; i++) {
        const el = nodes.snapshotItem(i);
        if (el.children.length > 2) continue;
        const text = (el.textContent ?? "").trim();
        if (text.length > 40) continue;
        if (pattern.test(text)) return true;
      }
    } catch {
    }
    return false;
  }
  function countKnightsInHand() {
    let n = 0;
    document.querySelectorAll("img").forEach((img) => {
      if (img.closest("[data-index]") || img.closest("#catan-copilot") || img.closest("[data-player-information-container]")) {
        return;
      }
      const label = `${img.getAttribute("alt") ?? ""} ${img.getAttribute("src") ?? ""}`;
      if (!/knight/i.test(label) || /largest/i.test(label)) return;
      const r = img.getBoundingClientRect();
      if (r.width === 0 || r.top < window.innerHeight * 0.55) return;
      n++;
    });
    return n;
  }
  function findChatScroller() {
    const row = document.querySelector("[data-index]");
    return row ? row.parentElement : null;
  }
  function scheduleRender() {
    if (renderTimer !== void 0) return;
    renderTimer = window.setTimeout(() => {
      renderTimer = void 0;
      if (tracker && overlay) {
        if (!tracker.youName) tracker.youName = getYouName();
        if (!tracker.youName && bridge.myColor !== null) {
          tracker.youName = bridge.colorToName.get(bridge.myColor) ?? null;
        }
        overlay.render(tracker, bridge);
        postLiveState();
      }
    }, 400);
  }
  window.addEventListener("message", (ev) => {
    const data = ev.data;
    if (ev.source !== window && ev.source !== null) return;
    if (!(data == null ? void 0 : data.__catan_copilot__)) return;
    if (data.dir && data.frame !== void 0) {
      const raw = data.raw;
      const decodes = data.decodes;
      if (capture.length < CAPTURE_LIMIT) {
        capture.push({ t: Date.now(), dir: data.dir, frame: data.frame, raw, decodes });
      }
      if (data.dir === "out") {
        const best = decodes ? Object.values(decodes).find((v) => v && typeof v === "object") : void 0;
        learner.recordOutbound(best ?? data.frame);
        scheduleRender();
      }
      return;
    }
    if (typeof data.type !== "number") return;
    if (data.type === STATE_EVENT.GAME_META || data.type === STATE_EVENT.INIT || data.type === STATE_EVENT.DIFF) {
      const prev = prevTurnColor;
      bridge.apply(data.type, data.payload);
      if (tracker && (data.type === STATE_EVENT.INIT || data.type === STATE_EVENT.DIFF)) {
        syncTrackerFromState();
        const turn = bridge.currentTurnColor;
        const myColor = bridge.myColor;
        if (turn !== null && myColor !== null) {
          if (prev === myColor && turn !== myColor) autopilot.onConfirm("end-turn");
          prevTurnColor = turn;
          autopilot.onTurnState(turn, myColor);
          if (bridge.isMyTurn && bridge.diceThrown) autopilot.onYouRolled();
        }
        if (myColor !== null) {
          const mineBuildings = bridge.buildings.filter((b) => b.colorId === myColor);
          const mine = mineBuildings.length;
          const myCities = mineBuildings.filter((b) => b.kind === "city").length;
          const myRoads = bridge.roads.filter((r) => r.colorId === myColor).length;
          if (mine > prevMyBuildings) autopilot.onConfirm("build-settlement");
          if (myCities > prevMyCities) autopilot.onConfirm("build-city");
          if (myRoads > prevMyRoads) autopilot.onConfirm("build-road");
          prevMyBuildings = mine;
          prevMyCities = myCities;
          prevMyRoads = myRoads;
        }
      }
    }
    scheduleRender();
  });
  function processRow(el) {
    if (!tracker) return;
    const idxAttr = el.getAttribute("data-index");
    if (idxAttr === null) return;
    const idx = parseInt(idxAttr, 10);
    if (Number.isNaN(idx) || idx <= lastProcessedIndex) return;
    lastProcessedIndex = idx;
    const ev = parseLogRow(el);
    applyEvent(tracker, ev);
    recordMove(ev);
    const you = tracker.youName;
    if (you) {
      if (ev.type === "roll" && ev.player === you) {
        learner.confirm("roll");
        autopilot.onYouRolled();
      } else if (ev.type === "buy-dev" && ev.player === you) {
        learner.confirm("buy-dev");
        autopilot.onConfirm("buy-dev");
      } else if (ev.type === "move-robber" && ev.player === you) {
        learner.confirm("move-robber");
        autopilot.onConfirm("move-robber");
      } else if (ev.type === "discard" && ev.player === you) {
        learner.confirm("discard");
        autopilot.onConfirm("discard");
      } else if (ev.type === "bank-trade" && ev.player === you) {
        autopilot.onConfirm("bank-trade");
      } else if (ev.type === "use-knight" && ev.player === you) {
        learner.confirm("play-knight");
        autopilot.onConfirm("play-knight");
      } else if (ev.type === "use-dev" && ev.player === you) {
        if (ev.card === "monopoly") autopilot.onConfirm("play-monopoly");
        autopilot.markDevPlayed();
      }
    }
    if (ev.type === "game-over" && !gameRecorded) {
      gameRecorded = true;
      recordGameEnd(tracker);
    }
    scheduleRender();
  }
  function sweepExistingRows(scroller) {
    const rows = [...scroller.querySelectorAll("[data-index]")].sort(
      (a, b) => parseInt(a.getAttribute("data-index"), 10) - parseInt(b.getAttribute("data-index"), 10)
    );
    rows.forEach(processRow);
  }
  let observedScroller = null;
  function attach(scroller) {
    tracker = createTracker(getYouName());
    lastProcessedIndex = -1;
    observedScroller = scroller;
    gameRecorded = false;
    prevTurnColor = null;
    prevMyBuildings = 0;
    prevMyCities = 0;
    prevMyRoads = 0;
    moveHistory.length = 0;
    if (!overlay) {
      overlay = new Overlay(document, {
        captureCount: () => capture.length,
        onDownloadCapture: downloadCapture,
        getAutopilotView: () => autopilot.view(),
        onToggleAutopilot: (on) => {
          autopilot.setEnabled(on);
          try {
            localStorage.setItem(AUTOPILOT_PREF, on ? "1" : "0");
          } catch {
          }
          scheduleRender();
        },
        needsRefresh: () => capture.length === 0,
        getHistory: () => moveHistory,
        onDownloadHistory: downloadHistory
      });
    }
    sweepExistingRows(scroller);
    observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        m.addedNodes.forEach((node) => {
          var _a;
          if (node instanceof Element) {
            if (node.hasAttribute("data-index")) processRow(node);
            else (_a = node.querySelectorAll) == null ? void 0 : _a.call(node, "[data-index]").forEach(processRow);
          }
        });
      }
    });
    observer.observe(scroller, { childList: true, subtree: true });
    scheduleRender();
  }
  function detach() {
    observer == null ? void 0 : observer.disconnect();
    observer = null;
    observedScroller = null;
    tracker = null;
    lastProcessedIndex = -1;
  }
  function watchForGame() {
    window.setInterval(() => {
      const scroller = findChatScroller();
      if (!observer && scroller) {
        attach(scroller);
      } else if (observer && !scroller) {
        detach();
      } else if (observer && scroller && scroller !== observedScroller) {
        detach();
        attach(scroller);
      }
    }, 2e3);
  }
  window.setInterval(() => {
    if (!autopilot.enabled || !tracker || !tracker.youName) return;
    if (bridge.currentTurnColor !== null && bridge.myColor !== null) {
      autopilot.onTurnState(bridge.currentTurnColor, bridge.myColor);
      if (bridge.isMyTurn && bridge.diceThrown) autopilot.onYouRolled();
    }
    autopilot.noteDomTurn(domSaysYourTurn());
    autopilot.setRobberPending(domSaysMoveRobber());
    autopilot.setDiscardPending(domSaysDiscard());
    const gs = bridge.board ? bridge.toGameState() : null;
    const advice = gs ? advisePlacement(gs.state, gs.youPlayer) : null;
    const fits = rankLiveStrategies(tracker, tracker.youName, strategyPriors(loadRecords()));
    const colorOrder = bridge.colorOrder();
    const canRob = (player) => {
      if (!bridge.friendlyRobber) return true;
      const color = colorOrder[player];
      return color === void 0 || bridge.publicVp(color) >= 3;
    };
    autopilot.tick({
      tracker,
      gs,
      advice,
      fit: fits[0] ?? null,
      robberHex: bridge.robberHex,
      canRob,
      knightsInHand: countKnightsInHand(),
      bankDevCards: bridge.bankDevCards,
      piecesLeft: bridge.myColor !== null ? bridge.piecesLeft(bridge.myColor) : void 0,
      myDevCardIds: bridge.myDevCardIds()
    });
    scheduleRender();
  }, 1500);
  watchForGame();
})();
