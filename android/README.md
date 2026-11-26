# Tara for Android

Tara's Android app is a **Trusted Web Activity**: the live site's `/keeper` page, opened full-screen in the
phone's own Chrome with Tara's icon, name and colours. Voice, "Hey Tara", sign-in and notifications behave exactly
as on the web, and every site deploy updates the app instantly (no new APK needed for site changes).

## Get it on your phone (free)

1. GitHub → **Actions** → **Tara Android app** → the latest green run → download **tara-android** (a zip).
   The workflow runs on every push that touches `android/`, or start it with **Run workflow**.
2. Unzip it on the phone and open `tara-<n>.apk`. Android asks once to allow installs from that app
   (Chrome or Files): allow it, then **Install**.
3. Open **Tara**. It needs Chrome (or another browser that supports Trusted Web Activities) on the phone.

An APK built from this project updates an installed one in place, because every build uses the same key.

## The signing key

- The key lives outside the repo, in `%USERPROFILE%\.tara-android\` (`tara-release.p12` and `password.txt`).
  **Back up both files** (a password manager is ideal). Losing them means a new key, a new `assetlinks.json`,
  and uninstalling the old app before installing the new one. The same key is what Google Play would need later.
- CI reads it from two repository secrets:
  - `TARA_ANDROID_KEYSTORE`: the contents of `keystore.base64.txt` in that folder
  - `TARA_ANDROID_KEY_PASSWORD`: the contents of `password.txt`
- Its SHA-256 fingerprint is published in `frontend/public/.well-known/assetlinks.json`. While the live site serves
  that file, the app opens with no browser bar; until then it works with a thin bar at the top.

## Publishing later (not free)

- **Google Play**: a one-time $25 developer account. Upload an Android App Bundle (`gradle bundleRelease`) signed
  with the same key. New personal accounts must run a closed test with 12 testers for 14 days first.
- **Apple App Store**: $99 a year and a Mac to build. Apple also rejects apps that only wrap a website, so an iOS
  version would need native features. On iPhone today: Safari → Share → **Add to Home Screen**.
