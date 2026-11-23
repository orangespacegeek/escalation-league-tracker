(function (global) {
  const TOKEN_KEY = "el_player_token";

  function token() {
    try {
      return localStorage.getItem(TOKEN_KEY) || "";
    } catch (_) {
      return "";
    }
  }

  function setToken(value) {
    localStorage.setItem(TOKEN_KEY, value);
  }

  function clearToken() {
    localStorage.removeItem(TOKEN_KEY);
  }

  async function api(method, path, body) {
    const headers = { "X-EL-Request": "1" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const current = token();
    if (current) headers.Authorization = "Bearer " + current;
    const res = await fetch(path, {
      method,
      headers,
      credentials: "same-origin",
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (_) {
      json = null;
    }
    if (!res.ok) {
      const err = new Error((json && json.error) || "Request failed");
      err.status = res.status;
      err.body = json;
      throw err;
    }
    return json;
  }

  function el(tag, attrs, text) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [key, value] of Object.entries(attrs)) {
        if (value == null) continue;
        if (key === "class") node.className = value;
        else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), value);
        else node.setAttribute(key, String(value));
      }
    }
    if (text != null) node.textContent = text;
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function playerMap(state) {
    const map = new Map();
    for (const player of state.players || []) map.set(player.player_id, player);
    return map;
  }

  function monthLabel(iso) {
    if (!iso) return "";
    const [y, m, d] = iso.split("-").map(Number);
    if (!y || !m || !d) return iso;
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-GB", {
      month: "short",
      year: "numeric",
      timeZone: "UTC"
    });
  }

  function tierLabel(tier) {
    if (!tier) return "Tier";
    const when = monthLabel(tier.starts_on);
    return when ? tier.name + " · " + when : tier.name;
  }

  function allegianceBadge(player) {
    const badge = el("span", { class: "badge " + (player.allegiance === "Traitor" ? "traitor" : "loyal") }, player.allegiance);
    return badge;
  }

  global.EL = { token, setToken, clearToken, api, el, clear, playerMap, monthLabel, tierLabel, allegianceBadge };
})(window);
