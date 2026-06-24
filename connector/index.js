const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");
const { URL } = require("node:url");
const { exec } = require("node:child_process");

const isPackaged = Boolean(process.pkg);
const connectorDir = __dirname;
const writableDir = isPackaged ? path.dirname(process.execPath) : connectorDir;
const publicDir = path.join(connectorDir, "public");
const configPath = path.join(writableDir, "config.json");
const exampleConfigPath = path.join(connectorDir, "config.example.json");

let runtimeConfig = loadConnectorConfig();
let syncTimer = null;
let browserOpened = false;

const state = {
  syncEnabled: false,
  syncInProgress: false,
  lastCycleStartedAt: "",
  lastCycleFinishedAt: "",
  lastError: "",
  stationStatuses: {}
};

const uiPort = getUiPort(runtimeConfig);

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host}`);

    if (requestUrl.pathname === "/api/state") {
      return sendJson(res, 200, buildUiState());
    }

    if (requestUrl.pathname === "/api/config") {
      if (req.method === "GET") {
        return sendJson(res, 200, { config: runtimeConfig });
      }

      if (req.method === "POST") {
        const body = await readJsonBody(req);
        const normalized = normalizeConnectorConfig(body);
        saveConnectorConfig(normalized);
        runtimeConfig = normalized;
        resetScheduler();
        return sendJson(res, 200, buildUiState("Configuration saved."));
      }

      return sendJson(res, 405, { error: "Only GET and POST are allowed." });
    }

    if (requestUrl.pathname === "/api/sync-now") {
      if (req.method !== "POST") {
        return sendJson(res, 405, { error: "Only POST is allowed." });
      }

      runSyncCycle({ manual: true }).catch(() => {});
      return sendJson(res, 202, buildUiState("Manual sync started."));
    }

    return serveStaticFile(requestUrl.pathname, res);
  } catch (error) {
    return sendJson(res, error.statusCode || 500, {
      error: error.message || "Unexpected connector error."
    });
  }
});

server.listen(uiPort, () => {
  console.log(`Connector setup is ready at http://localhost:${uiPort}`);
  maybeOpenBrowser(uiPort);
  resetScheduler();
});

function getUiPort(config) {
  const port = Number(process.env.CONNECTOR_PORT || config.uiPort || 3031);
  return Number.isFinite(port) && port > 0 ? port : 3031;
}

function loadConnectorConfig() {
  if (!fs.existsSync(configPath)) {
    return loadExampleConfig();
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
    return normalizeConnectorConfig(parsed, { allowPartial: true });
  } catch (error) {
    console.warn(`Could not read ${configPath}, using example values. ${error.message}`);
    return loadExampleConfig();
  }
}

function loadExampleConfig() {
  const parsed = JSON.parse(fs.readFileSync(exampleConfigPath, "utf8"));
  return normalizeConnectorConfig(parsed, { allowPartial: true });
}

