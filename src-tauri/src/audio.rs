use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::sync::{Arc, Mutex};
use base64::{Engine as _, engine::general_purpose};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

#[derive(Serialize, Clone)]
pub struct AudioPayload {
    pub speaker: String,
    pub data: String,
    pub amplitude: i16,
}

#[derive(Serialize, Clone)]
pub struct DeviceInfo {
    pub name: String,
    pub is_input: bool,
}

pub struct InterviewStreams(pub Arc<Mutex<Option<Vec<cpal::Stream>>>>);
unsafe impl Send for InterviewStreams {}
unsafe impl Sync for InterviewStreams {}

pub fn get_audio_devices() -> Vec<DeviceInfo> {
    let host = cpal::default_host();
    let mut devices = Vec::new();
    
    if let Ok(input_devices) = host.input_devices() {
        for d in input_devices {
            if let Ok(name) = d.name() {
                // On Windows with WASAPI, loopback capture endpoints are exposed as input
                // devices whose names typically contain "loopback". For our UI we want
                // to treat them as playback sources so they show up under "Interviewer Source".
                let is_loopback = name.to_lowercase().contains("loopback");
                devices.push(DeviceInfo {
                    name,
                    // real microphones: is_input = true, loopbacks: is_input = false
                    is_input: !is_loopback,
                });
            }
        }
    }
    
    if let Ok(output_devices) = host.output_devices() {
        for d in output_devices {
            if let Ok(name) = d.name() {
                devices.push(DeviceInfo { name, is_input: false });
            }
        }
    }
    devices
}

pub fn start_listening(app: AppHandle, speaker_type: String, target_device_name: Option<String>) -> Option<cpal::Stream> {
    let host = cpal::default_host();
    
    // Try to resolve the exact device by name first (if provided), preferring input-capable
    // devices so that loopback inputs are picked over plain outputs when both exist.
    let device = if let Some(ref name) = target_device_name {
        // Prefer input devices (this covers loopback endpoints on Windows)
        if let Ok(inputs) = host.input_devices() {
            if let Some(d) = inputs
                .into_iter()
                .find(|d| d.name().ok().as_ref() == Some(name))
            {
                Some(d)
            } else {
                // Fall back to any device with the same name (input or output)
                host.devices()
                    .ok()?
                    .into_iter()
                    .find(|d| d.name().ok().as_ref() == Some(name))
            }
        } else {
            host.devices()
                .ok()?
                .into_iter()
                .find(|d| d.name().ok().as_ref() == Some(name))
        }
    } else {
        if speaker_type == "interviewer" {
            host.default_output_device()
        } else {
            host.default_input_device()
        }
    }?;

    let device_name = device.name().unwrap_or_default();
    println!("[Audio] Capturing '{}' for {}", device_name, speaker_type);

    // Важно: для Output устройств на Windows CPAL автоматически пробует Loopback
    let config = match device.default_input_config() {
        Ok(c) => c,
        Err(_) => {
            // Если дефолтный инпут конфиг не сработал, пробуем взять из аутпута (если поддерживается)
            match device.default_output_config() {
                Ok(c) => c.into(),
                Err(e) => {
                    eprintln!("[Audio] Device '{}' configuration error: {}", device_name, e);
                    return None;
                }
            }
        }
    };

    let sample_rate = config.sample_rate().0;
    let channels = config.channels();
    let app_handle = Arc::new(app);
    let speaker = speaker_type.clone();
    let buffer = Arc::new(Mutex::new(Vec::<i16>::new()));

    let stream = match config.sample_format() {
        cpal::SampleFormat::F32 => {
            device.build_input_stream(
                &config.into(),
                move |data: &[f32], _| {
                    let mut buf = buffer.lock().unwrap();
                    let mut max_v = 0i16;
                    for &sample in data {
                        let converted = (sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
                        buf.push(converted);
                        if converted.abs() > max_v { max_v = converted.abs(); }
                    }
                    check_and_send_buffer(&mut buf, sample_rate, channels, &app_handle, &speaker, max_v);
                },
                |e| eprintln!("Stream error: {}", e),
                None
            )
        },
        cpal::SampleFormat::I16 => {
            device.build_input_stream(
                &config.into(),
                move |data: &[i16], _| {
                    let mut buf = buffer.lock().unwrap();
                    let mut max_v = 0i16;
                    for &s in data {
                        buf.push(s);
                        if s.abs() > max_v { max_v = s.abs(); }
                    }
                    check_and_send_buffer(&mut buf, sample_rate, channels, &app_handle, &speaker, max_v);
                },
                |e| eprintln!("Stream error: {}", e),
                None
            )
        },
        _ => return None,
    }.ok()?;

    stream.play().ok()?;
    Some(stream)
}

fn check_and_send_buffer(buf: &mut Vec<i16>, sample_rate: u32, channels: u16, app: &Arc<AppHandle>, speaker: &str, current_amp: i16) {
    let limit = sample_rate as usize * channels as usize * 3;
    
    if buf.len() > limit {
        let pcm_data = std::mem::take(buf);
        let max_amp = pcm_data.iter().map(|x| x.abs()).max().unwrap_or(0);
        
        if max_amp > 100 { 
            let wav_data = create_wav_data(sample_rate, channels, &pcm_data);
            let b64 = general_purpose::STANDARD.encode(wav_data);
            let _ = app.emit("audio-chunk", AudioPayload {
                speaker: speaker.to_string(),
                data: b64,
                amplitude: max_amp,
            });
        } else {
            let _ = app.emit("audio-chunk", AudioPayload {
                speaker: speaker.to_string(),
                data: "".to_string(),
                amplitude: current_amp,
            });
        }
    } else {
        // Каждые ~200мс обновляем индикатор в UI
        if buf.len() % 8000 == 0 {
            let _ = app.emit("audio-chunk", AudioPayload {
                speaker: speaker.to_string(),
                data: "".to_string(),
                amplitude: current_amp,
            });
        }
    }
}

fn create_wav_data(sample_rate: u32, channels: u16, samples: &[i16]) -> Vec<u8> {
    let spec = hound::WavSpec {
        channels,
        sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut cursor = std::io::Cursor::new(Vec::new());
    {
        let mut writer = hound::WavWriter::new(&mut cursor, spec).unwrap();
        for &s in samples {
            writer.write_sample(s).unwrap();
        }
    }
    cursor.into_inner()
}
