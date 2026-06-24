const stationTitle = document.getElementById("station-title");
const selectedStationName = document.getElementById("selected-station-name");
const pointCount = document.getElementById("point-count");
const lastRefresh = document.getElementById("last-refresh");
const tablePointCount = document.getElementById("table-point-count");
const stationBaseUrl = document.getElementById("station-base-url");
const stationEntryCount = document.getElementById("station-entry-count");
const stationLockStatus = document.getElementById("station-lock-status");
const stationConnectionMode = document.getElementById("station-connection-mode");
const stationConnectionHelp = document.getElementById("station-connection-help");
const message = document.getElementById("message");
const tableBody = document.getElementById("points-table-body");
const refreshButton = document.getElementById("refresh-button");
const autoRefresh = document.getElementById("auto-refresh");
const stationSelect = document.getElementById("station-select");
const stationPassword = document.getElementById("station-password");
const unlockButton = document.getElementById("unlock-button");
const clearPasswordButton = document.getElementById("clear-password-button");

let refreshTimer = null;
let stations = [];

refreshButton.addEventListener("click", () => {
  loadSelectedStation();
});

stationSelect.addEventListener("change", () => {
  navigateToStation(stationSelect.value);
});

unlockButton.addEventListener("click", () => {
  savePasswordForSelectedStation();
  loadSelectedStation();
});

clearPasswordButton.addEventListener("click", () => {
  clearPasswordForSelectedStation();
});

autoRefresh.addEventListener("change", () => {
  syncAutoRefresh();
});

initialize();

async function initialize() {
  await loadStations();
  syncAutoRefresh();
}

async function loadStations() {
  setMessage("Loading station list...", "info");

  try {
    const response = await fetch("/api/stations");
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || "Failed to load stations.");
    }

    stations = payload.stations || [];
    renderStationOptions(stations);

    if (!stations.length) {
      stationTitle.textContent = "No stations configured";
      selectedStationName.textContent = "None";
      pointCount.textContent = "0";
      tablePointCount.textContent = "0 points";
      stationBaseUrl.textContent = "No base URL";
      stationEntryCount.textContent = "0 branches";
      stationLockStatus.textContent = "No station";
      stationConnectionMode.textContent = "No station";
      stationConnectionHelp.textContent = "No stations are configured yet.";
      tableBody.innerHTML = `<tr><td colspan="2" class="empty-cell">No stations configured</td></tr>`;
      setMessage("No stations are configured yet.", "error");
      return;
    }

    const requestedStationId = getRequestedStationId();
    const stationId = stations.some((station) => station.id === requestedStationId)
      ? requestedStationId
      : stations[0].id;

    stationSelect.value = stationId;
    stationPassword.value = getSavedPassword(stationId);
    await loadSelectedStation();
  } catch (error) {
    stationTitle.textContent = "Failed";
    selectedStationName.textContent = "Failed";
    tableBody.innerHTML = "";
    setMessage(error.message, "error");
  }
}

async function loadSelectedStation() {
  const stationId = stationSelect.value;
  const station = stations.find((item) => item.id === stationId);

  if (!station) {
    setMessage("Please select a station first.", "error");
    return;
  }

  const connectorMode = station.connectionMode === "connector";
  stationTitle.textContent = station.name;
  selectedStationName.textContent = station.name;
  stationBaseUrl.textContent = station.baseUrl || (connectorMode ? "Private Niagara station" : "No base URL");
  stationEntryCount.textContent = `${station.entryCount || 0} branches`;
  stationConnectionMode.textContent = connectorMode ? "Connector Mode" : "Direct Mode";
  stationPassword.value = getSavedPassword(stationId);
  syncConnectorControls(connectorMode);

  if (connectorMode) {
    stationConnectionHelp.textContent =
      "This station is updated by a local connector running on the same network as Niagara.";
  } else {
    stationConnectionHelp.textContent =
      "Enter the Niagara station password to let the cloud app fetch live values directly.";
  }

  if (!connectorMode && station.requirePasswordPrompt && !getSavedPassword(stationId)) {
    pointCount.textContent = "0";
    tablePointCount.textContent = "0 points";
    lastRefresh.textContent = "Locked";
    stationLockStatus.textContent = "Locked";
    tableBody.innerHTML = `<tr><td colspan="2" class="empty-cell">Enter the station password to load values</td></tr>`;
    setMessage(`Enter the password for ${station.name} to fetch details.`, "info");
    return;
  }

  stationLockStatus.textContent = connectorMode ? "Connector Sync" : "Fetching";
  setMessage(
    connectorMode
      ? `Loading latest synced values for ${station.name}...`
      : `Loading values for ${station.name}...`,
    "info"
  );

  try {
    const response = await fetch(`/api/stations/${encodeURIComponent(stationId)}/points`, {
      headers: buildStationHeaders(stationId, connectorMode)
    });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || `Failed to load points for ${station.name}.`);
    }

    const points = payload.points || [];
    pointCount.textContent = String(points.length);
    tablePointCount.textContent = `${points.length} points`;
    lastRefresh.textContent = formatDateTime(payload.syncedAt || payload.fetchedAt);
    stationLockStatus.textContent = connectorMode ? "Synced" : "Unlocked";
    renderTable(points);

    const badCount = points.filter((point) => !point.ok || point.health === "bad").length;
    if (badCount > 0) {
      setMessage(`${station.name} loaded with ${badCount} unhealthy points.`, "info");
    } else {
      setMessage(
        connectorMode
          ? `${station.name} synced successfully from the local connector.`
          : `${station.name} loaded successfully.`,
        "success"
      );
    }
  } catch (error) {
    pointCount.textContent = "0";
    tablePointCount.textContent = "0 points";
    lastRefresh.textContent = "Failed";
    stationLockStatus.textContent = "Failed";
    tableBody.innerHTML = "";
    setMessage(error.message, "error");
  }
}

