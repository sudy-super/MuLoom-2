use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("muloom_gpu")
        .setup(|app, _| {
            #[cfg(target_os = "macos")]
            {
                if let Err(err) = metal::start_renderer(app) {
                    eprintln!("muloom_gpu: failed to start Metal renderer: {err:?}");
                }
            }
            Ok(())
        })
        .build()
}

#[cfg(target_os = "macos")]
mod metal {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::thread;
    use std::time::{Duration, Instant};

    use anyhow::{Context, Result};
    use tauri::Manager;
    use tauri::{AppHandle, PhysicalSize, Runtime, WebviewWindow, WindowEvent};
    use wgpu::{Gles3MinorVersion, TextureFormat};

    pub fn start_renderer<R: Runtime>(app: &AppHandle<R>) -> Result<()> {
        let window = if let Some(found) = app.get_webview_window("main") {
            found
        } else if let Some(first) = app.webview_windows().values().next().cloned() {
            first
        } else {
            return Err(anyhow::anyhow!(
                "failed to locate webview window for Metal renderer"
            ));
        };

        let running = Arc::new(AtomicBool::new(true));
        let window_resized = Arc::new(AtomicBool::new(true));

        {
            let running = running.clone();
            let window_resized = window_resized.clone();
            window.on_window_event(move |event| match event {
                WindowEvent::Destroyed => {
                    running.store(false, Ordering::SeqCst);
                }
                WindowEvent::CloseRequested { .. } => {
                    running.store(false, Ordering::SeqCst);
                }
                WindowEvent::Resized(_) => {
                    window_resized.store(true, Ordering::SeqCst);
                }
                WindowEvent::ScaleFactorChanged { .. } => {
                    window_resized.store(true, Ordering::SeqCst);
                }
                _ => {}
            });
        }

        thread::Builder::new()
            .name("muloom-metal-renderer".into())
            .spawn({
                let window = window.clone();
                move || {
                    if let Err(err) = run_renderer::<R>(window, running, window_resized) {
                        eprintln!("muloom_gpu: Metal renderer stopped: {err:?}");
                    }
                }
            })?;

        Ok(())
    }

