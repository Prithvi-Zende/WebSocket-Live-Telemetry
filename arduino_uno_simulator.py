"""
Arduino Uno Serial Data Simulator
Simulates an Arduino Uno connected to:
  1. Ultrasonic Distance Sensor (HC-SR04): 10 to 110 cm
  2. Gas Sensor (MQ-2 / MQ-135): 200 to 700 ppm
  3. Capacitive Touch Sensor (TTP223): "TOUCHED" or "CLEAR"
  4. Digital Pushbutton: "PRESSED" or "RELEASED"

Streams serial JSON telemetry matching the Frontend Integration Guide specifications.
Supports Virtual Serial Socket Bridge (default tcp://127.0.0.1:9000) or real COM port.
"""

import sys
import time
import math
import random
import socket
import argparse
import json
import threading

try:
    import serial
    HAS_PYSERIAL = True
except ImportError:
    HAS_PYSERIAL = False


class SensorSuite:
    """Physics and event simulation for the 4 hardware sensors."""

    def __init__(self):
        # 1. Ultrasonic Distance (10 to 110 cm)
        self.distance = 45.0
        self.target_distance = 45.0
        self.obstacle_active = False

        # 2. Gas Sensor (200 to 700 ppm)
        self.gas_base = 320.0
        self.gas_level = 320.0
        self.gas_surge = 0.0

        # 3. Capacitive Touch Sensor ("TOUCHED" or "CLEAR")
        self.touch_state = "CLEAR"
        self.touch_until = 0.0

        # 4. Pushbutton ("PRESSED" or "RELEASED")
        self.button_state = "RELEASED"
        self.button_until = 0.0

        self.last_update = time.time()

    def update(self) -> dict:
        now = time.time()
        dt = max(0.01, min(0.5, now - self.last_update))
        self.last_update = now

        # --- Ultrasonic Distance Simulation ---
        # Smoothly wanders between 15 and 95 cm unless an obstacle is triggered
        if self.obstacle_active:
            self.target_distance = 12.0
            if random.random() < 0.05:
                self.obstacle_active = False
        else:
            if random.random() < 0.08:
                self.target_distance = random.uniform(15.0, 95.0)

        # Smooth inertia approach to target distance
        self.distance += (self.target_distance - self.distance) * (dt * 2.5) + random.gauss(0, 0.4)
        dist_out = int(round(max(10, min(110, self.distance))))

        # --- Gas Sensor Simulation ---
        # Baseline 250 - 450 ppm, with smooth drift and decay of any surge
        self.gas_surge *= math.exp(-dt / 6.0)
        self.gas_base += random.gauss(0, 1.2)
        self.gas_base = max(220.0, min(480.0, self.gas_base))
        gas_calc = self.gas_base + self.gas_surge + random.gauss(0, 2.5)
        gas_out = int(round(max(200, min(700, gas_calc))))

        # --- Touch Sensor Simulation ---
        # Occasional random human touch interaction or persistent if manual trigger
        if now < self.touch_until:
            self.touch_state = "TOUCHED"
        else:
            if random.random() < 0.04:
                # 4% chance of a 1.2-second touch event
                self.touch_until = now + random.uniform(0.8, 1.6)
                self.touch_state = "TOUCHED"
            else:
                self.touch_state = "CLEAR"

        # --- Button Simulation ---
        # Occasional momentary button click
        if now < self.button_until:
            self.button_state = "PRESSED"
        else:
            if random.random() < 0.03:
                # 3% chance of a short 0.4-second press
                self.button_until = now + random.uniform(0.3, 0.6)
                self.button_state = "PRESSED"
            else:
                self.button_state = "RELEASED"

        return {
            "distance": dist_out,
            "gas": gas_out,
            "touch": self.touch_state,
            "button": self.button_state
        }

    def trigger_touch(self, duration: float = 2.0):
        self.touch_until = time.time() + duration
        self.touch_state = "TOUCHED"

    def trigger_button(self, duration: float = 1.0):
        self.button_until = time.time() + duration
        self.button_state = "PRESSED"

    def trigger_gas_leak(self, delta: float = 300.0):
        self.gas_surge += delta

    def trigger_obstacle(self):
        self.obstacle_active = True
        self.target_distance = 12.0


