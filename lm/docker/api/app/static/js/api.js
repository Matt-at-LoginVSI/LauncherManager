// api.js
// Simple wrapper around fetch for JSON and form requests.

(function () {
  "use strict";

  async function handleResponse(response) {
    let data;
    const contentType = response.headers.get("Content-Type") || "";

    if (contentType.includes("application/json")) {
      try {
        data = await response.json();
      } catch (e) {
        data = null;
      }
    } else {
      data = await response.text();
    }

    if (!response.ok) {
      const message =
        (data && (data.detail || data.message || data.error)) ||
        `Request failed with status ${response.status}`;
      const error = new Error(message);
      error.status = response.status;
      error.data = data;
      throw error;
    }

    return data;
  }

  async function apiGet(path) {
    const response = await fetch(path, {
      headers: {
        Accept: "application/json",
      },
    });

    // Gracefully handle missing/unimplemented endpoints
    if (response.status === 404 || response.status === 405) {
      return [];
    }

    return handleResponse(response);
  }

  async function apiPostJson(path, body) {
    const response = await fetch(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body || {}),
    });
    return handleResponse(response);
  }

  async function apiPostForm(path, formData) {
    const response = await fetch(path, {
      method: "POST",
      body: formData,
    });
    return handleResponse(response);
  }

async function apiDelete(path) {
  const response = await fetch(path, {
    method: "DELETE",
    headers: {
      Accept: "application/json",
    },
  });

  return handleResponse(response);
}

  window.Api = {
    get: apiGet,
    postJson: apiPostJson,
    postForm: apiPostForm,
    delete: apiDelete,
  };
})();
