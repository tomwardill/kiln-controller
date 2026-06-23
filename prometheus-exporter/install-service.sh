#!/bin/bash
# Install the kiln-exporter systemd service. The install directory is derived
# from this script's location and the uv binary is located on PATH, so neither
# a home directory nor the uv path is hardcoded.
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UV_BIN="$(command -v uv)"
if [ -z "$UV_BIN" ]; then
    echo "error: 'uv' not found on PATH; install it first: https://docs.astral.sh/uv/" >&2
    exit 1
fi
sed -e "s#__EXPORTER_DIR__#${SCRIPT_DIR}#g" -e "s#__UV__#${UV_BIN}#g" \
    "$SCRIPT_DIR/kiln-exporter.service" \
    | sudo tee /etc/systemd/system/kiln-exporter.service > /dev/null
sudo systemctl enable kiln-exporter
