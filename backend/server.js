const http = require("http");
const { execFile } = require("child_process");
const crypto = require("crypto");
const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 3001);
const INTERFACE = process.env.WIFI_INTERFACE || "wlan0";
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 1000);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin";

const SUDO = process.env.SUDO_PATH || "sudo";

const DNSMASQ_BLOCKLIST =
  process.env.DNSMASQ_BLOCKLIST ||
  "/etc/dnsmasq.d/pi-panel-blocklist.conf";

let commandInFlight = false;

const sessions = new Set();
const blockedMacs = new Set();
const autoBlockedMacs = new Set();
const limitedMacs = new Map();
const blockedSites = new Set();

let maxClients = null;
let lastStationOutput = "Waiting for station data...";

const deviceHistory = new Map();

const DOH_IPS = [
  "1.1.1.1",
  "1.0.0.1",

  "8.8.8.8",
  "8.8.4.4",

  "9.9.9.9",
  "149.112.112.112",

  "94.140.14.14",
  "94.140.15.15",

  "76.76.2.0",
  "76.76.10.0",

  "208.67.222.222",
  "208.67.220.220",
];

const RELATED_DOMAINS = {
  "youtube.com": [
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",

  "ytimg.com",
  "i.ytimg.com",
  "s.ytimg.com",

  "googlevideo.com",

  "youtubei.googleapis.com",
  "youtube.googleapis.com",
  "youtube-ui.l.google.com",

  "yt3.ggpht.com",
  "yt4.ggpht.com",

  "ggpht.com",
  "gvt1.com",

  "android.clients.google.com",
  "clients3.google.com",
  "clients6.google.com",

  "googleapis.com",

  "dns.google",
  "chrome.cloudflare-dns.com",
  "mozilla.cloudflare-dns.com",
  "cloudflare-dns.com",
],

  "instagram.com": [
    "instagram.com",
    "cdninstagram.com",
  ],

  "facebook.com": [
    "facebook.com",
    "fbcdn.net",
    "messenger.com",
  ],

  "whatsapp.com": [
    "whatsapp.com",
    "whatsapp.net",
  ],

  "tiktok.com": [
    "tiktok.com",
    "tiktokcdn.com",
    "byteoversea.com",
  ],
};

const server = http.createServer((req, res) => {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === "/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  handleApi(req, res).catch((error) => {
    console.error(error);

    sendJson(res, 500, {
      error: error.message || "Server error",
    });
  });
});

const wss = new WebSocket.Server({ server });

function broadcast(payload) {
  const message = JSON.stringify(payload);

  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,POST,OPTIONS"
  );

  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type,Authorization"
  );
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json",
  });

  res.end(JSON.stringify(payload));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk;

      if (body.length > 1024 * 1024) {
        req.destroy();
        reject(new Error("Request body too large"));
      }
    });

    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
  });
}

function getToken(req) {
  const header = req.headers.authorization || "";

  return header.startsWith("Bearer ")
    ? header.slice(7)
    : "";
}

function requireAdmin(req, res) {
  const token = getToken(req);

  if (!token || !sessions.has(token)) {
    sendJson(res, 401, {
      error: "Admin login required",
    });

    return false;
  }

  return true;
}

function isValidMac(mac) {
  return /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(mac);
}

function normalizeMac(mac) {
  return String(mac || "")
    .trim()
    .toLowerCase();
}

function normalizeSite(site) {
  let value = String(site || "")
    .trim()
    .toLowerCase();

  value = value
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]
    .split("?")[0]
    .split("#")[0]
    .replace(/:\d+$/, "");

  if (
    !/^(?!-)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/i.test(value)
  ) {
    throw new Error(
      "Enter valid domain like youtube.com"
    );
  }

  return value;
}

function classIdForMac(mac) {
  return (
    Number.parseInt(
      crypto
        .createHash("sha1")
        .update(mac)
        .digest("hex")
        .slice(0, 3),
      16
    ) + 100
  );
}