function saveConnectorConfig(config) {
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function normalizeConnectorConfig(input, options = {}) {
  const allowPartial = options.allowPartial === true;
  const stations = Array.isArray(input?.stations) ? input.stations : [];

  const normalized = {
    cloudBaseUrl: String(input?.cloudBaseUrl || "").trim(),
    connectorKey: String(input?.connectorKey || "").trim(),
    connectorName: String(input?.connectorName || "office-connector").trim() || "office-connector",
    syncIntervalMs: Math.max(Number(input?.syncIntervalMs || 15000), 5000),
    cloudAllowSelfSigned: Boolean(
      input?.cloudAllowSelfSigned === true ||
      String(input?.cloudAllowSelfSigned || "").toLowerCase() === "true"
    ),
    uiPort: getUiPort(input || {}),
    stations: stations
      .map((station) => normalizeStationConfig(station, { allowPartial }))
      .filter(Boolean)
  };

  if (!allowPartial) {
    validateConnectorConfig(normalized);
  }

  return normalized;
}

function validateConnectorConfig(config) {
  if (!config.cloudBaseUrl) {
    throwBadRequest("Cloud app URL is required.");
  }

  if (!config.connectorKey) {
    throwBadRequest("Connector key is required.");
  }

  if (!Array.isArray(config.stations) || !config.stations.length) {
    throwBadRequest("At least one local station is required.");
  }
}

function normalizeStationConfig(station, options = {}) {
  const allowPartial = options.allowPartial === true;
  const stationId = String(station?.stationId || "").trim();
  const name = String(station?.name || stationId).trim();
  const baseUrl = String(station?.baseUrl || "").trim();
  const username = String(station?.username || "").trim();
  const password = String(station?.password || "").trim();
  const apiKey = String(station?.apiKey || "").trim();
  const apiKeyHeader = String(station?.apiKeyHeader || "x-api-key").trim();
  const allowSelfSigned = Boolean(
    station?.allowSelfSigned === true ||
    String(station?.allowSelfSigned || "").toLowerCase() === "true"
  );

  const normalized = {
    stationId,
    name,
    baseUrl,
    username,
    password,
    apiKey,
    apiKeyHeader,
    allowSelfSigned,
    entries: normalizeEntries(station?.entries)
  };

  if (!allowPartial) {
    if (!stationId) {
      throwBadRequest("Each local station needs a station ID.");
    }

    if (!baseUrl) {
      throwBadRequest(`Local station '${stationId || name || "unknown"}' is missing the Niagara URL.`);
    }

    if (!apiKey && !username) {
      throwBadRequest(`Local station '${stationId || name || "unknown"}' needs a username or API key.`);
    }
  }

  return normalized.stationId || allowPartial ? normalized : null;
}

function normalizeEntries(entries) {
  const normalized = (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry && entry.path)
    .map((entry) => ({
      type: entry.type === "branch" ? "branch" : "point",
      label: entry.label || "",
      path: entry.path,
      slotPath: entry.slotPath || "",
      kind: entry.kind || "",
      excludePattern: entry.excludePattern || "",
      recursive: Boolean(entry.recursive)
    }));

  if (normalized.length) {
    return normalized;
  }

  return [
    {
      type: "branch",
      label: "Obix Exports",
      path: "config/Drivers/ObixNetwork/exports/",
      slotPath: "slot:/Drivers/ObixNetwork/exports",
      kind: "",
      excludePattern: "",
      recursive: false
    }
  ];
}

function resetScheduler() {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }

  state.syncEnabled = isSyncReady(runtimeConfig);
  if (!state.syncEnabled) {
    state.lastError = "Finish the connector setup form with your real station details and save it before syncing.";
    return;
  }

  state.lastError = "";
  runSyncCycle().catch(() => {});
  syncTimer = setInterval(() => {
    runSyncCycle().catch(() => {});
  }, Math.max(Number(runtimeConfig.syncIntervalMs || 15000), 5000));
}

