#!/usr/bin/env bash
# Quick sanity check for required GStreamer plugins.
set -euo pipefail

gst-inspect-1.0 vtenc_h264 glshader ndisrc avdec_hap
