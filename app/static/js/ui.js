// ui.js
// Shared UI helpers: main view rendering, loading overlay, toasts, modals, etc.

(function () {
  "use strict";

  const mainContent = document.getElementById("main-content");
  const loadingOverlay = document.getElementById("loading-overlay");
  const toastContainer = document.getElementById("toast-container");
  const modalRoot = document.getElementById("modal-root");
  const sectionTitleEl = document.getElementById("section-title");

  let modalOpen = false;

  function renderInMain(node) {
    if (!mainContent) return;
    mainContent.innerHTML = "";
    if (node) {
      mainContent.appendChild(node);
    }
  }

  function showLoading() {
    if (!loadingOverlay) return;
    loadingOverlay.classList.remove("hidden");
  }

  function hideLoading() {
    if (!loadingOverlay) return;
    loadingOverlay.classList.add("hidden");
  }

  function showToast(message, type) {
    if (!toastContainer) return;
    const toast = document.createElement("div");
    toast.className = "toast " + (type === "error" ? "error" : "info");

    const textSpan = document.createElement("span");
    textSpan.textContent = message || "";

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", () => {
      toastContainer.removeChild(toast);
    });

    toast.appendChild(textSpan);
    toast.appendChild(closeBtn);
    toastContainer.appendChild(toast);

    setTimeout(() => {
      if (toast.parentElement === toastContainer) {
        toastContainer.removeChild(toast);
      }
    }, 5000);
  }

  function showErrorToast(error) {
    const msg =
      (error && error.message) || "An unexpected error occurred. Please try again.";
    showToast(msg, "error");
  }

  function openModal(contentNode, options) {
    if (!modalRoot) return;
    modalRoot.innerHTML = "";

    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";

    const modal = document.createElement("div");
    modal.className = "modal";

    const closeBtn = document.createElement("button");
    closeBtn.className = "modal-close";
    closeBtn.type = "button";
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", closeModal);

    modal.appendChild(closeBtn);

    if (options && options.title) {
      const titleEl = document.createElement("div");
      titleEl.className = "modal-title";
      titleEl.textContent = options.title;
      modal.appendChild(titleEl);
    }

    if (contentNode) {
      modal.appendChild(contentNode);
    }

    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) {
        closeModal();
      }
    });

    overlay.appendChild(modal);
    modalRoot.appendChild(overlay);
    modalRoot.classList.add("open");
    modalOpen = true;
  }

  function closeModal() {
    if (!modalRoot) return;
    modalRoot.innerHTML = "";
    modalRoot.classList.remove("open");
    modalOpen = false;
  }

  document.addEventListener("keydown", function (e) {
    if (modalOpen && e.key === "Escape") {
      closeModal();
    }
  });

  function setSectionTitle(title) {
    if (sectionTitleEl) {
      sectionTitleEl.textContent = title || "";
    }
  }

  window.UI = {
    renderInMain,
    showLoading,
    hideLoading,
    showToast,
    showErrorToast,
    openModal,
    closeModal,
    setSectionTitle,
  };
})();
