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
    user_device: Option<String>,
    interviewer_device: Option<String>
) {
    println!("Starting Interview Mode (User: {:?}, Interviewer: {:?})", user_device, interviewer_device);
    
    let mut streams_vec = Vec::new();
    
    if let Some(s) = audio::start_listening(app.clone(), "user".to_string(), user_device) {
        streams_vec.push(s);
    }
    
    if let Some(s) = audio::start_listening(app.clone(), "interviewer".to_string(), interviewer_device) {
        streams_vec.push(s);
    }
    
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
    
    // Получаем все экраны и берем первый (основной)
    let screens = Screen::all();
    
    if screens.is_empty() {
        return Err("No screens found".to_string());
    }
    
    // Захватываем скриншот первого экрана
    let screen = &screens[0];
    let screenshot_image = screen.capture()
        .ok_or("Failed to capture screenshot")?;
    
    // Получаем буфер изображения
    // В версии 0.3 buffer() может возвращать уже PNG данные или сырые пиксели
    let buffer = screenshot_image.buffer();
    let width = screenshot_image.width();
    let height = screenshot_image.height();
    let expected_rgba_size = (width * height * 4) as usize;
    
    // Определяем формат данных по размеру буфера
    let png_data = if buffer.len() < expected_rgba_size {
        // Буфер меньше ожидаемого размера RGBA - вероятно, это уже сжатые данные (PNG)
        buffer.to_vec()
    } else {
        // Буфер полного размера - конвертируем RGBA в PNG
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
    
    // Конвертируем в base64
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
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            toggle_screen_share_protection,
            set_always_on_top,
            start_interview_mode,
            stop_interview_mode,
            get_audio_devices,
            capture_screenshot
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
