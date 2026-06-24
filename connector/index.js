const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");
const { URL } = require("node:url");

const configPath = path.join(__dirname, "config.json");
const exampleConfigPath = path.join(__dirname, "config.example.json");

const config = loadConnectorConfig();
const syncIntervalMs = Math.max(Number(config.syncIntervalMs || 15000), 5000);

let syncInProgress = false;

console.log(`Connector '${config.connectorName || "local-connector"}' started.`);
console.log(`Cloud app: ${config.cloudBaseUrl}`);
console.log(`Stations: ${config.stations.length}`);

runSyncCycle();
setInterval(runSyncCycle, syncIntervalMs);

async function runSyncCycle() {
  if (syncInProgress) {
    console.log("Previous sync still running, skipping this interval.");
    return;
  }

  syncInProgress = true;

  try {
    for (const station of config.stations) {
      await syncStation(station);
    }
  } catch (error) {
    console.error("Connector sync cycle failed:", error.message);
  } finally {
    syncInProgress = false;
  }
}

async function syncStation(station) {
  const runtimeStation = normalizeStationConfig(station);
  console.log(`Syncing '${runtimeStation.name}' from ${runtimeStation.baseUrl}`);

  const resolvedPoints = await resolveConfiguredPoints(runtimeStation, runtimeStation.entries);
  const points = await Promise.all(
    resolvedPoints.map((point) => fetchConfiguredPoint(runtimeStation, point))
  );

  const payload = {
    connectorKey: config.connectorKey,
    connectorName: config.connectorName || "local-connector",
    stationId: runtimeStation.stationId,
    stationName: runtimeStation.name,
    fetchedAt: new Date().toISOString(),
    points
  };

  const syncUrl = `${String(config.cloudBaseUrl).replace(/\/+$/, "")}/api/connector/sync`;
  const response = await postJson(syncUrl, payload, Boolean(config.cloudAllowSelfSigned));

  console.log(
    `Synced '${runtimeStation.name}' -> ${response.pointsReceived || points.length} points at ${response.syncedAt || "unknown time"}`
  );
}

function loadConnectorConfig() {
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `Missing connector/config.json. Copy '${exampleConfigPath}' to '${configPath}' and update it first.`
    );
  }

  const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));

  if (!parsed || typeof parsed !== "object") {
    throw new Error("connector/config.json must be a JSON object.");
  }

  if (!parsed.cloudBaseUrl) {
    throw new Error("connector/config.json is missing cloudBaseUrl.");
  }

  if (!parsed.connectorKey) {
    throw new Error("connector/config.json is missing connectorKey.");
  }

  if (!Array.isArray(parsed.stations) || !parsed.stations.length) {
    throw new Error("connector/config.json must contain at least one station.");
  }

  return parsed;
}

function normalizeStationConfig(station) {
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

  if (!stationId) {
    throw new Error("Each connector station needs stationId.");
  }

  if (!baseUrl) {
    throw new Error(`Connector station '${stationId}' is missing baseUrl.`);
  }

  if (!apiKey && !username) {
    throw new Error(`Connector station '${stationId}' needs a username or API key.`);
  }

  return {
    stationId,
    name,
    baseUrl,
    username,
    password,
    apiKey,
    apiKeyHeader,
    allowSelfSigned,
    entries: normalizeEntries(station.entries)
  };
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
