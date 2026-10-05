"""
Master Pipeline Orchestrator (run_all.py)
Starts the entire system aligned with the Frontend Workflow & Receiver Integration Guide:
  1. Arduino Uno Sensor Simulator (Virtual Serial Bridge: tcp://127.0.0.1:9000)
  2. Python Hardware Transmitter Gateway & Socket.IO Broadcast Server (Port 5000)
  3. Launches the live web feed receiver in your browser.
Cleanly shuts down all child processes on Ctrl+C.
"""

import sys
import os
import time
import subprocess
import webbrowser

PYTHON = sys.executable

def main():
    print("=" * 72)
    print("   ARDUINO SENSOR TELEMETRY & SOCKET.IO LIVE RECEIVER")
    print("   Sensors: Distance (cm), Gas (ppm), Touch, Pushbutton")
    print("=" * 72)

    processes = []

    try:
        # 1. Start Arduino Uno Simulator
        print("\n[1/2] Launching Arduino Uno Sensor Simulator (Virtual Bridge: 9000)...")
        p_arduino = subprocess.Popen(
            [PYTHON, "arduino_uno_simulator.py", "--rate", "2.0"],
            cwd=os.getcwd()
        )
        processes.append(("Arduino Uno Simulator", p_arduino))
        time.sleep(1.2)

        # 2. Start Transmitter Gateway & Socket.IO Server
        print("[2/2] Launching Hardware Transmitter & Socket.IO Broadcast Server (Port: 5000)...")
        p_tx = subprocess.Popen(
            [PYTHON, "transmitter.py", "--port", "5000"],
            cwd=os.getcwd()
        )
        processes.append(("Transmitter Gateway", p_tx))
        time.sleep(1.5)

        url = "http://127.0.0.1:5000"
        print(f"\n>> Pipeline is LIVE! Launching browser at: {url}")
        print(">> Broadcast event: 'sensor_update'")
        print(">> Press Ctrl+C anytime to stop all components.\n")
        webbrowser.open(url)

        while True:
            for name, proc in processes:
                poll = proc.poll()
                if poll is not None:
                    print(f"\n[Notice] {name} exited with code {poll}.")
            time.sleep(1)

    except KeyboardInterrupt:
        print("\n\nShutting down all telemetry processes...")
    finally:
        for name, proc in reversed(processes):
            try:
                print(f"Stopping {name} (PID: {proc.pid})...")
                proc.terminate()
                proc.wait(timeout=2)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass
        print("All processes stopped successfully. Goodbye!")

if __name__ == "__main__":
    main()
