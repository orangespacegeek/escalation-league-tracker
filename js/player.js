(function () {
  const app = document.querySelector("#app");
  const { el, clear, api, playerMap, tierLabel } = EL;

  function safeLink(url) {
    if (url && /^https?:\/\//i.test(url)) return el("a", { href: url, rel: "noopener noreferrer" }, url);
    return null;
  }

  async function load() {
    const id = Number(new URLSearchParams(location.search).get("id"));
    if (!Number.isInteger(id) || id < 1) {
      clear(app);
      app.appendChild(el("p", { class: "alert" }, "Missing player."));
      return;
    }
    try {
      const state = await api("GET", "/api/state");
      const player = playerMap(state).get(id);
      if (!player) {
        app.appendChild(el("p", { class: "alert" }, "Player was not found."));
        return;
      }
      document.title = player.name + " · Lost Planet";
      clear(app);
      const head = el("header", { class: "panel" });
      const title = el("h1", null, player.name);
      if (player.removed) title.appendChild(el("span", { class: "badge removed" }, "removed"));
      head.appendChild(title);
      head.appendChild(el("p", { class: "lede" }, player.faction));
      head.appendChild(EL.allegianceBadge(player));
      app.appendChild(head);

      const lists = state.lists.filter((list) => list.player_id === id);
      const listPanel = el("section", { class: "panel" });
      listPanel.appendChild(el("h2", null, "Army lists"));
      if (!state.tiers.length) listPanel.appendChild(el("p", null, "No tiers yet."));
      for (const tier of state.tiers) {
        const list = lists.find((item) => item.tier_id === tier.tier_id);
        const card = el("article", { class: "list-card" });
        card.appendChild(el("h3", null, tierLabel(tier)));
        if (!list || (!list.text && !list.url)) {
          card.appendChild(el("p", { class: "fine" }, "No list for this tier."));
        } else {
          if (list.text) card.appendChild(el("pre", { class: "list-text" }, list.text));
          const link = safeLink(list.url);
          if (link) card.appendChild(link);
        }
        listPanel.appendChild(card);
      }
      app.appendChild(listPanel);

      const games = state.reports
        .filter((report) => report.player_a_id === id || report.player_b_id === id)
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
      const names = playerMap(state);
      const gamePanel = el("section", { class: "panel" });
      gamePanel.appendChild(el("h2", null, "Games"));
      if (!games.length) gamePanel.appendChild(el("p", { class: "fine" }, "No games yet."));
      const stack = el("div", { class: "stack" });
      for (const report of games) {
        const otherId = report.player_a_id === id ? report.player_b_id : report.player_a_id;
        const other = names.get(otherId);
        const otherName = other ? other.name : "Player " + otherId;
        let line = "Drew with " + otherName;
        if (report.winner_id === id) line = "Beat " + otherName;
        if (report.winner_id != null && report.winner_id !== id) line = "Lost to " + otherName;
        const card = el("article", { class: "game-card" });
        card.appendChild(el("h3", null, line));
        const tier = state.tiers.find((item) => item.tier_id === report.tier_id);
        card.appendChild(el("p", { class: "fine" }, (tier ? tierLabel(tier) : "Tier") + " · " + (report.created_at || "").slice(0, 10)));
        if (report.notes) card.appendChild(el("p", null, report.notes));
        stack.appendChild(card);
      }
      gamePanel.appendChild(stack);
      app.appendChild(gamePanel);
    } catch (err) {
      clear(app);
      app.appendChild(el("p", { class: "alert" }, err.message));
    }
  }

  load();
})();
