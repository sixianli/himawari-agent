#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
project="$repo/clients/apple/App/Himawari.xcodeproj"
work="${HIMAWARI_TESTFLIGHT_WORK:-${RUNNER_TEMP:-$repo/.testflight}}"
archive="$work/Himawari.xcarchive"

need() {
  [ -n "${!1:-}" ] || { echo "TESTFLIGHT_MISSING $1" >&2; exit 2; }
}

archive_app() {
  need APPLE_TEAM_ID
  need HIMAWARI_BUILD_NUMBER
  rm -rf "$archive"
  xcodebuild archive \
    -project "$project" \
    -scheme Himawari \
    -configuration Release \
    -destination 'generic/platform=iOS' \
    -archivePath "$archive" \
    DEVELOPMENT_TEAM="$APPLE_TEAM_ID" \
    CODE_SIGN_STYLE=Manual \
    CODE_SIGN_IDENTITY=- \
    AD_HOC_CODE_SIGNING_ALLOWED=YES \
    PROVISIONING_PROFILE_SPECIFIER= \
    HIMAWARI_RELEASE_CHANNEL=testflight \
    CURRENT_PROJECT_VERSION="$HIMAWARI_BUILD_NUMBER"
  check_entitlements
}

write_key() {
  need ASC_KEY_ID
  need ASC_KEY_P8
  key="$work/AuthKey_$ASC_KEY_ID.p8"
  (umask 077; printf '%s\n' "$ASC_KEY_P8" > "$key")
}

import_certificate() {
  need BUILD_CERTIFICATE_BASE64
  need P12_PASSWORD
  keychain="$work/signing.keychain-db"
  local keychain_password certificate
  keychain_password="$(openssl rand -hex 24)"
  certificate="$work/signing.p12"
  (umask 077; printf '%s' "$BUILD_CERTIFICATE_BASE64" | base64 --decode > "$certificate")
  security create-keychain -p "$keychain_password" "$keychain"
  security set-keychain-settings -lut 21600 "$keychain"
  security unlock-keychain -p "$keychain_password" "$keychain"
  security import "$certificate" -P "$P12_PASSWORD" -A -t cert -f pkcs12 -k "$keychain"
  security set-key-partition-list -S apple-tool:,apple: -k "$keychain_password" "$keychain" >/dev/null
  security list-keychains -d user -s "$keychain" $(security list-keychains -d user | tr -d '"')
  rm -f "$certificate"
}

cleanup_signing() {
  [ -n "${keychain:-}" ] && security delete-keychain "$keychain" 2>/dev/null || true
  [ -n "${key:-}" ] && rm -f "$key"
}

archive_signed() {
  need APPLE_TEAM_ID
  need HIMAWARI_BUILD_NUMBER
  need ASC_ISSUER_ID
  trap cleanup_signing EXIT
  import_certificate
  write_key
  rm -rf "$archive"
  xcodebuild archive \
    -project "$project" \
    -scheme Himawari \
    -configuration Release \
    -destination 'generic/platform=iOS' \
    -archivePath "$archive" \
    -allowProvisioningUpdates \
    -authenticationKeyPath "$key" \
    -authenticationKeyID "$ASC_KEY_ID" \
    -authenticationKeyIssuerID "$ASC_ISSUER_ID" \
    DEVELOPMENT_TEAM="$APPLE_TEAM_ID" \
    HIMAWARI_RELEASE_CHANNEL=testflight \
    CURRENT_PROJECT_VERSION="$HIMAWARI_BUILD_NUMBER"
  check_entitlements
  export_and_upload
}

check_entitlements() {
  local app="$archive/Products/Applications/Himawari.app"
  [ -d "$app" ] || { echo "TESTFLIGHT_NO_APP $app" >&2; exit 1; }
  while IFS= read -r bundle; do
    echo "TESTFLIGHT_BUNDLE ${bundle#"$archive/"}"
    codesign -d --entitlements - --xml "$bundle" 2>/dev/null | plutil -p - 2>/dev/null || echo "TESTFLIGHT_NO_ENTITLEMENTS"
  done < <(echo "$app"; find "$app" -mindepth 1 \( -name '*.app' -o -name '*.appex' \) -type d)
  codesign -d --entitlements - --xml "$app" 2>/dev/null | grep -q "com.apple.security.application-groups" || {
    echo "TESTFLIGHT_ENTITLEMENTS_MISSING Himawari.app has no App Group in its signature" >&2
    exit 1
  }
}

export_and_upload() {
  local options="$work/ExportOptions.plist"
  cat > "$options" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>method</key>
	<string>app-store-connect</string>
	<key>destination</key>
	<string>upload</string>
	<key>signingStyle</key>
	<string>automatic</string>
	<key>teamID</key>
	<string>$APPLE_TEAM_ID</string>
	<key>manageAppVersionAndBuildNumber</key>
	<false/>
	<key>testFlightInternalTestingOnly</key>
	<true/>
	<key>uploadSymbols</key>
	<true/>
</dict>
</plist>
PLIST
  xcodebuild -exportArchive \
    -archivePath "$archive" \
    -exportOptionsPlist "$options" \
    -exportPath "$work/export" \
    -allowProvisioningUpdates \
    -authenticationKeyPath "$key" \
    -authenticationKeyID "$ASC_KEY_ID" \
    -authenticationKeyIssuerID "$ASC_ISSUER_ID"
}

case "${1:-}" in
  archive) mkdir -p "$work"; archive_app ;;
  upload) mkdir -p "$work"; archive_signed ;;
  *) echo "usage: clients/apple/scripts/testflight.sh archive|upload" >&2; exit 2 ;;
esac
