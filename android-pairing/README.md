# Android pairing bridge

This tool advertises the **Cloudflare Soloist player** on your Wi-Fi and forwards the Spotify app's initial ZeroConf authentication requests over HTTPS. It does not run Soloist or play music on Android. No Soloist API key is entered on Android, and the private link is kept only in memory.

This is an experimental relay. Spotify documents direct LAN pairing, but does not document this Cloudflare relay. Real Android-to-Cloudflare Spotify pairing and playback have not been verified with a Premium account.

## Before starting

1. Apply the repository overlay and redeploy the Worker and Container.
2. On the web client, log in with QR, open **Server playback**, and save your personal Soloist API key.
3. Select **Start server player**. Wait for **Waiting for Android pairing**, then choose **Create Android pairing link**.
4. Install Termux from its official F-Droid or GitHub distribution. Android 13 is supported by Termux; the bridge has not been tested on a physical Galaxy Note20 Ultra.
5. Extract this ZIP into Downloads. Allow Termux access to Downloads once:

```sh
termux-setup-storage
```

## Run

Open the extracted folder in Downloads. If its name is `spotify-soloist-android-bridge`, run:

```sh
cd ~/storage/downloads/spotify-soloist-android-bridge
bash start.sh
```

If the file manager created an extra enclosing folder, use `cd` to enter the folder containing `start.sh` and `bridge.py` instead. Python installs automatically the first time; no pip packages, root, or Debian installation are needed.

Paste the private Android pairing link at the hidden prompt. Confirm the Android phone's **Wi-Fi IPv4 address**. If automatic detection picks a mobile-data or VPN address, replace it with the address shown in Android's Wi-Fi connection details.

Open Spotify on the same Android phone, or on an iPhone connected to the same Wi-Fi. Select the **Spotify Cloud Player …** device. Keep Termux running while authentication completes. The bridge stops after Cloudflare saves the native session and restarts Soloist. Subsequent cloud starts restore that session; Android is only needed again if the stored session is revoked, deleted, or cannot be restored.

Return to the web client, choose a track, and press **Enable audio**. iPad audio comes from your Cloudflare site.

## Troubleshooting

- **No cloud device in Spotify:** make sure the Wi-Fi address is correct, both apps are on the same Wi-Fi, and the router does not isolate Wi-Fi clients. Disable a VPN while pairing. Android multicast discovery and the official app may behave differently between devices; try the iPhone Spotify app on the same Wi-Fi while the Android bridge remains running.
- **`soloist_connect_discovery_failed`:** Soloist's Connect HTTP interface was not discovered inside the Container. The Android bridge cannot fix this failure; copy the web client's server report.
- **Another account cannot pair:** the relay accepts only the Spotify account already linked to the web client's QR session.
- **Expired link:** choose **Create a new Android pairing link** and rerun the bridge. Links expire after at most 20 minutes and close after a successful pairing.
- **Still no sound:** copy the web client's server report. Successful Web API access, pairing, and actual audio are separate checks.

Keep pairing links and Soloist API keys private. The tool does not log request bodies, headers, or credentials. Do not expose its LAN port to the internet.
