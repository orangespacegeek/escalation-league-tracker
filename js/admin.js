(function () {
  const gate = document.querySelector("#gate");
  const app = document.querySelector("#app");
  const login = document.querySelector("#login-form");
  const loginOut = document.querySelector("#login-out");
  const { el, clear, api, tierLabel } = EL;
  let restoreToken = null;

  function note(node, kind, text) {
    node.replaceChildren(el("p", { class: kind, role: kind === "alert" ? "alert" : "status" }, text));
  }

  async function sessionOn() {
    const session = await api("GET", "/api/admin/session");
    return !!session.authenticated;
  }

  function tierForm(tier, onDone) {
    const form = el("form", { class: "list-card" });
    form.appendChild(el("h3", null, tier ? tierLabel(tier) : "New tier"));
    form.appendChild(el("label", null, "Name"));
    form.appendChild(el("input", { name: "name", required: "required", maxlength: "60", value: tier ? tier.name : "" }));
    form.appendChild(el("label", null, "Points"));
    form.appendChild(el("input", { name: "points", required: "required", inputmode: "numeric", value: tier ? tier.points : "" }));
    form.appendChild(el("label", null, "Starts"));
    form.appendChild(el("input", { name: "starts_on", type: "date", required: "required", value: tier && tier.starts_on ? tier.starts_on : "" }));
    form.appendChild(el("label", null, "Ends"));
    form.appendChild(el("input", { name: "ends_on", type: "date", value: tier && tier.ends_on ? tier.ends_on : "" }));
    const out = el("div");
    form.appendChild(out);
    const row = el("div", { class: "actions" });
    row.appendChild(el("button", { class: "btn", type: "submit" }, tier ? "Save tier" : "Add tier"));
    if (tier) {
      const remove = el("button", { class: "btn-danger", type: "button" }, "Delete tier");
      remove.addEventListener("click", async () => {
        if (!confirm("Delete this tier?")) return;
        try {
          await api("DELETE", "/api/admin/tiers/" + tier.tier_id);
          onDone();
        } catch (err) {
          note(out, "alert", err.message);
        }
      });
      row.appendChild(remove);
    }
    form.appendChild(row);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const data = new FormData(form);
      const body = {
        name: data.get("name"),
        points: Number(data.get("points")),
        starts_on: data.get("starts_on"),
        ends_on: data.get("ends_on")
      };
      try {
        if (tier) await api("PUT", "/api/admin/tiers/" + tier.tier_id, body);
        else await api("POST", "/api/admin/tiers", body);
        onDone();
      } catch (err) {
        note(out, "alert", err.message);
      }
    });
    return form;
  }

  function render(state) {
    clear(app);
    const tools = el("div", { class: "actions" });
    const logout = el("button", { class: "btn-quiet", type: "button" }, "Log out");
    logout.addEventListener("click", async () => {
      await api("POST", "/api/admin/logout");
      gate.hidden = false;
      app.hidden = true;
    });
    const download = el("button", { class: "btn", type: "button" }, "Download backup");
    download.addEventListener("click", async () => {
      const res = await fetch("/api/admin/backup", { headers: { "X-EL-Request": "1" }, credentials: "same-origin" });
      if (!res.ok) {
        note(backupOut, "alert", "Could not download the backup.");
        return;
      }
      const blob = await res.blob();
      const link = el("a", { href: URL.createObjectURL(blob), download: "escalation-league-backup.json" });
      document.body.appendChild(link);
      link.click();
      link.remove();
    });
    tools.appendChild(download);
    tools.appendChild(logout);
    app.appendChild(tools);

    const tiers = el("section", { class: "panel" });
    tiers.appendChild(el("h2", null, "Tiers"));
    tiers.appendChild(el("p", { class: "fine" }, "The current tier is whichever start and end dates contain today (UTC). If dates overlap, the one that started most recently is current."));
    for (const tier of state.tiers) tiers.appendChild(tierForm(tier, load));
    tiers.appendChild(tierForm(null, load));
    app.appendChild(tiers);

    const code = el("form", { class: "panel" });
    code.appendChild(el("h2", null, "Join code"));
    code.appendChild(el("p", { class: "fine" }, "The current code is stored as a hash, so it is not shown again. Setting a new one replaces it."));
    code.appendChild(el("label", { for: "join_code" }, "New join code"));
    code.appendChild(el("input", { id: "join_code", name: "join_code", required: "required", minlength: "6", maxlength: "64", autocomplete: "off" }));
    const codeOut = el("div");
    code.appendChild(codeOut);
    code.appendChild(el("button", { class: "btn", type: "submit" }, "Change join code"));
    code.addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        await api("PUT", "/api/admin/join-code", { join_code: new FormData(code).get("join_code") });
        code.reset();
        note(codeOut, "success", "Join code updated.");
      } catch (err) {
        note(codeOut, "alert", err.message);
      }
    });
    app.appendChild(code);

    const people = el("section", { class: "panel" });
    people.appendChild(el("h2", null, "Players"));
    for (const player of state.players) {
      const details = el("details", { class: "panel" });
      const summary = el("summary");
      summary.appendChild(el("strong", null, player.name));
      summary.appendChild(document.createTextNode(" · " + player.faction));
      if (player.removed) summary.appendChild(el("span", { class: "badge removed" }, "removed"));
      details.appendChild(summary);
      const form = el("form");
      form.appendChild(el("label", null, "Name"));
      form.appendChild(el("input", { name: "name", required: "required", maxlength: "60", value: player.name }));
      form.appendChild(el("label", null, "Faction"));
      form.appendChild(el("input", { name: "faction", required: "required", maxlength: "80", value: player.faction }));
      const side = el("select", { name: "allegiance" });
      for (const value of ["Loyalist", "Traitor"]) {
        const option = el("option", { value }, value);
        if (value === player.allegiance) option.selected = true;
        side.appendChild(option);
      }
      form.appendChild(el("label", null, "Allegiance"));
      form.appendChild(side);
      const removed = el("input", { name: "removed", type: "checkbox" });
      removed.checked = !!player.removed;
      const removedLabel = el("label", null, " Removed from the league");
      removedLabel.prepend(removed);
      form.appendChild(removedLabel);
      const out = el("div");
      form.appendChild(out);
      const row = el("div", { class: "actions" });
      row.appendChild(el("button", { class: "btn", type: "submit" }, "Save player"));
      const recovery = el("button", { class: "btn-quiet", type: "button" }, "New recovery code");
      recovery.addEventListener("click", async () => {
        try {
          const result = await api("POST", "/api/admin/players/" + player.player_id + "/recovery");
          note(out, "success", "New recovery code (shown once): " + result.recovery_code);
        } catch (err) {
          note(out, "alert", err.message);
        }
      });
      const remove = el("button", { class: "btn-danger", type: "button" }, "Remove player");
      remove.addEventListener("click", async () => {
        if (!confirm("Remove " + player.name + "?")) return;
        try {
          await api("DELETE", "/api/admin/players/" + player.player_id);
          load();
        } catch (err) {
          note(out, "alert", err.message);
        }
      });
      row.appendChild(recovery);
      row.appendChild(remove);
      form.appendChild(row);
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const data = new FormData(form);
        try {
          await api("PUT", "/api/admin/players/" + player.player_id, {
            name: data.get("name"),
            faction: data.get("faction"),
            allegiance: data.get("allegiance"),
            removed: removed.checked
          });
          load();
        } catch (err) {
          note(out, "alert", err.message);
        }
      });
      for (const tier of state.tiers) {
        const existing = state.lists.find((list) => list.player_id === player.player_id && list.tier_id === tier.tier_id);
        const listForm = el("form", { class: "list-card" });
        listForm.appendChild(el("h3", null, "List · " + tierLabel(tier)));
        const text = el("textarea", { name: "text", maxlength: "30000" }, existing ? existing.text : "");
        const url = el("input", { name: "url", type: "url", value: existing && existing.url ? existing.url : "" });
        listForm.appendChild(text);
        listForm.appendChild(url);
        const listOut = el("div");
        listForm.appendChild(listOut);
        listForm.appendChild(el("button", { class: "btn", type: "submit" }, "Save list"));
        listForm.addEventListener("submit", async (event) => {
          event.preventDefault();
          try {
            await api("PUT", "/api/admin/lists", {
              player_id: player.player_id,
              tier_id: tier.tier_id,
              text: text.value,
              url: url.value
            });
            note(listOut, "success", "List saved.");
          } catch (err) {
            note(listOut, "alert", err.message);
          }
        });
        details.appendChild(listForm);
      }
      details.appendChild(form);
      people.appendChild(details);
    }
    app.appendChild(people);

    const reports = el("section", { class: "panel" });
    reports.appendChild(el("h2", null, "Reports"));
    const create = el("form", { class: "list-card" });
    create.appendChild(el("h3", null, "Add a report"));
    const active = state.players.filter((player) => !player.removed);
    function playerSelect(name) {
      const select = el("select", { name });
      for (const player of active) select.appendChild(el("option", { value: player.player_id }, player.name));
      return select;
    }
    const tierSelect = el("select", { name: "tier_id" });
    for (const tier of state.tiers) {
      const option = el("option", { value: tier.tier_id }, tierLabel(tier));
      if (tier.tier_id === state.current_tier_id) option.selected = true;
      tierSelect.appendChild(option);
    }
    const result = el("select", { name: "result" });
    result.appendChild(el("option", { value: "a_win" }, "Player A won"));
    result.appendChild(el("option", { value: "b_win" }, "Player B won"));
    result.appendChild(el("option", { value: "draw" }, "Draw"));
    create.appendChild(el("label", null, "Player A"));
    create.appendChild(playerSelect("player_a_id"));
    create.appendChild(el("label", null, "Player B"));
    create.appendChild(playerSelect("player_b_id"));
    create.appendChild(el("label", null, "Tier"));
    create.appendChild(tierSelect);
    create.appendChild(el("label", null, "Result"));
    create.appendChild(result);
    create.appendChild(el("label", null, "Score A"));
    create.appendChild(el("input", { name: "score_a", inputmode: "numeric" }));
    create.appendChild(el("label", null, "Score B"));
    create.appendChild(el("input", { name: "score_b", inputmode: "numeric" }));
    create.appendChild(el("label", null, "Notes"));
    create.appendChild(el("textarea", { name: "notes" }));
    const createOut = el("div");
    create.appendChild(createOut);
    create.appendChild(el("button", { class: "btn", type: "submit" }, "Add report"));
    create.addEventListener("submit", async (event) => {
      event.preventDefault();
      const data = new FormData(create);
      try {
        await api("POST", "/api/admin/reports", {
          player_a_id: Number(data.get("player_a_id")),
          player_b_id: Number(data.get("player_b_id")),
          tier_id: Number(data.get("tier_id")),
          result: data.get("result"),
          score_a: data.get("score_a"),
          score_b: data.get("score_b"),
          notes: data.get("notes")
        });
        load();
      } catch (err) {
        note(createOut, "alert", err.message);
      }
    });
    if (active.length >= 2) reports.appendChild(create);
    const names = new Map(state.players.map((player) => [player.player_id, player.name]));
    for (const report of state.reports.slice().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))) {
      const form = el("form", { class: "list-card" });
      form.appendChild(el("h3", null, (names.get(report.player_a_id) || "A") + " vs " + (names.get(report.player_b_id) || "B")));
      const aSel = el("select", { name: "player_a_id" });
      const bSel = el("select", { name: "player_b_id" });
      for (const player of state.players) {
        aSel.appendChild(el("option", { value: player.player_id }, player.name));
        bSel.appendChild(el("option", { value: player.player_id }, player.name));
      }
      aSel.value = String(report.player_a_id);
      bSel.value = String(report.player_b_id);
      const tSel = el("select", { name: "tier_id" });
      for (const tier of state.tiers) tSel.appendChild(el("option", { value: tier.tier_id }, tierLabel(tier)));
      tSel.value = String(report.tier_id);
      const rSel = el("select", { name: "result" });
      rSel.appendChild(el("option", { value: "a_win" }, "Player A won"));
      rSel.appendChild(el("option", { value: "b_win" }, "Player B won"));
      rSel.appendChild(el("option", { value: "draw" }, "Draw"));
      rSel.value = report.winner_id == null ? "draw" : report.winner_id === report.player_a_id ? "a_win" : "b_win";
      form.appendChild(el("label", null, "Player A"));
      form.appendChild(aSel);
      form.appendChild(el("label", null, "Player B"));
      form.appendChild(bSel);
      form.appendChild(el("label", null, "Tier"));
      form.appendChild(tSel);
      form.appendChild(el("label", null, "Result"));
      form.appendChild(rSel);
      form.appendChild(el("label", null, "Score A"));
      form.appendChild(el("input", { name: "score_a", value: report.score_a == null ? "" : report.score_a }));
      form.appendChild(el("label", null, "Score B"));
      form.appendChild(el("input", { name: "score_b", value: report.score_b == null ? "" : report.score_b }));
      form.appendChild(el("label", null, "Notes"));
      form.appendChild(el("textarea", { name: "notes" }, report.notes || ""));
      const out = el("div");
      form.appendChild(out);
      const row = el("div", { class: "actions" });
      row.appendChild(el("button", { class: "btn", type: "submit" }, "Save report"));
      const del = el("button", { class: "btn-danger", type: "button" }, "Delete report");
      del.addEventListener("click", async () => {
        if (!confirm("Delete this report?")) return;
        try {
          await api("DELETE", "/api/admin/reports/" + report.report_id);
          load();
        } catch (err) {
          note(out, "alert", err.message);
        }
      });
      row.appendChild(del);
      form.appendChild(row);
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const data = new FormData(form);
        try {
          await api("PUT", "/api/admin/reports/" + report.report_id, {
            player_a_id: Number(data.get("player_a_id")),
            player_b_id: Number(data.get("player_b_id")),
            tier_id: Number(data.get("tier_id")),
            result: data.get("result"),
            score_a: data.get("score_a"),
            score_b: data.get("score_b"),
            notes: data.get("notes")
          });
          note(out, "success", "Report saved.");
          load();
        } catch (err) {
          note(out, "alert", err.message);
        }
      });
      reports.appendChild(form);
    }
    app.appendChild(reports);

    const backup = el("section", { class: "panel" });
    backup.appendChild(el("h2", null, "Restore"));
    backup.appendChild(el("p", { class: "fine" }, "Preview a backup first. Nothing is replaced until you type RESTORE. The file contains credential hashes. Treat it as secret."));
    const file = el("input", { type: "file", accept: "application/json,.json" });
    const backupOut = el("div");
    const confirm = el("input", { name: "confirm", autocomplete: "off", placeholder: "RESTORE" });
    const restore = el("button", { class: "btn-danger", type: "button" }, "Restore backup");
    backup.appendChild(file);
    backup.appendChild(backupOut);
    backup.appendChild(el("label", null, "Type RESTORE"));
    backup.appendChild(confirm);
    backup.appendChild(restore);
    file.addEventListener("change", async () => {
      restoreToken = null;
      const picked = file.files && file.files[0];
      if (!picked) return;
      try {
        const payload = JSON.parse(await picked.text());
        const preview = await api("POST", "/api/admin/backup/preview", payload);
        restoreToken = preview.restore_token;
        const summary = preview.summary;
        note(
          backupOut,
          "success",
          summary.players + " players, " + summary.lists + " lists, " + summary.reports + " reports, " + summary.tiers + " tiers. Join code " + (summary.join_code ? "included" : "missing") + "."
        );
      } catch (err) {
        note(backupOut, "alert", err.message);
      }
    });
    restore.addEventListener("click", async () => {
      try {
        await api("POST", "/api/admin/backup/restore", { confirm: confirm.value, restore_token: restoreToken });
        confirm.value = "";
        restoreToken = null;
        load();
      } catch (err) {
        note(backupOut, "alert", err.message);
      }
    });
    app.appendChild(backup);
  }

  async function load() {
    try {
      if (!(await sessionOn())) {
        gate.hidden = false;
        app.hidden = true;
        return;
      }
      gate.hidden = true;
      app.hidden = false;
      render(await api("GET", "/api/state"));
    } catch (err) {
      gate.hidden = false;
      app.hidden = true;
      note(loginOut, "alert", err.message);
    }
  }

  login.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await api("POST", "/api/admin/login", { password: new FormData(login).get("password") });
      login.reset();
      clear(loginOut);
      load();
    } catch (err) {
      note(loginOut, "alert", err.message);
    }
  });

  load();
})();
