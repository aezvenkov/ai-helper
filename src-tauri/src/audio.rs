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

/// Enumerate all audio devices. Output devices are marked with is_input = false
/// so they appear under "Interviewer Source" in the UI. Loopback inputs are
/// also marked is_input = false for the same reason.
pub fn get_audio_devices() -> Vec<DeviceInfo> {
    let host = cpal::default_host();
    let mut devices = Vec::new();
    let mut seen_names = std::collections::HashSet::new();

    // Input devices (microphones + WASAPI loopback endpoints)
    if let Ok(input_devices) = host.input_devices() {
        for d in input_devices {
            if let Ok(name) = d.name() {
                if seen_names.contains(&name) { continue; }
                seen_names.insert(name.clone());
                let is_loopback = name.to_lowercase().contains("loopback");
                devices.push(DeviceInfo {
                    name,
                    is_input: !is_loopback,
                });
            }
        }
    }

    // Output devices (speakers, headphones) — these can be used for loopback capture
    if let Ok(output_devices) = host.output_devices() {
        for d in output_devices {
            if let Ok(name) = d.name() {
                if seen_names.contains(&name) { continue; }
                seen_names.insert(name.clone());
                devices.push(DeviceInfo { name, is_input: false });
            }
        }
    }
    devices
}

/// Start capturing audio from a device.
///
/// For the "interviewer" speaker type we attempt loopback capture:
/// 1.  First look up the device by name among **all** available devices.
///     On Windows/WASAPI, output devices support `build_input_stream` which
///     transparently activates loopback mode.
/// 2.  Try `default_input_config()` first (works for real input devices and
///     some loopback endpoints).  If that fails, try `supported_input_configs()`
///     to find any workable configuration.
/// 3.  If the device is purely an output device where `build_input_stream`
///     fails, we still try — WASAPI should handle it.
pub fn start_listening(app: AppHandle, speaker_type: String, target_device_name: Option<String>) -> Option<cpal::Stream> {
    let host = cpal::default_host();

    // ──── Resolve device ────
    let device = resolve_device(&host, &speaker_type, target_device_name.as_deref())?;

    let device_name = device.name().unwrap_or_else(|_| "unknown".into());
    println!("[Audio] Attempting capture on '{}' for '{}'", device_name, speaker_type);

    // ──── Resolve input config ────
    // For loopback capture (interviewer), the device may be an output device.
    // On WASAPI, cpal transparently supports build_input_stream on output devices.
    let config = resolve_input_config(&device, &device_name)?;

    let sample_rate = config.sample_rate().0;
    let channels = config.channels();

    println!(
        "[Audio] Config for '{}': {}Hz, {} ch, {:?}",
        device_name, sample_rate, channels, config.sample_format()
    );

    let app_handle = Arc::new(app);
    let speaker = speaker_type.clone();
    let buffer = Arc::new(Mutex::new(Vec::<i16>::new()));

    let stream = build_capture_stream(
        &device,
        &config,
        buffer,
        sample_rate,
        channels,
        app_handle,
        speaker,
        &device_name,
    )?;

    stream.play().ok()?;
    println!("[Audio] ✓ Stream playing for '{}' on '{}'", speaker_type, device_name);
    Some(stream)
}

