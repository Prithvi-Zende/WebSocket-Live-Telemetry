/**
 * Frontend Workflow & Receiver Integration Script
 * Implements Section 1, 2, and 3 of the Frontend Integration Guide:
 *   - Live Socket.IO connection to Transmitter IP listening on 'sensor_update'
 *   - Direct DOM updates to #out-distance, #out-gas, #out-touch, #out-button
 *   - Offline Mock Data Generator as described in Example 1
 *   - 60 FPS real-time oscilloscope canvas & interactive injection triggers
 */

// Configuration State
let TRANSMITTER_IP = window.location.origin.includes("http") ? window.location.origin : "http://127.0.0.1:5000";
let socket = null;
let isMocking = false;
let mockInterval = null;

// Oscilloscope Buffer
const chartData = [];
const MAX_CHART_POINTS = 300;
let selectedChannel = "both";
let timeWindowSec = 30;
let totalLines = 0;
let totalBytes = 0;
const sessionStart = Date.now();

// DOM Element References
const dom = {
  outDistance: document.getElementById("out-distance"),
  outGas: document.getElementById("out-gas"),
  outTouch: document.getElementById("out-touch"),
  outButton: document.getElementById("out-button"),

  // Visual meters
  barDistance: document.getElementById("barDistance"),
  distStatus: document.getElementById("distStatus"),
  radarBlip: document.getElementById("radarBlip"),
  gasRadialCircle: document.getElementById("gasRadialCircle"),
  gasStatus: document.getElementById("gasStatus"),
  gasTrend: document.getElementById("gasTrend"),
  pillSafe: document.getElementById("pillSafe"),
  pillWarn: document.getElementById("pillWarn"),
  pillHazard: document.getElementById("pillHazard"),
  touchPadVisual: document.getElementById("touchPadVisual"),
  touchCardStatus: document.getElementById("touchCardStatus"),
  touchIndicatorText: document.getElementById("touchIndicatorText"),
  physicalBtnCap: document.getElementById("physicalBtnCap"),
  btnCardStatus: document.getElementById("btnCardStatus"),
  buttonIndicatorText: document.getElementById("buttonIndicatorText"),

  // Top Pills & Handshake
  sourceModeBadge: document.getElementById("sourceModeBadge"),
  sourceDot: document.getElementById("sourceDot"),
  ipBadge: document.getElementById("ipBadge"),
  toggleMockBtn: document.getElementById("toggleMockBtn"),
  mockBtnText: document.getElementById("mockBtnText"),
  mockIcon: document.getElementById("mockIcon"),
  configIpBtn: document.getElementById("configIpBtn"),
  handshakeBanner: document.getElementById("handshakeBanner"),
  transmitterIpInput: document.getElementById("transmitterIpInput"),
  saveIpBtn: document.getElementById("saveIpBtn"),
  closeIpBannerBtn: document.getElementById("closeIpBannerBtn"),

  // Oscilloscope & Terminal
  canvas: document.getElementById("liveChartCanvas"),
  canvasContainer: document.getElementById("canvasContainer"),
  terminalBody: document.getElementById("serialTerminalBody"),
  autoscrollCheck: document.getElementById("autoscrollCheck"),
  timestampsCheck: document.getElementById("timestampsCheck"),
  clearTerminalBtn: document.getElementById("clearTerminalBtn"),
  copyTerminalBtn: document.getElementById("copyTerminalBtn"),
  termLineCount: document.getElementById("termLineCount"),
  termBytesCount: document.getElementById("termBytesCount"),
  footerUptime: document.getElementById("footerUptime"),

  // Interactive buttons
  btnInjectTouch: document.getElementById("btnInjectTouch"),
  btnInjectButton: document.getElementById("btnInjectButton"),
  btnInjectGas: document.getElementById("btnInjectGas"),
  btnInjectObstacle: document.getElementById("btnInjectObstacle"),
  customCmdInput: document.getElementById("customCmdInput"),
  sendCmdBtn: document.getElementById("sendCmdBtn"),
};

