import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  AreaChart,
  Area,
} from "recharts";
const defaultWsUrl = `ws://${window.location.hostname}:3001`;
const WS_URL = import.meta.env.VITE_WS_URL || defaultWsUrl;
const API_URL = WS_URL.replace(/^ws/, "http").replace(/\/$/, "");

function parseStations(output) {
  if (!output || output === "No stations connected.") {
    return [];
  }

  const blocks = output
    .split(/^Station /m)
    .map((block) => block.trim())
    .filter(Boolean);

  return blocks.map((block) => {
    const lines = block.split("\n").map((line) => line.trim());
    const [firstLine, ...rest] = lines;
    const [mac = "Unknown"] = firstLine.split(/\s+/);
    const details = {};

    for (const line of rest) {
      const separatorIndex = line.indexOf(":");
      if (separatorIndex === -1) continue;

      const key = line.slice(0, separatorIndex).trim().toLowerCase();
      const value = line.slice(separatorIndex + 1).trim();
      details[key] = value;
    }

    return {
  mac: mac.toLowerCase(),

  signal: details.signal || "-",

  txBitrate:
    parseFloat(details["tx bitrate"]) || 0,

  rxBitrate:
    parseFloat(details["rx bitrate"]) || 0,

  connectedTime:
    details["connected time"] || "-",

  inactiveTime:
    details["inactive time"] || "-",

  txPackets:
    parseInt(details["tx packets"]) || 0,

  rxPackets:
    parseInt(details["rx packets"]) || 0,

  txBytes:
    parseInt(details["tx bytes"]) || 0,

  rxBytes:
    parseInt(details["rx bytes"]) || 0,
};
  });
}
function MatrixBackground() {
  useEffect(() => {
    const canvas = document.getElementById("matrix");
    const ctx = canvas.getContext("2d");

    let width = (canvas.width = window.innerWidth);
    let height = (canvas.height = window.innerHeight);

    const chars =
      "বদমাশলড়কাবদমাশলড়কাবদমাশলড়কাবদমাশলড়কাবদমাশলড়কাবদমাশলড়কাবদমাশলড়কা";

    const fontSize = 14;
    const columns = Math.floor(width / fontSize);

    const drops = Array(columns).fill(1);

    const resize = () => {
      width = canvas.width = window.innerWidth;
      height = canvas.height = window.innerHeight;
    };

    window.addEventListener("resize", resize);

    const draw = () => {
      ctx.fillStyle = "rgba(0, 0, 0, 0.08)";
      ctx.fillRect(0, 0, width, height);

      ctx.fillStyle = "#00ff9d";
      ctx.font = `${fontSize}px monospace`;

      for (let i = 0; i < drops.length; i++) {
        const text =
          chars[Math.floor(Math.random() * chars.length)];

        ctx.fillText(text, i * fontSize, drops[i] * fontSize);

        if (
          drops[i] * fontSize > height &&
          Math.random() > 0.975
        ) {
          drops[i] = 0;
        }

        drops[i]++;
      }
    };

    const interval = setInterval(draw, 35);

    return () => {
      clearInterval(interval);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return (
    <canvas
      id="matrix"
      className="fixed inset-0 z-0 opacity-20"
    />
  );
}

function App() {
  const [adminToken, setAdminToken] = useState(
    () => window.localStorage.getItem("adminToken") || ""
  );

  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [status, setStatus] = useState("Connecting...");
  const [statusTone, setStatusTone] = useState("warn");
  const [interfaceName, setInterfaceName] = useState("-");
  const [updatedAt, setUpdatedAt] = useState("-");
  const [rawOutput, setRawOutput] = useState(
    "Waiting for station data..."
  );

  const [showRawOutput, setShowRawOutput] = useState(false);

  const [controls, setControls] = useState({
    blockedMacs: [],
    autoBlockedMacs: [],
    limitedMacs: {},
    blockedSites: [],
    maxClients: null,
  });

  const [site, setSite] = useState("");
  const [maxClientsInput, setMaxClientsInput] = useState("");
  const [limitInputs, setLimitInputs] = useState({});
  const [busyAction, setBusyAction] = useState("");
  const [actionError, setActionError] = useState("");
  const [deviceHistory, setDeviceHistory] = useState({});
  const [anomalies, setAnomalies] = useState({});
  const stations = useMemo(
    () => parseStations(rawOutput),
    [rawOutput]
  );
const totalTx = stations.reduce(
  (sum, s) => sum + s.txBitrate,
  0
);

const totalRx = stations.reduce(
  (sum, s) => sum + s.rxBitrate,
  0
);

const totalPackets = stations.reduce(
  (sum, s) =>
    sum +
    (s.txPackets || 0) +
    (s.rxPackets || 0),
  0
);
  const authedFetch = async (path, body = {}) => {
    setActionError("");

    const response = await fetch(`${API_URL}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data.error || "Request failed");
    }

    if (data.blockedMacs) {
      setControls({
        blockedMacs: data.blockedMacs,
        autoBlockedMacs: data.autoBlockedMacs || [],
        limitedMacs: data.limitedMacs || {},
        blockedSites: data.blockedSites || [],
        maxClients: data.maxClients ?? null,
      });
    }

    return data;
  };

  const runAction = async (id, callback) => {
    setBusyAction(id);

    try {
      await callback();
    } catch (error) {
      setActionError(error.message);
    } finally {
      setBusyAction("");
    }
  };

  const login = async (event) => {
    event.preventDefault();
    setLoginError("");

    try {
      const response = await fetch(`${API_URL}/api/login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ password }),
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(data.error || "Login failed");
      }

      window.localStorage.setItem("adminToken", data.token);
      setAdminToken(data.token);
      setPassword("");
    } catch (error) {
      setLoginError(error.message);
    }
  };

  useEffect(() => {
    if (!adminToken) return undefined;

    fetch(`${API_URL}/api/state`, {
      headers: {
        Authorization: `Bearer ${adminToken}`,
      },
    })
      .then((response) => {
        if (response.status === 401) {
          window.localStorage.removeItem("adminToken");
          setAdminToken("");
        }

        return response.json();
      })
      .then((data) => {
        if (data?.blockedMacs) {
          setControls(data);
        }
      })
      .catch(() => undefined);

    return undefined;
  }, [adminToken]);

  useEffect(() => {
    let retryTimer;
    let socket;

    const connect = () => {
      socket = new WebSocket(WS_URL);

      socket.addEventListener("open", () => {
        setStatus("Connected");
        setStatusTone("ok");
      });

      socket.addEventListener("message", (event) => {
        const message = JSON.parse(event.data);

        if (message.interface) {
          setInterfaceName(message.interface);
        }

        if (message.timestamp) {
          setUpdatedAt(
            new Date(message.timestamp).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            })
          );
        }

        if (message.output) {
  setRawOutput(message.output);
if (message.type === "anomaly_detection") {
  setAnomalies((prev) => ({
    ...prev,
    [message.device.mac]: message.anomaly,
  }));
}
  const parsedStations =
    parseStations(message.output);

  const totalTx = parsedStations.reduce(
    (sum, s) =>
      sum + (s.txBitrate || 0),
    0
  );

  const totalRx = parsedStations.reduce(
    (sum, s) =>
      sum + (s.rxBitrate || 0),
    0
  );

  setDeviceHistory((prev) => {
  const updated = { ...prev };

  parsedStations.forEach((station) => {
    const mac = station.mac;

    if (!updated[mac]) {
      updated[mac] = [];
    }

    updated[mac] = [
      ...updated[mac].slice(-20),
      {
        time: new Date().toLocaleTimeString(),

        tx: station.txBitrate || 0,

        rx: station.rxBitrate || 0,
      },
    ];
  });

  return updated;
});
}

        if (message.controls) {
          setControls(message.controls);
        }

        if (message.type === "station_dump") {
          setStatus("LIVE");
          setStatusTone("ok");
        }

        if (message.type === "error") {
          setStatus("ERROR");
          setStatusTone("error");
        }
      });

      socket.addEventListener("close", () => {
        setStatus("Reconnecting...");
        setStatusTone("warn");

        retryTimer = window.setTimeout(connect, 1500);
      });

      socket.addEventListener("error", () => {
        socket.close();
      });
    };

    connect();

    return () => {
      window.clearTimeout(retryTimer);
      socket?.close();
    };
  }, []);

  const statusDot = {
    ok: "bg-emerald-400 shadow-emerald-500/60",
    warn: "bg-amber-400 shadow-amber-500/60",
    error: "bg-red-400 shadow-red-500/60",
  };

  const primaryButton =
    "rounded-xl bg-green-400 px-4 py-2 text-sm font-semibold text-black transition-all duration-200 hover:scale-[1.03] hover:bg-green-300 active:scale-95 disabled:opacity-40";

  const secondaryButton =
    "rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-zinc-200 backdrop-blur transition hover:bg-white/10 disabled:opacity-40";

  const inputClass =
    "w-full rounded-xl border border-white/10 bg-black/60 px-4 py-3 text-zinc-100 outline-none transition focus:border-cyan-400 focus:ring-2 focus:ring-cyan-400/20";

  if (!adminToken) {
    return (
      <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-black px-4 text-zinc-100">
        <div className="fixed inset-0 -z-20 opacity-[0.05] [background-image:linear-gradient(to_right,#ffffff22_1px,transparent_1px),linear-gradient(to_bottom,#ffffff22_1px,transparent_1px)] [background-size:40px_40px]" />

        <>
  <MatrixBackground />

  <div className="fixed inset-0 -z-10 bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.04),transparent_35%),radial-gradient(circle_at_bottom,rgba(0,255,140,0.08),transparent_30%)]" />
</>

        <form
          onSubmit={login}
          className="
relative
z-10
w-full
max-w-md
rounded-3xl
border
border-green-500/10
bg-black/70
p-8
shadow-[0_0_60px_rgba(0,255,120,0.08)]
backdrop-blur-2xl
"
        >
          <p className="text-xs uppercase tracking-[0.25em] text-green-400">
            Raspberry Pi
          </p>

          <h1 className="mt-4 text-4xl font-black tracking-tight">
            Chakravyuh
          </h1>

          <p className="mt-3 text-sm text-zinc-500">
            Secure network administration panel
          </p>

          <div className="mt-8">
            <label className="mb-2 block text-sm text-zinc-400">
              Admin Password
            </label>

            <input
              type="password"
              value={password}
              onChange={(event) =>
                setPassword(event.target.value)
              }
              className={inputClass}
              autoFocus
            />
          </div>

          {loginError && (
            <div className="mt-4 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-300">
              {loginError}
            </div>
          )}

          <button type="submit" className={`${primaryButton} mt-6 w-full`}>
            Access Console
          </button>
        </form>
      </main>
    );
  }

  return (
    <main className="relative min-h-screen overflow-hidden bg-black text-zinc-100">
      <div className="fixed inset-0 -z-20 opacity-[0.05] [background-image:linear-gradient(to_right,#ffffff22_1px,transparent_1px),linear-gradient(to_bottom,#ffffff22_1px,transparent_1px)] [background-size:40px_40px]" />

      <div className="fixed inset-0 -z-10 bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.06),transparent_35%),radial-gradient(circle_at_bottom,rgba(0,120,255,0.12),transparent_30%)]" />

      <div className="mx-auto max-w-7xl px-6 py-8">
        <section className="sticky top-4 z-20 mb-8 rounded-3xl border border-white/5 bg-black/40 p-6 backdrop-blur-2xl">
          <div className="flex flex-col justify-between gap-6 lg:flex-row lg:items-center">
            <div>
              <p className="text-xs uppercase tracking-[0.25em] text-green-400">
                Raspberry Pi
              </p>

              <h1 className="mt-3 text-5xl font-black tracking-tight">
                Chakravyuh
              </h1>

              <p className="mt-4 text-sm text-zinc-500">
                Live network monitoring for{" "}
                <span className="text-cyan-300">
                  {interfaceName}
                </span>
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-4">
              <div className="flex items-center gap-4 rounded-2xl border border-white/5 bg-zinc-950/70 px-5 py-4 shadow-[0_0_40px_rgba(0,0,0,0.6)]">
                <span
                  className={`h-3 w-3 rounded-full animate-pulse shadow-lg ${statusDot[statusTone]}`}
                />

                <div>
                  <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">
                    Status
                  </p>

                  <p className="mt-1 font-semibold text-white">
                    {status}
                  </p>
                </div>
              </div>

              <button
                onClick={() => {
                  window.localStorage.removeItem("adminToken");
                  setAdminToken("");
                }}
                className={secondaryButton}
              >
                Logout
              </button>
            </div>
          </div>
        </section>

       <section className="mb-6 grid gap-4 md:grid-cols-5">
  {[
    ["Interface", interfaceName],

    ["Connected Stations", stations.length],

    ["TX Traffic", `${totalTx.toFixed(1)} Mbps`],

    ["RX Traffic", `${totalRx.toFixed(1)} Mbps`],

    ["Packets", totalPackets],
  ].map(([label, value]) => (
    <motion.article
      key={label}
      layout
      className="rounded-2xl border border-white/5 bg-zinc-950/70 p-6 shadow-[0_0_40px_rgba(0,0,0,0.6)] backdrop-blur-xl"
    >
      <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">
        {label}
      </p>

      <p className="mt-4 text-3xl font-bold text-white">
        {value}
      </p>
    </motion.article>
  ))}
</section>

        {actionError && (
          <div className="mb-6 rounded-2xl border border-red-500/20 bg-red-500/10 px-5 py-4 text-sm text-red-300">
            {actionError}
          </div>
        )}
<section className="mb-6 grid gap-5 lg:grid-cols-2">
  <article className="rounded-3xl border border-white/5 bg-zinc-950/70 p-6 shadow-[0_0_40px_rgba(0,0,0,0.6)] backdrop-blur-xl">
    <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">
      Live Analytics
    </p>

    <h2 className="mt-2 text-2xl font-bold">
      Network Throughput
    </h2>

    
  </article>

  <article className="rounded-3xl border border-white/5 bg-zinc-950/70 p-6 shadow-[0_0_40px_rgba(0,0,0,0.6)] backdrop-blur-xl">
    <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">
      Packet Density
    </p>

    <h2 className="mt-2 text-2xl font-bold">
      Live Traffic Flow
    </h2>

    
  </article>
</section>
        <section className="grid gap-5 lg:grid-cols-[1.2fr_0.8fr]">
          <article className="overflow-hidden rounded-3xl border border-white/5 bg-zinc-950/70 shadow-[0_0_40px_rgba(0,0,0,0.6)] backdrop-blur-xl">
            <div className="border-b border-white/5 px-6 py-5">
              <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">
                Connected Clients
              </p>

              <h2 className="mt-2 text-2xl font-bold">
                Stations
              </h2>
            </div>

            <div className="grid gap-4 p-5">
              <AnimatePresence mode="popLayout">
                {stations.length === 0 ? (
                  <motion.div
                    key="empty"
                    className="grid min-h-[300px] place-items-center rounded-2xl border border-dashed border-white/10 text-zinc-500"
                  >
                    No active stations detected.
                  </motion.div>
                ) : (
                  stations.map((station) => {
                    const isBlocked =
                      controls.blockedMacs.includes(
                        station.mac
                      );

                    const isAutoBlocked =
                      controls.autoBlockedMacs.includes(
                        station.mac
                      );

                    const limit =
                      controls.limitedMacs[station.mac];

                      const anomaly =
  anomalies[station.mac];
                    const limitValue =
                      limitInputs[station.mac] ??
                      limit ??
                      512;

                    return (
                      <motion.article
                        key={station.mac}
                        layout
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0 }}
                        className="rounded-2xl border border-white/5 bg-black/40 p-5 transition-all duration-300 hover:-translate-y-1 hover:border-cyan-400/20 hover:bg-zinc-900/70"
                      >
                        <div className="mb-5 flex flex-col justify-between gap-4 lg:flex-row">
                          <div>
                            <h3 className="font-semibold text-white">
                              {station.mac}
                            </h3>

                            <p className="mt-2 text-sm text-emerald-400">
                              {station.signal}
                            </p>
                          </div>

                          <div className="flex flex-wrap gap-2">
                            {isBlocked && (
                              <span className="rounded-xl bg-red-500/10 px-3 py-1 text-xs text-red-300">
                                {isAutoBlocked
                                  ? "OVER LIMIT"
                                  : "BLOCKED"}
                              </span>
                            )}

                            {limit && (
                              <span className="rounded-xl bg-amber-500/10 px-3 py-1 text-xs text-amber-300">
                                {limit} Kbps
                              </span>
                            )}
                            {anomaly?.anomaly && (
  <span className="
    rounded-xl
    bg-red-500/10
    px-3
    py-1
    text-xs
    text-red-300
    border
    border-red-500/20
    animate-pulse
  ">
    PHY ANOMALY
  </span>
)}
                          </div>
                        </div>

                        <dl className="grid gap-4 sm:grid-cols-2">
                          {[
                            ["TX Bitrate", station.txBitrate],
                            ["RX Bitrate", station.rxBitrate],
                            ["Connected", station.connectedTime],
                            ["Inactive", station.inactiveTime],
                          ].map(([label, value]) => (
                            <div key={label}>
                              <dt className="text-[11px] uppercase tracking-[0.18em] text-zinc-500">
                                {label}
                              </dt>

                              <dd className="mt-1 text-sm text-zinc-200">
                                {value}
                              </dd>
                            </div>
                          ))}
                        </dl>
                        {anomaly?.anomaly && (
  <div className="
    mt-4
    rounded-2xl
    border
    border-red-500/20
    bg-red-500/5
    p-4
  ">
    <div className="flex items-center justify-between">
      <p className="text-sm font-semibold text-red-300">
        AI Threat Detection
      </p>

      <span className="
        rounded-lg
        bg-red-500/10
        px-2
        py-1
        text-xs
        text-red-200
      ">
        Score: {anomaly.score}
      </span>
    </div>

    <div className="mt-3 flex flex-wrap gap-2">
      {anomaly.reasons.map((reason) => (
        <span
          key={reason}
          className="
            rounded-lg
            bg-black/40
            px-2
            py-1
            text-xs
            text-red-200
            border
            border-red-500/10
          "
        >
          {reason}
        </span>
      ))}
    </div>
  </div>
)}
                        <div className="mt-6 h-[180px] rounded-2xl border border-white/5 bg-black/40 p-3">
  <ResponsiveContainer
    width="100%"
    height="100%"
  >
    <LineChart
      data={deviceHistory[station.mac] || []}
    >
      <CartesianGrid
        stroke="#222"
        strokeDasharray="3 3"
      />

      <XAxis
        dataKey="time"
        stroke="#555"
        hide
      />

      <YAxis
        stroke="#555"
        width={30}
      />

      <Tooltip
        contentStyle={{
          background: "#050505",
          border: "1px solid #222",
          borderRadius: "12px",
        }}
      />

      <Line
        type="monotone"
        dataKey="tx"
        stroke="#00ff9d"
        strokeWidth={2}
        dot={false}
      />

      <Line
        type="monotone"
        dataKey="rx"
        stroke="#00bfff"
        strokeWidth={2}
        dot={false}
      />
    </LineChart>
  </ResponsiveContainer>
</div>

                        <div className="mt-5 flex flex-col gap-4 border-t border-white/5 pt-5 xl:flex-row xl:items-center xl:justify-between">
                          <div className="flex flex-wrap gap-2">
                            <button
                              disabled={
                                busyAction ===
                                `${station.mac}:block`
                              }
                              onClick={() =>
                                runAction(
                                  `${station.mac}:block`,
                                  () =>
                                    authedFetch(
                                      `/api/clients/${station.mac}/${
                                        isBlocked
                                          ? "unblock"
                                          : "block"
                                      }`
                                    )
                                )
                              }
                              className={secondaryButton}
                            >
                              {isBlocked
                                ? "Unblock"
                                : "Block"}
                            </button>

                            {limit && (
                              <button
                                disabled={
                                  busyAction ===
                                  `${station.mac}:clear-limit`
                                }
                                onClick={() =>
                                  runAction(
                                    `${station.mac}:clear-limit`,
                                    () =>
                                      authedFetch(
                                        `/api/clients/${station.mac}/clear-limit`
                                      )
                                  )
                                }
                                className={secondaryButton}
                              >
                                Clear Limit
                              </button>
                            )}
                          </div>

                          <form
                            className="flex gap-2"
                            onSubmit={(event) => {
                              event.preventDefault();

                              runAction(
                                `${station.mac}:limit`,
                                () =>
                                  authedFetch(
                                    `/api/clients/${station.mac}/limit`,
                                    {
                                      kbps:
                                        Number(limitValue),
                                    }
                                  )
                              );
                            }}
                          >
                            <input
                              type="number"
                              value={limitValue}
                              min="32"
                              max="1000000"
                              onChange={(event) =>
                                setLimitInputs(
                                  (values) => ({
                                    ...values,
                                    [station.mac]:
                                      event.target.value,
                                  })
                                )
                              }
                              className={`${inputClass} w-32`}
                            />

                            <button
                              type="submit"
                              className={primaryButton}
                            >
                              Apply
                            </button>
                          </form>
                        </div>
                      </motion.article>
                    );
                  })
                )}
              </AnimatePresence>
            </div>
          </article>

          <div className="grid gap-5 content-start">
            <article className="rounded-3xl border border-white/5 bg-zinc-950/70 p-6 shadow-[0_0_40px_rgba(0,0,0,0.6)] backdrop-blur-xl">
              <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">
                Access Control
              </p>

              <h2 className="mt-2 text-2xl font-bold">
                Maximum Users
              </h2>

              <form
                className="mt-5 flex gap-2"
                onSubmit={(event) => {
                  event.preventDefault();

                  runAction(
                    "access-limit",
                    () =>
                      authedFetch("/api/access-limit", {
                        maxClients: maxClientsInput,
                      })
                  );
                }}
              >
                <input
                  type="number"
                  value={maxClientsInput}
                  onChange={(event) =>
                    setMaxClientsInput(event.target.value)
                  }
                  placeholder={
                    controls.maxClients
                      ? String(controls.maxClients)
                      : "No limit"
                  }
                  className={inputClass}
                />

                <button
                  type="submit"
                  className={primaryButton}
                >
                  Apply
                </button>
              </form>
            </article>

            <article className="rounded-3xl border border-white/5 bg-zinc-950/70 p-6 shadow-[0_0_40px_rgba(0,0,0,0.6)] backdrop-blur-xl">
              <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">
                Site Blocking
              </p>

              <h2 className="mt-2 text-2xl font-bold">
                Blocked Domains
              </h2>

              <form
                className="mt-5 flex gap-2"
                onSubmit={(event) => {
                  event.preventDefault();

                  runAction("site:block", async () => {
                    await authedFetch(
                      "/api/sites/block",
                      { site }
                    );

                    setSite("");
                  });
                }}
              >
                <input
                  type="text"
                  value={site}
                  onChange={(event) =>
                    setSite(event.target.value)
                  }
                  placeholder="youtube.com"
                  className={inputClass}
                />

                <button
                  type="submit"
                  className={primaryButton}
                >
                  Block
                </button>
              </form>

              <div className="mt-5 grid gap-3">
                {controls.blockedSites.map((blockedSite) => (
                  <div
                    key={blockedSite}
                    className="flex items-center justify-between rounded-2xl border border-white/5 bg-black/40 px-4 py-3"
                  >
                    <span className="text-sm">
                      {blockedSite}
                    </span>

                    <button
                      onClick={() =>
                        runAction(
                          `site:${blockedSite}`,
                          () =>
                            authedFetch(
                              "/api/sites/unblock",
                              {
                                site: blockedSite,
                              }
                            )
                        )
                      }
                      className={secondaryButton}
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            </article>

            <article className="overflow-hidden rounded-3xl border border-white/5 bg-zinc-950/70 shadow-[0_0_40px_rgba(0,0,0,0.6)] backdrop-blur-xl">
              <div className="flex items-center justify-between border-b border-white/5 px-6 py-5">
                <div>
                  <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">
                    Terminal View
                  </p>

                  <h2 className="mt-2 text-2xl font-bold">
                    Raw Output
                  </h2>
                </div>

                <button
                  onClick={() =>
                    setShowRawOutput((v) => !v)
                  }
                  className={secondaryButton}
                >
                  {showRawOutput ? "Hide" : "Show"}
                </button>
              </div>

              <AnimatePresence initial={false}>
                {showRawOutput && (
                  <motion.pre
                    key="raw-output"
                    initial={{
                      height: 0,
                      opacity: 0,
                    }}
                    animate={{
                      height: "auto",
                      opacity: 1,
                    }}
                    exit={{
                      height: 0,
                      opacity: 0,
                    }}
                    className="max-h-[34rem] overflow-auto whitespace-pre-wrap break-words border-t border-green-500/10 bg-black p-5 font-mono text-sm leading-6 text-green-400"
                  >
                    {rawOutput}
                  </motion.pre>
                )}
              </AnimatePresence>
            </article>
          </div>
        </section>
      </div>
    </main>
  );
}

export default App;