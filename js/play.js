(function () {
  const app = document.querySelector("#app");
  const { el, clear, api, token, clearToken, tierLabel } = EL;

  function signedOut() {
    clear(app);
    const panel = el("section", { class: "panel" });
    panel.appendChild(el("h2", null, "No token on this device"));
    panel.appendChild(el("p", null, "Join with the league code, or reclaim your player with the recovery code."));
    panel.appendChild(el("a", { class: "btn", href: "join.html" }, "Join or recover"));
    app.appendChild(panel);
  }

  function message(node, kind, text) {
    const box = el("p", { class: kind, role: kind === "alert" ? "alert" : "status" }, text);
    node.replaceChildren(box);
  }

  function render(me, state) {
    clear(app);
    const player = me.player;
    const profile = el("form", { class: "panel" });
    profile.appendChild(el("h2", null, player.name));
    profile.appendChild(el("p", { class: "fine" }, "This browser keeps your edit token. Use the recovery code to move it."));
    profile.appendChild(el("label", { for: "name" }, "Name"));
    profile.appendChild(el("input", { id: "name", name: "name", required: "required", maxlength: "60", value: player.name }));
    profile.appendChild(el("label", { for: "faction" }, "Faction"));
    profile.appendChild(el("input", { id: "faction", name: "faction", required: "required", maxlength: "80", value: player.faction }));
    const allegiance = el("select", { id: "allegiance", name: "allegiance" });
    for (const side of ["Loyalist", "Traitor"]) {
      const option = el("option", { value: side }, side);
      if (side === player.allegiance) option.selected = true;
      allegiance.appendChild(option);
    }
    profile.appendChild(el("label", { for: "allegiance" }, "Allegiance"));
    profile.appendChild(allegiance);
    const profileOut = el("div");
    profile.appendChild(profileOut);
    const save = el("button", { class: "btn", type: "submit" }, "Save profile");
    profile.appendChild(save);
    const forget = el("button", { class: "btn-quiet", type: "button" }, "Forget token on this device");
    forget.addEventListener("click", () => {
      clearToken();
      signedOut();
    });
    profile.appendChild(forget);
    profile.addEventListener("submit", async (event) => {
      event.preventDefault();
      const data = new FormData(profile);
      try {
        await api("PUT", "/api/me", {
          name: data.get("name"),
          faction: data.get("faction"),
          allegiance: data.get("allegiance")
        });
        message(profileOut, "success", "Profile saved.");
      } catch (err) {
        message(profileOut, "alert", err.message);
      }
    });
    app.appendChild(profile);

    const lists = el("section", { class: "panel" });
    lists.appendChild(el("h2", null, "Army lists"));
    lists.appendChild(el("p", { class: "fine" }, "One list per tier. You can edit it until the tier end date. Admins can always edit."));
    const byTier = new Map(me.lists.map((list) => [list.tier_id, list]));
    for (const tier of me.tiers) {
      const existing = byTier.get(tier.tier_id) || { text: "", url: "" };
      const form = el("form", { class: "list-card" });
      const title = el("h3", null, tierLabel(tier));
      if (!tier.open) title.appendChild(el("span", { class: "badge closed" }, "closed"));
      form.appendChild(title);
      const text = el("textarea", { name: "text", maxlength: "30000" }, existing.text || "");
      const url = el("input", { name: "url", type: "url", maxlength: "400", placeholder: "https://", value: existing.url || "" });
      if (!tier.open) {
        text.disabled = true;
        url.disabled = true;
        form.appendChild(el("p", { class: "closed-note" }, "This tier closed on " + (tier.ends_on || "its end date") + "."));
      }
      form.appendChild(el("label", null, "Pasted list"));
      form.appendChild(text);
      form.appendChild(el("label", null, "Or a link"));
      form.appendChild(url);
      const out = el("div");
      form.appendChild(out);
      if (tier.open) form.appendChild(el("button", { class: "btn", type: "submit" }, "Save list"));
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        try {
          await api("PUT", "/api/lists", {
            tier_id: tier.tier_id,
            text: text.value,
            url: url.value
          });
          message(out, "success", "List saved.");
        } catch (err) {
          message(out, "alert", err.message);
        }
      });
      lists.appendChild(form);
    }
    app.appendChild(lists);

    const report = el("form", { class: "panel", id: "report-form" });
    report.appendChild(el("h2", null, "Report a game"));
    const opponents = state.players.filter((person) => !person.removed && person.player_id !== player.player_id);
    if (!opponents.length) {
      report.appendChild(el("p", null, "Waiting for another player to join."));
    } else {
      const opponent = el("select", { name: "opponent_id", required: "required" });
      opponent.appendChild(el("option", { value: "" }, "Choose opponent"));
      for (const person of opponents) opponent.appendChild(el("option", { value: person.player_id }, person.name));
      const tier = el("select", { name: "tier_id" });
      for (const item of me.tiers) {
        const option = el("option", { value: item.tier_id }, tierLabel(item));
        if (item.tier_id === me.current_tier_id) option.selected = true;
        tier.appendChild(option);
      }
      const result = el("select", { name: "result" });
      result.appendChild(el("option", { value: "win" }, "I won"));
      result.appendChild(el("option", { value: "loss" }, "I lost"));
      result.appendChild(el("option", { value: "draw" }, "Draw"));
      report.appendChild(el("label", null, "Opponent"));
      report.appendChild(opponent);
      report.appendChild(el("label", null, "Tier"));
      report.appendChild(tier);
      report.appendChild(el("label", null, "Result"));
      report.appendChild(result);
      report.appendChild(el("label", null, "Your score (optional)"));
      report.appendChild(el("input", { name: "my_score", inputmode: "numeric", maxlength: "5" }));
      report.appendChild(el("label", null, "Opponent score (optional)"));
      report.appendChild(el("input", { name: "opponent_score", inputmode: "numeric", maxlength: "5" }));
      report.appendChild(el("label", null, "Notes (optional)"));
      report.appendChild(el("textarea", { name: "notes", maxlength: "2000" }));
      const out = el("div");
      report.appendChild(out);
      report.appendChild(el("button", { class: "btn", type: "submit" }, "Submit report"));
      report.addEventListener("submit", async (event) => {
        event.preventDefault();
        const data = new FormData(report);
        try {
          await api("POST", "/api/reports", {
            opponent_id: Number(data.get("opponent_id")),
            tier_id: Number(data.get("tier_id")),
            result: data.get("result"),
            my_score: data.get("my_score"),
            opponent_score: data.get("opponent_score"),
            notes: data.get("notes")
          });
          message(out, "success", "Game reported.");
          report.reset();
        } catch (err) {
          message(out, "alert", err.message);
        }
      });
    }
    app.appendChild(report);
  }

  async function load() {
    if (!token()) {
      signedOut();
      return;
    }
    try {
      const me = await api("GET", "/api/me");
      const state = await api("GET", "/api/state");
      render(me, state);
    } catch (err) {
      if (err.status === 401 || err.status === 403) clearToken();
      signedOut();
      app.appendChild(el("p", { class: "alert" }, err.message));
    }
  }

  load();
})();
