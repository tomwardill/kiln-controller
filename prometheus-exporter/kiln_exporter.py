#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.9"
# dependencies = [
#     "prometheus_client>=0.17",
#     "websocket-client>=1.0",
# ]
# ///
"""
Standalone Prometheus exporter for kiln-controller.

Connects to the kiln-controller `/status` WebSocket, keeps the most recent
oven state in memory, and exposes it as Prometheus metrics on /metrics.

The WebSocket pushes a full state payload roughly once per second (the oven's
time_step) regardless of whether a firing is in progress, so the exported
metrics always reflect the latest reading.

Dependencies are declared inline (PEP 723), so uv fetches them on first run:
    uv run kiln_exporter.py --kiln-url ws://localhost:8081/status --port 9090

All options can also be set via environment variables (see --help).
"""

import argparse
import json
import logging
import os
import threading
import time

import websocket
from prometheus_client import start_http_server, Gauge, Enum, Counter

log = logging.getLogger("kiln-exporter")

# Possible oven states reported by kiln-controller.
OVEN_STATES = ["IDLE", "RUNNING", "PAUSED"]

# ---------------------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------------------
TEMPERATURE = Gauge("kiln_temperature", "Current kiln temperature (configured temp scale)")
TARGET = Gauge("kiln_target_temperature", "Target/setpoint temperature (configured temp scale)")
HEAT = Gauge("kiln_heat", "Heating element duty cycle for the last step (0-1)")
HEAT_RATE = Gauge("kiln_heat_rate", "Rate of temperature change (degrees per time_scale_slope)")
RUNTIME = Gauge("kiln_runtime_seconds", "Elapsed runtime of the current profile in seconds")
TOTALTIME = Gauge("kiln_totaltime_seconds", "Total length of the current profile in seconds")
COST = Gauge("kiln_cost", "Estimated energy cost of the current run")
KWH_RATE = Gauge("kiln_kwh_rate", "Configured cost per kWh")
CATCHING_UP = Gauge("kiln_catching_up", "1 if the oven is catching up to the profile, else 0")

STATE = Enum("kiln_state", "Current oven state", states=OVEN_STATES)

# PID controller internals (present once a run has started).
PID = {
    name: Gauge("kiln_pid_%s" % name, "PID controller '%s' value" % name)
    for name in ["setpoint", "ispoint", "err", "errDelta", "p", "i", "d",
                 "kp", "ki", "kd", "pid", "out"]
}

# Exporter health.
LAST_UPDATE = Gauge("kiln_last_update_timestamp_seconds",
                    "Unix time of the last state message received from the kiln")
CONNECTED = Gauge("kiln_connected", "1 if the exporter is connected to the kiln WebSocket, else 0")
MESSAGES = Counter("kiln_messages_total", "Total number of state messages received")


def _set(gauge, value):
    """Set a gauge only when the value is numeric (ignore None/strings)."""
    if isinstance(value, bool):
        gauge.set(1 if value else 0)
    elif isinstance(value, (int, float)):
        gauge.set(value)


def update_metrics(state):
    """Map a kiln-controller state dict onto Prometheus metrics."""
    _set(TEMPERATURE, state.get("temperature"))
    _set(TARGET, state.get("target"))
    _set(HEAT, state.get("heat"))
    _set(HEAT_RATE, state.get("heat_rate"))
    _set(RUNTIME, state.get("runtime"))
    _set(TOTALTIME, state.get("totaltime"))
    _set(COST, state.get("cost"))
    _set(KWH_RATE, state.get("kwh_rate"))
    _set(CATCHING_UP, state.get("catching_up"))

    oven_state = state.get("state")
    if oven_state in OVEN_STATES:
        STATE.state(oven_state)

    pidstats = state.get("pidstats") or {}
    for name, gauge in PID.items():
        _set(gauge, pidstats.get(name))

    LAST_UPDATE.set_to_current_time()
    MESSAGES.inc()


# ---------------------------------------------------------------------------
# WebSocket client
# ---------------------------------------------------------------------------
def on_message(ws, message):
    try:
        state = json.loads(message)
    except (ValueError, TypeError):
        log.debug("ignoring non-JSON message: %r", message)
        return

    # The /status socket also emits a "backlog" payload on connect; the
    # per-tick state messages are flat dicts with a "temperature" key.
    if not isinstance(state, dict) or "temperature" not in state:
        return

    update_metrics(state)


def on_error(ws, error):
    log.warning("websocket error: %s", error)


def on_close(ws, status_code, msg):
    CONNECTED.set(0)
    log.info("websocket closed (%s %s)", status_code, msg)


def on_open(ws):
    CONNECTED.set(1)
    log.info("connected to kiln")


def run_forever(url, reconnect_delay):
    """Maintain a WebSocket connection, reconnecting on failure."""
    while True:
        try:
            ws = websocket.WebSocketApp(
                url,
                on_open=on_open,
                on_message=on_message,
                on_error=on_error,
                on_close=on_close,
            )
            ws.run_forever(ping_interval=30, ping_timeout=10)
        except Exception as e:  # noqa: BLE001 - keep the loop alive
            log.warning("websocket loop error: %s", e)
        CONNECTED.set(0)
        log.info("reconnecting in %ss", reconnect_delay)
        time.sleep(reconnect_delay)


def parse_args():
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--kiln-url",
                   default=os.environ.get("KILN_URL", "ws://localhost:8081/status"),
                   help="kiln-controller /status WebSocket URL "
                        "(env KILN_URL, default ws://localhost:8081/status)")
    p.add_argument("--port", type=int,
                   default=int(os.environ.get("EXPORTER_PORT", "9090")),
                   help="port to serve /metrics on (env EXPORTER_PORT, default 9090)")
    p.add_argument("--reconnect-delay", type=int,
                   default=int(os.environ.get("RECONNECT_DELAY", "5")),
                   help="seconds to wait before reconnecting (env RECONNECT_DELAY, default 5)")
    p.add_argument("--log-level",
                   default=os.environ.get("LOG_LEVEL", "INFO"),
                   help="logging level (env LOG_LEVEL, default INFO)")
    return p.parse_args()


def main():
    args = parse_args()
    logging.basicConfig(level=args.log_level.upper(),
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    CONNECTED.set(0)
    start_http_server(args.port)
    log.info("serving metrics on :%d/metrics", args.port)
    log.info("polling kiln at %s", args.kiln_url)

    # start_http_server runs in its own thread; drive the websocket here.
    run_forever(args.kiln_url, args.reconnect_delay)


if __name__ == "__main__":
    main()