    fn run_renderer<R: Runtime>(
        window: WebviewWindow<R>,
        running: Arc<AtomicBool>,
        window_resized: Arc<AtomicBool>,
    ) -> Result<()> {
        use wgpu::{
            Backends, DeviceDescriptor, Instance, InstanceDescriptor, PresentMode,
            SurfaceConfiguration, SurfaceError, TextureUsages,
        };

        let instance = Instance::new(InstanceDescriptor {
            backends: Backends::METAL,
            flags: wgpu::InstanceFlags::default(),
            dx12_shader_compiler: Default::default(),
            gles_minor_version: Gles3MinorVersion::Automatic,
        });

        let surface_target = unsafe { wgpu::SurfaceTargetUnsafe::from_window(&window) }
            .context("failed to derive surface target from Tauri window")?;
        let surface = unsafe { instance.create_surface_unsafe(surface_target) }
            .context("failed to create wgpu surface from Tauri window")?;

        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            compatible_surface: Some(&surface),
            force_fallback_adapter: false,
        }))
        .context("failed to acquire Metal adapter")?;

        let (device, queue) = pollster::block_on(adapter.request_device(
            &DeviceDescriptor {
                label: Some("muloom_metal_device"),
                required_features: wgpu::Features::empty(),
                required_limits: wgpu::Limits::default(),
            },
            None,
        ))
        .context("failed to create Metal device")?;

        let capabilities = surface.get_capabilities(&adapter);
        let surface_format = pick_surface_format(&capabilities.formats);
        let mut present_mode = PresentMode::AutoNoVsync;
        if !capabilities.present_modes.contains(&present_mode) {
            present_mode = capabilities
                .present_modes
                .iter()
                .copied()
                .find(|mode| matches!(mode, PresentMode::Immediate | PresentMode::Mailbox))
                .unwrap_or(PresentMode::Fifo);
        }

        let alpha_mode = capabilities
            .alpha_modes
            .iter()
            .copied()
            .find(|mode| matches!(mode, wgpu::CompositeAlphaMode::Opaque | wgpu::CompositeAlphaMode::Auto))
            .unwrap_or(wgpu::CompositeAlphaMode::Auto);

        let mut config = SurfaceConfiguration {
            usage: TextureUsages::RENDER_ATTACHMENT,
            format: surface_format,
            width: 1,
            height: 1,
            present_mode,
            alpha_mode,
            view_formats: vec![],
            desired_maximum_frame_latency: 1,
        };

        resize_surface(&window, &surface, &device, &mut config, true)?;

        let mut frame_index: u64 = 0;
        let mut last_frame_time = Instant::now();

        while running.load(Ordering::SeqCst) {
            if window_resized.swap(false, Ordering::SeqCst) {
                resize_surface(&window, &surface, &device, &mut config, false)?;
            } else {
                // Poll window size in case of missed events.
                resize_surface(&window, &surface, &device, &mut config, false)?;
            }

            if config.width == 0 || config.height == 0 {
                thread::sleep(Duration::from_millis(50));
                continue;
            }

            match surface.get_current_texture() {
                Ok(frame) => {
                    let view = frame
                        .texture
                        .create_view(&wgpu::TextureViewDescriptor::default());

                    let elapsed = last_frame_time.elapsed().as_secs_f32();
                    let phase = (frame_index as f32) * 0.005 + elapsed * 0.25;
                    let color = wgpu::Color {
                        r: 0.2 + 0.8 * (phase).sin().abs() as f64,
                        g: 0.1 + 0.6 * (phase * 1.7).cos().abs() as f64,
                        b: 0.15 + 0.7 * (phase * 0.9).sin().abs() as f64,
                        a: 1.0,
                    };

                    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
                        label: Some("muloom_metal_encoder"),
                    });

                    {
                        let _pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                            label: Some("muloom_metal_pass"),
                            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                                view: &view,
                                resolve_target: None,
                                ops: wgpu::Operations {
                                    load: wgpu::LoadOp::Clear(color),
                                    store: wgpu::StoreOp::Store,
                                },
                            })],
                            depth_stencil_attachment: None,
                            timestamp_writes: None,
                            occlusion_query_set: None,
                        });
                    }

                    queue.submit(Some(encoder.finish()));
                    frame.present();
                }
                Err(SurfaceError::Timeout) => {
                    // No frame available yet; skip this tick.
                }
                Err(SurfaceError::Lost) => {
                    resize_surface(&window, &surface, &device, &mut config, true)?;
                }
                Err(SurfaceError::Outdated) => {
                    resize_surface(&window, &surface, &device, &mut config, true)?;
                }
                Err(SurfaceError::OutOfMemory) => {
                    running.store(false, Ordering::SeqCst);
                    break;
                }
            }

            frame_index = frame_index.wrapping_add(1);
            last_frame_time = Instant::now();

            // Allow other threads to progress; CVDisplayLink integration can replace this later.
            thread::sleep(Duration::from_millis(4));
        }

        Ok(())
    }

    fn resize_surface<R: Runtime>(
        window: &WebviewWindow<R>,
        surface: &wgpu::Surface<'static>,
        device: &wgpu::Device,
        config: &mut wgpu::SurfaceConfiguration,
        force: bool,
    ) -> Result<()> {
        let size = window
            .inner_size()
            .unwrap_or_else(|_| PhysicalSize::new(config.width, config.height));

        let width = size.width.max(1);
        let height = size.height.max(1);

        if force || width != config.width || height != config.height {
            config.width = width;
            config.height = height;
            surface.configure(device, config);
        }

        Ok(())
    }

    fn pick_surface_format(formats: &[TextureFormat]) -> TextureFormat {
        formats
            .iter()
            .copied()
            .find(|format| matches!(format, TextureFormat::Bgra8UnormSrgb | TextureFormat::Bgra8Unorm))
            .unwrap_or_else(|| formats.get(0).copied().unwrap_or(TextureFormat::Bgra8Unorm))
    }
}
