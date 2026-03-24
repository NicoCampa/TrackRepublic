use std::{
  net::{SocketAddr, TcpStream},
  path::PathBuf,
  process::{Command, Stdio},
  thread,
  time::Duration,
};

use tauri::Manager;

const DESKTOP_PORT: u16 = 3210;
const DESKTOP_HOST: &str = "127.0.0.1";

fn production_server_url() -> String {
  format!("http://{DESKTOP_HOST}:{DESKTOP_PORT}")
}

fn wait_for_server() -> bool {
  let address: SocketAddr = format!("{DESKTOP_HOST}:{DESKTOP_PORT}")
    .parse()
    .expect("valid localhost socket");

  for _ in 0..80 {
    if TcpStream::connect_timeout(&address, Duration::from_millis(250)).is_ok() {
      return true;
    }
    thread::sleep(Duration::from_millis(250));
  }

  false
}

fn start_release_server() {
  let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
    .parent()
    .expect("repo root")
    .to_path_buf();
  let server_entry = repo_root.join(".next").join("standalone").join("server.js");
  if !server_entry.exists() {
    log::error!("Missing standalone server entry at {}", server_entry.display());
    return;
  }

  let node_path = option_env!("TRACK_REPUBLIC_NODE").unwrap_or("node");
  let spawn_result = Command::new(node_path)
    .arg(server_entry)
    .current_dir(&repo_root)
    .env("PORT", DESKTOP_PORT.to_string())
    .env("HOSTNAME", DESKTOP_HOST)
    .env("NODE_ENV", "production")
    .stdout(Stdio::null())
    .stderr(Stdio::null())
    .spawn();

  if let Err(error) = spawn_result {
    log::error!("Failed to start bundled Next server: {error}");
  }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      } else {
        start_release_server();

        let app_handle = app.handle().clone();
        thread::spawn(move || {
          if !wait_for_server() {
            log::error!("Desktop production server did not come up on {}", production_server_url());
            return;
          }

          if let Some(window) = app_handle.get_webview_window("main") {
            let target = production_server_url();
            if let Err(error) = window.navigate(target.parse().expect("valid desktop url")) {
              log::error!("Failed to navigate desktop window to local server: {error}");
            }
          }
        });
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
