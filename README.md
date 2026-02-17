# Interview Copilot

AI assistant for technical interviews with real-time hints, screen capture, and stealth mode.

> **Masking:** Appears as `audiodg.exe` (Windows Audio Device Graph Isolation) in Task Manager. The window is invisible during screen sharing.

---

## Features

| Feature | Description |
|---|---|
| **AI Chat** | Chat with Gemini API — ask questions, get answers with Markdown formatting |
| **Voice Hints** | Capture interviewer audio (WASAPI loopback) + your microphone → automatic hints |
| **Screenshot Analysis** | Capture screen → analyze via Gemini Vision (code, tasks, questions) |
| **Ghost Mode** | Window is invisible during Screen Share (`WDA_EXCLUDEFROMCAPTURE`) |
| **Stealth Cursor** | Cursor does not change shape when hovering over the window (stealth during sharing) |
| **Always on Top** | Window stays on top of other windows |
| **Persistent Settings** | API key, model, and settings adhere across sessions |

---

## Technologies

- **Frontend:** React 19 · TypeScript · Vite · Framer Motion · Lucide Icons
- **Backend:** Rust · Tauri 2
- **Audio:** cpal (WASAPI loopback on Windows)
- **AI:** Google Gemini API (text + vision + audio)

---

## Requirements

### All Platforms
- [Node.js](https://nodejs.org/) ≥ 18
- [Rust](https://rustup.rs/) ≥ 1.77
- [Tauri CLI](https://v2.tauri.app/start/prerequisites/) — installed via npm

### Windows (Primary Platform)
- Windows 10/11
- [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) (or Visual Studio with "Desktop development with C++" component)
- WebView2 (pre-installed on Windows 10 2004+)

### macOS
- Xcode Command Line Tools (`xcode-select --install`)
- macOS 10.15+

### Linux
- System libraries:
  ```bash
  # Ubuntu/Debian
  sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
    libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev \
    libasound2-dev  # for cpal (audio handling)
  ```

---

## Quick Start

### 1. Clone the repository

```bash
git clone https://github.com/your-user/ai-helper.git
cd ai-helper
```

### 2. Install dependencies

```bash
# Node.js dependencies (frontend)
npm install
```

> Rust dependencies (backend) will download automatically during the first build via Cargo.

### 3. Run in development mode

```bash
npm run tauri dev
```

This starts:
- Vite dev server (hot reload for frontend)
- Rust backend with automatic recompilation

> **First run** takes 3–5 minutes (compiling Rust dependencies). Subsequent runs take ~10 seconds.

### 4. Configure the app

1. Go to the **Settings** tab
2. Paste your **Google Gemini API Key** ([get it here](https://aistudio.google.com/apikey))
3. Select a model (recommended: `Gemini 2.0 Flash`)
4. Select audio devices:
   - **My Microphone** — your microphone
   - **Interviewer Source** — select your headphones/speakers (WASAPI loopback will capture audio from Zoom/Meet)

---

## Build (Production)

### Windows (.exe / .msi)

```bash
npm run tauri build
```

Output files location:
```
src-tauri/target/release/
├── audiodg.exe              ← Portable executable
└── bundle/
    ├── msi/audiodg_0.1.0_x64_en-US.msi    ← MSI installer
    └── nsis/audiodg_0.1.0_x64-setup.exe    ← NSIS installer
```

### macOS (.app / .dmg)

```bash
npm run tauri build
```

Output files location:
```
src-tauri/target/release/bundle/
├── macos/audiodg.app
└── dmg/audiodg_0.1.0_x64.dmg
```

### Linux (.deb / .AppImage)

```bash
npm run tauri build
```

Output files location:
```
src-tauri/target/release/bundle/
├── deb/audiodg_0.1.0_amd64.deb
└── appimage/audiodg_0.1.0_amd64.AppImage
```

---

## Useful Commands

| Command | Description |
|---|---|
| `npm run tauri dev` | Run in dev mode with hot reload |
| `npm run tauri build` | Build production bundle |
| `npm run dev` | Run frontend only (without Tauri) |
| `npm run build` | Build frontend only |
| `cargo check` | Check Rust code without compiling (in `src-tauri/`) |
| `cargo build --release` | Build Rust backend only (in `src-tauri/`) |

---

## Project Structure

```
ai-helper/
├── index.html                  # HTML entry point
├── package.json                # Node.js dependencies and scripts
├── vite.config.ts              # Vite configuration
├── tsconfig.json               # TypeScript configuration
│
├── src/                        # Frontend (React)
│   ├── main.tsx                # React entry point
│   ├── App.tsx                 # Main component (Chat, Voice, Settings)
│   ├── App.css                 # Component styles
│   └── index.css               # Design system (tokens, reset)
│
└── src-tauri/                  # Backend (Rust / Tauri)
    ├── Cargo.toml              # Rust dependencies
    ├── tauri.conf.json         # Tauri configuration (name, window, bundle)
    ├── capabilities/           # App permissions (HTTP, store)
    └── src/
        ├── main.rs             # Entry point (hides console in release)
        ├── lib.rs              # Tauri commands (screenshot, audio, window)
        └── audio.rs            # WASAPI loopback capture + WAV encoding
```

---

## How Interviewer Audio Capture Works

On Windows, **WASAPI loopback capture** is used via the `cpal` library:

1. User selects an output device (headphones/speakers) in Settings.
2. `cpal` calls `build_input_stream()` on this output device.
3. WASAPI automatically activates **loopback mode** — capturing all audio playing through that device.
4. Audio is buffered (~3 sec), converted to WAV, and sent to Gemini API.
5. AI analyzes speech and generates hints.

> **Important:** To capture audio from Zoom/Meet, select the **output device** through which you hear the interviewer.

---

## Troubleshooting

### "Interviewer audio stream failed"
- Ensure the correct output device is selected in Settings.
- If a device with "Loopback" in its name exists, select it.
- Restart the app after changing audio devices.

### "No models loaded"
- Check your API Key in Settings.
- Ensure the key has access to the Gemini API.

### First build is very slow
- This is normal — Cargo downloads and compiles ~200 Rust dependencies.
- Subsequent builds use cache and take ~10 seconds.

---

## License

Private project. All rights reserved.
