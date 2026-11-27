#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
project="$repo/clients/apple/App/Himawari.xcodeproj"
work="${HIMAWARI_MAC_RELEASE_WORK:-${RUNNER_TEMP:-$repo/.mac-release}}"
archive="$work/HimawariMac.xcarchive"
packages="$work/packages"
export_dir="$work/export"
app_name="HimawariMac.app"

need() {
  [ -n "${!1:-}" ] || { echo "MAC_RELEASE_MISSING $1" >&2; exit 2; }
}

cleanup() {
  [ -n "${key:-}" ] && rm -f "$key"
  [ -n "${keychain:-}" ] && security delete-keychain "$keychain" 2>/dev/null || true
  [ -n "${p12:-}" ] && rm -f "$p12"
}

archive_app() {
  need APPLE_TEAM_ID
  need HIMAWARI_BUILD_NUMBER
  need HIMAWARI_UPDATE_FEED
  need HIMAWARI_UPDATE_KEY
  rm -rf "$archive"
  xcodebuild archive \
    -project "$project" \
    -scheme HimawariMac \
    -configuration Release \
    -destination 'generic/platform=macOS' \
    -archivePath "$archive" \
    -clonedSourcePackagesDirPath "$packages" \
    DEVELOPMENT_TEAM="$APPLE_TEAM_ID" \
    CODE_SIGN_STYLE=Manual \
    CODE_SIGN_IDENTITY=- \
    PROVISIONING_PROFILE_SPECIFIER= \
    CURRENT_PROJECT_VERSION="$HIMAWARI_BUILD_NUMBER" \
    HIMAWARI_UPDATE_FEED="$HIMAWARI_UPDATE_FEED" \
    HIMAWARI_UPDATE_KEY="$HIMAWARI_UPDATE_KEY"
  check_archive
}

check_archive() {
  local app="$archive/Products/Applications/$app_name"
  [ -d "$app" ] || { echo "MAC_RELEASE_NO_APP $app" >&2; exit 1; }
  [ -d "$app/Contents/Frameworks/Sparkle.framework" ] || {
    echo "MAC_RELEASE_NO_SPARKLE Sparkle.framework is not embedded, so the app could not update itself" >&2
    exit 1
  }
  local feed
  feed="$(/usr/libexec/PlistBuddy -c 'Print :SUFeedURL' "$app/Contents/Info.plist")"
  [ "$feed" = "$HIMAWARI_UPDATE_FEED" ] || { echo "MAC_RELEASE_FEED_MISMATCH $feed" >&2; exit 1; }
  local edkey
  edkey="$(/usr/libexec/PlistBuddy -c 'Print :SUPublicEDKey' "$app/Contents/Info.plist")"
  [ "$edkey" = "$HIMAWARI_UPDATE_KEY" ] || { echo "MAC_RELEASE_KEY_MISMATCH" >&2; exit 1; }
}

import_certificate() {
  need MAC_DEVELOPER_ID_P12
  need MAC_DEVELOPER_ID_P12_PASSWORD
  keychain="$work/release.keychain-db"
  local password
  password="$(uuidgen)"
  p12="$work/developer-id.p12"
  (umask 077; printf '%s' "$MAC_DEVELOPER_ID_P12" | base64 --decode > "$p12")
  security create-keychain -p "$password" "$keychain"
  security set-keychain-settings -lut 3600 "$keychain"
  security unlock-keychain -p "$password" "$keychain"
  security import "$p12" -k "$keychain" -P "$MAC_DEVELOPER_ID_P12_PASSWORD" -T /usr/bin/codesign -T /usr/bin/security
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$password" "$keychain" >/dev/null
  security list-keychains -d user -s "$keychain" $(security list-keychains -d user | tr -d '"')
  rm -f "$p12"
  security find-identity -v -p codesigning "$keychain" | grep -q "Developer ID Application" || {
    echo "MAC_RELEASE_NO_DEVELOPER_ID the p12 holds no Developer ID Application identity" >&2
    exit 1
  }
}