/// Find the right device to capture from.
fn resolve_device(
    host: &cpal::Host,
    speaker_type: &str,
    target_name: Option<&str>,
) -> Option<cpal::Device> {
    if let Some(name) = target_name {
        // Try to find any device matching the exact name, searching all known
        // devices (inputs + outputs).  Prefer input devices first so that WASAPI
        // loopback endpoints (which appear as inputs with "loopback" in the
        // name) are picked over plain outputs.
        let all_devices: Vec<cpal::Device> = host.devices().ok()?.collect();

        // 1. Exact match among input-capable devices
        for d in &all_devices {
            if d.name().ok().as_deref() == Some(name) {
                if d.default_input_config().is_ok() || d.supported_input_configs().map(|mut c| c.next().is_some()).unwrap_or(false) {
                    println!("[Audio] Found input-capable device '{}'", name);
                    return Some(clone_device_by_name(host, name)?);
                }
            }
        }

        // 2. Any device with the name (for output-only devices, WASAPI can still loopback)
        for d in all_devices {
            if d.name().ok().as_deref() == Some(name) {
                println!("[Audio] Found device '{}' (may be output-only, will try loopback)", name);
                return Some(d);
            }
        }

        eprintln!("[Audio] Device '{}' not found, falling back to default", name);
    }

    // Default fallback
    if speaker_type == "interviewer" {
        // For interviewer: prefer an output device so WASAPI loopback kicks in
        let out = host.default_output_device();
        if let Some(ref d) = out {
            println!("[Audio] Using default output device '{}' for interviewer (loopback)", d.name().unwrap_or_default());
        } else {
            eprintln!("[Audio] No default output device available!");
        }
        out
    } else {
        let inp = host.default_input_device();
        if let Some(ref d) = inp {
            println!("[Audio] Using default input device '{}' for user", d.name().unwrap_or_default());
        } else {
            eprintln!("[Audio] No default input device available!");
        }
        inp
    }
}

/// Helper: find a device by name again (cpal devices aren't Clone)
fn clone_device_by_name(host: &cpal::Host, name: &str) -> Option<cpal::Device> {
    host.devices().ok()?.find(|d| d.name().ok().as_deref() == Some(name))
}

/// Determine a workable input configuration for the device.
/// For output devices (loopback), `default_input_config` may fail, so we
/// try multiple strategies.
fn resolve_input_config(device: &cpal::Device, device_name: &str) -> Option<cpal::SupportedStreamConfig> {
    // Strategy 1: default_input_config (works for most input and some loopback devices)
    if let Ok(config) = device.default_input_config() {
        println!("[Audio] Using default_input_config for '{}'", device_name);
        return Some(config);
    }

    // Strategy 2: enumerate supported input configs and pick the best one
    if let Ok(configs) = device.supported_input_configs() {
        let configs: Vec<_> = configs.collect();
        if !configs.is_empty() {
            // Prefer 16-bit, then 32-bit float, at the highest sample rate available
            let best = configs.iter()
                .max_by_key(|c| {
                    let format_score = match c.sample_format() {
                        cpal::SampleFormat::I16 => 2,
                        cpal::SampleFormat::F32 => 1,
                        _ => 0,
                    };
                    (format_score, c.max_sample_rate().0)
                });

            if let Some(cfg_range) = best {
                let config = cfg_range.with_max_sample_rate();
                println!(
                    "[Audio] Using supported_input_config for '{}': {}Hz, {:?}",
                    device_name,
                    config.sample_rate().0,
                    config.sample_format()
                );
                return Some(config);
            }
        }
    }

    // Strategy 3: try output config (for output devices used in loopback mode)
    // On WASAPI, build_input_stream on an output device will use loopback,
    // and the output config tells us the format to expect.
    if let Ok(output_config) = device.default_output_config() {
        println!(
            "[Audio] Using default_output_config (loopback mode) for '{}': {}Hz, {:?}",
            device_name,
            output_config.sample_rate().0,
            output_config.sample_format()
        );
        return Some(output_config);
    }

    eprintln!("[Audio] ✗ No workable config found for '{}'", device_name);
    None
}