// =============================================================
// Core DOM Update Function (EXACT SIGNATURE FROM GUIDE PAGE 2)
// =============================================================
function updateUI(data) {
  // 1. Mandatory DOM Updates (from Integration Guide)
  if (dom.outDistance) dom.outDistance.innerText = data.distance + ' cm';
  if (dom.outGas) dom.outGas.innerText = data.gas;
  if (dom.outTouch) dom.outTouch.innerText = data.touch;
  if (dom.outButton) dom.outButton.innerText = data.button;

  // 2. Rich Visual Meter Feedback
  // Distance Meter & Radar
  if (data.distance !== undefined) {
    const distNorm = Math.max(0, Math.min(100, ((data.distance - 10) / 100) * 100));
    if (dom.barDistance) dom.barDistance.style.width = `${distNorm}%`;

    if (data.distance <= 20) {
      dom.distStatus.textContent = "OBSTACLE NEAR";
      dom.distStatus.className = "card-status alert";
      if (dom.radarBlip) {
        dom.radarBlip.style.opacity = "1";
        dom.radarBlip.style.left = "48%";
        dom.radarBlip.style.top = "42%";
      }
    } else {
      dom.distStatus.textContent = "CLEAR";
      dom.distStatus.className = "card-status normal";
      if (dom.radarBlip) {
        dom.radarBlip.style.opacity = "0.4";
        dom.radarBlip.style.left = `${30 + (distNorm * 0.4)}%`;
      }
    }
  }

  // Gas PPM Gauge & Thresholds
  if (data.gas !== undefined) {
    const gasVal = data.gas;
    // Map 200 - 700 to radial stroke offset (301.6 circumference)
    const gasPct = Math.max(0, Math.min(1, (gasVal - 200) / 500));
    if (dom.gasRadialCircle) {
      dom.gasRadialCircle.style.strokeDashoffset = 301.6 - (gasPct * 301.6);
    }

    if (gasVal > 550) {
      dom.gasStatus.textContent = "HAZARD / LEAK";
      dom.gasStatus.className = "card-status alert";
      dom.gasTrend.textContent = "⚠️ High PPM Alert!";
      dom.gasTrend.className = "trend-indicator alert";
      if (dom.gasRadialCircle) dom.gasRadialCircle.style.stroke = "var(--accent-red)";
      setGasPillActive("hazard");
    } else if (gasVal > 420) {
      dom.gasStatus.textContent = "MODERATE";
      dom.gasStatus.className = "card-status warning";
      dom.gasTrend.textContent = "• Slightly Elevated";
      dom.gasTrend.className = "trend-indicator cyan";
      if (dom.gasRadialCircle) dom.gasRadialCircle.style.stroke = "var(--accent-amber)";
      setGasPillActive("warn");
    } else {
      dom.gasStatus.textContent = "SAFE";
      dom.gasStatus.className = "card-status normal";
      dom.gasTrend.textContent = "• Clean Atmosphere";
      dom.gasTrend.className = "trend-indicator green";
      if (dom.gasRadialCircle) dom.gasRadialCircle.style.stroke = "var(--accent-green)";
      setGasPillActive("safe");
    }
  }

  // Touch Sensor Feedback
  if (data.touch !== undefined) {
    if (data.touch === "TOUCHED") {
      dom.touchPadVisual.classList.add("touched");
      dom.touchCardStatus.textContent = "ACTIVE TOUCH";
      dom.touchCardStatus.className = "card-status alert";
      dom.touchIndicatorText.textContent = "⚡ Contact Established";
      dom.touchIndicatorText.className = "trend-indicator alert";
    } else {
      dom.touchPadVisual.classList.remove("touched");
      dom.touchCardStatus.textContent = "CLEAR";
      dom.touchCardStatus.className = "card-status normal";
      dom.touchIndicatorText.textContent = "• Standby";
      dom.touchIndicatorText.className = "trend-indicator";
    }
  }

  // Button Feedback
  if (data.button !== undefined) {
    if (data.button === "PRESSED") {
      dom.physicalBtnCap.classList.add("pressed");
      dom.btnCardStatus.textContent = "PRESSED";
      dom.btnCardStatus.className = "card-status alert";
      dom.buttonIndicatorText.textContent = "🔘 Key Down (0V)";
      dom.buttonIndicatorText.className = "trend-indicator alert";
    } else {
      dom.physicalBtnCap.classList.remove("pressed");
      dom.btnCardStatus.textContent = "RELEASED";
      dom.btnCardStatus.className = "card-status normal";
      dom.buttonIndicatorText.textContent = "• Ready (Pullup 5V)";
      dom.buttonIndicatorText.className = "trend-indicator";
    }
  }

  // 3. Append to Oscilloscope Data Buffer
  chartData.push({
    time: Date.now() / 1000,
    distance: data.distance || 0,
    gas: data.gas || 0,
  });
  if (chartData.length > MAX_CHART_POINTS) {
    chartData.shift();
  }

  // 4. Log to Serial Terminal
  const rawText = data.raw_serial || JSON.stringify(data);
  appendTerminalLine("rx-data", rawText);
}

