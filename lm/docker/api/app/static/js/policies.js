// policies.js
// Policies view: list policies, upload new policy JSON.

(function () {
  "use strict";

  const STATE = {
    policies: [],
    root: null,
    tableBody: null,
  };

  function showPoliciesView() {
    UI.setSectionTitle("POLICIES");

    const { root, tableBody, uploadButton } = buildView();
    STATE.root = root;
    STATE.tableBody = tableBody;

    UI.renderInMain(root);

    uploadButton.addEventListener("click", openUploadPolicyModal);

    loadPolicies();
  }

  function buildView() {
    const root = document.createElement("div");
    root.className = "card";

    const headerRow = document.createElement("div");
    headerRow.className = "tabs-row";

    const title = document.createElement("div");
    title.textContent = "Policies";

    const uploadButton = document.createElement("button");
    uploadButton.type = "button";
    uploadButton.className = "btn btn-primary btn-sm";
    uploadButton.textContent = "Upload policy";

    headerRow.appendChild(title);
    headerRow.appendChild(uploadButton);

    root.appendChild(headerRow);

    const tableWrapper = document.createElement("div");
    tableWrapper.className = "table-wrapper mt-sm";

    const table = document.createElement("table");
    table.className = "table";

    const thead = document.createElement("thead");
    const header = document.createElement("tr");
    ["ID", "Name", "Actions"].forEach(function (col) {
      const th = document.createElement("th");
      th.textContent = col;
      header.appendChild(th);
    });
    thead.appendChild(header);

    const tbody = document.createElement("tbody");

    table.appendChild(thead);
    table.appendChild(tbody);
    tableWrapper.appendChild(table);

    root.appendChild(tableWrapper);

    return { root, tableBody: tbody, uploadButton };
  }

  async function loadPolicies() {
    UI.showLoading();
    let policies = [];

    try {
      // Try to load policies normally
      const result = await Api.get("/api/policies");

      if (Array.isArray(result)) {
        policies = result;
      } else {
        policies = [];
      }
    } catch (err) {
      console.warn("Policies API unavailable or returned error:", err);

      // Do NOT render an error block for MVP
      // Just show an empty table instead
      policies = [];
    } finally {
      STATE.policies = policies;
      renderPolicies();
      UI.hideLoading();
    }
  }

  async function confirmDeletePolicy(id, name) {
    const ok = window.confirm(
      `Delete policy "${name}" (ID ${id})?\nThis cannot be undone.`
    );
    if (!ok) return;

    try {
      UI.showLoading();
      await Api.delete("/api/policies/" + String(id));
      UI.showToast("Policy deleted.", "info");
      loadPolicies();  // refresh table
    } catch (err) {
      console.error(err);
      UI.showErrorToast(err);
    } finally {
      UI.hideLoading();
    }
  }

  function renderPolicies() {
    if (!STATE.tableBody) return;
    STATE.tableBody.innerHTML = "";

    STATE.policies.forEach(function (policy) {
      const row = document.createElement("tr");

      // ID
      const idCell = document.createElement("td");
      idCell.textContent = String(policy.id);

      // Name
      const nameCell = document.createElement("td");
      nameCell.textContent = policy.name || "(unnamed)";

      // Actions cell
      const actionCell = document.createElement("td");

      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.textContent = "Delete";
      deleteBtn.className = "btn btn-danger btn-sm";

      deleteBtn.addEventListener("click", function (e) {
        e.stopPropagation();   // Prevent triggering row click
        confirmDeletePolicy(policy.id, policy.name);
      });

      actionCell.appendChild(deleteBtn);

      // Row click ? open details
      row.addEventListener("click", function () {
        openPolicyDetails(policy);
      });

      row.appendChild(idCell);
      row.appendChild(nameCell);
      row.appendChild(actionCell);

      STATE.tableBody.appendChild(row);
    });
  }

  function renderErrorBlock(error) {
    if (!STATE.root) return;
    const existing = STATE.root.querySelector(".error-block");
    if (existing) existing.remove();

    const block = document.createElement("div");
    block.className = "error-block mt-sm";

    const msg =
      (error && error.message) ||
      "Unable to load policies from the API. Check the appliance and try again.";
    const text = document.createElement("div");
    text.textContent = msg;

    block.appendChild(text);
    STATE.root.appendChild(block);
  }

  function openUploadPolicyModal() {
    const content = document.createElement("div");

    const form = document.createElement("form");

    const grid = document.createElement("div");
    grid.className = "form-grid";

    const nameWrapper = document.createElement("div");
    nameWrapper.className = "full-width";
    const nameLabel = document.createElement("div");
    nameLabel.className = "form-label";
    nameLabel.textContent = "Policy name";

    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.name = "name";
    nameInput.required = true;
    nameInput.className = "input";
    nameInput.placeholder = "Secure Sandbox Launcher";

    nameWrapper.appendChild(nameLabel);
    nameWrapper.appendChild(nameInput);

    const fileWrapper = document.createElement("div");
    fileWrapper.className = "full-width";
    const fileLabel = document.createElement("div");
    fileLabel.className = "form-label";
    fileLabel.textContent = "Policy JSON file";

    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.name = "file";
    fileInput.accept = ".json,application/json";
    fileInput.required = true;
    fileInput.className = "input";

    fileWrapper.appendChild(fileLabel);
    fileWrapper.appendChild(fileInput);

    grid.appendChild(nameWrapper);
    grid.appendChild(fileWrapper);

    form.appendChild(grid);

    const footer = document.createElement("div");
    footer.className = "modal-footer";

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "btn btn-sm";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", function () {
      UI.closeModal();
    });

    const saveBtn = document.createElement("button");
    saveBtn.type = "submit";
    saveBtn.className = "btn btn-primary btn-sm";
    saveBtn.textContent = "Upload";

    footer.appendChild(cancelBtn);
    footer.appendChild(saveBtn);
    form.appendChild(footer);

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      submitPolicyUpload(form);
    });

    content.appendChild(form);
    UI.openModal(content, { title: "Upload policy" });
  }

  async function submitPolicyUpload(form) {
    const formData = new FormData(form);

    const name = formData.get("name");
    const file = formData.get("file");

    if (!name || !file) {
      UI.showToast("Name and JSON file are required.", "error");
      return;
    }

    UI.showLoading();
    try {
      await Api.postForm("/api/policies", formData);
      UI.showToast("Policy uploaded.", "info");
      UI.closeModal();
      loadPolicies();
    } catch (err) {
      console.error(err);
      UI.showErrorToast(err);
    } finally {
      UI.hideLoading();
    }
  }

  async function openPolicyDetails(policy) {
    const content = document.createElement("div");

    const info = document.createElement("div");
    info.className = "modal-section";
    info.innerHTML =
      "<div class=\"form-label\">Policy</div>" +
      "<div class=\"text-muted\">ID: " +
      String(policy.id) +
      "</div>" +
      "<div class=\"text-muted\">Name: " +
      (policy.name || "(unnamed)") +
      "</div>";

    const jsonSection = document.createElement("div");
    jsonSection.className = "modal-section";

    const jsonLabel = document.createElement("div");
    jsonLabel.className = "form-label";
    jsonLabel.textContent = "Config JSON";

    const pre = document.createElement("pre");
    pre.className = "json-block";
    pre.textContent = "Loading�";

    jsonSection.appendChild(jsonLabel);
    jsonSection.appendChild(pre);

    content.appendChild(info);
    content.appendChild(jsonSection);

    const footer = document.createElement("div");
    footer.className = "modal-footer";

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "btn btn-sm";
    closeBtn.textContent = "Close";
    closeBtn.addEventListener("click", function () {
      UI.closeModal();
    });

    footer.appendChild(closeBtn);
    content.appendChild(footer);

    UI.openModal(content, { title: policy.name || "Policy" });

    // Try to fetch full JSON via /api/policies/{id}. If the backend doesn't
    // support it yet, fall back to a friendly message.
    try {
      const full = await Api.get("/api/policies/" + String(policy.id));
      pre.textContent = JSON.stringify(full, null, 2);
    } catch (err) {
      console.warn("GET /api/policies/{id} not available yet.", err);
      pre.textContent =
        "The backend does not expose /api/policies/" +
        policy.id +
        " yet.\n\nBasic info:\n" +
        JSON.stringify(policy, null, 2);
    }
  }

  window.PoliciesView = {
    show: showPoliciesView,
  };
})();
