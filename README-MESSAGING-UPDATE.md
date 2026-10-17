# ChatHub — Offline Messaging Update

This update adds a real text-message flow to the existing ChatHub React Native / Expo Android project.

## Included
- Text composer enabled in each chat.
- Text messages sent over Google Nearby Connections BYTES payloads.
- Incoming messages appended to the correct endpoint conversation.
- Per-device conversation history persisted locally with AsyncStorage.
- Timestamps, sent state, unread counts, and chat previews.
- Connection event/name mapping aligned with the Kotlin native module.
- Initiating side automatically accepts its connection handshake; the receiving side still sees and must accept the request.

## Important limits
- This is a text messaging implementation, not a complete commercial messaging product.
- Messages are persisted on each phone independently. There is no cloud sync, account system, server relay, end-to-end encryption layer designed by this project, file transfer UI, or delivery/read receipts.
- A message marked `Sent` means Nearby accepted the payload send operation; it is not a read receipt.
- Real device-to-device behavior must be verified on two Android phones. It has not been possible to run a physical-device test from this archive environment.

## Apply
1. Back up your current `D:\Chathub` project.
2. Extract this archive and merge/replace the included project files into your existing project folder. Do not replace your `android/local.properties` with another machine's file.
3. In PowerShell:
   ```powershell
   cd D:\Chathub
   npm install
   npx expo run:android
   ```
4. Keep both phones awake, install the same build on both, allow Nearby/Bluetooth permissions, and start scanning on both.
5. From one phone, tap Connect on the other. The receiving phone should accept the request in Requests. Once connected, open Chats and send a test message.

## If building a release APK
From PowerShell:
```powershell
cd D:\Chathub\android
.\gradlew assembleRelease
```
Expected APK path:
`D:\Chathub\android\app\build\outputs\apk\release\app-release.apk`

If the build fails, use the first actual `FAILURE: Build failed with an exception` section and the final error lines to diagnose it.