function syncConnectorControls(connectorMode) {
  stationPassword.disabled = connectorMode;
  unlockButton.disabled = connectorMode;
  clearPasswordButton.disabled = connectorMode;
  stationPassword.placeholder = connectorMode
    ? "Not used for connector mode"
    : "Enter station password";
}

function renderStationOptions(items) {
  stationSelect.innerHTML = items
    .map((station) => `<option value="${escapeHtml(station.id)}">${escapeHtml(station.name)}</option>`)
    .join("");
}

function renderTable(points) {
  if (!points.length) {
    tableBody.innerHTML = `
      <tr>
        <td colspan="2" class="empty-cell">No exported points found for this station</td>
      </tr>
    `;
    return;
  }

  tableBody.innerHTML = points
    .map((point) => {
      const displayValue = point.ok
        ? decodeHtmlEntities(point.display || point.rawValue || "—")
        : point.error || "Error";
      const rowClass =
        !point.ok || point.health === "bad" ? "row-bad" : point.health === "warn" ? "row-warn" : "";
      const valueClass =
        !point.ok || point.health === "bad" ? "bad" : point.health === "warn" ? "warn" : "";

      return `
        <tr class="${rowClass}">
          <td>${escapeHtml(point.label)}</td>
          <td class="${valueClass}">${escapeHtml(String(displayValue))}</td>
        </tr>
      `;
    })
    .join("");
}

function syncAutoRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }

  if (autoRefresh.checked) {
    refreshTimer = setInterval(loadSelectedStation, 15000);
  }
}

function navigateToStation(stationId) {
  window.location.href = `/stations/${encodeURIComponent(stationId)}`;
}

function getRequestedStationId() {
  const pathMatch = window.location.pathname.match(/^\/stations\/([^/]+)\/?$/);
  return pathMatch ? decodeURIComponent(pathMatch[1]) : "";
}

function setMessage(text, variant) {
  message.textContent = text;
  message.className = `message ${variant}`;
}

function buildStationHeaders(stationId, connectorMode) {
  if (connectorMode) {
    return {};
  }

  const password = getSavedPassword(stationId);
  if (!password) {
    return {};
  }

  return {
    "x-station-password": password
  };
}

function savePasswordForSelectedStation() {
  const stationId = stationSelect.value;
  const station = stations.find((item) => item.id === stationId);
  const password = stationPassword.value.trim();
  if (!stationId || !password || station?.connectionMode === "connector") {
    return;
  }

  sessionStorage.setItem(getPasswordStorageKey(stationId), password);
}

function clearPasswordForSelectedStation() {
  const stationId = stationSelect.value;
  const station = stations.find((item) => item.id === stationId);
  if (!stationId || station?.connectionMode === "connector") {
    return;
  }

  sessionStorage.removeItem(getPasswordStorageKey(stationId));
  stationPassword.value = "";
  tableBody.innerHTML = `<tr><td colspan="2" class="empty-cell">Enter the station password to load values</td></tr>`;
  pointCount.textContent = "0";
  tablePointCount.textContent = "0 points";
  lastRefresh.textContent = "Locked";
  stationLockStatus.textContent = "Locked";
  setMessage("Saved station password cleared.", "info");
}

function getSavedPassword(stationId) {
  return sessionStorage.getItem(getPasswordStorageKey(stationId)) || "";
}

function getPasswordStorageKey(stationId) {
  return `station-password:${stationId}`;
}

function formatDateTime(value) {
  if (!value) {
    return "Never";
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Never" : date.toLocaleString();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function decodeHtmlEntities(value) {
  const textarea = document.createElement("textarea");
  textarea.innerHTML = String(value);
  return textarea.value;
}