write_key() {
  need ASC_KEY_ID
  need ASC_KEY_P8
  need ASC_ISSUER_ID
  key="$work/AuthKey_$ASC_KEY_ID.p8"
  (umask 077; printf '%s\n' "$ASC_KEY_P8" > "$key")
}

export_app() {
  local options="$work/ExportOptions.plist"
  cat > "$options" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>method</key>
	<string>developer-id</string>
	<key>destination</key>
	<string>export</string>
	<key>signingStyle</key>
	<string>automatic</string>
	<key>teamID</key>
	<string>$APPLE_TEAM_ID</string>
</dict>
</plist>
PLIST
  rm -rf "$export_dir"
  xcodebuild -exportArchive \
    -archivePath "$archive" \
    -exportOptionsPlist "$options" \
    -exportPath "$export_dir" \
    -allowProvisioningUpdates \
    -authenticationKeyPath "$key" \
    -authenticationKeyID "$ASC_KEY_ID" \
    -authenticationKeyIssuerID "$ASC_ISSUER_ID"
  codesign --verify --deep --strict --verbose=2 "$export_dir/$app_name"
  codesign -dvv "$export_dir/$app_name" 2>&1 | grep -q "Authority=Developer ID Application" || {
    echo "MAC_RELEASE_NOT_DEVELOPER_ID exported app is not signed with Developer ID" >&2
    exit 1
  }
}

submit_for_notarization() {
  local upload="$work/notarize.zip"
  rm -f "$upload"
  ditto -c -k --keepParent "$export_dir/$app_name" "$upload"
  local submitted
  submitted="$(xcrun notarytool submit "$upload" \
    --key "$key" \
    --key-id "$ASC_KEY_ID" \
    --issuer "$ASC_ISSUER_ID" \
    --output-format json)"
  rm -f "$upload"
  submission="$(printf '%s' "$submitted" | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"
  echo "MAC_RELEASE_SUBMITTED $submission"
}

notary_status() {
  xcrun notarytool info "$submission" \
    --key "$key" \
    --key-id "$ASC_KEY_ID" \
    --issuer "$ASC_ISSUER_ID" \
    --output-format json | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin)["status"])'
}

wait_briefly() {
  local deadline=$((SECONDS + ${HIMAWARI_NOTARY_WAIT_SECONDS:-900}))
  local status
  while :; do
    status="$(notary_status)"
    echo "MAC_RELEASE_NOTARY_STATUS $status"
    case "$status" in
      Accepted) return 0 ;;
      Invalid|Rejected)
        xcrun notarytool log "$submission" --key "$key" --key-id "$ASC_KEY_ID" --issuer "$ASC_ISSUER_ID" || true
        echo "MAC_RELEASE_NOTARY_REJECTED $submission" >&2
        exit 1
        ;;
    esac
    [ "$SECONDS" -lt "$deadline" ] || return 1
    sleep 30
  done
}

staple_app() {
  xcrun stapler staple "$export_dir/$app_name"
  spctl --assess --type execute --verbose=2 "$export_dir/$app_name"
}

park_pending() {
  local pending="$work/pending"
  rm -rf "$pending"
  mkdir -p "$pending"
  ditto -c -k --sequesterRsrc --keepParent "$export_dir/$app_name" "$pending/app.zip"
  printf '%s\n' "$submission" > "$pending/submission-id"
  printf '%s\n' "$HIMAWARI_BUILD_NUMBER" > "$pending/build-number"
  echo "pending=$pending" >> "${GITHUB_OUTPUT:-/dev/null}"
  echo "MAC_RELEASE_PARKED $submission build $HIMAWARI_BUILD_NUMBER"
}

resolve_packages() {
  xcodebuild -resolvePackageDependencies \
    -project "$project" \
    -scheme HimawariMac \
    -clonedSourcePackagesDirPath "$packages"
}

