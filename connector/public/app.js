const connectorForm = document.getElementById("connector-form");
const message = document.getElementById("message");
const cloudBaseUrlInput = document.getElementById("cloud-base-url-input");
const connectorKeyInput = document.getElementById("connector-key-input");
const connectorNameInput = document.getElementById("connector-name-input");
const syncIntervalInput = document.getElementById("sync-interval-input");
const cloudSelfSignedInput = document.getElementById("cloud-self-signed-input");
const stationsContainer = document.getElementById("stations-container");
const stationTemplate = document.getElementById("station-card-template");
const addStationButton = document.getElementById("add-station-button");
const saveConfigButton = document.getElementById("save-config-button");
const syncNowButton = document.getElementById("sync-now-button");
const statusList = document.getElementById("status-list");
const connectorNameLabel = document.getElementById("connector-name-label");
const connectorStatusLabel = document.getElementById("connector-status-label");
const connectorLastSyncLabel = document.getElementById("connector-last-sync-label");

addStationButton.addEventListener("click", () => {
  addStationCard();
});

saveConfigButton.addEventListener("click", async () => {
  await saveConfig();
});

syncNowButton.addEventListener("click", async () => {
  await syncNow();
});

initialize();

async function initialize() {
  await refreshState();
}

async function refreshState() {
  try {
    const response = await fetch("/api/state");
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || "Failed to load connector state.");
    }

    populateForm(payload.config);
    renderState(payload.state);
  } catch (error) {
    setMessage(error.message, "error");
  }
}

function populateForm(config) {
  cloudBaseUrlInput.value = config.cloudBaseUrl || "";
  connectorKeyInput.value = config.connectorKey || "";
  connectorNameInput.value = config.connectorName || "";
  syncIntervalInput.value = String(config.syncIntervalMs || 15000);
  cloudSelfSignedInput.checked = Boolean(config.cloudAllowSelfSigned);

  stationsContainer.innerHTML = "";
  const stations = Array.isArray(config.stations) && config.stations.length
    ? config.stations
    : [createDefaultStation()];

  stations.forEach((station) => addStationCard(station));
}

function createDefaultStation() {
  return {
    stationId: "",
    name: "",
    baseUrl: "",
    username: "",
    password: "",
    allowSelfSigned: true,
    entries: [
      {
        path: "config/Drivers/ObixNetwork/exports/",
        slotPath: "slot:/Drivers/ObixNetwork/exports"
      }
    ]
  };
}

function addStationCard(station = createDefaultStation()) {
  const fragment = stationTemplate.content.cloneNode(true);
  const card = fragment.querySelector(".station-config-card");
  const title = fragment.querySelector(".station-card-title");

  title.textContent = station.name || station.stationId || "Local Station";

  setFieldValue(card, "stationId", station.stationId || "");
  setFieldValue(card, "name", station.name || "");
  setFieldValue(card, "baseUrl", station.baseUrl || "");
  setFieldValue(card, "username", station.username || "");
  setFieldValue(card, "password", station.password || "");
  setFieldValue(card, "branchPath", station.entries?.[0]?.path || "config/Drivers/ObixNetwork/exports/");
  setFieldValue(card, "branchSlotPath", station.entries?.[0]?.slotPath || "slot:/Drivers/ObixNetwork/exports");
  setCheckboxValue(card, "allowSelfSigned", Boolean(station.allowSelfSigned));

  card.querySelectorAll("input").forEach((input) => {
    input.addEventListener("input", () => {
      title.textContent =
        getFieldValue(card, "name") ||
        getFieldValue(card, "stationId") ||
        "Local Station";
    });
  });

  card.querySelector(".remove-station-button").addEventListener("click", () => {
    card.remove();
    if (!stationsContainer.children.length) {
      addStationCard();
    }
  });

  stationsContainer.appendChild(fragment);
}