function isSyncReady(config) {
  try {
    validateConnectorConfig(config);
    if (
      config.cloudBaseUrl.includes("your-cloud-app.onrender.com") ||
      config.connectorKey.includes("replace-with-your-connector-key")
    ) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

async function runSyncCycle(options = {}) {
  if (!isSyncReady(runtimeConfig)) {
    state.syncEnabled = false;
    return;
  }

  if (state.syncInProgress) {
    if (options.manual) {
      state.lastError = "A sync is already running.";
    }
    return;
  }

  state.syncInProgress = true;
  state.lastCycleStartedAt = new Date().toISOString();
  state.lastError = "";

  try {
    for (const station of runtimeConfig.stations) {
      await syncStation(station);
    }
  } catch (error) {
    state.lastError = error.message;
    console.error("Connector sync cycle failed:", error.message);
  } finally {
    state.syncInProgress = false;
    state.lastCycleFinishedAt = new Date().toISOString();
  }
}

async function syncStation(station) {
  const stationState = ensureStationState(station.stationId, station.name);
  stationState.status = "syncing";
  stationState.lastError = "";
  stationState.lastStartedAt = new Date().toISOString();

  try {
    console.log(`Syncing '${station.name}' from ${station.baseUrl}`);

    const resolvedPoints = await resolveConfiguredPoints(station, station.entries);
    const points = await Promise.all(resolvedPoints.map((point) => fetchConfiguredPoint(station, point)));

    const payload = {
      connectorKey: runtimeConfig.connectorKey,
      connectorName: runtimeConfig.connectorName || "local-connector",
      stationId: station.stationId,
      stationName: station.name,
      fetchedAt: new Date().toISOString(),
      points
    };

    const syncUrl = `${String(runtimeConfig.cloudBaseUrl).replace(/\/+$/, "")}/api/connector/sync`;
    const response = await postJson(syncUrl, payload, Boolean(runtimeConfig.cloudAllowSelfSigned));

    stationState.status = "ok";
    stationState.lastSyncedAt = response.syncedAt || new Date().toISOString();
    stationState.lastFinishedAt = new Date().toISOString();
    stationState.lastError = "";
    stationState.pointsReceived = response.pointsReceived || points.length;

    console.log(
      `Synced '${station.name}' -> ${stationState.pointsReceived} points at ${stationState.lastSyncedAt}`
    );
  } catch (error) {
    stationState.status = "error";
    stationState.lastError = error.message;
    stationState.lastFinishedAt = new Date().toISOString();
    throw error;
  }
}

function ensureStationState(stationId, stationName) {
  if (!state.stationStatuses[stationId]) {
    state.stationStatuses[stationId] = {
      stationId,
      stationName,
      status: "idle",
      lastStartedAt: "",
      lastFinishedAt: "",
      lastSyncedAt: "",
      pointsReceived: 0,
      lastError: ""
    };
  }

  return state.stationStatuses[stationId];
}

function buildUiState(message = "") {
  return {
    config: runtimeConfig,
    meta: {
      isPackaged,
      uiPort,
      configPath,
      writableDir
    },
    state: {
      ...state,
      message
    }
  };
}

async function resolveConfiguredPoints(station, entries) {
  const results = [];
  const seenPaths = new Set();

  for (const entry of entries) {
    const expanded = entry.type === "branch" ? await discoverPointsFromBranch(station, entry) : [entry];

    for (const point of expanded) {
      if (!point || !point.path || seenPaths.has(point.path)) {
        continue;
      }

      seenPaths.add(point.path);
      results.push(point);
    }
  }

  return results;
}

async function discoverPointsFromBranch(station, entry, depth = 0) {
  const url = buildPointUrl(station.baseUrl, entry.path);
  const response = await fetchText(station, url);
  const refs = extractRefNodes(response.body);
  const points = [];

  for (const ref of refs) {
    if (entry.excludePattern && new RegExp(entry.excludePattern).test(ref.name)) {
      continue;
    }

    const childPath = resolveChildPath(entry.path, ref.href);
    const childSlotPath = entry.slotPath ? joinSlotPath(entry.slotPath, ref.name) : "";

    if (entry.recursive && isBranchRef(ref)) {
      const nested = await discoverPointsFromBranch(
        station,
        {
          type: "branch",
          label: ref.name,
          path: childPath,
          slotPath: childSlotPath,
          kind: "",
          excludePattern: entry.excludePattern || "",
          recursive: true
        },
        depth + 1
      );
      points.push(...nested);
      continue;
    }

    points.push({
      type: "point",
      label: ref.name,
      path: childPath,
      slotPath: childSlotPath,
      kind: "",
      discoveredFrom: entry.label || entry.path,
      discoveryDepth: depth
    });
  }

  return points;
}

async function fetchConfiguredPoint(station, point) {
  const url = buildPointUrl(station.baseUrl, point.path);

  try {
    const response = await fetchText(station, url);
    const parsed = parseObixPoint(response.body);

    if (parsed.type === "err" || parsed.errorClass) {
      return {
        label: point.label,
        path: point.path,
        slotPath: point.slotPath || "",
        kind: point.kind || "",
        discoveredFrom: point.discoveredFrom || "",
        url,
        ok: false,
        error:
          parsed.display ||
          parsed.errorClass ||
          "Niagara returned an oBIX error for this point path."
      };
    }

    return {
      label: point.label,
      path: point.path,
      slotPath: point.slotPath || "",
      kind: point.kind || "",
      discoveredFrom: point.discoveredFrom || "",
      url,
      ok: true,
      ...parsed
    };
  } catch (error) {
    return {
      label: point.label,
      path: point.path,
      slotPath: point.slotPath || "",
      kind: point.kind || "",
      discoveredFrom: point.discoveredFrom || "",
      url,
      ok: false,
      error: error.message
    };
  }
}

function buildPointUrl(baseUrl, pointPath) {
  if (/^https?:\/\//i.test(pointPath)) {
    return pointPath;
  }

  const normalizedBase = String(baseUrl || "").replace(/\/+$/, "");
  const normalizedPath = pointPath.replace(/^\/+/, "");
  return `${normalizedBase}/${normalizedPath}`;
}

function fetchText(station, targetUrl, redirectCount = 0) {
  const urlObject = new URL(targetUrl);
  const client = urlObject.protocol === "https:" ? https : http;
  const headers = {
    Accept: "application/xml, text/xml;q=0.9, */*;q=0.8"
  };

  if (station.apiKey) {
    headers[station.apiKeyHeader] = station.apiKey;
  } else if (station.username || station.password) {
    const authValue = Buffer.from(`${station.username}:${station.password}`).toString("base64");
    headers.Authorization = `Basic ${authValue}`;
  }

  const options = {
    method: "GET",
    headers,
    agent:
      urlObject.protocol === "https:"
        ? new https.Agent({ rejectUnauthorized: !station.allowSelfSigned })
        : undefined
  };

  return new Promise((resolve, reject) => {
    const request = client.request(urlObject, options, (response) => {
      let body = "";

      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });

      response.on("end", () => {
        if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) {
          const contentType = String(response.headers["content-type"] || "").toLowerCase();
          const looksLikeHtml = contentType.includes("text/html") || /^\s*<html\b/i.test(body);

          if (looksLikeHtml) {
            reject(
              new Error(
                `Station '${station.name}' returned the login page instead of oBIX XML. Check the Niagara credentials and oBIX access.`
              )
            );
            return;
          }

          resolve({
            body,
            contentType
          });
          return;
        }

        if (
          response.statusCode &&
          [301, 302, 303, 307, 308].includes(response.statusCode) &&
          response.headers.location
        ) {
          if (redirectCount >= 5) {
            reject(new Error(`Station '${station.name}' redirected too many times.`));
            return;
          }

          const redirectedUrl = new URL(response.headers.location, urlObject).toString();
          fetchText(station, redirectedUrl, redirectCount + 1).then(resolve).catch(reject);
          return;
        }

        reject(
          new Error(
            `Station '${station.name}' request failed with ${response.statusCode || "unknown"} ${response.statusMessage || ""}`.trim()
          )
        );
      });
    });

    request.on("error", reject);
    request.end();
  });
}