function setGasPillActive(type) {
  dom.pillSafe.classList.remove("active");
  dom.pillWarn.classList.remove("active");
  dom.pillHazard.classList.remove("active");
  if (type === "safe") dom.pillSafe.classList.add("active");
  else if (type === "warn") dom.pillWarn.classList.add("active");
  else if (type === "hazard") dom.pillHazard.classList.add("active");
}

// =============================================================
// Section 3: Offline Mock Data Generator (EXACT CODE FROM GUIDE)
// =============================================================
function startMockingData() {
  console.log("Starting offline mock data generator...");
  appendTerminalLine("system", "[MOCK] Starting offline mock data generator (500ms interval)...");

  isMocking = true;
  dom.sourceModeBadge.textContent = "OFFLINE MOCK (500ms)";
  dom.sourceDot.className = "status-dot amber pulse";
  dom.mockBtnText.textContent = "Switch to Live Socket.IO";
  dom.mockIcon.textContent = "📡";

  // Disconnect real socket if connected
  if (socket && socket.connected) {
    socket.disconnect();
  }

  mockInterval = setInterval(() => {
    // Generate random simulated data matching the Python dictionary structure
    const mockData = {
      distance: Math.floor(Math.random() * 100) + 10, // 10 to 110 cm
      gas: Math.floor(Math.random() * 500) + 200,      // 200 to 700 ppm
      touch: Math.random() > 0.5 ? "TOUCHED" : "CLEAR",
      button: Math.random() > 0.8 ? "PRESSED" : "RELEASED"
    };

    // Manually trigger the UI update function as if data arrived over the network
    updateUI(mockData);
  }, 500); // Send fake data every 500ms
}

function stopMockingData() {
  if (mockInterval) {
    clearInterval(mockInterval);
    mockInterval = null;
  }
  isMocking = false;
  dom.mockBtnText.textContent = "Switch to Offline Mock";
  dom.mockIcon.textContent = "🧪";
  console.log("Stopped offline mock data generator.");
}

// =============================================================
// Section 1 & 2: Socket.IO Live Receiver
// =============================================================
function initSocketConnection(url) {
  stopMockingData();

  if (socket) {
    socket.disconnect();
    socket = null;
  }

  TRANSMITTER_IP = url.trim().replace(/\/$/, "");
  dom.ipBadge.textContent = TRANSMITTER_IP;
  dom.sourceModeBadge.textContent = "CONNECTING...";
  dom.sourceDot.className = "status-dot amber pulse";

  appendTerminalLine("system", `[Socket.IO] Connecting to Transmitter at ${TRANSMITTER_IP}...`);

  try {
    socket = io(TRANSMITTER_IP, {
      transports: ["websocket", "polling"],
      reconnectionAttempts: 10,
      timeout: 5000
    });

    socket.on("connect", () => {
      console.log("Connected to Transmitter Socket.IO!");
      dom.sourceModeBadge.textContent = "SOCKET.IO LIVE";
      dom.sourceDot.className = "status-dot green pulse";
      appendTerminalLine("system", `[Socket.IO] Connected! Listening on 'sensor_update' event.`);
    });

    // Mandatory Broadcast Event from Integration Guide
    socket.on("sensor_update", (data) => {
      updateUI(data);
    });

    socket.on("disconnect", () => {
      dom.sourceModeBadge.textContent = "DISCONNECTED";
      dom.sourceDot.className = "status-dot red";
      appendTerminalLine("alert", `[Socket.IO] Disconnected from ${TRANSMITTER_IP}. Retrying...`);
    });

    socket.on("connect_error", (err) => {
      dom.sourceModeBadge.textContent = "OFFLINE";
      dom.sourceDot.className = "status-dot red";
    });
  } catch (err) {
    console.error("Socket.IO Init Error:", err);
    dom.sourceModeBadge.textContent = "ERROR";
  }
}

