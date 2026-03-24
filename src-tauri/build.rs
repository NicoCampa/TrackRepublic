use std::process::Command;

fn main() {
    if let Ok(output) = Command::new("zsh").args(["-lc", "which node"]).output() {
        if output.status.success() {
            let node_path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !node_path.is_empty() {
                println!("cargo:rustc-env=TRACK_REPUBLIC_NODE={node_path}");
            }
        }
    }

    tauri_build::build()
}