function parseObixPoint(xml) {
  const type = firstMatch(xml, /<\s*([a-zA-Z0-9:_-]+)\b/);
  const outNode = findNamedNode(xml, "out");
  const source = outNode ? outNode.fragment : xml;
  const effectiveType = outNode?.type || type;
  const value = firstMatch(source, /\bval="([^"]*)"/);
  const display = firstMatch(source, /\bdisplay="([^"]*)"/);
  const unit = firstMatch(source, /\bunit="([^"]*)"/);
  const status = firstMatch(source, /\bstatus="([^"]*)"/);
  const href = firstMatch(xml, /\bhref="([^"]*)"/);
  const errorClass = firstMatch(xml, /\bis="([^"]*obix:[^"]*Err)"/);

  return {
    type: effectiveType || "unknown",
    value: coerceValue(effectiveType, value),
    rawValue: value,
    display: display || value || "",
    unit: unit || "",
    status: status || "",
    href: href || "",
    errorClass: errorClass || "",
    health: classifyHealth(status)
  };
}

function postJson(targetUrl, payload, allowSelfSigned) {
  const urlObject = new URL(targetUrl);
  const client = urlObject.protocol === "https:" ? https : http;
  const body = JSON.stringify(payload);
  const options = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body)
    },
    agent:
      urlObject.protocol === "https:"
        ? new https.Agent({ rejectUnauthorized: !allowSelfSigned })
        : undefined
  };

  return new Promise((resolve, reject) => {
    const request = client.request(urlObject, options, (response) => {
      let responseBody = "";

      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        responseBody += chunk;
      });

      response.on("end", () => {
        let parsed = {};
        if (responseBody.trim()) {
          try {
            parsed = JSON.parse(responseBody);
          } catch (error) {
            reject(new Error(`Cloud app returned invalid JSON: ${responseBody}`));
            return;
          }
        }

        if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) {
          resolve(parsed);
          return;
        }

        reject(
          new Error(
            parsed.error ||
              `Cloud app sync failed with ${response.statusCode || "unknown"} ${response.statusMessage || ""}`.trim()
          )
        );
      });
    });

    request.on("error", reject);
    request.write(body);
    request.end();
  });
}

function firstMatch(text, pattern) {
  const match = text.match(pattern);
  return match ? match[1] : "";
}