function parseStationMacs(output) {
  if (
    !output ||
    output === "No stations connected."
  ) {
    return [];
  }

  return output
    .split(/^Station /m)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) =>
      normalizeMac(block.split(/\s+/)[0])
    )
    .filter(isValidMac);
}
function parseStationDump(output) {
  if (!output || output === "No stations connected.") {
    return [];
  }

  return output
    .split(/^Station /m)
    .slice(1)
    .map((block) => {
      const lines = block.split("\n").map(l => l.trim());

      const mac = normalizeMac(
        lines[0].split(" ")[0]
      );

      const getValue = (key) => {
        const line = lines.find(l =>
          l.startsWith(key)
        );

        if (!line) return null;

        return line.split(":")[1]?.trim();
      };

      return {
        mac,

        inactive_time: parseInt(
          getValue("inactive time") || "0"
        ),

        rx_bytes: parseInt(
          getValue("rx bytes") || "0"
        ),

        tx_bytes: parseInt(
          getValue("tx bytes") || "0"
        ),

        rx_packets: parseInt(
          getValue("rx packets") || "0"
        ),

        tx_packets: parseInt(
          getValue("tx packets") || "0"
        ),

        tx_failed: parseInt(
          getValue("tx failed") || "0"
        ),

        tx_bitrate: parseFloat(
          getValue("tx bitrate") || "0"
        ),

        rx_bitrate: parseFloat(
          getValue("rx bitrate") || "0"
        ),

        connected_time: parseInt(
          getValue("connected time") || "0"
        ),
      };
    });
}
function logDeviceData(device) {
  const dir = "./logs";

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir);
  }

  const file = path.join(
    dir,
    `${device.mac}.csv`
  );

  const row = [
    new Date().toISOString(),

    device.tx_bitrate,

    device.rx_bitrate,

    device.tx_failed,

    device.inactive_time,

    device.tx_packets,

    device.rx_packets,
  ].join(",") + "\n";

  if (!fs.existsSync(file)) {
    fs.writeFileSync(
      file,
      "timestamp,tx_bitrate,rx_bitrate,tx_failed,inactive_time,tx_packets,rx_packets\n"
    );
  }

  fs.appendFileSync(file, row);
}
function detectAnomaly(device) {
  const history =
    deviceHistory.get(device.mac) || [];

  if (history.length < 5) {
    return {
      anomaly: false,
      score: 0,
      reasons: []
    };
  }

  const avgTx =
    history.reduce(
      (a, b) => a + b.tx_bitrate,
      0
    ) / history.length;

  const avgRx =
    history.reduce(
      (a, b) => a + b.rx_bitrate,
      0
    ) / history.length;

  let score = 0;
  const reasons = [];

  // TX bitrate collapse
  if (
    device.tx_bitrate < avgTx * 0.3
  ) {
    score += 40;
    reasons.push(
      "TX bitrate dropped sharply"
    );
  }

  // RX bitrate collapse
  if (
    device.rx_bitrate < avgRx * 0.3
  ) {
    score += 40;
    reasons.push(
      "RX bitrate dropped sharply"
    );
  }

  // Packet failures
  if (device.tx_failed > 10) {
    score += 30;
    reasons.push(
      "High transmission failures"
    );
  }

  // Inactivity spike
  if (device.inactive_time > 5000) {
    score += 20;
    reasons.push(
      "High inactivity detected"
    );
  }

  return {
    anomaly: score >= 50,
    score,
    reasons
  };
}
function runCommand(command, args, input) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      { timeout: 10000 },
      (error, stdout, stderr) => {
        const output = [stdout, stderr]
          .filter(Boolean)
          .join("\n")
          .trim();

        if (error) {
          reject(
            new Error(output || error.message)
          );

          return;
        }

        resolve(output);
      }
    );

    if (input !== undefined) {
      child.stdin.end(input);
    }
  });
}

async function sudo(args, input) {
  return runCommand(SUDO, args, input);
}

async function blockMac(mac) {
  await sudo([
    "iptables",
    "-C",
    "FORWARD",
    "-m",
    "mac",
    "--mac-source",
    mac,
    "-j",
    "DROP",
  ]).catch(async () => {
    await sudo([
      "iptables",
      "-I",
      "FORWARD",
      "1",
      "-m",
      "mac",
      "--mac-source",
      mac,
      "-j",
      "DROP",
    ]);
  });

  await sudo([
    "iw",
    "dev",
    INTERFACE,
    "station",
    "del",
    mac,
  ]).catch(() => undefined);

  blockedMacs.add(mac);
}

async function unblockMac(mac) {
  await sudo([
    "iptables",
    "-D",
    "FORWARD",
    "-m",
    "mac",
    "--mac-source",
    mac,
    "-j",
    "DROP",
  ]).catch(() => undefined);

  blockedMacs.delete(mac);
  autoBlockedMacs.delete(mac);
}

