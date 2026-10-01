pub mod agents;
pub mod folders;
pub mod handlers;
pub mod login_startup;

use std::process::{Command, Stdio};

/// A command that opens no console window on Windows.
/// Runs a program to its end: its output when it succeeds, else what it said went wrong.
#[cfg_attr(target_os = "linux", allow(dead_code))]
pub fn run_captured(program: &str, args: &[&str]) -> Result<String, String> {
    match hidden_command(program).args(args).output() {
        Ok(out) if out.status.success() => Ok(String::from_utf8_lossy(&out.stdout).into_owned()),
        Ok(out) => Err(String::from_utf8_lossy(&out.stderr).trim().to_owned()),
        Err(error) => Err(error.to_string()),
    }
}

pub fn hidden_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    #[allow(unused_mut)]
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

pub fn open_in_browser(url: &str) {
    open_with_system(url);
}

/// Shows a file or folder selected in Finder, Explorer or the Linux file manager.
pub fn reveal_in_file_manager(path: &std::path::Path) {
    let mut command = if cfg!(target_os = "macos") {
        let mut c = hidden_command("/usr/bin/open");
        c.arg("-R").arg(path);
        c
    } else if cfg!(windows) {
        let mut c = hidden_command("explorer");
        c.arg(format!("/select,{}", path.display()));
        c
    } else {
        // No portable "select this file": open the folder that holds it.
        let mut c = hidden_command("xdg-open");
        c.arg(if path.is_dir() { path } else { path.parent().unwrap_or(path) });
        c
    };
    if let Err(error) = command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn() {
        tracing::warn!("Could not show {}: {error}", path.display());
    }
}

/// Opens a file or URL with the program the system uses for it.
pub fn open_with_system(target: impl AsRef<std::ffi::OsStr>) {
    let target = target.as_ref();
    let mut command = if cfg!(target_os = "macos") {
        let mut c = hidden_command("/usr/bin/open");
        c.arg(target);
        c
    } else if cfg!(windows) {
        let mut c = hidden_command("rundll32");
        c.arg("url.dll,FileProtocolHandler").arg(target);
        c
    } else {
        let mut c = hidden_command("xdg-open");
        c.arg(target);
        c
    };
    if let Err(error) = command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn() {
        tracing::warn!("Could not open {}: {error}", target.to_string_lossy());
    }
}

/// Whether a process with this id is still running.
pub fn process_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        // Signal 0 checks existence; EPERM means it exists but belongs to someone else.
        let result = unsafe { libc::kill(pid as libc::pid_t, 0) };
        result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
        use windows_sys::Win32::System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle.is_null() {
                return false;
            }
            let mut code = 0u32;
            let ok = GetExitCodeProcess(handle, &mut code) != 0;
            CloseHandle(handle);
            ok && code == STILL_ACTIVE as u32
        }
    }
}
