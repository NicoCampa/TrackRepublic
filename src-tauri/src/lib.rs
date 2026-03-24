use std::{
    fs, io,
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::Duration,
};

use tauri::Manager;

const DESKTOP_HOST: &str = "127.0.0.1";

fn production_server_url(port: u16) -> String {
    format!("http://{DESKTOP_HOST}:{port}")
}

fn wait_for_server(port: u16) -> bool {
    let address: SocketAddr = format!("{DESKTOP_HOST}:{port}")
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

fn reserve_open_port() -> io::Result<u16> {
    let listener = std::net::TcpListener::bind((DESKTOP_HOST, 0))?;
    let port = listener.local_addr()?.port();
    drop(listener);
    Ok(port)
}

fn copy_directory(source: &Path, target: &Path, overwrite: bool) -> io::Result<()> {
    if !source.exists() {
        return Ok(());
    }

    fs::create_dir_all(target)?;

    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let entry_type = entry.file_type()?;
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());

        if entry_type.is_dir() {
            copy_directory(&source_path, &target_path, overwrite)?;
            continue;
        }

        if !overwrite && target_path.exists() {
            continue;
        }

        if let Some(parent) = target_path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(&source_path, &target_path)?;
    }

    Ok(())
}

fn copy_file(source: &Path, target: &Path, overwrite: bool) -> io::Result<()> {
    if !source.exists() {
        return Ok(());
    }
    if !overwrite && target.exists() {
        return Ok(());
    }

    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::copy(source, target)?;
    Ok(())
}

fn bundled_runtime_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let runtime_root = app
        .path()
        .resource_dir()
        .map_err(|error| format!("Failed to resolve desktop resource directory: {error}"))?
        .join("desktop-runtime");

    if !runtime_root.exists() {
        return Err(format!(
            "Missing desktop runtime resources at {}",
            runtime_root.display()
        ));
    }

    Ok(runtime_root)
}

fn prepare_workspace(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let runtime_root = bundled_runtime_root(app)?;
    let defaults_root = runtime_root.join("defaults");
    let workspace_root = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Failed to resolve app-local workspace: {error}"))?
        .join("workspace");

    fs::create_dir_all(workspace_root.join("config"))
        .map_err(|error| format!("Failed to create config workspace: {error}"))?;
    fs::create_dir_all(workspace_root.join("data").join("raw"))
        .map_err(|error| format!("Failed to create raw-data workspace: {error}"))?;
    fs::create_dir_all(workspace_root.join("data").join("processed"))
        .map_err(|error| format!("Failed to create processed-data workspace: {error}"))?;
    fs::create_dir_all(workspace_root.join("node_modules"))
        .map_err(|error| format!("Failed to create node_modules workspace: {error}"))?;

    copy_directory(
        &defaults_root.join("scripts"),
        &workspace_root.join("scripts"),
        true,
    )
    .map_err(|error| format!("Failed to sync bundled scripts: {error}"))?;
    copy_directory(
        &defaults_root.join("node_modules"),
        &workspace_root.join("node_modules"),
        true,
    )
    .map_err(|error| format!("Failed to sync bundled node modules: {error}"))?;

    copy_file(
        &defaults_root.join("config").join("instrument_registry.csv"),
        &workspace_root
            .join("config")
            .join("instrument_registry.csv"),
        true,
    )
    .map_err(|error| format!("Failed to sync instrument registry: {error}"))?;
    copy_file(
        &defaults_root
            .join("config")
            .join("manual_category_rules.csv"),
        &workspace_root
            .join("config")
            .join("manual_category_rules.csv"),
        false,
    )
    .map_err(|error| format!("Failed to seed manual rules file: {error}"))?;
    copy_file(
        &defaults_root
            .join("config")
            .join("transaction_overrides.csv"),
        &workspace_root
            .join("config")
            .join("transaction_overrides.csv"),
        false,
    )
    .map_err(|error| format!("Failed to seed transaction overrides file: {error}"))?;
    copy_file(
        &defaults_root
            .join("config")
            .join("manual_transactions.csv"),
        &workspace_root
            .join("config")
            .join("manual_transactions.csv"),
        false,
    )
    .map_err(|error| format!("Failed to seed manual transactions file: {error}"))?;
    copy_file(
        &defaults_root
            .join("config")
            .join("position_unit_overrides.csv"),
        &workspace_root
            .join("config")
            .join("position_unit_overrides.csv"),
        false,
    )
    .map_err(|error| format!("Failed to seed position overrides file: {error}"))?;

    Ok(workspace_root)
}

fn start_release_server(app: &tauri::AppHandle) -> Option<u16> {
    let runtime_root = match bundled_runtime_root(app) {
        Ok(path) => path,
        Err(error) => {
            log::error!("{error}");
            return None;
        }
    };
    let workspace_root = match prepare_workspace(app) {
        Ok(path) => path,
        Err(error) => {
            log::error!("{error}");
            return None;
        }
    };
    let server_entry = runtime_root.join("app-runtime").join("server.js");
    if !server_entry.exists() {
        log::error!(
            "Missing bundled Next server entry at {}",
            server_entry.display()
        );
        return None;
    }
    let port = match reserve_open_port() {
        Ok(port) => port,
        Err(error) => {
            log::error!("Failed to reserve a desktop server port: {error}");
            return None;
        }
    };
    let node_path = option_env!("TRACK_REPUBLIC_NODE").unwrap_or("node");
    let spawn_result = Command::new(node_path)
        .arg(server_entry)
        .current_dir(&workspace_root)
        .env("TRACK_REPUBLIC_RUNTIME_ROOT", runtime_root.as_os_str())
        .env("TRACK_REPUBLIC_WORKSPACE", workspace_root.as_os_str())
        .env("PORT", port.to_string())
        .env("HOSTNAME", DESKTOP_HOST)
        .env("NODE_ENV", "production")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();

    if let Err(error) = spawn_result {
        log::error!("Failed to start bundled Next server: {error}");
        return None;
    }

    Some(port)
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
                let Some(port) = start_release_server(&app.handle().clone()) else {
                    return Ok(());
                };

                let app_handle = app.handle().clone();
                thread::spawn(move || {
                    if !wait_for_server(port) {
                        log::error!(
                            "Desktop production server did not come up on {}",
                            production_server_url(port)
                        );
                        return;
                    }

                    if let Some(window) = app_handle.get_webview_window("main") {
                        let target = production_server_url(port);
                        if let Err(error) =
                            window.navigate(target.parse().expect("valid desktop url"))
                        {
                            log::error!(
                                "Failed to navigate desktop window to local server: {error}"
                            );
                        }
                    }
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
