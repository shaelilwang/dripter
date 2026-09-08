#!/usr/bin/env bash
# Build a distributable zip — just the extension, no tests or dev scaffolding.
set -euo pipefail
cd "$(dirname "$0")"
out="article-drip.zip"
rm -f "$out"
zip -r -q "$out" manifest.json src ui README.md \
  -x '*.DS_Store' -x '__MACOSX/*'
echo "wrote $out ($(du -h "$out" | cut -f1))"
echo "unzip anywhere, then chrome://extensions -> Load unpacked"
