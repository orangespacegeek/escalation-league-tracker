(function () {
  const app = document.querySelector("#app");
  const { el, clear, api, playerMap, tierLabel } = EL;

  function render(state) {
    clear(app);
    const params = new URLSearchParams(location.hash.replace(/^#/, ""));
    const raw = params.get("tier");
    const tierId = raw && state.tiers.some((tier) => String(tier.tier_id) === raw) ? Number(raw) : null;
    const chips = el("div", { class: "chips" });
    function chip(id, label) {
      const button = el("button", {
        class: "chip",
        type: "button",
        "aria-pressed": (id == null && tierId == null) || id === tierId ? "true" : "false",
        onclick: () => {
          location.hash = id == null ? "tier=all" : "tier=" + id;
        }
      }, label);
      chips.appendChild(button);
    }
    chip(null, "All tiers");
    for (const tier of state.tiers) chip(tier.tier_id, tierLabel(tier));
    app.appendChild(chips);

    const names = playerMap(state);
    const tiers = new Map(state.tiers.map((tier) => [tier.tier_id, tier]));
    let reports = state.reports.slice().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    if (tierId != null) reports = reports.filter((report) => report.tier_id === tierId);
    const board = el("section", { class: "panel" });
    board.appendChild(el("h2", null, "Game reports"));
    board.appendChild(el("p", null, "Anyone in the league can report a game from My army. Admins can edit or delete a report."));
    board.appendChild(el("a", { class: "btn", href: "play.html" }, "Report a game"));
    if (!reports.length) board.appendChild(el("p", { class: "fine" }, "No games reported."));
    const stack = el("div", { class: "stack" });
    for (const report of reports) {
      const a = names.get(report.player_a_id);
      const b = names.get(report.player_b_id);
      const aName = a ? a.name : "Player " + report.player_a_id;
      const bName = b ? b.name : "Player " + report.player_b_id;
      const card = el("article", { class: "game-card" });
      let headline = aName + " and " + bName + " drew";
      if (report.winner_id === report.player_a_id) headline = aName + " beat " + bName;
      if (report.winner_id === report.player_b_id) headline = bName + " beat " + aName;
      card.appendChild(el("h3", null, headline));
      const tier = tiers.get(report.tier_id);
      const bits = [tier ? tierLabel(tier) : "Tier " + report.tier_id, (report.created_at || "").slice(0, 10)];
      if (report.score_a != null || report.score_b != null) bits.push((report.score_a ?? "–") + "–" + (report.score_b ?? "–"));
      card.appendChild(el("p", { class: "fine" }, bits.join(" · ")));
      if (report.notes) card.appendChild(el("p", null, report.notes));
      const links = el("p", { class: "actions" });
      links.appendChild(el("a", { href: "player.html?id=" + report.player_a_id }, aName));
      links.appendChild(el("a", { href: "player.html?id=" + report.player_b_id }, bName));
      card.appendChild(links);
      stack.appendChild(card);
    }
    board.appendChild(stack);
    app.appendChild(board);
  }

  async function load() {
    try {
      render(await api("GET", "/api/state"));
    } catch (err) {
      clear(app);
      app.appendChild(el("p", { class: "alert" }, err.message));
    }
  }

  window.addEventListener("hashchange", load);
  load();
})();
