#!/bin/sh
# Regenerates assets/icon.ico from assets/icon.png (1024x1024), the sizes
# Windows uses for the taskbar, Explorer, and the installer.
# Replace assets/icon.png and run: npm run make:ico
# Needs ImageMagick 7 (brew install imagemagick).
set -e
cd "$(dirname "$0")/.."

magick assets/icon.png -define icon:auto-resize=256,128,64,48,32,16 assets/icon.ico
echo "wrote assets/icon.ico"
