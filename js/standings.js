(function () {
  const app = document.querySelector("#app");
  const { el, clear, api, tierLabel } = EL;

  function selectedId(state) {
    const params = new URLSearchParams(location.hash.replace(/^#/, ""));
    const raw = params.get("tier");
    if (raw === "overall") return null;
    if (raw && state.tiers.some((tier) => String(tier.tier_id) === raw)) return Number(raw);
    return state.current_tier_id;
  }

  function sliceFor(state, tierId) {
    if (tierId == null) return state.standings.overall;
    return state.standings.tiers[String(tierId)] || { rows: [], not_played: [] };
  }

  function render(state) {
    clear(app);
    const tierId = selectedId(state);
    const current = state.tiers.find((tier) => tier.tier_id === state.current_tier_id);
    const intro = el("p", { class: "lede" });
    intro.textContent = current
      ? "Current tier is " + tierLabel(current) + ". Dates use UTC. Sorted by wins, then fewer losses."
      : "No tier covers today (UTC). Sorted by wins, then fewer losses.";
    app.appendChild(intro);

    const chips = el("div", { class: "chips" });
    function addChip(id, label) {
      const pressed = (id == null && tierId == null) || id === tierId;
      const button = el("button", {
        class: "chip",
        type: "button",
        "aria-pressed": pressed ? "true" : "false",
        onclick: () => {
          location.hash = "tier=" + (id == null ? "overall" : id);
        }
      }, label);
      chips.appendChild(button);
    }
    for (const tier of state.tiers) addChip(tier.tier_id, tierLabel(tier));
    addChip(null, "Overall");
    app.appendChild(chips);

    const table = sliceFor(state, tierId);
    const board = el("section", { class: "panel" });
    board.appendChild(el("h2", null, tierId == null ? "Overall" : "This tier"));
    if (!table.rows.length) {
      board.appendChild(el("p", { class: "fine" }, "No reported games yet."));
    } else {
      const stack = el("div", { class: "stack" });
      for (const row of table.rows) {
        const card = el("a", { class: "player-card", href: "player.html?id=" + row.player_id });
        const who = el("div", { class: "who" });
        const name = el("span", { class: "name" }, row.name);
        if (row.removed) name.appendChild(el("span", { class: "badge removed" }, "removed"));
        who.appendChild(name);
        const meta = el("span", { class: "meta" }, row.faction + " · " + row.allegiance);
        who.appendChild(meta);
        card.appendChild(who);
        const record = el("div", { class: "record" });
        record.appendChild(el("strong", null, row.w + "–" + row.l + "–" + row.d));
        record.appendChild(el("span", null, row.played + (row.played === 1 ? " game" : " games")));
        card.appendChild(record);
        stack.appendChild(card);
      }
      board.appendChild(stack);
    }
    app.appendChild(board);

    const quiet = el("section", { class: "panel" });
    quiet.appendChild(el("h2", null, "Hasn't played yet"));
    if (tierId == null) {
      quiet.appendChild(el("p", { class: "fine" }, "Pick a tier to see who has not played yet."));
    } else if (!state.players.some((player) => !player.removed)) {
      quiet.appendChild(el("p", null, "No one has joined yet."));
      quiet.appendChild(el("a", { class: "btn", href: "join.html" }, "Join the league"));
    } else if (!table.not_played.length) {
      quiet.appendChild(el("p", null, "Everyone has a game in this tier."));
    } else {
      const stack = el("div", { class: "stack" });
      for (const row of table.not_played) {
        const card = el("a", { class: "player-card", href: "player.html?id=" + row.player_id });
        const who = el("div", { class: "who" });
        who.appendChild(el("span", { class: "name" }, row.name));
        who.appendChild(el("span", { class: "meta" }, row.faction + " · " + row.allegiance));
        card.appendChild(who);
        card.appendChild(el("span", { class: "fine" }, "No game"));
        stack.appendChild(card);
      }
      quiet.appendChild(stack);
    }
    app.appendChild(quiet);
  }

  async function load() {
    try {
      const state = await api("GET", "/api/state");
      render(state);
    } catch (err) {
      clear(app);
      app.appendChild(el("p", { class: "alert" }, err.message));
    }
  }

  window.addEventListener("hashchange", load);
  load();
})();
