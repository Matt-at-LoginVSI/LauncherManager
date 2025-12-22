// launchers.js
// Launchers view: table, search, register form, launcher details, actions, multi-select toolbar.

(function () {
  "use strict";

  const STATE = {
    launchers: [],
    currentRows: [],
    tableBody: null,
    searchInput: null,
    root: null,
    selected: new Set(), // machine_name values
    selectionBar: null,
    selectionText: null,
    masterCheckbox: null,
    busy: new Map(),
    groups: [],
    selectedGroupId: null,
    selectedGroupName: null,
    groupMembersSet: null,
    groupsListEl: null,
    groupBarEl: null,
    pageSize: 10,
    pageIndex: 0,
    filteredRows: [],
    footerLeftEl: null,
    footerRightEl: null,
    footerPrevBtn: null,
    footerNextBtn: null,
    sortKey: "launcher",
    sortDir: "asc",
    sortIcons: {},
    pageSizeSelect: null,
    refreshTimer: null,
    refreshEveryMs: 15000,
  };

  // ============================================================================
  // PUBLIC ENTRY POINT
  // ============================================================================
  function showLaunchersView() {
    UI.setSectionTitle("LAUNCHERS");

    const view = buildView();
    STATE.root = view.root;
    STATE.tableBody = view.tableBody;
    STATE.searchInput = view.searchInput;
    STATE.selectionBar = view.selectionBar;
    STATE.selectionText = view.selectionText;
    STATE.masterCheckbox = view.masterCheckbox;
    STATE.groupsListEl = view.groupsList;
    STATE.groupBarEl = view.groupBar;

    UI.renderInMain(view.root);
    attachEvents(view);
    loadLaunchers();
    initSSE();
    loadGroups();
    startAutoRefresh();
  }

  // ============================================================================
  // HELPERS
  // ============================================================================
  function showGroupBar() {
    if (!STATE.groupBarEl) return;
    if (!STATE.selectedGroupId) return;

    STATE.groupBarEl.innerHTML = "";
    STATE.groupBarEl.style.display = "flex";

    const title = document.createElement("div");
    title.className = "text-muted";
    title.textContent = `Group: ${STATE.selectedGroupName || STATE.selectedGroupId}`;

    const actions = document.createElement("div");
    actions.style.display = "inline-flex";
    actions.style.gap = "6px";

    ["commission", "decommission", "start", "stop"].forEach((action) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn btn-ghost btn-sm";
      btn.textContent = labelForAction(action);
      btn.addEventListener("click", () => runGroupJob(action));
      actions.appendChild(btn);
    });

    STATE.groupBarEl.appendChild(title);
    STATE.groupBarEl.appendChild(actions);
  }

  function hideGroupBar() {
    if (!STATE.groupBarEl) return;
    STATE.groupBarEl.style.display = "none";
    STATE.groupBarEl.innerHTML = "";
  }

  async function runGroupJob(action) {
    if (!STATE.selectedGroupId) {
      UI.showToast("Select a group first.", "error");
      return;
    }

    UI.showLoading();
    try {
      const res = await Api.postJson(
        `/api/groups/${encodeURIComponent(STATE.selectedGroupId)}/${action}`,
        {}
      );

      const queuedCount = (res.queued || []).length;
      const skippedCount = (res.skipped || []).length;

      UI.showToast(
        `${labelForAction(action)} queued for ${queuedCount} launcher(s)` +
          (skippedCount ? ` (${skippedCount} skipped)` : ""),
        "info"
      );
    } catch (err) {
      UI.showErrorToast(err);
    } finally {
      UI.hideLoading();
    }
  }

  async function loadGroups() {
    if (!STATE.groupsListEl) return;
    try {
      const groups = await Api.get("/api/groups");
      STATE.groups = Array.isArray(groups) ? groups : [];
      renderGroupsList();
    } catch (err) {
      console.warn("Failed to load groups", err);
    }
  }

  function renderGroupsList() {
    const el = STATE.groupsListEl;
    if (!el) return;
    el.innerHTML = "";

    const total = STATE.launchers.length;
    el.appendChild(makeGroupButton(null, `All launchers (${total})`));

    STATE.groups
      .filter(g => !/^all(\s+launchers)?$/i.test((g.name || "").trim()))
      .forEach(g => {
        const label = `${g.name}${Number.isFinite(g.member_count) ? ` (${g.member_count})` : ""}`;
        el.appendChild(makeGroupButton(g.id, label));
      });
  }

  function makeGroupButton(groupId, label) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn btn-sm";
    btn.style.justifyContent = "flex-start";
    btn.textContent = label;

    const active = (STATE.selectedGroupId || null) === (groupId || null);
    if (active) btn.classList.add("btn-primary");

    btn.addEventListener("click", async () => {
      STATE.selectedGroupId = groupId;
      STATE.groupMembersSet = null;
      STATE.selectedGroupName = groupId ? label : null;

      // Rerender list to update active styling
      renderGroupsList();

      if (!groupId) {
        hideGroupBar();
        applyFilter(STATE.searchInput ? STATE.searchInput.value || "" : "");
        return;
      }

      await loadGroupMembers(groupId);
      showGroupBar();
      applyFilter(STATE.searchInput ? STATE.searchInput.value || "" : "");
    });

    return btn;
  }

  async function loadGroupMembers(groupId) {
    const res = await Api.get(`/api/groups/${encodeURIComponent(groupId)}`);
    const members = (res && res.members) || [];
    STATE.groupMembersSet = new Set(members.map((m) => m.machine_name));
    STATE.selectedGroupName = res.group?.name || STATE.selectedGroupName;
  }

  function normalizeVersion(v) {
    if (!v) return "";
    return v.replace(/^v/i, "").trim();
  }

  function fmtTS(ts) {
    if (!ts) return "";
    const d = new Date(ts);
    return d.toLocaleDateString() + " " + d.toLocaleTimeString();
  }

  function getSelectedLaunchers() {
    const names = Array.from(STATE.selected);
    return STATE.launchers.filter((l) => names.includes(l.machine_name));
  }

  let sse;

  function initSSE() {
    // 1. If a shared client already exists, just bind our listeners
    if (window.realtime) {
      bindLauncherEvents();
      return;
    }

    // 2. Otherwise, create the shared client
    const listeners = new Map();
    const es = new EventSource("/api/events");

    // Define which events we care about globally
    const eventTypes = ["automation_run", "launcher_state", "rundeck_execution"];

    eventTypes.forEach((type) => {
      es.addEventListener(type, (e) => {
        try {
          const payload = JSON.parse(e.data);
          const cbs = listeners.get(type);
          if (cbs) cbs.forEach((cb) => cb(payload));
        } catch (err) {
          console.warn("SSE Parse Error", err);
        }
      });
    });

    es.onerror = () => {
      console.warn("SSE disconnected (will retry automatically)");
      // EventSource reconnects automatically, usually no action needed
    };

    // Expose globally for events.js to reuse
    window.realtime = {
      on(type, cb) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type).add(cb);
      },
      off(type, cb) {
        const cbs = listeners.get(type);
        if (cbs) cbs.delete(cb);
      },
      // Optional: expose raw source if needed
      es: es, 
    };

    // 3. Now bind our specific launcher events
    bindLauncherEvents();
  }

  function bindLauncherEvents() {
    // Prevent double-binding if initSSE is called multiple times
    if (STATE._launcherEventsBound) return;
    STATE._launcherEventsBound = true;

    window.realtime.on("automation_run", handleAutomationEvent);
    window.realtime.on("launcher_state", handleLauncherStateEvent);
  }

  function startAutoRefresh() {
    stopAutoRefresh();
    STATE.refreshTimer = setInterval(refreshLaunchersSoft, STATE.refreshEveryMs);
  }

  function stopAutoRefresh() {
    if (STATE.refreshTimer) {
      clearInterval(STATE.refreshTimer);
      STATE.refreshTimer = null;
    }
  }

  async function refreshLaunchersSoft() {
    // If user navigated away, stop polling
    if (!STATE.root || !document.body.contains(STATE.root)) {
      stopAutoRefresh();
      return;
    }

    try {
      const fresh = await Api.get("/api/launchers");
      if (!Array.isArray(fresh)) return;

      // Merge updates by machine_name (keeps selection + references stable)
      const byName = new Map(STATE.launchers.map(l => [l.machine_name, l]));

      fresh.forEach((n) => {
        const key = n.machine_name;
        if (!key) return;

        const existing = byName.get(key);
        if (existing) {
          // Shallow merge top-level
          Object.assign(existing, n);

          // Keep properties merged (optional but helpful)
          if (n.properties) {
            existing.properties = Object.assign({}, existing.properties || {}, n.properties || {});
          }
        } else {
          STATE.launchers.push(n);
        }
      });

      // Rebuild filteredRows using current filter inputs (do NOT reset pageIndex)
      const q = (STATE.searchInput ? (STATE.searchInput.value || "") : "").toLowerCase();
      const groupSet = STATE.groupMembersSet;

      const filtered = STATE.launchers.filter((l) => {
        const name = (l.machine_name || "");
        if (groupSet && !groupSet.has(name)) return false;
        return name.toLowerCase().includes(q);
      });

      STATE.filteredRows = filtered;

      // Keep groups counts fresh too (optional, but usually expected)
      renderGroupsList();

      // Re-render table with latest data
      renderTable(STATE.filteredRows);
    } catch (e) {
      console.warn("Auto refresh failed", e);
    }
  }

  function handleAutomationEvent(evt) {
    const { machine_name, status, job_type } = evt;

    if (!machine_name) return;

    if (status === "queued" || status === "running") {
      STATE.busy.set(machine_name, job_type);
    } else {
      STATE.busy.delete(machine_name);
    }

    // Update launcher online flag if provided
    const launcher = STATE.launchers.find(l => l.machine_name === machine_name);
    if (launcher && typeof evt.online === "boolean") {
      launcher.online = evt.online;
    }

    renderTable(STATE.filteredRows);
  }

  function setPage(newIndex) {
    const total = (STATE.filteredRows || []).length;
    const totalPages = Math.max(1, Math.ceil(total / STATE.pageSize));
    const clamped = Math.min(Math.max(newIndex, 0), totalPages - 1);

    if (clamped === STATE.pageIndex) return;
    STATE.pageIndex = clamped;

    renderTable(STATE.filteredRows);
  }

  function updateFooter(total) {
    if (STATE.pageSizeSelect) {
      STATE.pageSizeSelect.value = String(STATE.pageSize);
    }
    if (!STATE.footerRightEl) return;

    if (!total) {
      STATE.footerRightEl.textContent = "0-0 of 0";
      if (STATE.footerPrevBtn) STATE.footerPrevBtn.disabled = true;
      if (STATE.footerNextBtn) STATE.footerNextBtn.disabled = true;
      return;
    }

    const start = STATE.pageIndex * STATE.pageSize + 1;
    const end = Math.min(total, start + STATE.pageSize - 1);

    STATE.footerRightEl.textContent = `${start}-${end} of ${total}`;

    const totalPages = Math.ceil(total / STATE.pageSize);
    if (STATE.footerPrevBtn) STATE.footerPrevBtn.disabled = STATE.pageIndex <= 0;
    if (STATE.footerNextBtn) STATE.footerNextBtn.disabled = STATE.pageIndex >= totalPages - 1;
  }

  function setSort(key) {
    if (STATE.sortKey === key) {
      STATE.sortDir = STATE.sortDir === "asc" ? "desc" : "asc";
    } else {
      STATE.sortKey = key;
      STATE.sortDir = "asc";
    }
    STATE.pageIndex = 0;
    renderTable(STATE.filteredRows);
  }

  function sortRows(rows) {
    const dir = STATE.sortDir === "asc" ? 1 : -1;

    const rankOnline = (l) => {
      // Running (busy) > Online > Offline (for asc)
      if (STATE.busy.has(l.machine_name)) return 2;
      return l.online ? 1 : 0;
    };

    const nameKey = (l) => (l.machine_name || "").toLowerCase();

    const out = (rows || []).slice();
    out.sort((a, b) => {
      if (STATE.sortKey === "online") {
        const ra = rankOnline(a);
        const rb = rankOnline(b);
        if (ra !== rb) return (ra - rb) * dir;
        return nameKey(a).localeCompare(nameKey(b)) * dir;
      }

      // launcher
      return nameKey(a).localeCompare(nameKey(b)) * dir;
    });

    return out;
  }

  function updateSortIndicators() {
    const clear = (i) => {
      i.style.borderLeft = "";
      i.style.borderRight = "";
      i.style.borderTop = "";
      i.style.borderBottom = "";
    };

    const up = (i) => {
      i.style.borderLeft = "4px solid transparent";
      i.style.borderRight = "4px solid transparent";
      i.style.borderBottom = "6px solid #9ca3af";
      i.style.borderTop = "0";
    };

    const down = (i) => {
      i.style.borderLeft = "4px solid transparent";
      i.style.borderRight = "4px solid transparent";
      i.style.borderTop = "6px solid #9ca3af";
      i.style.borderBottom = "0";
    };

    ["launcher", "online"].forEach((k) => {
      const icon = STATE.sortIcons[k];
      if (!icon) return;

      if (STATE.sortKey !== k) {
        clear(icon);
        return;
      }

      if (STATE.sortDir === "asc") up(icon);
      else down(icon);
    });
  }

  function handleLauncherStateEvent(evt) {
    const machineName = evt.machine_name || evt.machineName;
    if (!machineName) return;

    const launcher = STATE.launchers.find(l => l.machine_name === machineName);
    if (!launcher) return;

    if (typeof evt.online === "boolean") {
      launcher.online = evt.online;
    }

    // optional: keep state in properties if you want it
    if (evt.state) {
      launcher.properties = launcher.properties || {};
      launcher.properties.state = evt.state;
    }

    // IMPORTANT: always re-render from full filtered set
    renderTable(STATE.filteredRows || []);
  }

  async function deleteLauncher(machineName) {
    if (!confirm(`Are you sure you want to permanently delete ${machineName}?`)) return;

    UI.showLoading();
    try {
      await Api.delete(`/api/launchers/${encodeURIComponent(machineName)}`);
      UI.showToast(`Launcher ${machineName} deleted.`, "info");
      
      // Remove from local list immediately
      STATE.launchers = STATE.launchers.filter(l => l.machine_name !== machineName);
      STATE.selected.delete(machineName);
      
      applyFilter(STATE.searchInput ? STATE.searchInput.value : "");
    } catch (err) {
      UI.showErrorToast(err);
    } finally {
      UI.hideLoading();
    }
  }

  // ============================================================================
  // BUILD VIEW
  // ============================================================================
  function buildView() {
    const root = document.createElement("div");
    root.className = "card";

    const headerRow = document.createElement("div");
    headerRow.className = "tabs-row";

    // ----- Title -----
    const title = document.createElement("div");
    title.textContent = "Launchers";
    headerRow.appendChild(title);

    // ----- Search + Register -----
    const rightControls = document.createElement("div");
    rightControls.style.display = "flex";
    rightControls.style.alignItems = "center";
    rightControls.style.gap = "8px";

    const searchInput = document.createElement("input");
    searchInput.type = "search";
    searchInput.placeholder = "Search by launcher name";
    searchInput.className = "input input-search";

    const registerBtn = document.createElement("button");
    registerBtn.type = "button";
    registerBtn.className = "btn btn-primary btn-sm";
    registerBtn.textContent = "Register Launcher";

    const importBtn = document.createElement("button");
    importBtn.type = "button";
    importBtn.className = "btn btn-sm";
    importBtn.textContent = "Import Launchers";
    importBtn.addEventListener("click", openImportCsvModal);

    rightControls.appendChild(searchInput);
    rightControls.appendChild(registerBtn);
    rightControls.appendChild(importBtn);
    headerRow.appendChild(rightControls);

    root.appendChild(headerRow);

    const contentRow = document.createElement("div");
    contentRow.style.display = "flex";
    contentRow.style.gap = "12px";
    contentRow.style.alignItems = "flex-start";

    // Sidebar
    const sidebar = document.createElement("div");
    sidebar.className = "card";
    sidebar.style.width = "260px";
    sidebar.style.padding = "10px";
    sidebar.style.flex = "0 0 260px";
    sidebar.style.alignSelf = "flex-start";
    sidebar.style.height = "auto";

    const sideTitle = document.createElement("div");
    sideTitle.className = "form-label";
    sideTitle.textContent = "Groups";

    const groupsList = document.createElement("div");
    groupsList.style.display = "flex";
    groupsList.style.flexDirection = "column";
    groupsList.style.gap = "6px";
    groupsList.style.marginTop = "8px";

    sidebar.appendChild(sideTitle);
    sidebar.appendChild(groupsList);

    // ----- Table Layout -----
    const tableWrapper = document.createElement("div");
    tableWrapper.className = "table-wrapper";

    // Selection toolbar (multi-select)
    const selectionBar = document.createElement("div");
    selectionBar.className = "selection-bar";
    selectionBar.style.display = "none";
    selectionBar.style.padding = "6px 10px";
    selectionBar.style.borderBottom = "1px solid #e5e7eb";
    selectionBar.style.alignItems = "center";
    selectionBar.style.gap = "8px";
    selectionBar.style.justifyContent = "flex-start"; // keep everything on the left

    const selectionText = document.createElement("div");
    selectionText.className = "text-muted";
    selectionText.textContent = "0 launchers selected";

    const selectionActions = document.createElement("div");
    selectionActions.style.display = "inline-flex";
    selectionActions.style.gap = "6px";
    // no margin-left: auto ? actions stay on the left next to the text

    const btnEditConfig = document.createElement("button");
    btnEditConfig.type = "button";
    btnEditConfig.className = "btn btn-sm";
    btnEditConfig.textContent = "Edit configuration";
    btnEditConfig.addEventListener("click", openBulkEditConfiguration);

    const btnCommission = document.createElement("button");
    btnCommission.type = "button";
    btnCommission.className = "btn btn-ghost btn-sm";
    btnCommission.textContent = "Commission";
    btnCommission.addEventListener("click", () => runBulkJob("commission"));

    const btnDecommission = document.createElement("button");
    btnDecommission.type = "button";
    btnDecommission.className = "btn btn-ghost btn-sm";
    btnDecommission.textContent = "Decommission";
    btnDecommission.addEventListener("click", () => runBulkJob("decommission"));

    const btnStart = document.createElement("button");
    btnStart.type = "button";
    btnStart.className = "btn btn-ghost btn-sm";
    btnStart.textContent = "Start";
    btnStart.addEventListener("click", () => runBulkJob("start"));

    const btnStop = document.createElement("button");
    btnStop.type = "button";
    btnStop.className = "btn btn-ghost btn-sm";
    btnStop.textContent = "Stop";
    btnStop.addEventListener("click", () => runBulkJob("stop"));

    selectionActions.appendChild(btnEditConfig);
    selectionActions.appendChild(btnCommission);
    selectionActions.appendChild(btnDecommission);
    selectionActions.appendChild(btnStart);
    selectionActions.appendChild(btnStop);

    selectionBar.appendChild(selectionText);
    selectionBar.appendChild(selectionActions);

    tableWrapper.appendChild(selectionBar);

    // Table
    const table = document.createElement("table");
    table.className = "table";

    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");

    // Selection column header
    const selectTh = document.createElement("th");
    const masterCheckbox = document.createElement("input");
    masterCheckbox.type = "checkbox";
    masterCheckbox.addEventListener("change", onMasterCheckboxChange);
    selectTh.appendChild(masterCheckbox);
    headRow.appendChild(selectTh);

    function makeSortableTh(label, key) {
      const th = document.createElement("th");
      th.style.cursor = "pointer";
      th.style.userSelect = "none";
      th.title = "Sort";

      const text = document.createElement("span");
      text.textContent = label;

      // Triangle icon (no unicode)
      const icon = document.createElement("span");
      icon.className = "sort-icon";
      icon.style.display = "inline-block";
      icon.style.marginLeft = "6px";
      icon.style.verticalAlign = "middle";
      icon.style.width = "0";
      icon.style.height = "0";

      th.appendChild(text);
      th.appendChild(icon);

      th.addEventListener("click", () => setSort(key));

      STATE.sortIcons[key] = icon;
      return th;
    }

    headRow.appendChild(makeSortableTh("Launcher", "launcher"));
    headRow.appendChild(makeSortableTh("Online", "online"));
    headRow.appendChild(document.createElement("th")).textContent = "Commissioned";

    ["Version", "IP Address", "OS Version", "First Seen", "Autologon", "Actions"].forEach((text) => {
      const th = document.createElement("th");
      th.textContent = text;
      headRow.appendChild(th);
    });

    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    table.appendChild(tbody);
    tableWrapper.appendChild(table);

    // Footer (pagination)
    const footer = document.createElement("div");
    footer.className = "table-footer";

    const footerLeft = document.createElement("div");
    footerLeft.style.display = "flex";
    footerLeft.style.alignItems = "center";
    footerLeft.style.gap = "6px";

    const leftLabel = document.createElement("div");
    leftLabel.textContent = "Items per page:";

    const pageSizeSelect = document.createElement("select");
    pageSizeSelect.className = "select";
    [10, 20, 30, 40, 50].forEach((n) => {
      const opt = document.createElement("option");
      opt.value = String(n);
      opt.textContent = String(n);
      pageSizeSelect.appendChild(opt);
    });
    pageSizeSelect.value = String(STATE.pageSize);

    pageSizeSelect.addEventListener("change", () => {
      const v = parseInt(pageSizeSelect.value, 10);
      if (!Number.isFinite(v)) return;
      STATE.pageSize = v;
      STATE.pageIndex = 0;
      renderTable(STATE.filteredRows);
    });

    STATE.pageSizeSelect = pageSizeSelect;

    footerLeft.appendChild(leftLabel);
    footerLeft.appendChild(pageSizeSelect);

    const footerRight = document.createElement("div");
    footerRight.className = "pagination";

    const prevBtn = document.createElement("button");
    prevBtn.type = "button";
    prevBtn.className = "btn btn-sm";
    prevBtn.textContent = "Prev";

    const rangeSpan = document.createElement("span");
    rangeSpan.className = "text-muted";
    rangeSpan.style.margin = "0 8px";
    rangeSpan.textContent = "0-0 of 0";

    const nextBtn = document.createElement("button");
    nextBtn.type = "button";
    nextBtn.className = "btn btn-sm";
    nextBtn.textContent = "Next";

    footerRight.appendChild(prevBtn);
    footerRight.appendChild(rangeSpan);
    footerRight.appendChild(nextBtn);

    footer.appendChild(footerLeft);
    footer.appendChild(footerRight);

    tableWrapper.appendChild(footer);

    // store refs
    STATE.footerLeftEl = footerLeft;
    STATE.footerRightEl = rangeSpan;
    STATE.footerPrevBtn = prevBtn;
    STATE.footerNextBtn = nextBtn;

    // wire paging
    prevBtn.addEventListener("click", () => setPage(STATE.pageIndex - 1));
    nextBtn.addEventListener("click", () => setPage(STATE.pageIndex + 1));

    tableWrapper.appendChild(footer);

    // Main content wrapper
    const main = document.createElement("div");
    main.style.flex = "1";

    // Group action bar (shows only when a group is selected)
    const groupBar = document.createElement("div");
    groupBar.style.display = "none";
    groupBar.style.padding = "6px 10px";
    groupBar.style.borderBottom = "1px solid #e5e7eb";
    groupBar.style.alignItems = "center";
    groupBar.style.gap = "8px";
    groupBar.style.justifyContent = "flex-start";
    groupBar.style.marginBottom = "8px";

    main.appendChild(groupBar);
    main.appendChild(tableWrapper);

    contentRow.appendChild(sidebar);
    contentRow.appendChild(main);
    root.appendChild(contentRow);

    return {
      root: root,
      tableBody: tbody,
      searchInput: searchInput,
      registerButton: registerBtn,
      importButton: importBtn,
      selectionBar,
      selectionText,
      masterCheckbox,
      groupsList,
      groupBar,
    };
  }

  // ============================================================================
  // EVENT WIRING
  // ============================================================================
  function attachEvents(view) {
    if (view.searchInput) {
      view.searchInput.addEventListener("input", function () {
        applyFilter(view.searchInput.value || "");
      });
    }

    if (view.registerButton) {
      view.registerButton.addEventListener("click", openRegisterLauncherModal);
    }
  }

  // ============================================================================
  // LOAD LAUNCHERS
  // ============================================================================
  async function loadLaunchers() {
    if (!STATE.root) return;
    UI.showLoading();
    try {
      const launchers = await Api.get("/api/launchers");
      STATE.launchers = Array.isArray(launchers) ? launchers : [];
      applyFilter(STATE.searchInput ? STATE.searchInput.value || "" : "");
    } catch (err) {
      renderErrorBlock(err);
    } finally {
      UI.hideLoading();
    }
  }

  function renderErrorBlock(error) {
    const existing = STATE.root.querySelector(".error-block");
    if (existing) existing.remove();

    const block = document.createElement("div");
    block.className = "error-block";

    const msg =
      (error && error.message) ||
      "Unable to load launchers from the API. Check the appliance and try again.";

    block.innerHTML = `
      <div>${msg}</div>
      <button class="btn btn-sm" style="margin-top:8px;">Retry</button>
    `;

    block.querySelector("button").addEventListener("click", function () {
      block.remove();
      loadLaunchers();
    });

    STATE.root.insertBefore(block, STATE.root.children[1] || null);
  }

  // ============================================================================
  // FILTER
  // ============================================================================
  function applyFilter(query) {
    const q = (query || "").toLowerCase();
    const groupSet = STATE.groupMembersSet; // null means "All"

    const filtered = STATE.launchers.filter(function (l) {
      const name = (l.machine_name || "");
      if (groupSet && !groupSet.has(name)) return false;
      return name.toLowerCase().includes(q);
    });

    STATE.pageIndex = 0;
    STATE.filteredRows = filtered;
    renderTable(filtered);
  }

  // ============================================================================
  // SELECTION HELPERS
  // ============================================================================
  function onMasterCheckboxChange(e) {
    const checked = e.target.checked;
    const rows = STATE.currentRows || [];

    if (checked) {
      rows.forEach((l) => STATE.selected.add(l.machine_name));
    } else {
      rows.forEach((l) => STATE.selected.delete(l.machine_name));
    }

    renderTable(STATE.filteredRows);
  }

  function onRowCheckboxChange(machineName, checked) {
    if (checked) {
      STATE.selected.add(machineName);
    } else {
      STATE.selected.delete(machineName);
    }
    syncMasterCheckbox();
    updateSelectionBar();
  }

  function syncMasterCheckbox() {
    if (!STATE.masterCheckbox) return;
    const rows = STATE.currentRows || [];
    if (rows.length === 0) {
      STATE.masterCheckbox.checked = false;
      STATE.masterCheckbox.indeterminate = false;
      return;
    }

    let selectedCount = 0;
    rows.forEach((l) => {
      if (STATE.selected.has(l.machine_name)) selectedCount++;
    });

    if (selectedCount === 0) {
      STATE.masterCheckbox.checked = false;
      STATE.masterCheckbox.indeterminate = false;
    } else if (selectedCount === rows.length) {
      STATE.masterCheckbox.checked = true;
      STATE.masterCheckbox.indeterminate = false;
    } else {
      STATE.masterCheckbox.checked = false;
      STATE.masterCheckbox.indeterminate = true;
    }
  }

  function updateSelectionBar() {
    if (!STATE.selectionBar || !STATE.selectionText) return;
    const count = STATE.selected.size;

    if (count === 0) {
      STATE.selectionBar.style.display = "none";
      STATE.selectionText.textContent = "0 launchers selected";
      return;
    }

    STATE.selectionBar.style.display = "flex";
    STATE.selectionText.textContent =
      count === 1 ? "1 launcher selected" : `${count} launchers selected`;
  }

  // ============================================================================
  // RENDER TABLE
  // ============================================================================
  function renderTable(rows) {
    if (!STATE.tableBody) return;

    // Full filtered set
    STATE.filteredRows = rows || [];
    const total = STATE.filteredRows.length;

    // Sort BEFORE pagination
    const sorted = sortRows(STATE.filteredRows);

    // Clamp pageIndex if data shrank
    const totalPages = Math.max(1, Math.ceil(total / STATE.pageSize));
    if (STATE.pageIndex > totalPages - 1) STATE.pageIndex = totalPages - 1;
    if (STATE.pageIndex < 0) STATE.pageIndex = 0;

    // Slice to current page
    const startIdx = STATE.pageIndex * STATE.pageSize;
    const endIdx = startIdx + STATE.pageSize;
    const pageRows = sorted.slice(startIdx, endIdx);

    // Render only current page
    STATE.tableBody.innerHTML = "";
    STATE.currentRows = pageRows;

    // Read LE version from top bar text: "Login Enterprise: v6.3.14"
    let leVersionRaw = "";
    const versionNode = document.querySelector(".topbar-right");
    if (versionNode) {
      const text = versionNode.textContent || "";
      const match = text.match(/v?(\d+\.\d+\.\d+)/i);
      if (match) leVersionRaw = match[1];
    }
    const normLE = normalizeVersion(leVersionRaw);

    pageRows.forEach((l) => {
      const isBusy = STATE.busy.has(l.machine_name);
      const props = l.properties || {};
      const row = document.createElement("tr");

      if (isBusy) row.classList.add("row-busy");

      const isSelected = STATE.selected.has(l.machine_name);

      // Selection checkbox
      const selectCell = document.createElement("td");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = isSelected;
      cb.disabled = isBusy;
      cb.addEventListener("change", (e) =>
        onRowCheckboxChange(l.machine_name, e.target.checked)
      );
      selectCell.appendChild(cb);
      row.appendChild(selectCell);

      // Launcher name
      const nameCell = document.createElement("td");
      nameCell.textContent = l.machine_name || "";
      row.appendChild(nameCell);

      // Online / Busy
      const onlineCell = document.createElement("td");
      if (isBusy) {
        onlineCell.innerHTML = `
          <span class="spinner"></span>
          <span class="text-muted ml-xs">Running</span>
        `;
      } else {
        onlineCell.innerHTML = l.online
          ? `<span class="status-pill status-online">Online</span>`
          : `<span class="status-pill status-offline">Offline</span>`;
      }
      row.appendChild(onlineCell);

      // Commissioned Status
      const commCell = document.createElement("td");
      commCell.innerHTML = l.commissioned
        ? `<span class="status-pill status-online">Yes</span>`
        : `<span class="status-pill status-offline">No</span>`;
      row.appendChild(commCell);

      // Version (compare with LE)
      const versionCell = document.createElement("td");
      const launcherVersion = props.LauncherVersion || "";
      const normLauncher = normalizeVersion(launcherVersion);
      const isMismatch = normLE && normLauncher && normLauncher !== normLE;

      if (launcherVersion) {
        versionCell.innerHTML = isMismatch
          ? `<span class="status-pill status-offline">${launcherVersion} (Out of date)</span>`
          : `<span class="status-pill status-online">${launcherVersion}</span>`;
      } else {
        versionCell.textContent = "";
      }
      row.appendChild(versionCell);

      // IP Address
      const ipCell = document.createElement("td");
      ipCell.textContent = l.ip_address || "";
      row.appendChild(ipCell);

      // OS Version
      const osCell = document.createElement("td");
      osCell.textContent = props.OSVersion || "";
      row.appendChild(osCell);

      // First Seen
      const firstSeenCell = document.createElement("td");
      firstSeenCell.textContent = fmtTS(l.first_seen);
      row.appendChild(firstSeenCell);

      // Autologon
      const autologonCell = document.createElement("td");
      autologonCell.innerHTML = l.autologon_enabled
        ? `<span class="status-pill status-online">Enabled</span>`
        : `<span class="status-pill status-offline">Disabled</span>`;
      row.appendChild(autologonCell);

      // Actions
      const actionsCell = document.createElement("td");
      const wrapper = document.createElement("div");
      wrapper.style.display = "inline-flex";
      wrapper.style.gap = "6px";

      ["commission", "decommission", "start", "stop"].forEach((action) => {
        const btn = createActionButton(labelForAction(action), action, l.machine_name);
        btn.disabled = isBusy;
        wrapper.appendChild(btn);
      });

      const delBtn = document.createElement("button");
      delBtn.className = "btn btn-ghost btn-sm";
      delBtn.textContent = "Delete";
      delBtn.style.color = "#e05757"; // Red text
      delBtn.disabled = isBusy;
      delBtn.onclick = () => deleteLauncher(l.machine_name);
      wrapper.appendChild(delBtn);

      actionsCell.appendChild(wrapper);
      row.appendChild(actionsCell);

      STATE.tableBody.appendChild(row);
    });

    syncMasterCheckbox();
    updateSelectionBar();
    updateFooter(total);
    updateSortIndicators();
  }

  // ============================================================================
  // ACTION BUTTONS (ROW LEVEL)
  // ============================================================================
  function createActionButton(label, action, machineName) {
    const btn = document.createElement("button");
    btn.className = "btn btn-ghost btn-sm";
    btn.textContent = label;
    btn.onclick = () => triggerAction(btn, action, machineName);
    return btn;
  }

  async function triggerAction(btn, action, machineName) {
    const original = btn.textContent;
    STATE.busy.set(machineName, action);
    renderTable(STATE.filteredRows);

    const progressText = {
      commission: "Commissioning",
      decommission: "Decommissioning",
      start: "Starting",
      stop: "Stopping",
    }[action];

    btn.disabled = true;
    btn.textContent = progressText;

    try {
      const result = await Api.postJson(
        `/api/launchers/${encodeURIComponent(machineName)}/${action}`,
        {}
      );
      const runId = result.automationRunId;
      UI.showToast(
        `${labelForAction(action)} job queued for ${machineName}${
          runId ? ` (Run #${runId})` : ""
        }`,
        "info"
      );
    } catch (err) {
      UI.showErrorToast(err);
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  }

  function labelForAction(action) {
    return (
      {
        commission: "Commission",
        decommission: "Decommission",
        start: "Start",
        stop: "Stop",
      }[action] || "Action"
    );
  }

  // ============================================================================
  // BULK RUNDECK JOBS
  // ============================================================================
  async function runBulkJob(action) {
    const selectedLaunchers = getSelectedLaunchers();
    if (selectedLaunchers.length === 0) {
      UI.showToast("Select at least one launcher first.", "error");
      return;
    }

    UI.showLoading();
    try {
      const res = await Api.postJson(`/api/launchers/bulk/${action}`, {
        machine_names: selectedLaunchers.map((l) => l.machine_name),
      });

      const queuedCount = (res.queued || []).length;
      const skippedCount = (res.skipped || []).length;

      UI.showToast(
        `${labelForAction(action)} queued for ${queuedCount} launcher(s)` +
          (skippedCount ? ` (${skippedCount} skipped)` : ""),
        "info"
      );
    } catch (err) {
      UI.showErrorToast(err);
    } finally {
      UI.hideLoading();
    }
  }

  // ============================================================================
  // REGISTER LAUNCHER MODAL
  // ============================================================================
  function openRegisterLauncherModal() {
    const content = document.createElement("div");

    const section = document.createElement("div");
    section.className = "modal-section";

    const grid = document.createElement("div");
    grid.className = "form-grid";

    function addField(labelText, name, opts) {
      const wrapper = document.createElement("div");
      if (opts?.fullWidth) wrapper.classList.add("full-width");

      const label = document.createElement("div");
      label.className = "form-label";
      label.textContent = labelText;

      const input = document.createElement("input");
      input.type = opts?.inputType || "text";
      input.className = "input";
      input.name = name;
      if (opts?.placeholder) input.placeholder = opts.placeholder;
      if (opts?.required) input.required = true;

      wrapper.appendChild(label);
      wrapper.appendChild(input);
      grid.appendChild(wrapper);
      return input;
    }

    const form = document.createElement("form");

    addField("Machine name", "machineName", {
      required: true,
      placeholder: "ps-launch-001",
    });

    addField("IP address", "ipAddress", {
      required: true,
      placeholder: "10.0.0.42",
    });

    function addSelect(labelText, name) {
      const wrapper = document.createElement("div");

      const label = document.createElement("div");
      label.className = "form-label";
      label.textContent = labelText;

      const select = document.createElement("select");
      select.className = "select";
      select.name = name;

      wrapper.appendChild(label);
      wrapper.appendChild(select);
      grid.appendChild(wrapper);
      return select;
    }

    const credentialSelect = addSelect("Credential", "credentialId");
    const policySelect = addSelect("Policy", "managedPolicyId");

    section.appendChild(grid);
    form.appendChild(section);

    const footer = document.createElement("div");
    footer.className = "modal-footer";

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "btn btn-sm";
    cancelBtn.textContent = "Cancel";
    cancelBtn.onclick = () => UI.closeModal();

    const saveBtn = document.createElement("button");
    saveBtn.type = "submit";
    saveBtn.className = "btn btn-primary btn-sm";
    saveBtn.textContent = "Save";

    footer.appendChild(cancelBtn);
    footer.appendChild(saveBtn);
    form.appendChild(footer);

    form.onsubmit = function (e) {
      e.preventDefault();
      submitRegisterLauncherForm(form);
    };

    content.appendChild(form);
    UI.openModal(content, { title: "Register launcher" });

    populateCredentialsDropdown(credentialSelect);
    populatePoliciesDropdown(policySelect);
  }

  function openImportCsvModal() {
    const content = document.createElement("div");
    const form = document.createElement("form");

    const help = document.createElement("div");
    help.className = "text-muted";
    help.style.marginBottom = "10px";
    help.textContent = "Upload a CSV with columns: Machine name, IP address, Credential, Policy.";

    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = ".csv,text/csv";
    fileInput.className = "input";
    fileInput.required = true;

    const footer = document.createElement("div");
    footer.className = "modal-footer";

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "btn btn-sm";
    cancelBtn.textContent = "Cancel";
    cancelBtn.onclick = () => UI.closeModal();

    const uploadBtn = document.createElement("button");
    uploadBtn.type = "submit";
    uploadBtn.className = "btn btn-primary btn-sm";
    uploadBtn.textContent = "Import";

    footer.appendChild(cancelBtn);
    footer.appendChild(uploadBtn);

    form.appendChild(help);
    form.appendChild(fileInput);
    form.appendChild(footer);

    form.onsubmit = async (e) => {
      e.preventDefault();
      if (!fileInput.files || !fileInput.files[0]) return;

      const fd = new FormData();
      fd.set("file", fileInput.files[0]);

      UI.showLoading();
      try {
        const res = await Api.postForm("/api/launchers/import", fd);

        const ins = res.inserted || 0;
        const upd = res.updated || 0;
        const sk = (res.skipped || []).length;

        UI.showToast(`Import complete: ${ins} inserted, ${upd} updated${sk ? `, ${sk} skipped` : ""}.`, "info");

        UI.closeModal();
        loadLaunchers();
        loadGroups(); // refresh counts
      } catch (err) {
        UI.showErrorToast(err);
      } finally {
        UI.hideLoading();
      }
    };

    content.appendChild(form);
    UI.openModal(content, { title: "Import launchers from CSV" });
  }

  async function populateCredentialsDropdown(selectEl) {
    selectEl.innerHTML = "";
    const none = document.createElement("option");
    none.value = "";
    none.textContent = "None";
    selectEl.appendChild(none);

    try {
      const creds = await Api.get("/api/credentials");
      creds.forEach((c) => {
        const opt = document.createElement("option");
        opt.value = c.id;
        opt.textContent = `${c.name} (${c.username || "no user"})`;
        selectEl.appendChild(opt);
      });
    } catch (err) {
      UI.showErrorToast(err);
    }
  }

  async function populatePoliciesDropdown(selectEl) {
    selectEl.innerHTML = "";
    const none = document.createElement("option");
    none.value = "";
    none.textContent = "None";
    selectEl.appendChild(none);

    try {
      const policies = await Api.get("/api/policies");
      policies.forEach((p) => {
        const opt = document.createElement("option");
        opt.value = p.id;
        opt.textContent = p.name;
        selectEl.appendChild(opt);
      });
    } catch (err) {
      UI.showErrorToast(err);
    }
  }

  async function submitRegisterLauncherForm(form) {
    const formData = new FormData(form);

    const machineName = formData.get("machineName");
    const ipAddress = formData.get("ipAddress");

    if (!machineName || !ipAddress) {
      UI.showToast("Machine name and IP address are required.", "error");
      return;
    }

    formData.set("sshHost", ipAddress);
    formData.set("sshPort", "22");

    UI.showLoading();
    try {
      await Api.postForm("/api/launchers/register", formData);
      UI.closeModal();
      UI.showToast("Launcher saved.", "info");
      loadLaunchers();
    } catch (err) {
      UI.showErrorToast(err);
    } finally {
      UI.hideLoading();
    }
  }

  // ============================================================================
  // BULK EDIT CONFIGURATION
  // ============================================================================
  async function openBulkEditConfiguration() {
    const selectedLaunchers = getSelectedLaunchers();
    if (selectedLaunchers.length === 0) {
      UI.showToast("Select at least one launcher first.", "error");
      return;
    }

    UI.showLoading();
    try {
      const [credentials, policies] = await Promise.all([
        Api.get("/api/credentials"),
        Api.get("/api/policies"),
      ]);

      const content = document.createElement("div");
      const section = document.createElement("div");
      section.className = "modal-section";

      const grid = document.createElement("div");
      grid.className = "form-grid";

      const title = document.createElement("div");
      title.className = "form-label";
      title.textContent =
        selectedLaunchers.length === 1
          ? "Edit configuration for 1 launcher"
          : `Edit configuration for ${selectedLaunchers.length} launchers`;
      content.appendChild(title);

      // Figure out current credential / policy across selection
      const first = selectedLaunchers[0];

      let credId = first.credential_id || null;
      let sameCred = true;
      selectedLaunchers.forEach((l) => {
        if ((l.credential_id || null) !== credId) sameCred = false;
      });

      let polId = first.managed_policy_id || null;
      let samePol = true;
      selectedLaunchers.forEach((l) => {
        if ((l.managed_policy_id || null) !== polId) samePol = false;
      });

      const credLookup = {};
      credentials.forEach((c) => {
        credLookup[c.id] = c.name;
      });

      const polLookup = {};
      policies.forEach((p) => {
        polLookup[p.id] = p.name;
      });

      const currentCredLabel = !credId
        ? "none"
        : sameCred
        ? credLookup[credId] || `ID ${credId}`
        : "mixed";

      const currentPolLabel = !polId
        ? "none"
        : samePol
        ? polLookup[polId] || `ID ${polId}`
        : "mixed";

      // Credential select
      const credWrap = document.createElement("div");
      const credLabel = document.createElement("div");
      credLabel.className = "form-label";
      credLabel.textContent = "Credential";

      const credSelect = document.createElement("select");
      credSelect.className = "select";
      credSelect.name = "credentialId";

      const credLeaveOpt = document.createElement("option");
      credLeaveOpt.value = "";
      credLeaveOpt.textContent = `Leave unchanged (${currentCredLabel})`;
      credSelect.appendChild(credLeaveOpt);

      credentials.forEach((c) => {
        const opt = document.createElement("option");
        opt.value = c.id;
        opt.textContent = `${c.name} (${c.username || "no user"})`;
        credSelect.appendChild(opt);
      });

      credWrap.appendChild(credLabel);
      credWrap.appendChild(credSelect);

      // Policy select
      const polWrap = document.createElement("div");
      const polLabel = document.createElement("div");
      polLabel.className = "form-label";
      polLabel.textContent = "Policy";

      const polSelect = document.createElement("select");
      polSelect.className = "select";
      polSelect.name = "managedPolicyId";

      const polLeaveOpt = document.createElement("option");
      polLeaveOpt.value = "";
      polLeaveOpt.textContent = `Leave unchanged (${currentPolLabel})`;
      polSelect.appendChild(polLeaveOpt);

      policies.forEach((p) => {
        const opt = document.createElement("option");
        opt.value = p.id;
        opt.textContent = p.name;
        polSelect.appendChild(opt);
      });

      polWrap.appendChild(polLabel);
      polWrap.appendChild(polSelect);

      grid.appendChild(credWrap);
      grid.appendChild(polWrap);
      section.appendChild(grid);
      content.appendChild(section);

      const footer = document.createElement("div");
      footer.className = "modal-footer";

      const cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.className = "btn btn-sm";
      cancelBtn.textContent = "Cancel";
      cancelBtn.onclick = () => UI.closeModal();

      const saveBtn = document.createElement("button");
      saveBtn.type = "button";
      saveBtn.className = "btn btn-primary btn-sm";
      saveBtn.textContent = "Save";
      saveBtn.onclick = () =>
        bulkApplyConfiguration(selectedLaunchers, credSelect.value, polSelect.value);

      footer.appendChild(cancelBtn);
      footer.appendChild(saveBtn);
      content.appendChild(footer);

      UI.openModal(content, { title: "Edit configuration" });

      // Tweak this modal's width so it auto-sizes and avoids horizontal scroll
      const modalEl = document.querySelector(".modal");
      if (modalEl) {
        modalEl.style.width = "auto";       // shrink-to-fit content
        modalEl.style.maxWidth = "520px";   // cap at the normal modal width
        modalEl.style.minWidth = "360px";   // keep it from getting too tiny
        modalEl.style.overflowX = "hidden"; // no bottom scrollbar
      }
    } catch (err) {
      UI.showErrorToast(err);
    } finally {
      UI.hideLoading();
    }
  }

  async function bulkApplyConfiguration(selectedLaunchers, credentialId, policyId) {
    // Empty string means "leave unchanged".
    const setCred = credentialId !== "";
    const setPol = policyId !== "";

    if (!setCred && !setPol) {
      UI.showToast("Nothing to update. Choose a credential or policy.", "error");
      return;
    }

    UI.showLoading();
    try {
      await Promise.all(
        selectedLaunchers.map((details) => {
          const formData = new FormData();
          formData.set("machineName", details.machine_name);
          formData.set("ipAddress", details.ip_address || "");
          formData.set("sshHost", details.ssh_host || details.ip_address || "");
          formData.set("sshPort", details.ssh_port || 22);

          if (setCred) {
            formData.set("credentialId", credentialId);
          }
          if (setPol) {
            formData.set("managedPolicyId", policyId);
          }

          return Api.postForm("/api/launchers/register", formData);
        })
      );

      UI.showToast("Configuration updated.", "info");
      UI.closeModal();
      loadLaunchers();
    } catch (err) {
      UI.showErrorToast(err);
    } finally {
      UI.hideLoading();
    }
  }

  // ============================================================================
  // LAUNCHER DETAILS (still available for future use)
  // ============================================================================
  async function openLauncherDetails(launcherBasic) {
    const machineName = launcherBasic.machine_name;
    if (!machineName) return;

    UI.showLoading();
    try {
      const [details, credentials, policies] = await Promise.all([
        Api.get(`/api/launchers/${encodeURIComponent(machineName)}`),
        Api.get("/api/credentials"),
        Api.get("/api/policies"),
      ]);

      const content = document.createElement("div");

      const detailsSection = document.createElement("div");
      detailsSection.className = "modal-section";

      const label = document.createElement("div");
      label.className = "form-label";
      label.textContent = "Launcher details";

      const pre = document.createElement("pre");
      pre.className = "json-block";
      pre.textContent = JSON.stringify(details, null, 2);

      detailsSection.appendChild(label);
      detailsSection.appendChild(pre);

      const policySection = document.createElement("div");
      policySection.className = "modal-section";

      const pLabel = document.createElement("div");
      pLabel.className = "form-label";
      pLabel.textContent = "Policy";

      const policyInfo = document.createElement("div");
      policyInfo.className = "text-muted";

      const currentPolicyId = details.managed_policy_id || null;
      const match = policies.find((p) => p.id === currentPolicyId);
      policyInfo.textContent = currentPolicyId
        ? `Current policy: ${match ? match.name : currentPolicyId}`
        : "No policy attached.";

      const viewPolicyBtn = document.createElement("button");
      viewPolicyBtn.className = "btn btn-sm mt-sm";
      viewPolicyBtn.textContent = "View policy JSON";

      const policyPre = document.createElement("pre");
      policyPre.className = "json-block mt-sm";
      policyPre.style.display = "none";

      viewPolicyBtn.onclick = async () => {
        if (policyPre.style.display === "block") {
          policyPre.style.display = "none";
          viewPolicyBtn.textContent = "View policy JSON";
          return;
        }
        try {
          const pj = await Api.get(`/api/launchers/${machineName}/policy`);
          policyPre.textContent = JSON.stringify(pj, null, 2);
          policyPre.style.display = "block";
          viewPolicyBtn.textContent = "Hide policy JSON";
        } catch (err) {
          UI.showErrorToast(err);
        }
      };

      policySection.appendChild(pLabel);
      policySection.appendChild(policyInfo);
      policySection.appendChild(viewPolicyBtn);
      policySection.appendChild(policyPre);

      const footer = document.createElement("div");
      footer.className = "modal-footer";

      const closeBtn = document.createElement("button");
      closeBtn.className = "btn btn-sm";
      closeBtn.textContent = "Close";
      closeBtn.onclick = () => UI.closeModal();

      footer.appendChild(closeBtn);

      content.appendChild(detailsSection);
      content.appendChild(policySection);
      content.appendChild(footer);

      UI.openModal(content, { title: machineName });
    } catch (err) {
      UI.showErrorToast(err);
    } finally {
      UI.hideLoading();
    }
  }

  // ============================================================================
  // EXPORT
  // ============================================================================
  window.LaunchersView = {
    show: showLaunchersView,
  };
})();