async function limitMac(mac, kbps) {
  const rate = Number(kbps);

  if (
    !Number.isInteger(rate) ||
    rate < 32 ||
    rate > 1000000
  ) {
    throw new Error(
      "Limit must be between 32 and 1000000 Kbps"
    );
  }

  const id = classIdForMac(mac);

  await sudo([
    "tc",
    "qdisc",
    "replace",
    "dev",
    INTERFACE,
    "root",
    "handle",
    "1:",
    "htb",
    "default",
    "999",
  ]);

  await sudo([
    "tc",
    "class",
    "replace",
    "dev",
    INTERFACE,
    "parent",
    "1:",
    "classid",
    "1:999",
    "htb",
    "rate",
    "1000mbit",
    "ceil",
    "1000mbit",
  ]).catch(() => undefined);

  await sudo([
    "tc",
    "class",
    "replace",
    "dev",
    INTERFACE,
    "parent",
    "1:",
    "classid",
    `1:${id}`,
    "htb",
    "rate",
    `${rate}kbit`,
    "ceil",
    `${rate}kbit`,
  ]);

  await sudo([
    "tc",
    "filter",
    "replace",
    "dev",
    INTERFACE,
    "protocol",
    "ip",
    "parent",
    "1:",
    "pref",
    String(id),
    "flower",
    "dst_mac",
    mac,
    "classid",
    `1:${id}`,
  ]);

  limitedMacs.set(mac, rate);
}

async function clearLimitMac(mac) {
  const id = classIdForMac(mac);

  await sudo([
    "tc",
    "filter",
    "del",
    "dev",
    INTERFACE,
    "protocol",
    "ip",
    "parent",
    "1:",
    "pref",
    String(id),
  ]).catch(() => undefined);

  await sudo([
    "tc",
    "class",
    "del",
    "dev",
    INTERFACE,
    "classid",
    `1:${id}`,
  ]).catch(() => undefined);

  limitedMacs.delete(mac);
}

