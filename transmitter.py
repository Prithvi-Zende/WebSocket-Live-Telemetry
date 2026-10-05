"""
Python Hardware Transmitter Gateway & Socket.IO Broadcast Server
Implements Section 1 & 2 of the Frontend Workflow & Receiver Integration Guide:
  1. Ingests real or simulated serial stream from Arduino Uno (Virtual Socket 9000 or COM port).
  2. Detects and prints local Wi-Fi IP address for the IP Handshake (e.g. http://192.168.1.100:5000).
  3. Broadcasts the 'sensor_update' event with {distance, gas, touch, button} to all connected Socket.IO clients.
  4. Serves the web feed dashboard directly on port 5000 with CORS enabled for independent frontend dev servers (Vite/Webpack/React).
"""

import sys
import os
import time
import json
import socket
import argparse
import threading
import logging
from flask import Flask, send_from_directory, jsonify, request
from flask_socketio import SocketIO, emit

try:
    import serial
    HAS_PYSERIAL = True
except ImportError:
    HAS_PYSERIAL = False

# Configure Flask & Socket.IO
app = Flask(__name__, static_folder="static", static_url_path="")
app.config["SECRET_KEY"] = "arduino-telemetry-secret"

# Enable CORS for all origins so external Vite / React / Webpack servers can connect freely
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")

# Disable verbose HTTP logs to keep transmitter feed clean
log = logging.getLogger("werkzeug")
log.setLevel(logging.ERROR)

# Global Telemetry State
latest_sensor_data = {
    "distance": 0,
    "gas": 0,
    "touch": "CLEAR",
    "button": "RELEASED"
}

# Downlink queue for commands sent from web to Arduino RX
downlink_commands = []
lock = threading.Lock()


