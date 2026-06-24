const fs = require("node:fs");
const path = require("node:path");

const rootDir = path.resolve(__dirname, "..");
const distDir = path.join(rootDir, "dist");
const connectorTemplatePath = path.join(rootDir, "connector", "config.example.json");
const outputConfigTemplatePath = path.join(distDir, "config.example.json");
const outputReadmePath = path.join(distDir, "CONNECTOR-README.txt");
const outputLauncherPath = path.join(distDir, "Start Niagara Connector.bat");

fs.mkdirSync(distDir, { recursive: true });
fs.copyFileSync(connectorTemplatePath, outputConfigTemplatePath);

fs.writeFileSync(
  outputLauncherPath,
  [
    "@echo off",
    "cd /d \"%~dp0\"",
    "echo Starting Niagara Connector...",
    "echo.",
    "if not exist \"NiagaraConnector.exe\" (",
    "  echo NiagaraConnector.exe was not found in this folder.",
    "  echo Please keep this launcher beside NiagaraConnector.exe.",
    "  echo.",
    "  pause",
    "  exit /b 1",
    ")",
    "start \"\" \"NiagaraConnector.exe\"",
    "exit /b 0",
    ""
  ].join("\r\n"),
  "utf8"
);

fs.writeFileSync(
  outputReadmePath,
  [
    "NIAGARA CONNECTOR FOR WINDOWS",
    "=============================",
    "",
    "This folder is the local connector that runs near the Niagara station.",
    "",
    "How another user should use it:",
    "1. Keep NiagaraConnector.exe and Start Niagara Connector.bat in the same folder.",
    "2. Double-click Start Niagara Connector.bat.",
    "3. The setup page opens in the browser at http://localhost:3031.",
    "4. Enter the cloud dashboard URL, connector key, and local Niagara station details.",
    "5. Save the setup and click Sync Now.",
    "",
    "Important:",
    "- The connector must run on the same network as the Niagara station.",
    "- The Cloud Station ID must match the station created in the cloud dashboard.",
    "- The connector stores its saved setup in config.json beside the EXE.",
    "",
    "Developer build notes:",
    "- Run npm install",
    "- Run npm run connector:build",
    "- The EXE will be created as dist\\NiagaraConnector.exe",
    ""
  ].join("\r\n"),
  "utf8"
);

console.log(`Prepared connector distribution files in ${distDir}`);