function siteBlockConfig() {
  const lines = [];

  for (const site of Array.from(blockedSites).sort()) {
    const related =
      RELATED_DOMAINS[site] || [site];

    for (const domain of related) {
      const clean = domain
        .replace(/^https?:\/\//, "")
        .replace(/^www\./, "")
        .replace(/\/$/, "");

      lines.push(
        `address=/${clean}/#`,
        `address=/.${clean}/#`
      );
    }
  }

  return [...new Set(lines)].join("\n");
}
async function disableIPv6() {
  await sudo([
    "sysctl",
    "-w",
    "net.ipv6.conf.all.disable_ipv6=1",
  ]);

  await sudo([
    "sysctl",
    "-w",
    "net.ipv6.conf.default.disable_ipv6=1",
  ]);
}
async function disconnectClients() {
  const macs = parseStationMacs(
    lastStationOutput
  );

  for (const mac of macs) {
    await sudo([
      "iw",
      "dev",
      INTERFACE,
      "station",
      "del",
      mac,
    ]).catch(() => undefined);
  }
}

async function writeSiteBlocklist() {
  const config =
    siteBlockConfig() + "\n";

  console.log(config);

  await sudo(
    ["tee", DNSMASQ_BLOCKLIST],
    config
  );

  await sudo(["dnsmasq", "--test"]);

  await sudo([
    "systemctl",
    "restart",
    "dnsmasq",
  ]);

  await sudo([
    "systemd-resolve",
    "--flush-caches",
  ]).catch(() => undefined);
}

async function blockSite(site) {
  console.log("Blocking:", site);

  blockedSites.add(site);

  await writeSiteBlocklist();

  await disconnectClients();
}

async function unblockSite(site) {
  blockedSites.delete(site);

  await writeSiteBlocklist();

  await disconnectClients();
}

async function enforceLocalDNS() {
  await sudo([
    "iptables",
    "-t",
    "nat",
    "-C",
    "PREROUTING",
    "-p",
    "udp",
    "--dport",
    "53",
    "-j",
    "REDIRECT",
    "--to-ports",
    "53",
  ]).catch(async () => {
    await sudo([
      "iptables",
      "-t",
      "nat",
      "-A",
      "PREROUTING",
      "-p",
      "udp",
      "--dport",
      "53",
      "-j",
      "REDIRECT",
      "--to-ports",
      "53",
    ]);
  });

  await sudo([
    "iptables",
    "-t",
    "nat",
    "-C",
    "PREROUTING",
    "-p",
    "tcp",
    "--dport",
    "53",
    "-j",
    "REDIRECT",
    "--to-ports",
    "53",
  ]).catch(async () => {
    await sudo([
      "iptables",
      "-t",
      "nat",
      "-A",
      "PREROUTING",
      "-p",
      "tcp",
      "--dport",
      "53",
      "-j",
      "REDIRECT",
      "--to-ports",
      "53",
    ]);
  });

  await sudo([
    "iptables",
    "-C",
    "FORWARD",
    "-p",
    "udp",
    "--dport",
    "53",
    "-j",
    "DROP",
  ]).catch(async () => {
    await sudo([
      "iptables",
      "-A",
      "FORWARD",
      "-p",
      "udp",
      "--dport",
      "53",
      "-j",
      "DROP",
    ]);
  });

  await sudo([
    "iptables",
    "-C",
    "FORWARD",
    "-p",
    "tcp",
    "--dport",
    "53",
    "-j",
    "DROP",
  ]).catch(async () => {
    await sudo([
      "iptables",
      "-A",
      "FORWARD",
      "-p",
      "tcp",
      "--dport",
      "53",
      "-j",
      "DROP",
    ]);
  });
}

async function blockDoH() {
  for (const ip of DOH_IPS) {
    await sudo([
      "iptables",
      "-C",
      "FORWARD",
      "-d",
      ip,
      "-j",
      "DROP",
    ]).catch(async () => {
      await sudo([
        "iptables",
        "-A",
        "FORWARD",
        "-d",
        ip,
        "-j",
        "DROP",
      ]);
    });
  }
}

async function blockQUIC() {
  await sudo([
    "iptables",
    "-C",
    "FORWARD",
    "-p",
    "udp",
    "--dport",
    "443",
    "-j",
    "REJECT",
  ]).catch(async () => {
    await sudo([
      "iptables",
      "-A",
      "FORWARD",
      "-p",
      "udp",
      "--dport",
      "443",
      "-j",
      "REJECT",
    ]);
  });
}

async function enforceMaxClients(
  stationMacs
) {
  if (!Number.isInteger(maxClients)) {
    for (const mac of Array.from(
      autoBlockedMacs
    )) {
      await unblockMac(mac);
    }

    return;
  }

  const allowed = new Set(
    stationMacs.slice(0, maxClients)
  );

  const overLimit =
    stationMacs.slice(maxClients);

  for (const mac of overLimit) {
    if (!blockedMacs.has(mac)) {
      await blockMac(mac);
      autoBlockedMacs.add(mac);
    }
  }

  for (const mac of Array.from(
    autoBlockedMacs
  )) {
    if (allowed.has(mac)) {
      await unblockMac(mac);
    }
  }
}

function controlState() {
  return {
    blockedMacs: Array.from(blockedMacs),
    autoBlockedMacs: Array.from(
      autoBlockedMacs
    ),
    limitedMacs: Object.fromEntries(
      limitedMacs
    ),
    blockedSites: Array.from(
      blockedSites
    ).sort(),
    maxClients,
  };
}

async function handleApi(req, res) {
  const url = new URL(
    req.url,
    `http://${req.headers.host}`
  );

  if (
    req.method === "POST" &&
    url.pathname === "/api/login"
  ) {
    const body = await readJson(req);

    if (
      body.password !== ADMIN_PASSWORD
    ) {
      sendJson(res, 401, {
        error: "Wrong admin password",
      });

      return;
    }

    const token = crypto
      .randomBytes(24)
      .toString("hex");

    sessions.add(token);

    sendJson(res, 200, { token });

    return;
  }

  if (url.pathname === "/api/state") {
    if (!requireAdmin(req, res))
      return;

    sendJson(res, 200, {
      ...controlState(),
      interface: INTERFACE,
    });

    return;
  }

  if (!requireAdmin(req, res))
    return;

  const macMatch =
    url.pathname.match(
      /^\/api\/clients\/([^/]+)\/(block|unblock|limit|clear-limit)$/
    );

  if (
    req.method === "POST" &&
    macMatch
  ) {
    const mac = normalizeMac(
      decodeURIComponent(macMatch[1])
    );

    if (!isValidMac(mac)) {
      sendJson(res, 400, {
        error: "Invalid MAC address",
      });

      return;
    }

    const action = macMatch[2];
    const body = await readJson(req);

    if (action === "block")
      await blockMac(mac);

    if (action === "unblock")
      await unblockMac(mac);

    if (action === "limit")
      await limitMac(mac, body.kbps);

    if (action === "clear-limit")
      await clearLimitMac(mac);

    sendJson(res, 200, {
      ok: true,
      ...controlState(),
    });

    broadcast({
      type: "control_state",
      timestamp:
        new Date().toISOString(),
      ...controlState(),
    });

    return;
  }

  if (
    req.method === "POST" &&
    (
      url.pathname ===
        "/api/sites/block" ||
      url.pathname ===
        "/api/sites/unblock"
    )
  ) {
    const body = await readJson(req);

    const site = normalizeSite(
      body.site
    );

    if (
      url.pathname.endsWith("/block")
    ) {
      await blockSite(site);
    }

    if (
      url.pathname.endsWith(
        "/unblock"
      )
    ) {
      await unblockSite(site);
    }

    sendJson(res, 200, {
      ok: true,
      ...controlState(),
    });

    broadcast({
      type: "control_state",
      timestamp:
        new Date().toISOString(),
      ...controlState(),
    });

    return;
  }

  if (
    req.method === "POST" &&
    url.pathname ===
      "/api/access-limit"
  ) {
    const body = await readJson(req);

    const nextMax =
      body.maxClients === null ||
      body.maxClients === ""
        ? null
        : Number(body.maxClients);

    if (
      nextMax !== null &&
      (
        !Number.isInteger(nextMax) ||
        nextMax < 1 ||
        nextMax > 256
      )
    ) {
      sendJson(res, 400, {
        error:
          "Maximum clients must be between 1 and 256",
      });

      return;
    }

    maxClients = nextMax;

    await enforceMaxClients(
      parseStationMacs(
        lastStationOutput
      )
    );

    sendJson(res, 200, {
      ok: true,
      ...controlState(),
    });

    broadcast({
      type: "control_state",
      timestamp:
        new Date().toISOString(),
      ...controlState(),
    });

    return;
  }

  sendJson(res, 404, {
    error: "Not found",
  });
}

function runStationDump() {

  if (commandInFlight) {
    return;
  }

  commandInFlight = true;

  execFile(
    "iw",
    [
      "dev",
      INTERFACE,
      "station",
      "dump",
    ],
    { timeout: 5000 },
    (error, stdout, stderr) => {
      const timestamp =
        new Date().toISOString();

      commandInFlight = false;

      if (error) {
        broadcast({
          type: "error",
          timestamp,
          interface: INTERFACE,
          output:
            stderr?.trim() ||
            error.message,
        });

        return;
      }

      const output =
        stdout.trim() ||
        "No stations connected.";

      lastStationOutput = output;

      const devices =
  parseStationDump(output);

for (const device of devices) {

  const history =
    deviceHistory.get(device.mac) || [];

  history.push(device);

  if (history.length > 20) {
    history.shift();
  }

  deviceHistory.set(
    device.mac,
    history
  );
  logDeviceData(device);
  const anomaly =
    detectAnomaly(device);

  broadcast({
    type: "anomaly_detection",
    timestamp,
    device,
    anomaly
  });
   if (
    anomaly.anomaly &&
    anomaly.score >= 80
  ) {

    console.log(
      `[AI] Severe anomaly detected for ${device.mac}`
    );}
}
      enforceMaxClients(
        parseStationMacs(output)
      )
        .then(() => {
          broadcast({
            type: "control_state",
            timestamp:
              new Date().toISOString(),
            ...controlState(),
          });
        })
        .catch((enforceError) => {
          broadcast({
            type: "error",
            timestamp:
              new Date().toISOString(),
            interface: INTERFACE,
            output:
              enforceError.message,
          });
        });

      broadcast({
        type: "station_dump",
        timestamp,
        interface: INTERFACE,
        output,
        controls: controlState(),
      });
    }
  );
}

wss.on("connection", (socket) => {
  socket.send(
    JSON.stringify({
      type: "connected",
      timestamp:
        new Date().toISOString(),
      interface: INTERFACE,
      pollIntervalMs:
        POLL_INTERVAL_MS,
      output: lastStationOutput,
      controls: controlState(),
    })
  );

  runStationDump();
});

server.listen(
  PORT,
  "0.0.0.0",
  async () => {
    console.log(
      `Backend listening on ws://0.0.0.0:${PORT}`
    );

    console.log(
      `Streaming: iw dev ${INTERFACE} station dump`
    );

    try {
      await disableIPv6();
      await enforceLocalDNS();

      await blockDoH();

      await blockQUIC();

      console.log(
        "DNS enforcement enabled"
      );
    } catch (error) {
      console.error(
        "Startup firewall error:",
        error.message
      );
    }
  }
);

setInterval(
  runStationDump,
  POLL_INTERVAL_MS
);