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
      gameOver: false
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
        bankRatio: {}
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
  const COSTS$1 = {
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
        applyDelta(p, COSTS$1[ev.what]);
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
        applyDelta(p, COSTS$1.dev);
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
  const SQRT3 = Math.sqrt(3);
  function hexCenter(q, r) {
    return { x: SQRT3 * q + SQRT3 / 2 * r, y: 1.5 * r };
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
    return hexCorner(x, y, c.z === 0 ? 5 : 2);
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
  const COSTS = {
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
        const cost = COSTS[item];
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
        for (const r of RESOURCES) hand[r] -= COSTS[item][r] ?? 0;
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
  const BUILD_COSTS = {
    road: { wood: 1, brick: 1 },
    settlement: { wood: 1, brick: 1, sheep: 1, wheat: 1 },
    city: { ore: 3, wheat: 2 },
    dev: { ore: 1, sheep: 1, wheat: 1 }
  };
  function simulateLive(p, strategy, seed, rounds = 25, trials = 30) {
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
        const cost = BUILD_COSTS[item];
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
        } else if (handTotal({ ...p, hand }) > 7) {
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
  function rankLiveStrategies(state, name) {
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
      const simVp = simulateLive(p, strategy, 1e3 + i * 31);
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
      const cost = BUILD_COSTS[item];
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
  function nextMoves(state, name, fit, facts) {
    const p = state.players.get(name);
    if (!p || !fit) return [];
    const actions = [];
    const hand = { ...p.hand };
    const total = RESOURCES.reduce((s, r) => s + hand[r], 0);
    if (total > 7) {
      const toDiscard = Math.floor(total / 2);
      const keepFor = fit.strategy.buildOrder[0];
      const keep = { ...BUILD_COSTS[keepFor] };
      const discards = [];
      const pool = { ...hand };
      for (let i = 0; i < toDiscard; i++) {
        const pick = [...RESOURCES].sort(
          (a, b) => pool[b] - (keep[b] ?? 0) - (pool[a] - (keep[a] ?? 0)) || fit.strategy.weights[a] - fit.strategy.weights[b]
        )[0];
        pool[pick]--;
        discards.push(pick);
      }
      const counts = /* @__PURE__ */ new Map();
      for (const d of discards) counts.set(d, (counts.get(d) ?? 0) + 1);
      actions.push({
        text: `If a 7 rolls, discard ${[...counts].map(([r, n]) => `${n} ${r}`).join(" + ")} — keep the makings of a ${keepFor}.`,
        primary: false
      });
    }
    const canAfford = (item) => RESOURCES.every((r) => hand[r] >= (BUILD_COSTS[item][r] ?? 0));
    const pay = (item) => {
      for (const r of RESOURCES) hand[r] -= BUILD_COSTS[item][r] ?? 0;
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
          (s, r) => s + Math.max(0, (BUILD_COSTS[item][r] ?? 0) - hand[r]),
          0
        );
        if (missing < bestMissing) {
          bestMissing = missing;
          bestItem = item;
        }
      }
      const missingList = RESOURCES.filter((r) => (BUILD_COSTS[bestItem][r] ?? 0) > hand[r]).map((r) => `${(BUILD_COSTS[bestItem][r] ?? 0) - hand[r]} ${r}`).join(" + ");
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
  function roadPathTo(state, player, target) {
    const sources = /* @__PURE__ */ new Set();
    for (const b of state.buildings) if (b.player === player) sources.add(b.vertexId);
    for (const r of state.roads) {
      if (r.player === player) {
        const e = state.board.edges[r.edgeId];
        sources.add(e.a);
        sources.add(e.b);
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
    const setup = yourBuildings.length < 2 && state.buildings.length < 8;
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
#catan-copilot .res { text-transform: capitalize; }
#catan-copilot .res::before {
  content: ""; display: inline-block; width: 8px; height: 8px; border-radius: 2px;
  margin-right: 4px;
}
#catan-copilot .res.brick::before { background: var(--brick); }
#catan-copilot .res.wheat::before { background: var(--wheat); }
#catan-copilot .res.sheep::before { background: var(--sheep); }
#catan-copilot .res.ore::before { background: var(--ore); }
#catan-copilot .res.wood::before { background: var(--wood); }
#catan-copilot-toggle {
  position: fixed; top: 70px; right: 12px; z-index: 2147483001;
  background: #4a3aa7; color: #fff; border: none; border-radius: 16px;
  padding: 5px 12px; font: 600 12px system-ui, sans-serif; cursor: pointer;
  display: none;
}
`;
  function esc(s) {
    return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  }
  class Overlay {
    constructor(doc) {
      __publicField(this, "root");
      __publicField(this, "body");
      __publicField(this, "toggle");
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
      const parts = [];
      let gs = null;
      let advice = null;
      if (bridge2 == null ? void 0 : bridge2.board) {
        gs = bridge2.toGameState();
        if (gs) advice = advisePlacement(gs.state, gs.youPlayer);
      }
      const you = state.youName;
      const fits = you && state.players.has(you) ? rankLiveStrategies(state, you) : [];
      if (you && fits.length > 0) {
        let facts = null;
        if (gs && gs.youPlayer !== null) {
          facts = placementFacts(gs.state, gs.youPlayer, advice);
        }
        const inSetup = (advice == null ? void 0 : advice.phase) === "setup";
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
      this.body.innerHTML = parts.join("");
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
        const cards = `${handTotal(p)}${p.uncertainty ? `±${p.uncertainty}` : ""}`;
        const hand = RESOURCES.filter((r) => p.hand[r] > 0).map((r) => `${p.hand[r]}<span class="res ${r}"></span>`).join(" ");
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
  const TILE_TYPE = {
    0: "desert",
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
  const WS_EVENT = {
    GAME_START: 1,
    PLAY_ORDER: 8,
    PLAYER_STATE: 12,
    BOARD_DESCRIPTION: 14,
    BUILD_EDGE: 15,
    BUILD_CORNER: 16,
    GAME_END: 45
  };
  class BoardBridge {
    constructor() {
      __publicField(this, "board", null);
      __publicField(this, "buildings", []);
      __publicField(this, "roads", []);
      __publicField(this, "myColor", null);
      __publicField(this, "colorToName", /* @__PURE__ */ new Map());
    }
    reset() {
      this.board = null;
      this.buildings = [];
      this.roads = [];
      this.myColor = null;
      this.colorToName.clear();
    }
    handle(type, payload) {
      switch (type) {
        case WS_EVENT.GAME_START:
          this.reset();
          return true;
        case WS_EVENT.GAME_END:
          return false;
        case WS_EVENT.PLAY_ORDER: {
          const p = payload;
          if (typeof (p == null ? void 0 : p.myColor) === "number") this.myColor = p.myColor;
          return true;
        }
        case WS_EVENT.PLAYER_STATE: {
          const players = payload;
          if (Array.isArray(players)) {
            for (const pl of players) {
              if ((pl == null ? void 0 : pl.username) && typeof pl.color === "number") {
                this.colorToName.set(pl.color, pl.username);
              }
            }
          }
          return true;
        }
        case WS_EVENT.BOARD_DESCRIPTION:
          this.loadBoard(payload);
          return true;
        case WS_EVENT.BUILD_CORNER:
          this.buildCorner(payload);
          return true;
        case WS_EVENT.BUILD_EDGE:
          this.buildEdge(payload);
          return true;
        default:
          return false;
      }
    }
    loadBoard(payload) {
      var _a, _b;
      const p = payload;
      const tiles = (_a = p == null ? void 0 : p.tileState) == null ? void 0 : _a.tiles;
      if (!Array.isArray(tiles) || tiles.length === 0) return;
      this.board = buildBoard(
        0,
        tiles.map((t) => {
          const kind = TILE_TYPE[t.tileType] ?? "desert";
          const token = kind === "desert" || !t._diceNumber ? null : t._diceNumber;
          return { q: t.hexFace.x, r: t.hexFace.y, kind, token };
        })
      );
      for (const pe of ((_b = p == null ? void 0 : p.portState) == null ? void 0 : _b.portEdges) ?? []) {
        const kind = PORT_TYPE[pe.portType] ?? "any";
        const port = { kind, ratio: kind === "any" ? 3 : 2 };
        for (const pt of colonistEdgeToPixels(pe.hexEdge)) {
          const v = findVertexAt(this.board, pt.x, pt.y);
          if (v) v.port = { ...port };
        }
      }
      const oldBuildings = this.buildings;
      const oldRoads = this.roads;
      this.buildings = oldBuildings.filter((b) => b.vertexId < this.board.vertices.length);
      this.roads = oldRoads.filter((r) => r.edgeId < this.board.edges.length);
    }
    buildCorner(payload) {
      if (!this.board) return;
      const item = Array.isArray(payload) ? payload[0] : payload;
      if (!(item == null ? void 0 : item.hexCorner) || typeof item.owner !== "number") return;
      const pt = colonistCornerToPixel(item.hexCorner);
      const v = findVertexAt(this.board, pt.x, pt.y);
      if (!v) return;
      const kind = item.buildingType === 2 ? "city" : "settlement";
      const existing = this.buildings.find((b) => b.vertexId === v.id);
      if (existing) {
        existing.kind = kind;
        existing.colorId = item.owner;
      } else {
        this.buildings.push({ vertexId: v.id, colorId: item.owner, kind });
      }
    }
    buildEdge(payload) {
      if (!this.board) return;
      const item = Array.isArray(payload) ? payload[0] : payload;
      if (!(item == null ? void 0 : item.hexEdge) || typeof item.owner !== "number") return;
      const [p1, p2] = colonistEdgeToPixels(item.hexEdge);
      const va = findVertexAt(this.board, p1.x, p1.y);
      const vb = findVertexAt(this.board, p2.x, p2.y);
      if (!va || !vb) return;
      const edge = findEdgeBetween(this.board, va.id, vb.id);
      if (edge && !this.roads.some((r) => r.edgeId === edge.id)) {
        this.roads.push({ edgeId: edge.id, colorId: item.owner });
      }
    }
    /** Distinct color ids in stable order — index becomes engine PlayerId. */
    colorOrder() {
      const colors = /* @__PURE__ */ new Set();
      for (const b of this.buildings) colors.add(b.colorId);
      for (const r of this.roads) colors.add(r.colorId);
      if (this.myColor !== null) colors.add(this.myColor);
      for (const c of this.colorToName.keys()) colors.add(c);
      return [...colors].sort((a, b) => a - b);
    }
    /** Engine GameState for the strategy/placement advisor, or null. */
    toGameState() {
      if (!this.board) return null;
      const order = this.colorOrder();
      const toPid = (c) => Math.min(3, Math.max(0, order.indexOf(c)));
      const state = {
        board: this.board,
        buildings: this.buildings.map((b) => ({
          vertexId: b.vertexId,
          player: toPid(b.colorId),
          kind: b.kind
        })),
        roads: this.roads.map((r) => ({ edgeId: r.edgeId, player: toPid(r.colorId) }))
      };
      const youPlayer = this.myColor !== null && order.includes(this.myColor) ? toPid(this.myColor) : null;
      return { state, youPlayer };
    }
  }
  let tracker = null;
  let overlay = null;
  const bridge = new BoardBridge();
  let observer = null;
  let lastProcessedIndex = -1;
  let renderTimer;
  function getYouName() {
    var _a;
    const el = document.getElementsByClassName("web-header-username")[0];
    return ((_a = el == null ? void 0 : el.textContent) == null ? void 0 : _a.trim()) || null;
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
      }
    }, 400);
  }
  function injectPageTap() {
    var _a;
    try {
      const runtime = (_a = typeof browser !== "undefined" ? browser : chrome) == null ? void 0 : _a.runtime;
      if (!runtime) return;
      const s = document.createElement("script");
      s.src = runtime.getURL("inject.js");
      s.onload = () => s.remove();
      (document.head || document.documentElement).appendChild(s);
    } catch {
    }
  }
  window.addEventListener("message", (ev) => {
    const data = ev.data;
    if (ev.source !== window && ev.source !== null) return;
    if (!(data == null ? void 0 : data.__catan_copilot__) || typeof data.type !== "number") return;
    bridge.handle(data.type, data.payload);
    if (tracker && !tracker.youName && bridge.myColor !== null) {
      tracker.youName = bridge.colorToName.get(bridge.myColor) ?? null;
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
    applyEvent(tracker, parseLogRow(el));
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
    if (!overlay) overlay = new Overlay(document);
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
  injectPageTap();
  watchForGame();
})();
