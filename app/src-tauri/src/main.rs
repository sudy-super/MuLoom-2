#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod plugins;

fn main() {
    tauri::Builder::default()
        .plugin(plugins::muloom_gpu::init())
        .run(tauri::generate_context!())
        .expect("failed to run tauri application");
}
