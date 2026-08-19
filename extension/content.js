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
  const RESOURCE_IMG_SELECTOR = Object.keys(ALT_TO_RESOURCE).flatMap((a) => [`img[alt="${a}"]`, `img[alt="${cap(a)}"]`]).join(", ");
  function cap(s) {
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
      (n) => el.querySelector(`img[alt="${n}"], img[alt="${cap(n)}"]`)
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
  function emptyHand() {
    return Object.fromEntries(RESOURCES.map((r) => [r, 0]));
  }
  function getPlayer(state, name, color = "#888") {
    let p = state.players.get(name);
    if (!p) {
      p = {
        name,
        color,
        hand: emptyHand(),
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
  const COSTS = {
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
        applyDelta(p, COSTS[ev.what]);
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
        applyDelta(p, COSTS.dev);
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
      tagline: "Take the best production available, decide later",
      weights: { wood: 1, brick: 1, sheep: 1, wheat: 1, ore: 1 },
      buildOrder: ["settlement", "road", "city", "dev", "settlement"]
    }
  ];
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
  function robberAdvice(state) {
    const you = state.youName;
    const opponents = [...state.players.values()].filter((p2) => p2.name !== you);
    if (opponents.length === 0) return null;
    const scored = opponents.map((p2) => {
      const prod = productionTotal(expectedProduction(p2));
      return { p: p2, threat: visibleVp(p2) * 1.2 + prod * 36 * 0.6 + handTotal(p2) * 0.15 };
    }).sort((a, b) => b.threat - a.threat);
    const { p } = scored[0];
    let best = null;
    for (const [n, delta] of p.incomeByNumber) {
      for (const [res, count] of Object.entries(delta)) {
        const value = (count ?? 0) * pips(n);
        if (!best || value > best.amount) best = { n, res, amount: value };
      }
    }
    const blockHint = best ? ` Their biggest earner is ${best.n} (pays them ${p.incomeByNumber.get(best.n) ? describeDelta(p.incomeByNumber.get(best.n)) : best.res}) — block that tile.` : "";
    return {
      target: p.name,
      reason: `${p.name} leads the threat board: ${visibleVp(p)} visible VP, ~${(productionTotal(expectedProduction(p)) * 36).toFixed(0)} pips of income, ${handTotal(p)}${p.uncertainty ? `±${p.uncertainty}` : ""} cards in hand.` + blockHint
    };
  }
  function describeDelta(d) {
    return Object.entries(d).filter(([, v]) => (v ?? 0) > 0).map(([r, v]) => `${v} ${r}`).join(", ");
  }
  function tradeTips(state, name, fit) {
    const p = state.players.get(name);
    if (!p || !fit) return [];
    const tips = [];
    const w = fit.strategy.weights;
    const prod = expectedProduction(p);
    for (const item of fit.strategy.buildOrder) {
      const cost = BUILD_COSTS[item];
      const missing = RESOURCES.filter((r) => (cost[r] ?? 0) > p.hand[r]);
      const missingCount = missing.reduce((s, r) => s + (cost[r] ?? 0) - p.hand[r], 0);
      if (missingCount === 0) {
        tips.push({ text: `You can afford a ${item} right now — build it.` });
        break;
      }
      if (missingCount <= 2) {
        const surplus = RESOURCES.filter((r) => p.hand[r] - (cost[r] ?? 0) >= 2);
        tips.push({
          text: `One trade from a ${item}: get ${missing.join(" + ")}` + (surplus.length ? `, offer ${surplus.join(" or ")}` : "") + "."
        });
        break;
      }
    }
    const surplusRes = [...RESOURCES].sort(
      (a, b) => prod[b] * (2 - w[b]) - prod[a] * (2 - w[a])
    )[0];
    const neededRes = [...RESOURCES].sort((a, b) => w[b] - w[a]).find((r) => prod[r] < 0.05);
    if (surplusRes && neededRes && surplusRes !== neededRes) {
      tips.push({
        text: `Long-term: your ${surplusRes} income is expendable for ${fit.strategy.name}; you produce almost no ${neededRes} — trade or port toward it.`
      });
    }
    const ratio = RESOURCES.find((r) => (p.bankRatio[r] ?? 4) <= 3);
    if (ratio) {
      tips.push({
        text: `Never accept a worse deal than your ${p.bankRatio[ratio]}:1 bank rate on ${ratio}.`
      });
    }
    return tips;
  }
  const CSS = `
#catan-copilot {
  --surface: #fcfcfb; --ink: #0b0b0b; --ink-2: #52514e; --ink-3: #898781;
  --hairline: #e1e0d9; --accent: #4a3aa7; --bar: #2a78d6;
  --brick: #b5432a; --wheat: #e2a41a; --sheep: #58b47a; --ore: #4f6bb0; --wood: #268c46;
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
    render(state) {
      const parts = [];
      parts.push(this.renderDeck(deckStatus(state), state));
      parts.push(this.renderPlayers(state));
      const you = state.youName;
      if (you && state.players.has(you)) {
        const fits = rankLiveStrategies(state, you);
        parts.push(this.renderStrategies(fits));
        const robber = robberAdvice(state);
        if (robber) {
          parts.push(`<h4>Robber</h4><p class="cc-note">${esc(robber.reason)}</p>`);
        }
        const tips = tradeTips(state, you, fits[0]);
        if (tips.length) parts.push(this.renderTrades(tips));
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
      return `
      <h4>Players</h4>
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
    renderTrades(tips) {
      return `<h4>Trading</h4>${tips.map((t) => `<p class="cc-note">${esc(t.text)}</p>`).join("")}`;
    }
  }
  let tracker = null;
  let overlay = null;
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
        overlay.render(tracker);
      }
    }, 400);
  }
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
  watchForGame();
})();
