#!/usr/bin/env bash
#
# Package the example plugin as WordPress expects it: one folder in a zip,
# with the SDK copied inside so the plugin runs without Composer.
#
#   ./build.sh            → dist/invoice-pro-example-1.0.0.zip
#   ./build.sh 1.1.0      → sets the version in the header first
#
# Upload the zip in the back-office (Products → Invoice Pro → Upload a
# release), publish it, and every licensed site is offered it.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
plugin="invoice-pro-example"
version="${1:-$(sed -n 's/^ \* Version: *//p' "$here/$plugin/$plugin.php")}"
work="$(mktemp -d)"

cp -R "$here/$plugin" "$work/$plugin"
mkdir -p "$work/$plugin/lib/licence-app-sdk"
cp -R "$here/../../sdk/php/src" "$work/$plugin/lib/licence-app-sdk/src"
cp "$here/../../sdk/php/composer.json" "$work/$plugin/lib/licence-app-sdk/"

# The version lives in two places in the header and the boot call.
sed -i.bak -E "s/^( \* Version: *).*/\1$version/; s/('version' *=> *')[^']*'/\1$version'/" "$work/$plugin/$plugin.php"
rm "$work/$plugin/$plugin.php.bak"

mkdir -p "$here/dist"
rm -f "$here/dist/$plugin-$version.zip"
(cd "$work" && zip -qr "$here/dist/$plugin-$version.zip" "$plugin")
rm -rf "$work"

echo "$here/dist/$plugin-$version.zip"
