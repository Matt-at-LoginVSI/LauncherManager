// main.js
// App bootstrap: navigation, initial view, LE version indicator.

(function () {
  "use strict";

  function init() {
    initNavigation();
    loadLeVersion();
    // Default view
    showView("launchers");
  }

  function initNavigation() {
    const navItems = document.querySelectorAll(".nav-item");
    navItems.forEach(function (item) {
      item.addEventListener("click", function () {
        const view = item.getAttribute("data-view");
        setActiveNav(view);
        showView(view);
      });
    });
  }

  function setActiveNav(view) {
    const navItems = document.querySelectorAll(".nav-item");
    navItems.forEach(function (item) {
      if (item.getAttribute("data-view") === view) {
        item.classList.add("active");
      } else {
        item.classList.remove("active");
      }
    });
  }

function showView(view) {
  switch (view) {
    case "launchers":
      LaunchersView.show();
      break;
    case "policies":
      PoliciesView.show();
      break;
    case "credentials":
      CredentialsView.show();
      break;
    case "events":
      EventsView.show();
      break;
    default:
      LaunchersView.show();
  }
}

  function buildStubView(message) {
    const card = document.createElement("div");
    card.className = "card";
    const text = document.createElement("div");
    text.className = "text-muted";
    text.textContent = message;
    card.appendChild(text);
    return card;
  }

  async function loadLeVersion() {
    const label = document.getElementById("le-version-label");
    if (!label) return;

    try {
      const data = await Api.get("/api/le-version");
      if (data && data.version) {
        label.textContent = "Login Enterprise: v" + data.version;
      } else {
        label.textContent = "Login Enterprise: unknown";
      }
    } catch (err) {
      console.error(err);
      label.textContent = "Login Enterprise: unavailable";
    }
  }

  // Initialize once DOM is ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  window.App = {
    showView,
  };
})();
