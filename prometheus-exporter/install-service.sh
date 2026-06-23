#!/bin/bash
# Install the kiln-exporter systemd service, deriving the install directory
# from this script's location so no home directory is hardcoded.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
sed "s#__EXPORTER_DIR__#${SCRIPT_DIR}#g" "$SCRIPT_DIR/kiln-exporter.service" \
    | sudo tee /etc/systemd/system/kiln-exporter.service > /dev/null
sudo systemctl enable kiln-exporter