package_update() {
  need SPARKLE_PRIVATE_KEY
  need HIMAWARI_RELEASE_BASE
  need HIMAWARI_BUILD_NUMBER
  local version
  version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$export_dir/$app_name/Contents/Info.plist")"
  local minimum
  minimum="$(/usr/libexec/PlistBuddy -c 'Print :LSMinimumSystemVersion' "$export_dir/$app_name/Contents/Info.plist")"
  local zip_name="Himawari-$version-$HIMAWARI_BUILD_NUMBER.zip"
  local zip="$work/$zip_name"
  rm -f "$zip"
  ditto -c -k --sequesterRsrc --keepParent "$export_dir/$app_name" "$zip"
  local sign_update="$packages/artifacts/sparkle/Sparkle/bin/sign_update"
  [ -x "$sign_update" ] || { echo "MAC_RELEASE_NO_SIGN_UPDATE $sign_update" >&2; exit 1; }
  local signature
  signature="$(printf '%s' "$SPARKLE_PRIVATE_KEY" | "$sign_update" --ed-key-file - "$zip")"
  case "$signature" in
    *'sparkle:edSignature="'*'length="'*) ;;
    *) echo "MAC_RELEASE_BAD_SIGNATURE" >&2; exit 1 ;;
  esac
  cat > "$work/appcast.xml" <<XML
<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
  <channel>
    <title>Himawari</title>
    <item>
      <title>$version ($HIMAWARI_BUILD_NUMBER)</title>
      <pubDate>$(LC_ALL=C date -u '+%a, %d %b %Y %H:%M:%S +0000')</pubDate>
      <sparkle:version>$HIMAWARI_BUILD_NUMBER</sparkle:version>
      <sparkle:shortVersionString>$version</sparkle:shortVersionString>
      <sparkle:minimumSystemVersion>$minimum</sparkle:minimumSystemVersion>
      <enclosure url="$HIMAWARI_RELEASE_BASE/mac-$HIMAWARI_BUILD_NUMBER/$zip_name" type="application/octet-stream" $signature />
    </item>
  </channel>
</rss>
XML
  xmllint --noout "$work/appcast.xml"
  echo "zip=$zip" >> "${GITHUB_OUTPUT:-/dev/null}"
  echo "zip_name=$zip_name" >> "${GITHUB_OUTPUT:-/dev/null}"
  echo "appcast=$work/appcast.xml" >> "${GITHUB_OUTPUT:-/dev/null}"
  echo "version=$version" >> "${GITHUB_OUTPUT:-/dev/null}"
}

release() {
  trap cleanup EXIT
  archive_app
  import_certificate
  write_key
  export_app
  submit_for_notarization
  if wait_briefly; then
    staple_app
    package_update
    echo "notarized=true" >> "${GITHUB_OUTPUT:-/dev/null}"
  else
    park_pending
    echo "notarized=false" >> "${GITHUB_OUTPUT:-/dev/null}"
  fi
}

finish() {
  need HIMAWARI_PENDING_DIR
  [ -f "$HIMAWARI_PENDING_DIR/app.zip" ] || { echo "MAC_RELEASE_NO_PENDING $HIMAWARI_PENDING_DIR" >&2; exit 1; }
  HIMAWARI_BUILD_NUMBER="$(tr -d '[:space:]' < "$HIMAWARI_PENDING_DIR/build-number")"
  export HIMAWARI_BUILD_NUMBER
  echo "build=$HIMAWARI_BUILD_NUMBER" >> "${GITHUB_OUTPUT:-/dev/null}"
  rm -rf "$export_dir"
  mkdir -p "$export_dir"
  ditto -x -k "$HIMAWARI_PENDING_DIR/app.zip" "$export_dir"
  resolve_packages
  staple_app
  package_update
}

case "${1:-}" in
  release) mkdir -p "$work"; release ;;
  finish) mkdir -p "$work"; finish ;;
  *) echo "usage: clients/apple/scripts/mac-release.sh release|finish" >&2; exit 2 ;;
esac
