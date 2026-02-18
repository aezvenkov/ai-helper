use tauri::{Manager, Runtime, Window, State};
use window_vibrancy::apply_blur;
use std::sync::{Arc, Mutex};

mod audio;
use audio::{InterviewStreams, DeviceInfo};

#[tauri::command]
fn get_audio_devices() -> Vec<DeviceInfo> {
    audio::get_audio_devices()
}

#[tauri::command]
fn set_always_on_top<R: Runtime>(window: Window<R>, enabled: bool) {
    window.set_always_on_top(enabled).unwrap();
}

#[tauri::command]
fn set_window_opacity<R: Runtime>(window: Window<R>, opacity: f64) {
    #[cfg(windows)]
    {
        use winapi::um::winuser::{
            GetWindowLongW, SetWindowLongW, GWL_EXSTYLE,
            SetLayeredWindowAttributes, LWA_ALPHA,
        };
        use winapi::um::dwmapi::DwmExtendFrameIntoClientArea;
        use winapi::um::uxtheme::MARGINS;
        const WS_EX_LAYERED: i32 = 0x00080000;

        let clamped = opacity.max(0.1).min(1.0);
        let alpha = (clamped * 255.0) as u8;
        let hwnd = window.hwnd().unwrap().0 as winapi::shared::windef::HWND;

        unsafe {
            let ex_style = GetWindowLongW(hwnd, GWL_EXSTYLE);

            if clamped < 1.0 {
                // Add WS_EX_LAYERED if not already set
                if ex_style & WS_EX_LAYERED == 0 {
                    SetWindowLongW(hwnd, GWL_EXSTYLE, ex_style | WS_EX_LAYERED);
                }
                SetLayeredWindowAttributes(hwnd, 0, alpha, LWA_ALPHA);
            } else {
                // Remove WS_EX_LAYERED for full performance
                SetWindowLongW(hwnd, GWL_EXSTYLE, ex_style & !WS_EX_LAYERED);
                // Re-extend frame for blur/transparency to work
                let margins = MARGINS { cxLeftWidth: -1, cxRightWidth: -1, cyTopHeight: -1, cyBottomHeight: -1 };
                DwmExtendFrameIntoClientArea(hwnd, &margins);
            }
        }
    }
}

#[tauri::command]
fn toggle_screen_share_protection<R: Runtime>(window: Window<R>, enabled: bool) {
    #[cfg(windows)]
    {
        use winapi::um::winuser::{SetWindowDisplayAffinity, WDA_NONE};
        const WDA_EXCLUDEFROMCAPTURE: u32 = 0x00000011;
        let hwnd = window.hwnd().unwrap();
        let affinity = if enabled { WDA_EXCLUDEFROMCAPTURE } else { WDA_NONE };
        unsafe {
            SetWindowDisplayAffinity(hwnd.0 as _, affinity);
        }
    }
}

#[tauri::command]
fn start_interview_mode(
    app: tauri::AppHandle, 
    state: State<'_, InterviewStreams>,
    interviewer_device: Option<String>
) {
    println!("═══════════════════════════════════════════");
    println!("[Interview] Starting Interview Mode (interviewer only)");
    println!("[Interview] Interviewer device: {:?}", interviewer_device);
    println!("═══════════════════════════════════════════");
    
    let mut streams_vec = Vec::new();
    
    match audio::start_listening(app.clone(), "interviewer".to_string(), interviewer_device) {
        Some(s) => {
            println!("[Interview] ✓ Interviewer audio stream started (loopback)");
            streams_vec.push(s);
        }
        None => {
            eprintln!("[Interview] ✗ Failed to start interviewer audio stream");
            eprintln!("[Interview]   Hint: On Windows, select an output device (speakers/headphones)");
            eprintln!("[Interview]   for the interviewer source. WASAPI will use loopback capture.");
        }
    }
    
    println!("[Interview] Active streams: {}", streams_vec.len());
    
    let mut streams = state.0.lock().unwrap();
    *streams = Some(streams_vec);
}


