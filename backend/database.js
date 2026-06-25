const fs = require("node:fs");

async function createDatabase(options) {
  const { Pool } = require("pg");

  const pool = new Pool({
    connectionString: options.connectionString,
    ssl: options.ssl,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000
  });

  pool.on("error", (error) => {
    console.error("PostgreSQL pool error:", error.message);
  });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS stations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      base_url TEXT NOT NULL DEFAULT '',
      username TEXT NOT NULL DEFAULT '',
      password TEXT NOT NULL DEFAULT '',
      api_key TEXT NOT NULL DEFAULT '',
      api_key_header TEXT NOT NULL DEFAULT 'x-api-key',
      allow_self_signed BOOLEAN NOT NULL DEFAULT FALSE,
      require_password_prompt BOOLEAN NOT NULL DEFAULT TRUE,
      connection_mode TEXT NOT NULL DEFAULT 'direct',
      connector_key TEXT NOT NULL DEFAULT '',
      entries_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS station_sync (
      station_id TEXT PRIMARY KEY,
      station_name TEXT NOT NULL DEFAULT '',
      fetched_at TIMESTAMPTZ NULL,
      synced_at TIMESTAMPTZ NULL,
      connector_name TEXT NOT NULL DEFAULT '',
      point_count INTEGER NOT NULL DEFAULT 0,
      points_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await migrateSeedData(pool, options);

  return {
    async loadStations() {
      const result = await pool.query(`
        SELECT
          id,
          name,
          base_url,
          username,
          password,
          api_key,
          api_key_header,
          allow_self_signed,
          require_password_prompt,
          connection_mode,
          connector_key,
          entries_json
        FROM stations
        ORDER BY created_at ASC
      `);

      return result.rows.map((row) => ({
        id: row.id,
        name: row.name,
        baseUrl: row.base_url,
        username: row.username,
        password: row.password,
        apiKey: row.api_key,
        apiKeyHeader: row.api_key_header,
        allowSelfSigned: Boolean(row.allow_self_signed),
        requirePasswordPrompt: Boolean(row.require_password_prompt),
        connectionMode: row.connection_mode,
        connectorKey: row.connector_key,
        entries: Array.isArray(row.entries_json) ? row.entries_json : []
      }));
    },

    async upsertStation(station) {
      await pool.query(
        `
          INSERT INTO stations (
            id,
            name,
            base_url,
            username,
            password,
            api_key,
            api_key_header,
            allow_self_signed,
            require_password_prompt,
            connection_mode,
            connector_key,
            entries_json,
            created_at,
            updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, NOW(), NOW())
          ON CONFLICT (id) DO UPDATE SET
            name = EXCLUDED.name,
            base_url = EXCLUDED.base_url,
            username = EXCLUDED.username,
            password = EXCLUDED.password,
            api_key = EXCLUDED.api_key,
            api_key_header = EXCLUDED.api_key_header,
            allow_self_signed = EXCLUDED.allow_self_signed,
            require_password_prompt = EXCLUDED.require_password_prompt,
            connection_mode = EXCLUDED.connection_mode,
            connector_key = EXCLUDED.connector_key,
            entries_json = EXCLUDED.entries_json,
            updated_at = NOW()
        `,
        [
          String(station.id || "").trim(),
          String(station.name || station.id || "").trim(),
          String(station.baseUrl || "").trim(),
          String(station.username || "").trim(),
          String(station.password || "").trim(),
          String(station.apiKey || "").trim(),
          String(station.apiKeyHeader || "x-api-key").trim(),
          Boolean(station.allowSelfSigned),
          station.requirePasswordPrompt !== false,
          station.connectionMode === "connector" ? "connector" : "direct",
          String(station.connectorKey || "").trim(),
          JSON.stringify(Array.isArray(station.entries) ? station.entries : [])
        ]
      );
    },

    async deleteStation(stationId) {
      await pool.query("DELETE FROM stations WHERE id = $1", [String(stationId)]);
    },

    async loadStationSyncCache() {
      const result = await pool.query(`
        SELECT
          station_id,
          station_name,
          fetched_at,
          synced_at,
          connector_name,
          point_count,
          points_json
        FROM station_sync
      `);

      return result.rows.reduce((accumulator, row) => {
        accumulator[row.station_id] = {
          stationId: row.station_id,
          stationName: row.station_name,
          fetchedAt: row.fetched_at ? new Date(row.fetched_at).toISOString() : "",
          syncedAt: row.synced_at ? new Date(row.synced_at).toISOString() : "",
          connectorName: row.connector_name,
          pointCount: Number(row.point_count || 0),
          points: Array.isArray(row.points_json) ? row.points_json : []
        };
        return accumulator;
      }, {});
    },

    async upsertStationSync(sync) {
      await pool.query(
        `
          INSERT INTO station_sync (
            station_id,
            station_name,
            fetched_at,
            synced_at,
            connector_name,
            point_count,
            points_json,
            updated_at
          )
          VALUES ($1, $2, NULLIF($3, '')::timestamptz, NULLIF($4, '')::timestamptz, $5, $6, $7::jsonb, NOW())
          ON CONFLICT (station_id) DO UPDATE SET
            station_name = EXCLUDED.station_name,
            fetched_at = EXCLUDED.fetched_at,
            synced_at = EXCLUDED.synced_at,
            connector_name = EXCLUDED.connector_name,
            point_count = EXCLUDED.point_count,
            points_json = EXCLUDED.points_json,
            updated_at = NOW()
        `,
        [
          String(sync.stationId || "").trim(),
          String(sync.stationName || "").trim(),
          String(sync.fetchedAt || "").trim(),
          String(sync.syncedAt || "").trim(),
          String(sync.connectorName || "").trim(),
          Number(sync.pointCount || 0),
          JSON.stringify(Array.isArray(sync.points) ? sync.points : [])
        ]
      );
    },

    async deleteStationSync(stationId) {
      await pool.query("DELETE FROM station_sync WHERE station_id = $1", [String(stationId)]);
    }
  };
}

async function migrateSeedData(pool, options) {
  const stationCount = Number((await pool.query("SELECT COUNT(*)::int AS count FROM stations")).rows[0].count || 0);
  if (stationCount === 0) {
    const stationsFromFile = loadJsonFile(options.stationsSeedFile, []);
    const seedStations = Array.isArray(stationsFromFile) && stationsFromFile.length
      ? stationsFromFile
      : options.fallbackStations;

    for (const station of seedStations) {
      await pool.query(
        `
          INSERT INTO stations (
            id,
            name,
            base_url,
            username,
            password,
            api_key,
            api_key_header,
            allow_self_signed,
            require_password_prompt,
            connection_mode,
            connector_key,
            entries_json,
            created_at,
            updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, NOW(), NOW())
          ON CONFLICT (id) DO NOTHING
        `,
        [
          String(station?.id || "").trim(),
          String(station?.name || station?.id || "").trim(),
          String(station?.baseUrl || station?.base_url || "").trim(),
          String(station?.username || "").trim(),
          String(station?.password || "").trim(),
          String(station?.apiKey || station?.api_key || "").trim(),
          String(station?.apiKeyHeader || station?.api_key_header || "x-api-key").trim(),
          normalizeBoolean(station?.allowSelfSigned || station?.allow_self_signed),
          station?.requirePasswordPrompt == null
            ? true
            : normalizeBoolean(station?.requirePasswordPrompt || station?.require_password_prompt),
          station?.connectionMode === "connector" || station?.connection_mode === "connector"
            ? "connector"
            : "direct",
          String(station?.connectorKey || station?.connector_key || "").trim(),
          JSON.stringify(Array.isArray(station?.entries) ? station.entries : [])
        ]
      );
    }
  }

  const syncCount = Number((await pool.query("SELECT COUNT(*)::int AS count FROM station_sync")).rows[0].count || 0);
  if (syncCount === 0) {
    const syncMap = loadJsonFile(options.syncSeedFile, {});
    if (syncMap && typeof syncMap === "object" && !Array.isArray(syncMap)) {
      for (const sync of Object.values(syncMap)) {
        await pool.query(
          `
            INSERT INTO station_sync (
              station_id,
              station_name,
              fetched_at,
              synced_at,
              connector_name,
              point_count,
              points_json,
              updated_at
            )
            VALUES ($1, $2, NULLIF($3, '')::timestamptz, NULLIF($4, '')::timestamptz, $5, $6, $7::jsonb, NOW())
            ON CONFLICT (station_id) DO NOTHING
          `,
          [
            String(sync?.stationId || sync?.station_id || "").trim(),
            String(sync?.stationName || sync?.station_name || "").trim(),
            String(sync?.fetchedAt || sync?.fetched_at || "").trim(),
            String(sync?.syncedAt || sync?.synced_at || "").trim(),
            String(sync?.connectorName || sync?.connector_name || "").trim(),
            Number(sync?.pointCount || sync?.point_count || 0),
            JSON.stringify(Array.isArray(sync?.points) ? sync.points : [])
          ]
        );
      }
    }
  }
}

function loadJsonFile(filePath, fallbackValue) {
  if (!filePath || !fs.existsSync(filePath)) {
    return fallbackValue;
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallbackValue;
  }
}

function normalizeBoolean(value) {
  return value === true || String(value || "").toLowerCase() === "true" || value === 1;
}

module.exports = {
  createDatabase
};
