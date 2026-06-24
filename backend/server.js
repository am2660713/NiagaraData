const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");
const { URL } = require("node:url");

const backendDir = __dirname;
const rootDir = path.join(backendDir, "..");
const publicDir = path.join(rootDir, "frontend");
const configDir = path.join(backendDir, "config");
const dataDir = path.join(backendDir, "data");
const pointsFile = path.join(configDir, "points.json");
const stationsFile = path.join(configDir, "stations.json");
const stationSyncFile = path.join(dataDir, "station-sync.json");

loadDotEnv(path.join(rootDir, ".env"));
ensureDir(configDir);
ensureDir(dataDir);

const port = Number(process.env.PORT || 3000);
const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

const stations = loadStations();
const stationSyncCache = loadStationSyncCache();

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host}`);

    if (requestUrl.pathname === "/api/health") {
      return sendJson(res, 200, {
        ok: true,
        stationCount: stations.length,
        connectorStationCount: stations.filter((station) => station.connectionMode === "connector").length,
        defaultStationId: stations[0]?.id || ""
      });
    }

    if (requestUrl.pathname === "/api/stations") {
      if (req.method === "POST") {
        const body = await readJsonBody(req);
        const created = addStation(body);
        return sendJson(res, 201, {
          station: summarizeStation(created)
        });
      }

      return sendJson(res, 200, {
        stations: stations.map(summarizeStation)
      });
    }

    const stationDeleteMatch = requestUrl.pathname.match(/^\/api\/stations\/([^/]+)$/);
    if (stationDeleteMatch) {
      if (req.method !== "DELETE") {
        return sendJson(res, 405, { error: "Only DELETE is allowed for this station route." });
      }

      const stationId = decodeURIComponent(stationDeleteMatch[1]);
      const removed = deleteStation(stationId);
      return sendJson(res, 200, {
        ok: true,
        station: summarizeStation(removed)
      });
    }

    if (requestUrl.pathname === "/api/connector/sync") {
      if (req.method !== "POST") {
        return sendJson(res, 405, { error: "Only POST is allowed for connector sync." });
      }

      const body = await readJsonBody(req);
      const syncResult = saveConnectorSync(body);
      return sendJson(res, 200, syncResult);
    }

    const stationMatch = requestUrl.pathname.match(/^\/api\/stations\/([^/]+)\/(config|points|point)$/);
    if (stationMatch) {
      const stationId = decodeURIComponent(stationMatch[1]);
      const action = stationMatch[2];
      const station = getStationOrThrow(stationId);

      if (action === "config") {
        return sendJson(res, 200, await buildStationConfigResponse(station, req));
      }

      if (action === "points") {
        return sendJson(res, 200, await buildStationPointsResponse(station, req));
      }

      const pointPath = requestUrl.searchParams.get("path");
      if (!pointPath) {
        return sendJson(res, 400, { error: "Missing query parameter: path" });
      }

      const singlePoint = await buildSinglePointResponse(station, req, pointPath);
      return sendJson(res, singlePoint.error ? 502 : 200, singlePoint);
    }

    if (
      requestUrl.pathname === "/api/config" ||
      requestUrl.pathname === "/api/niagara/points" ||
      requestUrl.pathname === "/api/niagara/point"
    ) {
      if (!stations.length) {
        return sendJson(res, 400, { error: "No stations configured." });
      }

      const defaultStation = stations[0];

      if (requestUrl.pathname === "/api/config") {
        return sendJson(res, 200, await buildStationConfigResponse(defaultStation, req));
      }

      if (requestUrl.pathname === "/api/niagara/points") {
        return sendJson(res, 200, await buildStationPointsResponse(defaultStation, req));
      }

      const pointPath = requestUrl.searchParams.get("path");
      if (!pointPath) {
        return sendJson(res, 400, { error: "Missing query parameter: path" });
      }

      const result = await buildSinglePointResponse(defaultStation, req, pointPath);
      return sendJson(res, result.error ? 502 : 200, result);
    }

    if (/^\/stations\/[^/]+\/?$/.test(requestUrl.pathname)) {
      return serveStaticFile("/station.html", res);
    }

    return serveStaticFile(requestUrl.pathname, res);
  } catch (error) {
    const statusCode = error && error.statusCode ? error.statusCode : 500;
    return sendJson(res, statusCode, {
      error: error.message || "Unexpected server error."
    });
  }
});

server.listen(port, () => {
  console.log(`Niagara dashboard is running at http://localhost:${port}`);
});

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();
    if (!(key in process.env)) {
      process.env[key] = stripQuotes(value);
    }
  }
}

function stripQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function ensureDir(directoryPath) {
  fs.mkdirSync(directoryPath, { recursive: true });
}

function loadJsonFile(filePath, fallbackValue) {
  if (!fs.existsSync(filePath)) {
    return fallbackValue;
  }

  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJsonFile(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function loadStations() {
  if (fs.existsSync(stationsFile)) {
    const parsed = loadJsonFile(stationsFile, []);

    if (!Array.isArray(parsed)) {
      throw new Error("backend/config/stations.json must be an array.");
    }

    return parsed.map(normalizeStation).filter(Boolean);
  }

  const fallbackBaseUrl = (process.env.NIAGARA_BASE_URL || "").trim();
  if (!fallbackBaseUrl) {
    return [];
  }

  return [
    normalizeStation({
      id: "default-station",
      name: "Default Station",
      baseUrl: fallbackBaseUrl,
      username: process.env.NIAGARA_USERNAME || "",
      password: process.env.NIAGARA_PASSWORD || "",
      apiKey: process.env.NIAGARA_API_KEY || "",
      apiKeyHeader: process.env.NIAGARA_API_KEY_HEADER || "x-api-key",
      allowSelfSigned: String(process.env.NIAGARA_ALLOW_SELF_SIGNED || "false").toLowerCase() === "true",
      entries: readLegacyPointsConfig(),
      connectionMode: "direct"
    })
  ].filter(Boolean);
}

function loadStationSyncCache() {
  const parsed = loadJsonFile(stationSyncFile, {});
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}

function normalizeStation(station) {
  if (!station || !station.id) {
    return null;
  }

  const connectionMode = station.connectionMode === "connector" ? "connector" : "direct";
  const baseUrl = String(station.baseUrl || "").trim();
  if (connectionMode === "direct" && !baseUrl) {
    return null;
  }

  const username = station.usernameEnv ? process.env[station.usernameEnv] || "" : station.username || "";
  const password = station.passwordEnv ? process.env[station.passwordEnv] || "" : station.password || "";
  const apiKey = station.apiKeyEnv ? process.env[station.apiKeyEnv] || "" : station.apiKey || "";
  const apiKeyHeader = station.apiKeyHeader || "x-api-key";
  const allowSelfSigned = Boolean(
    station.allowSelfSigned === true ||
    String(station.allowSelfSigned || "").toLowerCase() === "true"
  );

  return {
    id: String(station.id),
    name: station.name || station.id,
    baseUrl,
    username,
    password,
    apiKey,
    apiKeyHeader,
    allowSelfSigned,
    requirePasswordPrompt:
      connectionMode === "direct" ? station.requirePasswordPrompt !== false : false,
    connectionMode,
    connectorKey: String(station.connectorKey || "").trim(),
    entries: normalizeEntries(station.entries)
  };
}

function addStation(input) {
  const rawStation = buildStationFromInput(input);
  appendStationConfig(rawStation);

  const normalized = normalizeStation(rawStation);
  stations.push(normalized);
  return normalized;
}

function deleteStation(stationId) {
  const stationIndex = stations.findIndex((station) => station.id === stationId);
  if (stationIndex === -1) {
    const error = new Error(`Station '${stationId}' was not found.`);
    error.statusCode = 404;
    throw error;
  }

  const [removed] = stations.splice(stationIndex, 1);
  persistStationsConfig();

  if (stationSyncCache[stationId]) {
    delete stationSyncCache[stationId];
    writeJsonFile(stationSyncFile, stationSyncCache);
  }

  return removed;
}

function buildStationFromInput(input) {
  const name = String(input?.name || "").trim();
  const connectionMode = String(input?.connectionMode || "direct").trim() === "connector" ? "connector" : "direct";
  const baseUrl = String(input?.baseUrl || "").trim();
  const username = String(input?.username || "").trim();
  const connectorKey = String(input?.connectorKey || "").trim();
  const branchPath = String(input?.branchPath || "config/Drivers/ObixNetwork/exports/").trim();
  const branchSlotPath = String(input?.branchSlotPath || "slot:/Drivers/ObixNetwork/exports").trim();
  const branchLabel = String(input?.branchLabel || "Obix Exports").trim();
  const idSource = String(input?.id || name).trim();
  const id = slugify(idSource);

  if (!name) {
    throwBadRequest("Station name is required.");
  }

  if (!id) {
    throwBadRequest("Station id could not be created.");
  }

  if (stations.some((station) => station.id === id)) {
    const error = new Error(`A station with id '${id}' already exists.`);
    error.statusCode = 409;
    throw error;
  }

  if (connectionMode === "direct") {
    if (!baseUrl) {
      throwBadRequest("Station base URL is required for direct mode.");
    }

    if (!username) {
      throwBadRequest("Station username is required for direct mode.");
    }
  }

  if (connectionMode === "connector" && !connectorKey) {
    throwBadRequest("Connector key is required for connector mode.");
  }

  return {
    id,
    name,
    baseUrl,
    username,
    allowSelfSigned: Boolean(input?.allowSelfSigned),
    requirePasswordPrompt: connectionMode === "direct" && input?.requirePasswordPrompt !== false,
    connectionMode,
    connectorKey,
    entries: [
      {
        type: "branch",
        label: branchLabel || "Obix Exports",
        path: branchPath,
        slotPath: branchSlotPath,
        recursive: false
      }
    ]
  };
}

function appendStationConfig(rawStation) {
  const existing = loadJsonFile(stationsFile, []);
  if (!Array.isArray(existing)) {
    throw new Error("backend/config/stations.json must be an array.");
  }

  existing.push(rawStation);
  writeJsonFile(stationsFile, existing);
}

function persistStationsConfig() {
  writeJsonFile(stationsFile, stations.map(serializeStationConfig));
}

function serializeStationConfig(station) {
  return {
    id: station.id,
    name: station.name,
    baseUrl: station.baseUrl,
    username: station.username,
    apiKey: station.apiKey,
    apiKeyHeader: station.apiKeyHeader,
    allowSelfSigned: station.allowSelfSigned,
    requirePasswordPrompt: station.requirePasswordPrompt,
    connectionMode: station.connectionMode,
    connectorKey: station.connectorKey,
    entries: station.entries.map((entry) => ({
      type: entry.type,
      label: entry.label,
      path: entry.path,
      slotPath: entry.slotPath,
      kind: entry.kind,
      excludePattern: entry.excludePattern,
      recursive: entry.recursive
    }))
  };
}

function normalizeEntries(entries) {
  return (Array.isArray(entries) ? entries : [])
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
}

function readLegacyPointsConfig() {
  if (!fs.existsSync(pointsFile)) {
    return [];
  }

  const parsed = loadJsonFile(pointsFile, []);
  if (!Array.isArray(parsed)) {
    throw new Error("backend/config/points.json must be an array.");
  }

  return normalizeEntries(parsed);
}

function getStationOrThrow(stationId) {
  const station = stations.find((item) => item.id === stationId);
  if (!station) {
    const error = new Error(`Station '${stationId}' was not found.`);
    error.statusCode = 404;
    throw error;
  }

  return station;
}

function summarizeStation(station) {
  const sync = getStationSync(station.id);
  return {
    id: station.id,
    name: station.name,
    baseUrl: station.baseUrl,
    requirePasswordPrompt: station.requirePasswordPrompt,
    entryCount: station.entries.length,
    connectionMode: station.connectionMode,
    connectorKeyConfigured: Boolean(station.connectorKey),
    syncStatus:
      station.connectionMode === "connector"
        ? sync
          ? "synced"
          : "waiting-for-connector"
        : "direct",
    lastSyncedAt: sync?.syncedAt || "",
    cachedPointCount: sync?.pointCount || 0
  };
}

function getStationSync(stationId) {
  return stationSyncCache[stationId] || null;
}

function saveConnectorSync(payload) {
  const stationId = String(payload?.stationId || "").trim();
  const connectorKey = String(payload?.connectorKey || "").trim();
  const fetchedAt = normalizeIsoDate(payload?.fetchedAt) || new Date().toISOString();

  if (!stationId) {
    throwBadRequest("Connector sync requires stationId.");
  }

  if (!connectorKey) {
    throwBadRequest("Connector sync requires connectorKey.");
  }

  const station = getStationOrThrow(stationId);
  if (station.connectionMode !== "connector") {
    throwBadRequest(`Station '${station.name}' is not configured for connector mode.`);
  }

  if (!station.connectorKey || station.connectorKey !== connectorKey) {
    const error = new Error(`Connector key is invalid for station '${station.name}'.`);
    error.statusCode = 403;
    throw error;
  }

  const points = sanitizeConnectorPoints(payload?.points);
  const snapshot = {
    stationId,
    stationName: station.name,
    fetchedAt,
    syncedAt: new Date().toISOString(),
    connectorName: String(payload?.connectorName || "").trim(),
    pointCount: points.length,
    points
  };

  stationSyncCache[stationId] = snapshot;
  writeJsonFile(stationSyncFile, stationSyncCache);

  return {
    ok: true,
    station: summarizeStation(station),
    syncedAt: snapshot.syncedAt,
    fetchedAt: snapshot.fetchedAt,
    pointsReceived: snapshot.pointCount
  };
}

function sanitizeConnectorPoints(points) {
  if (!Array.isArray(points)) {
    return [];
  }

  return points.map((point, index) => {
    const label = normalizeText(point?.label || point?.name || `Point ${index + 1}`);
    const rawValue = point?.rawValue == null ? "" : String(point.rawValue);
    const display = normalizeText(point?.display || rawValue);
    const status = normalizeText(point?.status || "");
    const ok = point?.ok !== false;

    return {
      label,
      path: normalizeText(point?.path || ""),
      slotPath: normalizeText(point?.slotPath || ""),
      kind: normalizeText(point?.kind || ""),
      discoveredFrom: normalizeText(point?.discoveredFrom || ""),
      url: normalizeText(point?.url || ""),
      ok,
      value: point?.value ?? null,
      rawValue,
      display,
      unit: normalizeText(point?.unit || ""),
      status,
      href: normalizeText(point?.href || ""),
      errorClass: normalizeText(point?.errorClass || ""),
      health: ["ok", "warn", "bad"].includes(point?.health) ? point.health : classifyHealth(status),
      error: normalizeText(point?.error || "")
    };
  });
}

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeIsoDate(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString();
}

function slugify(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function throwBadRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  throw error;
}

function createStationAccess(station, req) {
  const headerPassword = String(req.headers["x-station-password"] || "");
  const headerUsername = String(req.headers["x-station-username"] || "");
  const password = headerPassword || station.password || "";
  const username = headerUsername || station.username || "";

  if (station.requirePasswordPrompt && !headerPassword) {
    const error = new Error(`Password required for station '${station.name}'.`);
    error.statusCode = 401;
    throw error;
  }

  return {
    ...station,
    username,
    password
  };
}

async function buildStationConfigResponse(station, req) {
  if (station.connectionMode === "connector") {
    const sync = requireStationSync(station);
    return {
      station: summarizeStation(station),
      entries: station.entries,
      points: sync.points.map(summarizePointConfig),
      fetchedAt: sync.fetchedAt,
      syncedAt: sync.syncedAt
    };
  }

  const stationAccess = createStationAccess(station, req);
  const resolvedPoints = await resolveConfiguredPoints(stationAccess, station.entries);
  return {
    station: summarizeStation(station),
    entries: station.entries,
    points: resolvedPoints.map(summarizePointConfig)
  };
}

async function buildStationPointsResponse(station, req) {
  if (station.connectionMode === "connector") {
    const sync = requireStationSync(station);
    return {
      station: summarizeStation(station),
      fetchedAt: sync.fetchedAt,
      syncedAt: sync.syncedAt,
      points: sync.points
    };
  }

  const stationAccess = createStationAccess(station, req);
  const resolvedPoints = await resolveConfiguredPoints(stationAccess, station.entries);
  const points = await Promise.all(resolvedPoints.map((point) => fetchConfiguredPoint(stationAccess, point)));
  return {
    station: summarizeStation(station),
    fetchedAt: new Date().toISOString(),
    points
  };
}

async function buildSinglePointResponse(station, req, pointPath) {
  if (station.connectionMode === "connector") {
    const sync = requireStationSync(station);
    const point = sync.points.find((item) => item.path === pointPath || item.label === pointPath);
    if (!point) {
      return {
        label: pointPath,
        path: pointPath,
        ok: false,
        error: `Point '${pointPath}' was not found in the latest connector sync.`
      };
    }

    return point;
  }

  const stationAccess = createStationAccess(station, req);
  return fetchConfiguredPoint(stationAccess, {
    type: "point",
    label: pointPath,
    path: pointPath,
    slotPath: "",
    kind: "",
    discoveredFrom: ""
  });
}

function requireStationSync(station) {
  const sync = getStationSync(station.id);
  if (!sync) {
    const error = new Error(
      `No local connector sync has been received yet for station '${station.name}'. Start the connector on the Niagara network first.`
    );
    error.statusCode = 503;
    throw error;
  }

  return sync;
}

function summarizePointConfig(point) {
  return {
    label: point.label,
    path: point.path,
    slotPath: point.slotPath || "",
    kind: point.kind || "",
    discoveredFrom: point.discoveredFrom || ""
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
                `Station '${station.name}' returned the login page instead of oBIX XML. Check that this station user has oBIX access.`
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

    request.on("error", (error) => {
      if (["EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT"].includes(error.code)) {
        reject(
          new Error(
            `Station '${station.name}' is not reachable from this server. If the Niagara host is on a private network, use connector mode instead of direct mode.`
          )
        );
        return;
      }

      reject(error);
    });
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
  const health = classifyHealth(status);

  return {
    type: effectiveType || "unknown",
    value: coerceValue(effectiveType, value),
    rawValue: value,
    display: display || value || "",
    unit: unit || "",
    status: status || "",
    href: href || "",
    errorClass: errorClass || "",
    health
  };
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
      display: attrs.display || "",
      displayName: attrs.displayName || attrs.display || attrs.name || ""
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
  const contentType = contentTypes[extension] || "application/octet-stream";
  const file = fs.readFileSync(resolvedPath);

  res.writeHead(200, { "Content-Type": contentType });
  res.end(file);
}

function sendJson(res, statusCode, data) {
  const payload = JSON.stringify(data, null, 2);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8"
  });
  res.end(payload);
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8"
  });
  res.end(text);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 5 * 1024 * 1024) {
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
      } catch (error) {
        const parseError = new Error("Invalid JSON request body.");
        parseError.statusCode = 400;
        reject(parseError);
      }
    });

    req.on("error", reject);
  });
}
