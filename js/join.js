(function () {
  const { el, api, setToken, token } = EL;
  const form = document.querySelector("#join-form");
  const recover = document.querySelector("#recover-form");
  const out = document.querySelector("#join-out");
  const note = document.querySelector("#existing-note");

  if (token()) note.hidden = false;

  function showError(message) {
    out.replaceChildren(el("p", { class: "alert", role: "alert" }, message));
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    form.querySelector("button").disabled = true;
    try {
      const result = await api("POST", "/api/join", {
        join_code: data.get("join_code"),
        name: data.get("name"),
        faction: data.get("faction"),
        allegiance: data.get("allegiance")
      });
      setToken(result.token);
      const box = el("div", { class: "success", role: "status" });
      box.appendChild(el("p", null, "You're in as " + result.player.name + ". Save this recovery code. It is shown once and is how you sign this device back in."));
      const field = el("input", { class: "recovery", readonly: "readonly", value: result.recovery_code });
      box.appendChild(field);
      const copy = el("button", { class: "btn", type: "button" }, "Copy recovery code");
      copy.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(result.recovery_code);
          copy.textContent = "Copied";
        } catch (_) {
          field.focus();
          field.select();
        }
      });
      box.appendChild(copy);
      box.appendChild(el("a", { class: "btn", href: "play.html" }, "Add your army list"));
      out.replaceChildren(box);
      form.hidden = true;
    } catch (err) {
      showError(err.message);
    } finally {
      form.querySelector("button").disabled = false;
    }
  });

  recover.addEventListener("submit", async (event) => {
    event.preventDefault();
    const code = new FormData(recover).get("recovery_code");
    try {
      const result = await api("POST", "/api/recover", { recovery_code: code });
      setToken(result.token);
      out.replaceChildren(el("p", { class: "success", role: "status" }, "Token restored for " + result.player.name + ". The previous device is signed out."));
      location.href = "play.html";
    } catch (err) {
      showError(err.message);
    }
  });
})();
