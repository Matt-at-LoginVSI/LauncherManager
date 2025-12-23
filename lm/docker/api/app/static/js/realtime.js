// realtime.js - SSE client + simple event bus
(function () {
  "use strict";

  let es = null;
  const handlers = Object.create(null); // eventName -> [fn]

  function on(eventName, fn) {
    if (!handlers[eventName]) handlers[eventName] = [];
    handlers[eventName].push(fn);
  }

  function emit(eventName, payload) {
    const list = handlers[eventName] || [];
    list.forEach(function (fn) {
      try { fn(payload); } catch (e) { console.error(e); }
    });
  }

  function connect() {
    if (es) return;

    es = new EventSource("/api/events"); // SSE/EventSource :contentReference[oaicite:5]{index=5}

    ["launcher_state", "automation_run"].forEach(function (evt) {
      es.addEventListener(evt, function (e) {
        let data = null;
        try { data = e.data ? JSON.parse(e.data) : null; }
        catch (_) { data = e.data; }
        emit(evt, data);
      });
    });

    es.onerror = function () {
      // Browser auto-reconnects based on retry: value
      // Keep this quiet for MVP (avoid toast spam).
    };
  }

  window.Realtime = { connect, on };
})();