class ArduinoUnoSimulator:
    def __init__(self, port: str = None, baud: int = 115200, socket_port: int = 9000, sample_hz: float = 2.0):
        self.port = port
        self.baud = baud
        self.socket_port = socket_port
        self.sample_hz = max(0.5, min(50.0, sample_hz))
        self.running = False
        self.seq_number = 0
        self.sensors = SensorSuite()

        self.serial_conn = None
        self.server_socket = None
        self.client_sockets = []
        self.lock = threading.Lock()

    def build_serial_line(self, readings: dict) -> str:
        self.seq_number += 1
        # Payload matching the exact Python dictionary structure from the Integration Guide:
        payload = {
            "distance": readings["distance"],
            "gas": readings["gas"],
            "touch": readings["touch"],
            "button": readings["button"],
            "seq": self.seq_number,
            "timestamp": round(time.time(), 3)
        }
        return json.dumps(payload) + "\r\n"

    def process_rx_command(self, cmd: str) -> str:
        cmd = cmd.strip().upper()
        if not cmd:
            return ""

        print(f"\n[Arduino RX] << {cmd}")

        if cmd == "PING":
            return "PONG\r\n"
        elif cmd in ("TOUCH", "TRIGGER_TOUCH"):
            self.sensors.trigger_touch(2.5)
            return "OK:TOUCH_TRIGGERED\r\n"
        elif cmd in ("PRESS", "BUTTON", "CLICK"):
            self.sensors.trigger_button(1.5)
            return "OK:BUTTON_PRESSED\r\n"
        elif cmd in ("GAS", "GAS_LEAK", "SPIKE_GAS"):
            self.sensors.trigger_gas_leak(280.0)
            return "OK:GAS_LEAK_SIMULATED\r\n"
        elif cmd in ("OBSTACLE", "NEAR"):
            self.sensors.trigger_obstacle()
            return "OK:OBSTACLE_DETECTED\r\n"
        elif cmd.startswith("RATE:"):
            try:
                hz = float(cmd.split(":")[1])
                self.sample_hz = max(0.5, min(50.0, hz))
                return f"OK:RATE_{self.sample_hz:.1f}HZ\r\n"
            except Exception as e:
                return f"ERR:RATE_{e}\r\n"
        return f"ERR:UNKNOWN_{cmd}\r\n"

    def _socket_listener_thread(self):
        self.server_socket.listen(5)
        print(f"[Arduino Simulator] Virtual Serial Bridge listening on tcp://127.0.0.1:{self.socket_port}")

        while self.running:
            try:
                client_sock, addr = self.server_socket.accept()
                print(f"[Arduino Simulator] Transmitter connected from {addr[0]}:{addr[1]}")
                with self.lock:
                    self.client_sockets.append(client_sock)

                rx_t = threading.Thread(target=self._client_rx_thread, args=(client_sock,), daemon=True)
                rx_t.start()
            except Exception:
                break

    def _client_rx_thread(self, client_sock):
        buffer = ""
        while self.running:
            try:
                data = client_sock.recv(512)
                if not data:
                    break
                buffer += data.decode("utf-8", errors="ignore")
                while "\n" in buffer:
                    line, buffer = buffer.split("\n", 1)
                    resp = self.process_rx_command(line)
                    if resp:
                        client_sock.sendall(resp.encode("utf-8"))
            except Exception:
                break

        with self.lock:
            if client_sock in self.client_sockets:
                self.client_sockets.remove(client_sock)
        try:
            client_sock.close()
        except Exception:
            pass

    def start(self):
        self.running = True

        if self.port and HAS_PYSERIAL:
            try:
                print(f"[Arduino Simulator] Opening physical COM port: {self.port} at {self.baud} baud...")
                self.serial_conn = serial.Serial(self.port, self.baud, timeout=0.1)
                print(f"[Arduino Simulator] Connected to {self.port}")
            except Exception as e:
                print(f"[Arduino Simulator] Could not open COM port {self.port}: {e}")
                self.serial_conn = None

        if not self.serial_conn:
            self.server_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            self.server_socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            self.server_socket.bind(("127.0.0.1", self.socket_port))
            listener_t = threading.Thread(target=self._socket_listener_thread, daemon=True)
            listener_t.start()

        print("=" * 68)
        print("  ARDUINO UNO SENSOR SIMULATOR ACTIVE")
        print("  Sensors: Distance (HC-SR04), Gas (MQ), Touch (TTP223), Button")
        print(f"  Streaming at: {self.sample_hz} Hz ({int(1000/self.sample_hz)}ms interval)")
        print(f"  Interface: {'COM ' + self.port if self.serial_conn else 'Virtual Serial Socket (Port ' + str(self.socket_port) + ')'}")
        print("=" * 68)

        try:
            while self.running:
                readings = self.sensors.update()
                line = self.build_serial_line(readings)
                line_bytes = line.encode("utf-8")

                # Send to physical serial
                if self.serial_conn and self.serial_conn.is_open:
                    try:
                        self.serial_conn.write(line_bytes)
                        if self.serial_conn.in_waiting > 0:
                            rx = self.serial_conn.readline().decode("utf-8", errors="ignore")
                            resp = self.process_rx_command(rx)
                            if resp:
                                self.serial_conn.write(resp.encode("utf-8"))
                    except Exception as e:
                        print(f"[Arduino] Serial error: {e}")

                # Broadcast to virtual serial socket clients (Transmitter)
                with self.lock:
                    dead = []
                    for s in self.client_sockets:
                        try:
                            s.sendall(line_bytes)
                        except Exception:
                            dead.append(s)
                    for d in dead:
                        self.client_sockets.remove(d)

                # Terminal log
                touch_color = "\033[32m" if readings["touch"] == "TOUCHED" else "\033[90m"
                btn_color = "\033[33m" if readings["button"] == "PRESSED" else "\033[90m"
                sys.stdout.write(
                    f"\r\033[36m[UNO TX #{self.seq_number:05d}]\033[0m "
                    f"Distance: \033[1m{readings['distance']:3d} cm\033[0m | "
                    f"Gas: \033[35m{readings['gas']:3d} ppm\033[0m | "
                    f"Touch: {touch_color}{readings['touch']:7s}\033[0m | "
                    f"Button: {btn_color}{readings['button']:8s}\033[0m"
                )
                sys.stdout.flush()

                time.sleep(1.0 / self.sample_hz)

        except KeyboardInterrupt:
            print("\n[Arduino Simulator] Stopping...")
        finally:
            self.stop()

    def stop(self):
        self.running = False
        if self.serial_conn:
            try:
                self.serial_conn.close()
            except Exception:
                pass
        with self.lock:
            for s in self.client_sockets:
                try:
                    s.close()
                except Exception:
                    pass
            self.client_sockets.clear()
        if self.server_socket:
            try:
                self.server_socket.close()
            except Exception:
                pass
        print("[Arduino Simulator] Stopped.")


def main():
    parser = argparse.ArgumentParser(description="Arduino Uno Sensor Data Simulator")
    parser.add_argument("--port", "-p", default=None, help="Physical COM port (e.g. COM3). Defaults to Virtual Serial Socket.")
    parser.add_argument("--baud", "-b", type=int, default=115200, help="Baud rate (default: 115200)")
    parser.add_argument("--socket-port", type=int, default=9000, help="Virtual serial port (default: 9000)")
    parser.add_argument("--rate", "-r", type=float, default=2.0, help="Packet rate in Hz (default: 2.0 = 500ms)")

    args = parser.parse_args()

    sim = ArduinoUnoSimulator(
        port=args.port,
        baud=args.baud,
        socket_port=args.socket_port,
        sample_hz=args.rate
    )
    sim.start()


if __name__ == "__main__":
    main()
