// credentials.js
// Credentials view: list credentials, add new ones.

(function () {
  "use strict";

  const STATE = {
    credentials: [],
    root: null,
    tableBody: null,
  };

  function showCredentialsView() {
    UI.setSectionTitle("CREDENTIALS");

    const { root, tableBody, addButton } = buildView();
    STATE.root = root;
    STATE.tableBody = tableBody;

    UI.renderInMain(root);

    addButton.addEventListener("click", openAddCredentialModal);

    loadCredentials();
  }

  function buildView() {
    const root = document.createElement("div");
    root.className = "card";

    const headerRow = document.createElement("div");
    headerRow.className = "tabs-row";

    const title = document.createElement("div");
    title.textContent = "Credentials";

    const addButton = document.createElement("button");
    addButton.type = "button";
    addButton.className = "btn btn-primary btn-sm";
    addButton.textContent = "Add credential";

    headerRow.appendChild(title);
    headerRow.appendChild(addButton);

    root.appendChild(headerRow);

    const tableWrapper = document.createElement("div");
    tableWrapper.className = "table-wrapper mt-sm";

    const table = document.createElement("table");
    table.className = "table";

    const thead = document.createElement("thead");
    const header = document.createElement("tr");

    // REMOVED: Type column
    ["ID", "Name", "Username", "Created at", "Actions"].forEach(function (col) {
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

    return { root, tableBody: tbody, addButton };
  }

  async function loadCredentials() {
    UI.showLoading();
    try {
      const creds = await Api.get("/api/credentials");
      STATE.credentials = Array.isArray(creds) ? creds : [];
      renderCredentials();
    } catch (err) {
      console.error(err);
      renderErrorBlock(err);
    } finally {
      UI.hideLoading();
    }
  }

  async function confirmDeleteCredential(id, name) {
    const ok = window.confirm(
      `Delete credential "${name}" (ID ${id})?\nThis cannot be undone.`
    );
    if (!ok) return;

    try {
      UI.showLoading();
      await Api.delete("/api/credentials/" + String(id));
      UI.showToast("Credential deleted.", "info");
      loadCredentials();
    } catch (err) {
      console.error(err);
      UI.showErrorToast(err);
    } finally {
      UI.hideLoading();
    }
  }

  function renderCredentials() {
    if (!STATE.tableBody) return;
    STATE.tableBody.innerHTML = "";

    STATE.credentials.forEach(function (cred) {
      const row = document.createElement("tr");

      const idCell = document.createElement("td");
      idCell.textContent = String(cred.id);

      const nameCell = document.createElement("td");
      nameCell.textContent = cred.name || "(unnamed)";

      // REMOVED: Type cell

      const usernameCell = document.createElement("td");
      usernameCell.textContent = cred.username || "";

      const createdCell = document.createElement("td");
      createdCell.textContent = cred.created_at || "";

      const actionCell = document.createElement("td");
      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className = "btn btn-danger btn-sm";
      deleteBtn.textContent = "Delete";

      deleteBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        confirmDeleteCredential(cred.id, cred.name);
      });

      actionCell.appendChild(deleteBtn);

      row.appendChild(idCell);
      row.appendChild(nameCell);
      row.appendChild(usernameCell);
      row.appendChild(createdCell);
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
      "Unable to load credentials from the API. Check the appliance and try again.";
    const text = document.createElement("div");
    text.textContent = msg;

    block.appendChild(text);
    STATE.root.appendChild(block);
  }

  function openAddCredentialModal() {
    const content = document.createElement("div");
    const form = document.createElement("form");

    const grid = document.createElement("div");
    grid.className = "form-grid";

    function addField(labelText, name, options) {
      const wrapper = document.createElement("div");
      if (options && options.fullWidth) wrapper.classList.add("full-width");

      const label = document.createElement("div");
      label.className = "form-label";
      label.textContent = labelText;

      const input = document.createElement("input");
      input.type = (options && options.inputType) || "text";
      input.className = "input";
      input.name = name;

      if (options && options.placeholder) input.placeholder = options.placeholder;
      if (options && options.required) input.required = true;

      wrapper.appendChild(label);
      wrapper.appendChild(input);
      grid.appendChild(wrapper);
      return input;
    }

    const nameInput = addField("Name", "name", {
      required: true,
      placeholder: "Launcher Svc",
      fullWidth: true,
    });

    const usernameInput = addField("Username", "username", {
      required: true,
      placeholder: "svc_launcher@loginvsi.com",
      fullWidth: true,
    });

    const secretInput = addField("Password", "secret", {
      inputType: "password",
      required: true,
      fullWidth: true,
    });

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
    saveBtn.textContent = "Save";

    footer.appendChild(cancelBtn);
    footer.appendChild(saveBtn);
    form.appendChild(footer);

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      submitCredentialForm({
        name: nameInput.value,
        type: "ssh-password", // ALWAYS default
        username: usernameInput.value,
        secret: secretInput.value,
      });
    });

    content.appendChild(form);
    UI.openModal(content, { title: "Add credential" });
  }

  async function submitCredentialForm(payload) {
    if (!payload.name || !payload.username || !payload.secret) {
      UI.showToast("Name, username, and secret are required.", "error");
      return;
    }

    UI.showLoading();
    try {
      await Api.postJson("/api/credentials", payload);
      UI.showToast("Credential added.", "info");
      UI.closeModal();
      loadCredentials();
    } catch (err) {
      console.error(err);
      UI.showErrorToast(err);
    } finally {
      UI.hideLoading();
    }
  }

  window.CredentialsView = {
    show: showCredentialsView,
  };
})();
