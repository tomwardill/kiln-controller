# kiln-controller Prometheus exporter

A standalone Prometheus exporter for [kiln-controller](../README.md). It runs as
a separate process and needs **no changes to kiln-controller itself**.

It connects to the kiln-controller `/status` WebSocket, keeps the most recent
oven state in memory, and exposes it as Prometheus metrics on `/metrics`. The
WebSocket pushes a full state payload roughly once per second (the oven's
`time_step`) whether or not a firing is in progress, so the metrics always
reflect the latest thermocouple reading.

## Run

Like the rest of the project, the exporter runs under [uv](https://docs.astral.sh/uv/).
Its dependencies are declared inline in `kiln_exporter.py` (PEP 723), so uv
fetches them automatically on first run — no manual install step:

```bash
cd prometheus-exporter
uv run kiln_exporter.py --kiln-url ws://localhost:8081/status --port 9090
```

Point `--kiln-url` at your kiln-controller host (it listens on `listening_port`,
`8081` by default). Then scrape `http://<exporter-host>:9090/metrics`.

> A `requirements.txt` is also provided for non-uv setups
> (`pip install -r requirements.txt` then `./kiln_exporter.py ...`).

### Run on boot (systemd)

```bash
cd prometheus-exporter
./install-service.sh
sudo systemctl start kiln-exporter
```

`install-service.sh` substitutes the real install path and the `uv` binary
location into `kiln-exporter.service` (neither a home directory nor the uv path
is hardcoded), copies it to `/etc/systemd/system/`, and enables it. The unit
runs the exporter with `uv run kiln_exporter.py`, so uv resolves the inline
dependencies on start. Edit the `Environment=` lines in `kiln-exporter.service`
before installing if your kiln is not on `localhost:8081`.

### Configuration

All flags can also be set via environment variables:

| Flag                | Env var            | Default                       |
|---------------------|--------------------|-------------------------------|
| `--kiln-url`        | `KILN_URL`         | `ws://localhost:8081/status`  |
| `--port`            | `EXPORTER_PORT`    | `9090`                        |
| `--reconnect-delay` | `RECONNECT_DELAY`  | `5`                           |
| `--log-level`       | `LOG_LEVEL`        | `INFO`                        |

## Metrics

| Metric                                 | Description                                       |
|----------------------------------------|---------------------------------------------------|
| `kiln_temperature`                     | Current temperature (configured temp scale)       |
| `kiln_target_temperature`              | Target/setpoint temperature                       |
| `kiln_heat`                            | Heating element duty cycle for the last step (0-1)|
| `kiln_heat_rate`                       | Rate of temperature change                        |
| `kiln_runtime_seconds`                 | Elapsed runtime of the current profile            |
| `kiln_totaltime_seconds`               | Total length of the current profile               |
| `kiln_cost`                            | Estimated energy cost of the current run          |
| `kiln_kwh_rate`                        | Configured cost per kWh                           |
| `kiln_catching_up`                     | 1 if the oven is catching up to the profile       |
| `kiln_state`                           | Oven state enum (`IDLE`/`RUNNING`/`PAUSED`)        |
| `kiln_pid_*`                           | PID internals (setpoint, ispoint, err, p, i, d, …)|
| `kiln_connected`                       | 1 if connected to the kiln WebSocket              |
| `kiln_last_update_timestamp_seconds`   | Unix time of the last state message received      |
| `kiln_messages_total`                  | Total state messages received (counter)           |

The `kiln_pid_*` gauges only carry meaningful values once a firing has started
(before that, kiln-controller has no PID stats to report).

## Example Prometheus scrape config

```yaml
scrape_configs:
  - job_name: kiln
    static_configs:
      - targets: ["localhost:9090"]
```