#[tauri::command]
fn stop_interview_mode(state: State<'_, InterviewStreams>) {
    println!("Stopping Interview Mode...");
    let mut streams = state.0.lock().unwrap();
    *streams = None; 
}

#[tauri::command]
async fn capture_screenshot<R: Runtime>(_window: Window<R>) -> Result<String, String> {
    use base64::{Engine as _, engine::general_purpose};
    use screenshots::Screen;
    use image::{ImageEncoder, codecs::png::PngEncoder, ExtendedColorType};
    
    let screens = Screen::all();
    
    if screens.is_empty() {
        return Err("No screens found".to_string());
    }
    
    let screen = &screens[0];
    let screenshot_image = screen.capture()
        .ok_or("Failed to capture screenshot")?;
    
    let buffer = screenshot_image.buffer();
    let width = screenshot_image.width();
    let height = screenshot_image.height();
    let expected_rgba_size = (width * height * 4) as usize;
    
    let png_data = if buffer.len() < expected_rgba_size {
        buffer.to_vec()
    } else {
        let mut png_vec = Vec::new();
        {
            let encoder = PngEncoder::new(&mut png_vec);
            encoder.write_image(
                &buffer,
                width,
                height,
                ExtendedColorType::Rgba8,
            ).map_err(|e| format!("Failed to encode PNG: {}", e))?;
        }
        png_vec
    };
    
    let base64_image = general_purpose::STANDARD.encode(&png_data);
    Ok(base64_image)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let streams = InterviewStreams(Arc::new(Mutex::new(None)));

    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .manage(streams)
        .setup(|app| {
            let window = app.get_webview_window("main").unwrap();
            #[cfg(target_os = "windows")]
            {
                apply_blur(&window, Some((18, 18, 18, 125)))
                    .expect("Unsupported platform!");

                // Hide from Alt+Tab by setting WS_EX_TOOLWINDOW style
                use winapi::um::winuser::{GetWindowLongW, SetWindowLongW, GWL_EXSTYLE, WS_EX_TOOLWINDOW, WS_EX_APPWINDOW};
                let hwnd = window.hwnd().unwrap().0 as winapi::shared::windef::HWND;
                unsafe {
                    let ex_style = GetWindowLongW(hwnd, GWL_EXSTYLE);
                    let new_style = (ex_style | WS_EX_TOOLWINDOW as i32) & !(WS_EX_APPWINDOW as i32);
                    SetWindowLongW(hwnd, GWL_EXSTYLE, new_style);
                }
            }

            // Register Alt+1 global shortcut to toggle window visibility
            #[cfg(desktop)]
            {
                use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
                use tauri::Manager;

                let toggle_shortcut = Shortcut::new(Some(Modifiers::ALT), Code::Digit1);

                app.handle().plugin(
                    tauri_plugin_global_shortcut::Builder::new()
                        .with_handler(move |app, shortcut, event| {
                            if shortcut == &toggle_shortcut && event.state() == ShortcutState::Pressed {
                                if let Some(win) = app.get_webview_window("main") {
                                    if win.is_minimized().unwrap_or(false) {
                                        // Window is minimized — restore it
                                        let _ = win.unminimize();
                                        let _ = win.show();
                                        let _ = win.set_focus();
                                    } else if win.is_visible().unwrap_or(false) {
                                        let _ = win.hide();
                                    } else {
                                        let _ = win.show();
                                        let _ = win.set_focus();
                                    }
                                }
                            }
                        })
                        .build(),
                )?;

                app.global_shortcut().register(
                    Shortcut::new(Some(Modifiers::ALT), Code::Digit1)
                )?;

                println!("[Hotkey] Alt+1 registered: toggle window visibility");
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            toggle_screen_share_protection,
            set_always_on_top,
            set_window_opacity,
            start_interview_mode,
            stop_interview_mode,
            get_audio_devices,
            capture_screenshot
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
