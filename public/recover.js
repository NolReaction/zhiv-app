/* Standalone recovery must work without loading the game or changing account data. */
(() => {
  "use strict";
  const recoverButton = document.getElementById("recover-button");
  const diagnosticsButton = document.getElementById("diagnostics-button");
  const status = document.getElementById("recovery-status");
  const output = document.getElementById("diagnostics-output");
  const marker = "__zhiv_recovery";
  let busy = false;

  const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
  const count = value => Number.isSafeInteger(value) && value >= 0;
  const nonempty = value => typeof value === "string" && value.length > 0;
  const date = value => typeof value === "string" && Number.isFinite(Date.parse(value));
  const appStatus = body => object(body) && body.schemaVersion === 1
    && typeof body.buildId === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(body.buildId)
    && typeof body.maintenance === "boolean";
  const snapshot = body => object(body) && nonempty(body.ownerPublicId) && count(body.revision) && date(body.serverTime);
  const validators = {
    "/readyz": body => object(body) && body.status === "ready",
    "/app-status.json": appStatus,
    "/api/v1/me": body => object(body) && object(body.user) && nonempty(body.user.publicId)
      && object(body.profile) && object(body.streak) && count(body.checkInCount) && date(body.serverTime)
      && (body.gameplayGeneration === undefined || count(body.gameplayGeneration)),
    "/api/v1/world": body => snapshot(body) && object(body.state) && body.state.schemaVersion === 1
      && object(body.state.resources) && count(body.catalogVersion),
    "/api/v1/economy": body => snapshot(body) && object(body.wallet) && count(body.wallet.coins)
      && count(body.wallet.pearls) && object(body.inventory) && object(body.buildings)
      && Array.isArray(body.jobs) && object(body.catalog),
  };
  function deadline(operation, milliseconds) {
    const controller = new AbortController();
    let timer;
    return Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error("TIMEOUT")); }, milliseconds);
      }),
    ]).finally(() => clearTimeout(timer));
  }
  async function read(path) {
    return deadline(async signal => {
      const url = new URL(path, location.origin);
      // API contracts may reject query parameters (notably economy). Their
      // traffic is already network-only; only public deployment status is busted.
      if (path === "/app-status.json") url.searchParams.set(marker, String(Date.now()));
      const response = await fetch(url.href, { method: "GET", credentials: "same-origin", cache: "no-store",
        headers: { Accept: "application/json" }, signal });
      const body = await response.json().catch(() => null);
      return { response, body };
    }, 10_000);
  }
  function safeIdentifier(value) {
    return typeof value === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(value) ? value : null;
  }
  function setBusy(value) {
    busy = value;
    recoverButton.disabled = value;
    diagnosticsButton.disabled = value;
  }
  async function checkConnection() {
    if (busy) return;
    setBusy(true);
    status.textContent = "Проверяем соединение. Данные и файлы не изменяются.";
    output.textContent = "";
    try {
      const lines = await Promise.all(Object.entries(validators).map(async ([path, valid]) => {
        try {
          const { response, body } = await read(path);
          const details = [path, `HTTP ${response.status}`];
          if (response.ok) details.push(valid(body) ? "базовый формат JSON: верный" : "базовый формат JSON: НЕВЕРНЫЙ");
          const code = object(body) ? safeIdentifier(body.code) : null;
          const requestId = safeIdentifier(response.headers.get("X-Request-ID"))
            ?? (object(body) ? safeIdentifier(body.requestId) : null);
          if (code) details.push(`code=${code}`);
          if (requestId) details.push(`requestId=${requestId}`);
          if (path === "/app-status.json" && appStatus(body) && body.maintenance) details.push("идёт обновление");
          return details.join(" · ");
        } catch (error) {
          return `${path} · ${error instanceof Error && error.message === "TIMEOUT" ? "время ожидания истекло" : "ответ не получен"}`;
        }
      }));
      output.textContent = lines.join("\n");
      status.textContent = "Проверка завершена. Верный базовый формат ещё не подтверждает полную совместимость игры.";
    } finally { setBusy(false); }
  }
  async function updateWorker() {
    try {
      if (!navigator.serviceWorker) return;
      await deadline(async signal => {
        const registration = await navigator.serviceWorker.getRegistration("/");
        if (registration && !signal.aborted) await registration.update();
      }, 4_000);
    } catch { /* An unavailable worker update must not block a fresh network navigation. */ }
  }
  async function recover() {
    if (busy) return;
    setBusy(true);
    status.textContent = "Проверяем, что обновление сервера завершено…";
    try {
      const { response, body } = await read("/app-status.json");
      if (!response.ok || !appStatus(body)) throw new Error("STATUS_UNAVAILABLE");
      if (body.maintenance) {
        status.textContent = "Сервер ещё обновляется. Подождите немного и повторите. Файлы не изменены.";
        return;
      }
      status.textContent = "Загружаем свежие файлы. Вход и сохранения остаются на месте…";
      if (typeof caches !== "undefined") {
        await deadline(async signal => {
          const names = await caches.keys();
          if (signal.aborted) return;
          const selected = names.filter(name => name.startsWith("zhiv-shell-")
            || name === "zhiv-assets-v1" || name === "zhiv-meta-v1");
          await Promise.all(selected.map(name => caches.delete(name)));
        }, 5_000);
      }
      await updateWorker();
      const target = new URL("/", location.origin);
      target.search = location.search;
      target.hash = location.hash;
      target.searchParams.delete(marker);
      target.searchParams.set(marker, String(Date.now()));
      location.replace(target.href);
    } catch (error) {
      status.textContent = error instanceof Error && ["STATUS_UNAVAILABLE", "TIMEOUT"].includes(error.message)
        ? "Не удалось проверить сервер или обновить файлы вовремя. Проверьте интернет и повторите. Вход и сохранения не изменены."
        : "Браузер не смог обновить файлы. Повторите попытку или пришлите результат проверки соединения. Вход и сохранения не изменены.";
    } finally { setBusy(false); }
  }
  recoverButton.addEventListener("click", recover);
  diagnosticsButton.addEventListener("click", checkConnection);
})();
