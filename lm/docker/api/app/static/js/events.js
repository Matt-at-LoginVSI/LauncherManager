// static/js/events.js
(function () {
  "use strict";

  const Events = {
    // data
    runs: [],
    byExecId: new Map(),

    // ui
    container: null,
    initialized: false,

    pageSize: 10,
    pageIndex: 0,

    // realtime
    realtimeBound: false,
    es: null, // fallback EventSource

    // modal/polling state
    modalOpen: false,
    pollTimer: null,
    pollAbort: false,

    mount() {
      const main = document.getElementById("main-content");
      if (!main) return;

      // Leaving/re-entering Events: stop realtime/polling + close modal
      this.stopOutputPolling();
      this.closeModal();
      this.unbindRealtime();

      // --- HTML STRUCTURE UPDATE START ---
      main.innerHTML = `
        <div class="card">
          <div class="card-header">
            <div class="card-title">Events</div>
          </div>

          <div class="card-body">
            <table class="table">
              <thead>
                <tr>
                  <th>Execution ID</th>
                  <th>Job</th>
                  <th>Machine</th>
                  <th>Status</th>
                  <th>Started</th>
                  <th>Ended</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody id="runs-table-body"></tbody>
            </table>

            <div id="events-empty" class="text-muted hidden" style="padding: 12px;">
              No executions found.
            </div>
          </div>

          <div class="table-footer">
            <div style="display: flex; align-items: center; gap: 6px;">
              <div>Items per page:</div>
              <select id="events-page-size" class="select">
                <option value="10">10</option>
                <option value="20">20</option>
                <option value="30">30</option>
                <option value="40">40</option>
                <option value="50">50</option>
              </select>
            </div>
            <div class="pagination">
              <button id="events-prev" class="btn btn-sm" type="button">Prev</button>
              <span id="events-range" class="text-muted" style="margin: 0 8px;">0-0 of 0</span>
              <button id="events-next" class="btn btn-sm" type="button">Next</button>
            </div>
          </div>
        </div>
      `;
      // --- HTML STRUCTURE UPDATE END ---

      const title = document.getElementById("section-title");
      if (title) title.textContent = "EVENTS";

      this.container = document.getElementById("runs-table-body");
      
      // --- EVENT LISTENERS FOR PAGINATION START ---
      const sizeSelect = document.getElementById("events-page-size");
      if (sizeSelect) {
        sizeSelect.value = String(this.pageSize);
        sizeSelect.addEventListener("change", (e) => {
          this.pageSize = parseInt(e.target.value, 10);
          this.pageIndex = 0; // Reset to page 1 on size change
          this.render();
        });
      }

      document.getElementById("events-prev")?.addEventListener("click", () => this.setPage(this.pageIndex - 1));
      document.getElementById("events-next")?.addEventListener("click", () => this.setPage(this.pageIndex + 1));
      // --- EVENT LISTENERS FOR PAGINATION END ---

      this.injectModalCssOnce();
    },

    async init() {
      this.mount();
      if (!this.container) return;

      await this.loadRuns();
      this.bindRealtime();
    },

    async loadRuns() {
      try {
        const resp = await Api.get("/api/rundeck/executions?limit=150&offset=0");
        const items = resp?.items || resp?.executions || (Array.isArray(resp) ? resp : []);
        this.setRuns(items);
        this.render();
      } catch (e) {
        console.error("[Events] Failed to load runs", e);
        this.setRuns([]);
        this.render();
      }
    },

    setRuns(items) {
      this.runs = Array.isArray(items) ? items : [];
      this.byExecId.clear();
      for (const r of this.runs) {
        const id = this.getExecId(r);
        if (id != null) this.byExecId.set(String(id), r);
      }
    },

    // ---------------------------
    // Realtime (SSE)
    // ---------------------------
    bindRealtime() {
      if (this.realtimeBound) return;
      this.realtimeBound = true;

      // Prefer the shared SSE client if you already have one (Launchers page)
      if (window.realtime && typeof window.realtime.on === "function") {
        this._onRundeckExecution = (payload) => this.onRundeckExecution(payload);
        window.realtime.on("rundeck_execution", this._onRundeckExecution);
        return;
      }

      // Fallback: connect directly
      try {
        this.es = new EventSource("/api/events");
        this.es.addEventListener("rundeck_execution", (ev) => {
          try {
            const payload = JSON.parse(ev.data || "{}");
            this.onRundeckExecution(payload);
          } catch (e) {
            console.warn("[Events] SSE payload parse failed", e);
          }
        });

        // Optional: log stream errors (it will auto-reconnect)
        this.es.onerror = () => {
          // keep quiet unless you want noise in console
          // console.warn("[Events] SSE disconnected (will retry)");
        };
      } catch (e) {
        console.warn("[Events] Failed to start EventSource", e);
      }
    },

    unbindRealtime() {
      // shared realtime client
      if (window.realtime && typeof window.realtime.off === "function" && this._onRundeckExecution) {
        window.realtime.off("rundeck_execution", this._onRundeckExecution);
      }
      this._onRundeckExecution = null;

      // direct EventSource
      if (this.es) {
        try {
          this.es.close();
        } catch (_) {}
        this.es = null;
      }

      this.realtimeBound = false;
    },

    onRundeckExecution(evt) {
      // Expected payload from your watcher:
      // { executionId, status, dateStarted, dateEnded, job:{name}, machine_name }
      const execId = evt?.executionId ?? evt?.id;
      if (execId == null) return;

      const key = String(execId);
      let run = this.byExecId.get(key);

      if (!run) {
        // New execution not in our list yet — insert it at top
        run = {
          id: execId,
          status: evt.status || "running",
          dateStarted: evt.dateStarted ? { date: evt.dateStarted } : { date: new Date().toISOString() },
          dateEnded: evt.dateEnded ? { date: evt.dateEnded } : null,
          job: evt.job || (evt.job_name ? { name: evt.job_name } : { name: "" }),
          machine_name: evt.machine_name || "-",
          user: evt.user || "",
          project: evt.project || "",
        };

        this.runs.unshift(run);
        // cap list so it doesn't grow forever
        if (this.runs.length > 200) this.runs.length = 200;

        this.byExecId.set(key, run);
        this.render();
        return;
      }

      // Update existing row
      if (evt.status) run.status = evt.status;

      if (evt.dateStarted) run.dateStarted = { date: evt.dateStarted };
      if (evt.dateEnded) run.dateEnded = { date: evt.dateEnded };

      if (evt.job && evt.job.name) {
        run.job = run.job || {};
        run.job.name = evt.job.name;
      }

      if (evt.machine_name) run.machine_name = evt.machine_name;

      // If modal is open for this execution, reflect status in the modal meta too
      if (this.modalOpen && this._modalExecId === key) {
        const meta = document.getElementById("lm-exec-meta");
        if (meta) {
          // keep it simple: just update the status row if present
          const statusNode = meta.querySelector("[data-k='status']");
          if (statusNode) statusNode.textContent = run.status || "";
        }
      }

      // Update only the one row in DOM if possible; otherwise full render
      const tr = this.container?.querySelector(`tr[data-exec-id="${this.escapeAttr(key)}"]`);
      if (tr) {
        const statusEl = tr.querySelector("[data-col='status']");
        const endedEl = tr.querySelector("[data-col='ended']");
        
        // --- CHANGE START ---
        if (statusEl) statusEl.innerHTML = this.formatStatus(run.status);
        // --- CHANGE END ---
        
        if (endedEl) endedEl.textContent = this.fmtDate(run.dateEnded);
      } else {
        this.render();
      }
    },

    formatStatus(statusRaw) {
      const s = (statusRaw || "").toLowerCase();
      
      // RUNNING (Blue + Spinner)
      if (s === "running" || s === "queued" || s === "scheduled") {
        return `<span class="status-pill status-running"><span class="spinner"></span>${this.escapeHtml(s)}</span>`;
      }
      
      // SUCCESS (Green)
      if (s === "succeeded" || s === "success") {
        return `<span class="status-pill status-success">${this.escapeHtml(s)}</span>`;
      }
      
      // FAILED (Red)
      if (s === "failed" || s === "failure" || s === "aborted" || s === "cancelled" || s === "timedout") {
        return `<span class="status-pill status-failed">${this.escapeHtml(s)}</span>`;
      }
      
      // DEFAULT (Gray)
      return `<span class="status-pill status-other">${this.escapeHtml(s)}</span>`;
    },

    // ---------------------------
    // Rendering
    // ---------------------------
    render() {
      if (!this.container) return;

      const total = this.runs.length;
      const empty = document.getElementById("events-empty");
      if (empty) empty.classList.toggle("hidden", total > 0);

      // --- PAGINATION LOGIC START ---
      const totalPages = Math.max(1, Math.ceil(total / this.pageSize));
      
      // Ensure current page is valid
      if (this.pageIndex >= totalPages) this.pageIndex = totalPages - 1;
      if (this.pageIndex < 0) this.pageIndex = 0;

      const startIdx = this.pageIndex * this.pageSize;
      const endIdx = startIdx + this.pageSize;
      const pageRows = this.runs.slice(startIdx, endIdx);
      // --- PAGINATION LOGIC END ---

      this.container.innerHTML = "";

      // Loop over pageRows instead of this.runs
      for (const run of pageRows) {
        const execId = this.getExecId(run);
        const execKey = execId == null ? "" : String(execId);
        const machine = this.getMachineName(run);

        const tr = document.createElement("tr");
        tr.setAttribute("data-exec-id", execKey);

        tr.innerHTML = `
          <td>${execId ?? ""}</td>
          <td>${this.escapeHtml(run.job?.name || run.jobName || "")}</td>
          <td>${this.escapeHtml(machine)}</td>
          <td data-col="status">${this.formatStatus(run.status)}</td>
          <td>${this.escapeHtml(this.fmtDate(run.dateStarted))}</td>
          <td data-col="ended">${this.escapeHtml(this.fmtDate(run.dateEnded))}</td>
          <td>
            <button class="btn btn-sm" ${execId ? "" : "disabled"}>View</button>
          </td>
        `;

        const btn = tr.querySelector("button");
        btn.onclick = () => {
          if (!execId) return;
          this.openRun(execId);
        };

        this.container.appendChild(tr);
      }

      this.updateFooter(total);
    },

    setPage(newIndex) {
      const total = this.runs.length;
      const totalPages = Math.max(1, Math.ceil(total / this.pageSize));
      
      // Clamp values
      const clamped = Math.min(Math.max(newIndex, 0), totalPages - 1);
      
      if (clamped !== this.pageIndex) {
        this.pageIndex = clamped;
        this.render();
      }
    },

    updateFooter(total) {
      const rangeEl = document.getElementById("events-range");
      const prevBtn = document.getElementById("events-prev");
      const nextBtn = document.getElementById("events-next");

      if (!rangeEl || !prevBtn || !nextBtn) return;

      if (total === 0) {
        rangeEl.textContent = "0-0 of 0";
        prevBtn.disabled = true;
        nextBtn.disabled = true;
        return;
      }

      const start = this.pageIndex * this.pageSize + 1;
      const end = Math.min(total, start + this.pageSize - 1);
      const totalPages = Math.ceil(total / this.pageSize);

      rangeEl.textContent = `${start}-${end} of ${total}`;
      prevBtn.disabled = this.pageIndex <= 0;
      nextBtn.disabled = this.pageIndex >= totalPages - 1;
    },

    // ---------------------------
    // Modal + output polling
    // ---------------------------
    injectModalCssOnce() {
      if (document.getElementById("lm-events-modal-css")) return;

      const style = document.createElement("style");
      style.id = "lm-events-modal-css";
      style.textContent = `
        /* --- UTILITY (Fixes "No executions found" bug) --- */
        .hidden { display: none !important; }

        /* --- Modal Styles --- */
        .lm-modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.45); z-index: 9999; display: flex; align-items: center; justify-content: center; padding: 24px; }
        .lm-modal { width: min(980px, 100%); max-height: 85vh; background: #fff; border-radius: 10px; overflow: hidden; box-shadow: 0 12px 40px rgba(0,0,0,0.25); display: flex; flex-direction: column; }
        .lm-modal-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 14px; border-bottom: 1px solid rgba(0,0,0,0.08); }
        .lm-modal-title { font-weight: 600; }
        .lm-modal-body { padding: 12px 14px; overflow: auto; }
        .lm-kv { display: grid; grid-template-columns: 160px 1fr; gap: 6px 12px; margin-bottom: 12px; font-size: 13px; }
        .lm-kv .k { opacity: 0.7; }
        .lm-output { border: 1px solid rgba(0,0,0,0.10); border-radius: 8px; padding: 10px; background: #0b1020; color: #e9eefc; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; font-size: 12px; white-space: pre-wrap; word-break: break-word; min-height: 180px; }
        .lm-muted { opacity: 0.7; font-size: 12px; margin: 6px 0 10px; }

        /* --- Status Pills --- */
        .status-pill { display: inline-flex; align-items: center; justify-content: center; min-width: 80px; padding: 2px 10px; border-radius: 999px; font-size: 11px; font-weight: 500; text-transform: capitalize; }
        .status-success { background-color: rgba(139, 197, 65, 0.18); color: #16a34a; }
        .status-failed  { background-color: rgba(224, 87, 87, 0.18); color: #b91c1c; }
        .status-running { background-color: rgba(47, 134, 235, 0.18); color: #1d4ed8; }
        .status-other   { background-color: #f3f4f6; color: #374151; }
        .status-pill .spinner { margin-right: 6px; border-width: 2px; width: 10px; height: 10px; }
      `;
      document.head.appendChild(style);
    },

    openModal(execId) {
      const root = document.getElementById("modal-root");
      if (!root) return;

      this.closeModal(); // ensure only one
      this.modalOpen = true;
      this._modalExecId = String(execId);

      // IMPORTANT: your CSS disables pointer-events unless .open is set
      root.classList.add("open");

      const overlay = document.createElement("div");
      overlay.className = "lm-modal-overlay";
      overlay.innerHTML = `
        <div class="lm-modal" role="dialog" aria-modal="true">
          <div class="lm-modal-header">
            <div class="lm-modal-title">Execution ${this.escapeHtml(String(execId))}</div>
            <button class="btn btn-sm" id="lm-modal-close" type="button">Close</button>
          </div>
          <div class="lm-modal-body">
            <div id="lm-exec-meta" class="lm-muted">Loading execution details…</div>
            <div class="lm-muted" style="margin-top:10px;">Output</div>
            <div id="lm-run-output" class="lm-output">Loading output…</div>
          </div>
        </div>
      `;

      overlay.addEventListener("click", (e) => {
        if (e.target === overlay) this.closeModal();
      });

      overlay.querySelector("#lm-modal-close").addEventListener("click", () => this.closeModal());

      // Escape closes
      this._onKeyDown = (e) => {
        if (e.key === "Escape") this.closeModal();
      };
      document.addEventListener("keydown", this._onKeyDown);

      root.appendChild(overlay);
    },

    closeModal() {
      const root = document.getElementById("modal-root");
      if (!root) return;

      this.stopOutputPolling();

      root.innerHTML = "";
      root.classList.remove("open");

      if (this._onKeyDown) document.removeEventListener("keydown", this._onKeyDown);
      this._onKeyDown = null;

      this.modalOpen = false;
      this._modalExecId = null;
    },

    setModalMeta(html) {
      const meta = document.getElementById("lm-exec-meta");
      if (meta) meta.innerHTML = html;
    },

    appendOutput(text) {
      const out = document.getElementById("lm-run-output");
      if (!out) return;
      out.textContent += text;
    },

    replaceOutput(text) {
      const out = document.getElementById("lm-run-output");
      if (!out) return;
      out.textContent = text;
    },

    stopOutputPolling() {
      this.pollAbort = true;
      if (this.pollTimer) {
        clearTimeout(this.pollTimer);
        this.pollTimer = null;
      }
    },

    async openRun(execId) {
      this.openModal(execId);
      this.stopOutputPolling();
      this.pollAbort = false;

      const detailRes = await this.apiGetWithFallback([
        `/api/rundeck/executions/${execId}`,
        `/api/rundeck/execution/${execId}`,
      ]);

      if (!detailRes.ok) {
        this.setModalMeta(
          `Could not load execution detail.<br><span class="lm-muted">Confirm /api/rundeck/executions/{id} exists.</span>`
        );
        this.replaceOutput("Output unavailable (execution detail endpoint not found).");
        return;
      }

      const exec = detailRes.data || {};
      const started = this.fmtDate(exec?.dateStarted || exec?.["date-started"]?.date);
      const ended = this.fmtDate(exec?.dateEnded || exec?.["date-ended"]?.date);
      const status = exec?.status || "";
      const user = exec?.user || "";
      const argstring = exec?.argstring || "";

      const machine =
        exec?.options?.machineName ||
        this.parseOpt(argstring, "machineName") ||
        "-";

      const jobName =
        exec?.job?.name ||
        exec?.job?.id ||
        exec?.job ||
        "";

      // data-k hooks so we can live-update status if SSE arrives while modal is open
      this.setModalMeta(`
        <div class="lm-kv">
          <div class="k">Job</div><div>${this.escapeHtml(String(jobName))}</div>
          <div class="k">Machine</div><div>${this.escapeHtml(String(machine))}</div>
          <div class="k">Status</div><div data-k="status">${this.escapeHtml(String(status))}</div>
          <div class="k">User</div><div>${this.escapeHtml(String(user))}</div>
          <div class="k">Started</div><div>${this.escapeHtml(String(started))}</div>
          <div class="k">Ended</div><div>${this.escapeHtml(String(ended))}</div>
        </div>
        <div class="lm-muted">Args: ${argstring ? this.escapeHtml(argstring) : "(none)"}</div>
      `);

      this.replaceOutput("");
      await this.streamOutput(execId);
    },

    async streamOutput(execId) {
      let offset = 0;
      let lastmod = 0;

      const poll = async () => {
        if (this.pollAbort || !this.modalOpen) return;

        const outputRes = await this.apiGetWithFallback([
          `/api/rundeck/executions/${execId}/output?offset=${offset}&lastmod=${lastmod}`,
          `/api/rundeck/execution/${execId}/output?offset=${offset}&lastmod=${lastmod}`,
        ]);

        if (!outputRes.ok) {
          this.stopOutputPolling();
          this.replaceOutput("Output unavailable (LM-API output route not found).");
          return;
        }

        const data = outputRes.data || {};
        if (!Array.isArray(data.entries)) {
          this.stopOutputPolling();
          this.replaceOutput("Output response format unexpected (entries is not an array).");
          return;
        }

        for (const entry of data.entries) {
          const line = entry?.log ?? "";
          if (line) this.appendOutput(line + "\n");
        }

        offset = typeof data.offset === "number" ? data.offset : offset;
        lastmod = typeof data.lastmod === "number" ? data.lastmod : lastmod;

        if (!data.completed) {
          this.pollTimer = setTimeout(poll, 1500);
        }
      };

      poll();
    },

    // ---------------------------
    // Helpers
    // ---------------------------
    getExecId(run) {
      return run?.id ?? run?.executionId ?? run?.execution_id ?? null;
    },

    fmtDate(d) {
      if (!d) return "";
      if (typeof d === "object" && d.date) return d.date;
      return String(d);
    },

    parseOpt(argstring, optName) {
      if (!argstring) return null;
      const s = String(argstring);
      const re = new RegExp(`(?:^|\\s)-${optName}(?:=|\\s+)(\\S+)`, "i");
      const m = s.match(re);
      return m && m[1] ? m[1] : null;
    },

    getMachineName(run) {
      return (
        run?.machine_name ??
        run?.machineName ??
        run?.options?.machineName ??
        this.parseOpt(run?.argstring, "machineName") ??
        "-"
      );
    },

    isFastApiNotFound(payload) {
      return payload && typeof payload === "object" && payload.detail === "Not Found";
    },

    async apiGetWithFallback(urls) {
      for (const url of urls) {
        try {
          const data = await Api.get(url);
          if (this.isFastApiNotFound(data)) continue;
          return { ok: true, url, data };
        } catch (e) {
          const msg = String(e?.message || e || "");
          if (msg.includes("404") || msg.includes("Not Found")) continue;
          return { ok: false, url, error: e };
        }
      }
      return { ok: false, error: new Error("All endpoint variants returned Not Found") };
    },

    escapeHtml(s) {
      return String(s)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
    },

    escapeAttr(s) {
      // safe enough for our data-exec-id selector
      return String(s).replaceAll('"', '\\"');
    },
  };

  // What main.js expects
  window.EventsView = {
    show() {
      Events.init();
    },
  };
})();
