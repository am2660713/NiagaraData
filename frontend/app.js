const stationCount = document.getElementById("station-count");
const homeStatus = document.getElementById("home-status");
const message = document.getElementById("message");
const stationLinks = document.getElementById("station-links");
const addStationForm = document.getElementById("add-station-form");
const stationNameInput = document.getElementById("station-name-input");
const stationIdInput = document.getElementById("station-id-input");
const stationBaseUrlInput = document.getElementById("station-base-url-input");
const stationUsernameInput = document.getElementById("station-username-input");
const stationBranchPathInput = document.getElementById("station-branch-path-input");
const stationBranchSlotPathInput = document.getElementById("station-branch-slot-path-input");
const stationSelfSignedInput = document.getElementById("station-self-signed-input");

addStationForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await submitStationForm();
});

initialize();

async function initialize() {
  await loadStations();
}

async function loadStations() {
  setMessage("Loading stations...", "info");

  try {
    const response = await fetch("/api/stations");
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || "Failed to load stations.");
    }

    const stations = payload.stations || [];
    stationCount.textContent = String(stations.length);
    homeStatus.textContent = stations.length ? "Ready" : "Empty";
    renderStationLinks(stations);
    setMessage(
      stations.length ? "Select a station page below." : "No stations configured.",
      stations.length ? "success" : "error"
    );
  } catch (error) {
    stationCount.textContent = "0";
    homeStatus.textContent = "Failed";
    stationLinks.innerHTML = "";
    setMessage(error.message, "error");
  }
}

async function submitStationForm() {
  setMessage("Saving new station...", "info");

  try {
    const payload = {
      name: stationNameInput.value.trim(),
      id: stationIdInput.value.trim(),
      baseUrl: stationBaseUrlInput.value.trim(),
      username: stationUsernameInput.value.trim(),
      branchPath: stationBranchPathInput.value.trim(),
      branchSlotPath: stationBranchSlotPathInput.value.trim(),
      allowSelfSigned: stationSelfSignedInput.checked,
      requirePasswordPrompt: true
    };

    const response = await fetch("/api/stations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || "Failed to add station.");
    }

    addStationForm.reset();
    stationBranchPathInput.value = "config/Drivers/ObixNetwork/exports/";
    stationBranchSlotPathInput.value = "slot:/Drivers/ObixNetwork/exports";
    stationSelfSignedInput.checked = true;
    setMessage(`Station '${result.station.name}' added successfully.`, "success");
    await loadStations();
  } catch (error) {
    setMessage(error.message, "error");
  }
}

function renderStationLinks(stations) {
  if (!stations.length) {
    stationLinks.innerHTML = `<div class="empty-cell">No stations configured</div>`;
    return;
  }

  stationLinks.innerHTML = stations
    .map((station) => {
      const href = `/stations/${encodeURIComponent(station.id)}`;
      return `
        <a class="station-link-card" href="${href}">
          <div class="station-link-top">
            <strong>${escapeHtml(station.name)}</strong>
            <span class="station-link-badge">${station.entryCount || 0} branches</span>
          </div>
          <span class="station-link-url">${escapeHtml(station.baseUrl || "")}</span>
          <span>${escapeHtml(href)}</span>
          <span class="station-link-action">Open station page</span>
        </a>
      `;
    })
    .join("");
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