/// Build an input stream that matches the device's sample format.
fn build_capture_stream(
    device: &cpal::Device,
    config: &cpal::SupportedStreamConfig,
    buffer: Arc<Mutex<Vec<i16>>>,
    sample_rate: u32,
    channels: u16,
    app: Arc<AppHandle>,
    speaker: String,
    device_name: &str,
) -> Option<cpal::Stream> {
    let stream_config: cpal::StreamConfig = config.clone().into();
    let dn = device_name.to_string();

    let stream = match config.sample_format() {
        cpal::SampleFormat::F32 => {
            let buf = buffer.clone();
            let app = app.clone();
            let spk = speaker.clone();
            device.build_input_stream(
                &stream_config,
                move |data: &[f32], _| {
                    let mut b = buf.lock().unwrap();
                    let mut max_v: i16 = 0;
                    for &sample in data {
                        let converted = (sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
                        b.push(converted);
                        let abs = converted.abs();
                        if abs > max_v { max_v = abs; }
                    }
                    check_and_send_buffer(&mut b, sample_rate, channels, &app, &spk, max_v);
                },
                move |e| eprintln!("[Audio] Stream error on '{}': {}", dn, e),
                None,
            )
        }
        cpal::SampleFormat::I16 => {
            let buf = buffer.clone();
            let app = app.clone();
            let spk = speaker.clone();
            let dn2 = device_name.to_string();
            device.build_input_stream(
                &stream_config,
                move |data: &[i16], _| {
                    let mut b = buf.lock().unwrap();
                    let mut max_v: i16 = 0;
                    for &s in data {
                        b.push(s);
                        let abs = s.abs();
                        if abs > max_v { max_v = abs; }
                    }
                    check_and_send_buffer(&mut b, sample_rate, channels, &app, &spk, max_v);
                },
                move |e| eprintln!("[Audio] Stream error on '{}': {}", dn2, e),
                None,
            )
        }
        cpal::SampleFormat::U16 => {
            let buf = buffer.clone();
            let app = app.clone();
            let spk = speaker.clone();
            let dn2 = device_name.to_string();
            device.build_input_stream(
                &stream_config,
                move |data: &[u16], _| {
                    let mut b = buf.lock().unwrap();
                    let mut max_v: i16 = 0;
                    for &sample in data {
                        // Convert u16 (0..65535) to i16 (-32768..32767)
                        let converted = (sample as i32 - 32768) as i16;
                        b.push(converted);
                        let abs = converted.abs();
                        if abs > max_v { max_v = abs; }
                    }
                    check_and_send_buffer(&mut b, sample_rate, channels, &app, &spk, max_v);
                },
                move |e| eprintln!("[Audio] Stream error on '{}': {}", dn2, e),
                None,
            )
        }
        other => {
            eprintln!("[Audio] Unsupported sample format {:?} for '{}'", other, device_name);
            return None;
        }
    };

    match stream {
        Ok(s) => Some(s),
        Err(e) => {
            eprintln!("[Audio] ✗ Failed to build input stream for '{}': {}", device_name, e);
            None
        }
    }
}

fn check_and_send_buffer(
    buf: &mut Vec<i16>,
    sample_rate: u32,
    channels: u16,
    app: &Arc<AppHandle>,
    speaker: &str,
    current_amp: i16,
) {
    // Send every ~6 seconds of audio (longer buffer = more context, fewer false triggers)
    let limit = sample_rate as usize * channels as usize * 6;

    if buf.len() > limit {
        let pcm_data = std::mem::take(buf);
        let max_amp = pcm_data.iter().map(|x| x.abs()).max().unwrap_or(0);

        // Only send to API if there is meaningful speech (amplitude > 800 filters breaths/noise)
        if max_amp > 800 {
            let wav_data = create_wav_data(sample_rate, channels, &pcm_data);
            let b64 = general_purpose::STANDARD.encode(wav_data);
            let _ = app.emit("audio-chunk", AudioPayload {
                speaker: speaker.to_string(),
                data: b64,
                amplitude: max_amp,
            });
        } else {
            // Silent buffer — just update the amplitude indicator
            let _ = app.emit("audio-chunk", AudioPayload {
                speaker: speaker.to_string(),
                data: "".to_string(),
                amplitude: current_amp,
            });
        }
    } else {
        // Periodic amplitude updates (~every 200ms)
        let update_interval = (sample_rate as usize * channels as usize) / 5;
        if update_interval > 0 && buf.len() % update_interval < (channels as usize * 2) {
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
        writer.finalize().unwrap();
    }
    cursor.into_inner()
}