function extractRefNodes(xml) {
  const refs = [];
  const pattern = /<ref\b([^>]*)\/>/g;
  let match;

  while ((match = pattern.exec(xml)) !== null) {
    const attrs = parseXmlAttributes(match[1]);
    refs.push({
      name: attrs.name || "",
      href: attrs.href || "",
      is: attrs.is || "",
      display: attrs.display || ""
    });
  }

  return refs.filter((ref) => ref.name && ref.href);
}

function parseXmlAttributes(text) {
  const attributes = {};
  const pattern = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)="([^"]*)"/g;
  let match;

  while ((match = pattern.exec(text)) !== null) {
    attributes[match[1]] = match[2];
  }

  return attributes;
}

function findNamedNode(xml, nodeName) {
  const pattern = new RegExp(`<([a-zA-Z0-9:_-]+)\\s+name="${escapeRegExp(nodeName)}"([^>]*)>`, "i");
  const match = xml.match(pattern);
  if (!match) {
    return null;
  }

  return {
    type: match[1],
    fragment: match[0]
  };
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function resolveChildPath(parentPath, childHref) {
  if (/^https?:\/\//i.test(childHref)) {
    return childHref;
  }

  if (/^https?:\/\//i.test(parentPath)) {
    return new URL(childHref, parentPath).toString();
  }

  const normalizedParent = parentPath.endsWith("/") ? parentPath : `${parentPath}/`;
  return `${normalizedParent}${childHref.replace(/^\/+/, "")}`;
}

function joinSlotPath(parentSlotPath, childName) {
  const normalizedParent = parentSlotPath.replace(/\/+$/, "");
  return `${normalizedParent}/${childName}`;
}

function isBranchRef(ref) {
  const marker = `${ref.is} ${ref.display}`.toLowerCase();
  return marker.includes("folder") || marker.includes("container");
}

function coerceValue(type, value) {
  if (value == null) {
    return null;
  }

  const normalizedType = String(type || "").toLowerCase();
  if (normalizedType.endsWith("bool")) {
    return value === "true";
  }

  if (
    normalizedType.endsWith("real") ||
    normalizedType.endsWith("int") ||
    normalizedType.endsWith("long")
  ) {
    const numeric = Number(value);
    return Number.isNaN(numeric) ? value : numeric;
  }

  return value;
}

function classifyHealth(status) {
  const normalized = String(status || "").toLowerCase();

  if (!normalized || normalized === "ok") {
    return "ok";
  }

  if (
    normalized.includes("fault") ||
    normalized.includes("down") ||
    normalized.includes("stale") ||
    normalized.includes("alarm") ||
    normalized.includes("disabled")
  ) {
    return "bad";
  }

  return "warn";
}

function maybeOpenBrowser(port) {
  if (browserOpened || process.env.CONNECTOR_NO_BROWSER === "true") {
    return;
  }

  browserOpened = true;
  const url = `http://localhost:${port}`;

  if (process.platform === "win32") {
    exec(`start "" "${url}"`);
    return;
  }

  if (process.platform === "darwin") {
    exec(`open "${url}"`);
    return;
  }

  exec(`xdg-open "${url}"`);
}

function serveStaticFile(requestPath, res) {
  const safePath = requestPath === "/" ? "/index.html" : requestPath;
  const resolvedPath = path.normalize(path.join(publicDir, safePath));

  if (!resolvedPath.startsWith(publicDir)) {
    return sendText(res, 403, "Forbidden");
  }

  if (!fs.existsSync(resolvedPath) || fs.statSync(resolvedPath).isDirectory()) {
    return sendText(res, 404, "Not found");
  }

  const extension = path.extname(resolvedPath).toLowerCase();
  const contentType =
    extension === ".html"
      ? "text/html; charset=utf-8"
      : extension === ".css"
        ? "text/css; charset=utf-8"
        : extension === ".js"
          ? "application/javascript; charset=utf-8"
          : "application/octet-stream";

  res.writeHead(200, { "Content-Type": contentType });
  res.end(fs.readFileSync(resolvedPath));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 2 * 1024 * 1024) {
        reject(new Error("Request body is too large."));
      }
    });

    req.on("end", () => {
      if (!body.trim()) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Invalid JSON request body."));
      }
    });

    req.on("error", reject);
  });
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8"
  });
  res.end(JSON.stringify(data, null, 2));
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8"
  });
  res.end(text);
}

function throwBadRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  throw error;
}
