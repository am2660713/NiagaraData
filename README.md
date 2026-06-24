# Niagara Multi-Station Dashboard

This project is a user-friendly dashboard for multiple Niagara stations and multiple users.

## What it does

- Loads a list of stations from `backend/config/stations.json`
- Gives each station its own direct page URL like `/stations/akash-test`
- Keeps the home page and station value pages separate
- Shows all configured stations in a dropdown and link list
- Connects to the selected station's oBIX endpoint
- Auto-discovers exported points from the configured branch
- Shows point names and current values in a simple table

## Main files

- `backend/server.js` - multi-station backend and Niagara proxy
- `backend/config/stations.json` - station list and branch configuration
- `frontend/index.html` - dashboard page
- `frontend/app.js` - station picker and direct-page behavior
- `frontend/styles.css` - responsive dashboard styling

## Folder structure

- `backend/` - server and Niagara station config
- `frontend/` - HTML, CSS, and browser JavaScript

## Page structure

- Home page: `http://localhost:3000`
- Station value page: `http://localhost:3000/stations/akash-test`

The home page only shows station choices.

Each station page only shows that station's values.

## Direct station pages

Each station gets its own page automatically:

- `http://localhost:3000/stations/akash-test`
- `http://localhost:3000/stations/second-station-demo`

If you add another station to `backend/config/stations.json`, it will:

- appear in the dropdown automatically
- appear in the direct links section automatically
- get its own page URL automatically

## Station config

Example `backend/config/stations.json`:

```json
[
  {
    "id": "akash-test",
    "name": "Akash Test",
    "baseUrl": "https://10.0.0.62/obix",
    "usernameEnv": "NIAGARA_USERNAME",
    "passwordEnv": "NIAGARA_PASSWORD",
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
```

The repo currently includes two station entries:

- `akash-test`
- `second-station-demo`

Right now `second-station-demo` is only a sample and points to the same Niagara host so you can test two different pages immediately. Replace its `baseUrl`, credentials env vars, and branch settings with your real second station later.

## Add another user or station

Add another station object to `backend/config/stations.json`:

```json
{
  "id": "plant-2",
  "name": "Plant 2",
  "baseUrl": "https://10.0.0.70/obix",
  "usernameEnv": "PLANT2_USERNAME",
  "passwordEnv": "PLANT2_PASSWORD",
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
```

Then add the env vars in `.env`:

```env
PORT=3000
NIAGARA_USERNAME=obixuser
NIAGARA_PASSWORD=Admin.12345
PLANT2_USERNAME=anotherUser
PLANT2_PASSWORD=anotherPassword
```

## Run

```bash
node backend/server.js
```

Then open:

```text
http://localhost:3000
```

Or go directly to one station:

```text
http://localhost:3000/stations/akash-test
```

Or the second sample page:

```text
http://localhost:3000/stations/second-station-demo
```

## API routes

- `GET /api/health`
- `GET /api/stations`
- `GET /api/stations/:id/config`
- `GET /api/stations/:id/points`
- `GET /api/stations/:id/point?path=...`

## Notes

- Different users can open the same dashboard and choose different stations independently.
- Different stations can use different URLs, credentials, and branches.
- The frontend is read-only right now; it displays values and does not write back to Niagara.
