# Movabi Native Build Checklist

This project is prepared for Capacitor Android and iOS builds.

## Android

Local build requirements:

- JDK 21 must be installed and `JAVA_HOME` should point to it. The current Gradle/Capacitor Android toolchain can fail on Java 8 or 17.
- Android SDK Platform 35 is currently used by this repo. `android/local.properties` should point to the local SDK, for example:
  ```properties
  sdk.dir=C\:\\Program Files (x86)\\Android\\android-sdk
  ```
- If you want to move back to SDK 36 later, install Android SDK Platform 36 and accept the Android SDK license in Android Studio SDK Manager first.

1. Build and sync:
   ```powershell
   npm run native:sync
   ```

2. Debug APK:
   ```powershell
   npm run android:debug
   ```

3. Release AAB:
   ```powershell
   $env:MOVABI_ANDROID_KEYSTORE="C:\secure\movabi-release.jks"
   $env:MOVABI_ANDROID_KEYSTORE_PASSWORD="..."
   $env:MOVABI_ANDROID_KEY_ALIAS="movabi"
   $env:MOVABI_ANDROID_KEY_PASSWORD="..."
   npm run android:release
   ```

4. Required private files:
   - `android/app/google-services.json` for Firebase push notifications.
   - Release keystore stored outside the repo.

## iOS

Run this on macOS with Xcode installed:

```bash
npm run ios:sync
npm run cap:open:ios
```

Then in Xcode:

1. Select the `App` target.
2. Set Team to the Apple Developer account.
3. Keep bundle identifier as `com.movabi.app`.
4. Add capabilities:
   - Push Notifications
   - Background Modes: Remote notifications
5. Add `GoogleService-Info.plist` to `ios/App/App` if Firebase push is enabled.
6. Archive with `Product > Archive`.

## Store Certificates Needed

- Apple Developer Program membership.
- iOS Distribution certificate and provisioning profile for `com.movabi.app`.
- Android upload key or Play App Signing key.
- Firebase Android app config: `google-services.json`.
- Firebase iOS app config: `GoogleService-Info.plist`.

Do not commit certificates, profiles, keystores, or Firebase private platform files.