def get_local_ip() -> str:
    """Detects active local Wi-Fi / LAN IP address for IP Handshake."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
    except Exception:
        ip = "127.0.0.1"
    finally:
        s.close()
    return ip


# -------------------------------------------------------------
# Flask Web Routes
# -------------------------------------------------------------
@app.route("/")
def index():
    return send_from_directory("static", "index.html")


@app.route("/<path:path>")
def static_files(path):
    return send_from_directory("static", path)


@app.route("/api/sensors")
def api_sensors():
    """REST endpoint to fetch the latest sensor reading."""
    with lock:
        return jsonify(latest_sensor_data)


@app.route("/api/command", methods=["POST"])
def api_command():
    data = request.get_json(force=True, silent=True) or {}
    cmd = data.get("command", "")
    if cmd:
        with lock:
            downlink_commands.append(cmd)
        return jsonify({"success": True, "command": cmd})
    return jsonify({"error": "No command provided"}), 400


# -------------------------------------------------------------
# Socket.IO Event Handlers
# -------------------------------------------------------------
@socketio.on("connect")
def handle_connect():
    print(f"\n[Transmitter Socket.IO] Frontend client connected (Client SID: {request.sid})")
    # Send current state immediately upon connection
    with lock:
        emit("sensor_update", latest_sensor_data)


@socketio.on("disconnect")
def handle_disconnect():
    print(f"\n[Transmitter Socket.IO] Frontend client disconnected (Client SID: {request.sid})")


@socketio.on("command")
def handle_command_event(data):
    cmd = data if isinstance(data, str) else data.get("command", "")
    if cmd:
        print(f"[Transmitter RX from Web] Downlink command: {cmd}")
        with lock:
            downlink_commands.append(cmd)


# -------------------------------------------------------------
# Arduino Serial Ingestion Worker
# -------------------------------------------------------------
class SerialIngestionWorker(threading.Thread):
    def __init__(self, serial_port: str = None, baud: int = 115200, socket_host: str = "127.0.0.1", socket_port: int = 9000):
        super().__init__(daemon=True)
        self.serial_port = serial_port
        self.baud = baud
        self.socket_host = socket_host
        self.socket_port = socket_port
        self.running = True
        self.serial_conn = None
        self.sock_conn = None
        self.packet_count = 0

    def connect(self) -> bool:
        if self.serial_port and HAS_PYSERIAL:
            try:
                print(f"[Transmitter] Connecting to COM port: {self.serial_port} at {self.baud} baud...")
                self.serial_conn = serial.Serial(self.serial_port, self.baud, timeout=0.1)
                print(f"[Transmitter] Connected to Hardware Serial: {self.serial_port}")
                return True
            except Exception as e:
                print(f"[Transmitter] Could not connect to {self.serial_port}: {e}. Retrying virtual socket...")

        # Virtual Socket Bridge
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.settimeout(2.0)
            sock.connect((self.socket_host, self.socket_port))
            sock.settimeout(None)
            self.sock_conn = sock
            print(f"[Transmitter] Connected to Arduino Virtual Serial on tcp://{self.socket_host}:{self.socket_port}")
            return True
        except Exception:
            return False

    def send_downlink_to_arduino(self, cmd: str):
        if not cmd.endswith("\n"):
            cmd += "\n"
        data = cmd.encode("utf-8")
        try:
            if self.serial_conn and self.serial_conn.is_open:
                self.serial_conn.write(data)
            elif self.sock_conn:
                self.sock_conn.sendall(data)
            print(f"[Transmitter >> Arduino] Relayed command: {cmd.strip()}")
        except Exception as e:
            print(f"[Transmitter] Downlink error: {e}")

    def run(self):
        buffer = ""

        while self.running:
            if not self.serial_conn and not self.sock_conn:
                if not self.connect():
                    time.sleep(1.5)
                    continue

            try:
                # 1. Process any pending downlink commands
                with lock:
                    cmds_to_send = list(downlink_commands)
                    downlink_commands.clear()
                for c in cmds_to_send:
                    self.send_downlink_to_arduino(c)

                # 2. Read incoming serial bytes
                raw_chunk = ""
                if self.serial_conn:
                    data = self.serial_conn.read(256)
                    raw_chunk = data.decode("utf-8", errors="ignore")
                elif self.sock_conn:
                    data = self.sock_conn.recv(512)
                    if not data:
                        raise ConnectionResetError("Virtual serial socket closed")
                    raw_chunk = data.decode("utf-8", errors="ignore")

                if not raw_chunk:
                    time.sleep(0.01)
                    continue

                buffer += raw_chunk
                while "\n" in buffer:
                    line, buffer = buffer.split("\n", 1)
                    line = line.strip()
                    if not line:
                        continue

                    if line.startswith("{") and line.endswith("}"):
                        try:
                            payload = json.loads(line)
                            # Ensure exact fields expected by frontend integration guide:
                            data_to_broadcast = {
                                "distance": int(payload.get("distance", 0)),
                                "gas": int(payload.get("gas", 0)),
                                "touch": str(payload.get("touch", "CLEAR")),
                                "button": str(payload.get("button", "RELEASED")),
                                "raw_serial": line,
                                "timestamp": payload.get("timestamp", time.time())
                            }

                            with lock:
                                latest_sensor_data.update(data_to_broadcast)

                            # Broadcast 'sensor_update' event to all connected Socket.IO clients!
                            socketio.emit("sensor_update", data_to_broadcast)
                            self.packet_count += 1

                            # Print live status
                            t_color = "\033[32m" if data_to_broadcast["touch"] == "TOUCHED" else "\033[90m"
                            b_color = "\033[33m" if data_to_broadcast["button"] == "PRESSED" else "\033[90m"
                            sys.stdout.write(
                                f"\r\033[32m[TX LIVE #{self.packet_count:05d}]\033[0m "
                                f"Distance: \033[1m{data_to_broadcast['distance']:3d} cm\033[0m | "
                                f"Gas: \033[35m{data_to_broadcast['gas']:3d} ppm\033[0m | "
                                f"Touch: {t_color}{data_to_broadcast['touch']:7s}\033[0m | "
                                f"Button: {b_color}{data_to_broadcast['button']:8s}\033[0m"
                            )
                            sys.stdout.flush()

                        except json.JSONDecodeError:
                            pass

            except Exception as e:
                print(f"\n[Transmitter] Serial connection lost ({e}). Reconnecting...")
                if self.sock_conn:
                    try:
                        self.sock_conn.close()
                    except Exception:
                        pass
                    self.sock_conn = None
                if self.serial_conn:
                    try:
                        self.serial_conn.close()
                    except Exception:
                        pass
                    self.serial_conn = None
                time.sleep(2.0)


def main():
    parser = argparse.ArgumentParser(description="Arduino Telemetry Transmitter & Socket.IO Server")
    parser.add_argument("--port", "-p", default=5000, type=int, help="HTTP / Socket.IO port (default: 5000)")
    parser.add_argument("--serial-port", default=None, help="Physical COM port (e.g. COM3). Defaults to socket bridge.")
    parser.add_argument("--baud", default=115200, type=int, help="Baud rate (default: 115200)")
    parser.add_argument("--socket-port", default=9000, type=int, help="Virtual serial bridge port (default: 9000)")

    args = parser.parse_args()

    local_ip = get_local_ip()

    print("=" * 72)
    print("   HARDWARE TRANSMITTER & SOCKET.IO BROADCAST GATEWAY")
    print("=" * 72)
    print(f"  [1. IP Handshake] Provide this address to the Frontend Team:")
    print(f"      LOCAL WI-FI IP:     http://{local_ip}:{args.port}")
    print(f"      LOOPBACK IP:        http://127.0.0.1:{args.port}")
    print(f"  [2. Event Broadcast]:   'sensor_update'")
    print(f"  [3. Payload Schema]:    {{distance: cm, gas: ppm, touch: str, button: str}}")
    print(f"  [4. Built-in Web UI]:   http://{local_ip}:{args.port}")
    print("=" * 72)

    # Start serial worker
    worker = SerialIngestionWorker(
        serial_port=args.serial_port,
        baud=args.baud,
        socket_host="127.0.0.1",
        socket_port=args.socket_port
    )
    worker.start()

    # Start Socket.IO Web Server on 0.0.0.0:5000
    try:
        socketio.run(app, host="0.0.0.0", port=args.port, allow_unsafe_werkzeug=True)
    except KeyboardInterrupt:
        print("\n[Transmitter] Shutting down...")
    finally:
        worker.running = False


if __name__ == "__main__":
    main()
