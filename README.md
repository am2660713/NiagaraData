# Niagara Multi-Station Dashboard

This project now supports **two ways** to read Niagara station data:

- **Direct mode**: the cloud app connects to the Niagara oBIX URL itself
- **Connector mode**: a small local connector runs near Niagara and syncs points into the cloud app

Connector mode is the important part for private stations on local office networks.

## Architecture

### Cloud app

- Runs the website and API
- Stores station definitions
- Shows one dashboard page per station
- Accepts point sync updates from local connectors

### Local connector

- Runs on the same network as Niagara
- Connects to local/private oBIX URLs like `https://10.0.0.62/obix`
- Auto-discovers points from `ObixNetwork/exports`
- Pushes the latest values to the cloud app

## Folder structure

- `backend/` - cloud API and station config
- `backend/config/stations.json` - cloud station definitions
- `backend/data/station-sync.json` - latest synced connector data
- `frontend/` - dashboard UI
- `connector/` - local sync service for private Niagara networks

## What works now

- Multiple stations
- One page per station
- Direct cloud fetch for public/reachable Niagara stations
- Connector sync for private/local Niagara stations
- Automatic point discovery from `config/Drivers/ObixNetwork/exports/`
- Cached latest connector values shown in the cloud dashboard

## Direct mode vs connector mode

### Direct mode

Use direct mode when your cloud server can reach the Niagara URL.

Example:

- `https://public-station.example.com/obix`

### Connector mode

Use connector mode when Niagara is private and only reachable on the local network.

Example:

- `https://10.0.0.62/obix`
- `https://192.168.1.20/obix`

In connector mode:

- the cloud app does **not** fetch Niagara directly
- the local connector fetches Niagara and sends points to the cloud app

## Main pages

- Home page: `http://localhost:3000`
- Station page example: `http://localhost:3000/stations/akash-test`

## Cloud station config

Example `backend/config/stations.json`:

```json
[
  {
    "id": "public-station",
    "name": "Public Station",
    "connectionMode": "direct",
    "baseUrl": "https://public-station.example.com/obix",
    "usernameEnv": "NIAGARA_USERNAME",
    "passwordEnv": "NIAGARA_PASSWORD",
    "allowSelfSigned": true,
    "requirePasswordPrompt": true,
    "entries": [
      {
        "type": "branch",
        "label": "Obix Exports",
        "path": "config/Drivers/ObixNetwork/exports/",
        "slotPath": "slot:/Drivers/ObixNetwork/exports",
        "recursive": false
      }
    ]
  },
  {
    "id": "office-private-station",
    "name": "Office Private Station",
    "connectionMode": "connector",
    "connectorKey": "office-connector-key",
    "baseUrl": "https://10.0.0.62/obix",
    "entries": [
      {
        "type": "branch",
        "label": "Obix Exports",
        "path": "config/Drivers/ObixNetwork/exports/",
        "slotPath": "slot:/Drivers/ObixNetwork/exports",
        "recursive": false
      }
    ]
  }
]
```

## Local connector config

Copy:

- `connector/config.example.json`

to:

- `connector/config.json`

Then update it.

Example `connector/config.json`:

```json
{
  "cloudBaseUrl": "https://your-cloud-app.onrender.com",
  "connectorKey": "office-connector-key",
  "connectorName": "office-connector",
  "syncIntervalMs": 15000,
  "stations": [
    {
      "stationId": "office-private-station",
      "name": "Office Private Station",
      "baseUrl": "https://10.0.0.62/obix",
      "username": "obixuser",
      "password": "Admin.12345",
      "allowSelfSigned": true,
      "entries": [
        {
          "type": "branch",
          "label": "Obix Exports",
          "path": "config/Drivers/ObixNetwork/exports/",
          "slotPath": "slot:/Drivers/ObixNetwork/exports",
          "recursive": false
        }
      ]
    }
  ]
}
```

Important:

- `stationId` in `connector/config.json` must match the station id in `backend/config/stations.json`
- `connectorKey` in `connector/config.json` must match the cloud station `connectorKey`

## Run locally

### Cloud app

```bash
npm start
```

### Local connector

```bash
npm run connector:start
```

## Environment variables

Example `.env`:

```env
PORT=3000
NIAGARA_BASE_URL=https://public-station.example.com/obix
NIAGARA_USERNAME=obixuser
NIAGARA_PASSWORD=Admin.12345
NIAGARA_API_KEY=
NIAGARA_API_KEY_HEADER=x-api-key
NIAGARA_ALLOW_SELF_SIGNED=true
```

## Render deployment

Render should run the **cloud app only**:

- Build Command: `npm install`
- Start Command: `npm start`

The `connector/` service should **not** run on Render if it needs to reach private Niagara IPs.
Run the connector locally or on a local office server instead.

## API routes

- `GET /api/health`
- `GET /api/stations`
- `POST /api/stations`
- `GET /api/stations/:id/config`
- `GET /api/stations/:id/points`
- `GET /api/stations/:id/point?path=...`
- `POST /api/connector/sync`

## Current limitation

`backend/data/station-sync.json` is file-based storage for now.

That means:

- local development works well
- simple demos work well
- Render may lose synced cache on redeploy/restart unless you later move this to a database

## Recommended next step

For production, the next improvement should be:

- move users, stations, and synced point cache to a database
- add real user login/authentication
- add connector registration and heartbeat status