function sendDownlinkCommand(cmd) {
  if (!cmd) return;
  const cleanCmd = cmd.trim().toUpperCase();

  if (socket && socket.connected) {
    socket.emit("command", { command: cleanCmd });
    appendTerminalLine("tx-cmd", `[TX >> Arduino] ${cleanCmd}`);
  } else {
    // Fallback to HTTP POST
    fetch(`${TRANSMITTER_IP}/api/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: cleanCmd }),
    })
      .then((res) => res.json())
      .then(() => {
        appendTerminalLine("tx-cmd", `[REST >> Arduino] ${cleanCmd}`);
      })
      .catch((e) => {
        appendTerminalLine("alert", `[ERR] Command failed: ${e}`);
      });
  }
}

// =============================================================
// Real-Time Canvas Oscilloscope (60 FPS)
// =============================================================
function resizeCanvas() {
  const rect = dom.canvasContainer.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  dom.canvas.width = rect.width * dpr;
  dom.canvas.height = rect.height * dpr;
  const ctx = dom.canvas.getContext("2d");
  ctx.scale(dpr, dpr);
}

function renderCanvas() {
  const canvas = dom.canvas;
  const ctx = canvas.getContext("2d");
  const rect = dom.canvasContainer.getBoundingClientRect();
  const width = rect.width;
  const height = rect.height;

  ctx.fillStyle = "#090e1a";
  ctx.fillRect(0, 0, width, height);

  // Grid
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.04)";
  for (let i = 1; i < 5; i++) {
    const y = (height / 5) * i;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  if (chartData.length < 2) return;

  const now = chartData[chartData.length - 1].time;
  const minTime = now - timeWindowSec;
  const visible = chartData.filter((p) => p.time >= minTime);
  if (visible.length < 2) return;

  const getX = (t) => ((t - minTime) / timeWindowSec) * width;

  // Draw Distance (0 - 120 cm) in Neon Cyan
  if (selectedChannel === "both" || selectedChannel === "distance") {
    ctx.save();
    ctx.beginPath();
    ctx.strokeStyle = "#00f2fe";
    ctx.lineWidth = 2.2;
    ctx.shadowColor = "#00f2fe";
    ctx.shadowBlur = 8;
    visible.forEach((pt, i) => {
      const x = getX(pt.time);
      const y = height - ((pt.distance / 120) * (height - 30)) - 15;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.restore();
  }

  // Draw Gas (0 - 800 ppm mapped to canvas) in Neon Coral
  if (selectedChannel === "both" || selectedChannel === "gas") {
    ctx.save();
    ctx.beginPath();
    ctx.strokeStyle = "#ff7675";
    ctx.lineWidth = 2.2;
    ctx.shadowColor = "#ff7675";
    ctx.shadowBlur = 8;
    visible.forEach((pt, i) => {
      const x = getX(pt.time);
      const y = height - ((pt.gas / 800) * (height - 30)) - 15;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.restore();
  }
}

function startOscilloscopeLoop() {
  function loop() {
    renderCanvas();
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
}

// =============================================================
// Terminal & Helpers
// =============================================================
function appendTerminalLine(type, text) {
  const lineEl = document.createElement("div");
  lineEl.className = `term-line ${type}`;

  totalLines++;
  totalBytes += text.length;

  let prefix = "";
  if (dom.timestampsCheck && dom.timestampsCheck.checked) {
    const d = new Date();
    prefix = `[${d.toTimeString().split(" ")[0]}.${String(d.getMilliseconds()).padStart(3, "0")}] `;
  }

  lineEl.textContent = `${prefix}${text}`;
  dom.terminalBody.appendChild(lineEl);

  if (dom.autoscrollCheck && dom.autoscrollCheck.checked) {
    dom.terminalBody.scrollTop = dom.terminalBody.scrollHeight;
  }

  while (dom.terminalBody.childElementCount > 150) {
    dom.terminalBody.removeChild(dom.terminalBody.firstChild);
  }

  if (dom.termLineCount) dom.termLineCount.textContent = `Lines: ${totalLines}`;
  if (dom.termBytesCount) {
    const kb = (totalBytes / 1024).toFixed(1);
    dom.termBytesCount.textContent = `Bytes: ${kb} KB`;
  }
}

// =============================================================
// Event Handlers
// =============================================================
function setupEventListeners() {
  // Toggle between Offline Mock & Live Socket.IO
  dom.toggleMockBtn.addEventListener("click", () => {
    if (isMocking) {
      initSocketConnection(TRANSMITTER_IP);
    } else {
      startMockingData();
    }
  });

  // IP Handshake Modal / Banner
  dom.configIpBtn.addEventListener("click", () => {
    dom.handshakeBanner.style.display = dom.handshakeBanner.style.display === "none" ? "block" : "none";
    dom.transmitterIpInput.value = TRANSMITTER_IP;
  });

  dom.closeIpBannerBtn.addEventListener("click", () => {
    dom.handshakeBanner.style.display = "none";
  });

  dom.saveIpBtn.addEventListener("click", () => {
    const newIp = dom.transmitterIpInput.value;
    if (newIp) {
      initSocketConnection(newIp);
      dom.handshakeBanner.style.display = "none";
    }
  });

  // Channel & Window buttons
  document.querySelectorAll(".channel-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".channel-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      selectedChannel = btn.dataset.channel;
    });
  });

  document.querySelectorAll(".time-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".time-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      timeWindowSec = parseInt(btn.dataset.window, 10);
    });
  });

  // Terminal Controls
  dom.clearTerminalBtn.addEventListener("click", () => {
    dom.terminalBody.innerHTML = "";
    appendTerminalLine("system", "[SYSTEM] Terminal cleared.");
  });

  dom.copyTerminalBtn.addEventListener("click", () => {
    navigator.clipboard.writeText(dom.terminalBody.innerText).then(() => {
      dom.copyTerminalBtn.textContent = "Copied!";
      setTimeout(() => (dom.copyTerminalBtn.textContent = "Copy"), 1500);
    });
  });

  // Interactive Hardware Injectors
  dom.btnInjectTouch.addEventListener("click", () => sendDownlinkCommand("TOUCH"));
  dom.btnInjectButton.addEventListener("click", () => sendDownlinkCommand("PRESS"));
  dom.btnInjectGas.addEventListener("click", () => sendDownlinkCommand("GAS_LEAK"));
  dom.btnInjectObstacle.addEventListener("click", () => sendDownlinkCommand("OBSTACLE"));

  dom.sendCmdBtn.addEventListener("click", () => {
    const cmd = dom.customCmdInput.value;
    if (cmd) {
      sendDownlinkCommand(cmd);
      dom.customCmdInput.value = "";
    }
  });

  dom.customCmdInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const cmd = dom.customCmdInput.value;
      if (cmd) {
        sendDownlinkCommand(cmd);
        dom.customCmdInput.value = "";
      }
    }
  });

  window.addEventListener("resize", () => {
    resizeCanvas();
  });

  setInterval(() => {
    const diff = Math.floor((Date.now() - sessionStart) / 1000);
    const hrs = String(Math.floor(diff / 3600)).padStart(2, "0");
    const mins = String(Math.floor((diff % 3600) / 60)).padStart(2, "0");
    const secs = String(diff % 60).padStart(2, "0");
    dom.footerUptime.textContent = `Feed Uptime: ${hrs}:${mins}:${secs}`;
  }, 1000);
}

// Initialization
window.addEventListener("DOMContentLoaded", () => {
  resizeCanvas();
  setupEventListeners();
  startOscilloscopeLoop();

  // Connect to Transmitter via Socket.IO
  initSocketConnection(TRANSMITTER_IP);
});