async function saveConfig() {
  setMessage("Saving connector setup...", "info");

  try {
    const payload = {
      cloudBaseUrl: cloudBaseUrlInput.value.trim(),
      connectorKey: connectorKeyInput.value.trim(),
      connectorName: connectorNameInput.value.trim(),
      syncIntervalMs: Number(syncIntervalInput.value.trim() || 15000),
      cloudAllowSelfSigned: cloudSelfSignedInput.checked,
      stations: collectStations()
    };

    const response = await fetch("/api/config", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || "Failed to save connector setup.");
    }

    renderState(result.state);
    setMessage("Connector setup saved successfully.", "success");
  } catch (error) {
    setMessage(error.message, "error");
  }
}

async function syncNow() {
  setMessage("Starting manual sync...", "info");

  try {
    const response = await fetch("/api/sync-now", {
      method: "POST"
    });
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || "Failed to start manual sync.");
    }

    renderState(result.state);
    setMessage("Manual sync started.", "success");

    setTimeout(refreshState, 1200);
  } catch (error) {
    setMessage(error.message, "error");
  }
}

function collectStations() {
  return Array.from(stationsContainer.querySelectorAll(".station-config-card"))
    .map((card) => ({
      stationId: getFieldValue(card, "stationId"),
      name: getFieldValue(card, "name"),
      baseUrl: getFieldValue(card, "baseUrl"),
      username: getFieldValue(card, "username"),
      password: getFieldValue(card, "password"),
      allowSelfSigned: getCheckboxValue(card, "allowSelfSigned"),
      entries: [
        {
          type: "branch",
          label: "Obix Exports",
          path: getFieldValue(card, "branchPath"),
          slotPath: getFieldValue(card, "branchSlotPath"),
          recursive: false
        }
      ]
    }))
    .filter((station) => station.stationId || station.name || station.baseUrl);
}

function renderState(runtimeState) {
  connectorNameLabel.textContent = connectorNameInput.value.trim() || "local-connector";
  connectorStatusLabel.textContent = runtimeState.syncInProgress
    ? "Syncing now"
    : runtimeState.syncEnabled
      ? "Ready"
      : "Setup needed";
  connectorLastSyncLabel.textContent = formatDateTime(runtimeState.lastCycleFinishedAt);

  statusList.innerHTML = "";
  const statuses = Object.values(runtimeState.stationStatuses || {});

  if (!statuses.length) {
    statusList.innerHTML = `<div class="empty-state">No station sync has happened yet.</div>`;
  } else {
    statusList.innerHTML = statuses
      .map((station) => {
        return `
          <div class="status-card">
            <strong>${escapeHtml(station.stationName || station.stationId)}</strong>
            <span>Status: ${escapeHtml(station.status || "idle")}</span>
            <span>Last sync: ${escapeHtml(formatDateTime(station.lastSyncedAt))}</span>
            <span>Points: ${escapeHtml(String(station.pointsReceived || 0))}</span>
            <span>${escapeHtml(station.lastError || "No errors")}</span>
          </div>
        `;
      })
      .join("");
  }

  if (runtimeState.message) {
    setMessage(runtimeState.message, "success");
  } else if (runtimeState.lastError) {
    setMessage(runtimeState.lastError, "error");
  } else if (runtimeState.syncEnabled) {
    setMessage("Connector is ready. Save changes or click Sync Now anytime.", "success");
  } else {
    setMessage("Fill the setup form and save it to start syncing.", "info");
  }
}

function setFieldValue(root, field, value) {
  const input = root.querySelector(`[data-field="${field}"]`);
  if (input) {
    input.value = value;
  }
}

function setCheckboxValue(root, field, value) {
  const input = root.querySelector(`[data-field="${field}"]`);
  if (input) {
    input.checked = value;
  }
}

function getFieldValue(root, field) {
  const input = root.querySelector(`[data-field="${field}"]`);
  return input ? input.value.trim() : "";
}

function getCheckboxValue(root, field) {
  const input = root.querySelector(`[data-field="${field}"]`);
  return Boolean(input?.checked);
}

function formatDateTime(value) {
  if (!value) {
    return "Never";
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Never" : date.toLocaleString();
}

function setMessage(text, variant) {
  message.textContent = text;
  message.className = `message ${variant}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
