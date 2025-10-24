#!/usr/bin/env bash
# Example commands for HAP/VideoToolbox transcoding.
set -euo pipefail

echo "HAP encode example"
echo "gst-launch-1.0 gltestsrc ! videoconvert ! avenc_hap ! qtmux ! filesink location=out_hap.mov"

echo "H.264 low-latency encode example"
echo "gst-launch-1.0 gltestsrc ! videoconvert ! vtenc_h264 realtime=true allow-frame-reordering=false ! mp4mux ! filesink location=out_h264.mp4"
