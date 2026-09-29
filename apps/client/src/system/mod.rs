pub mod folders;
pub mod login_startup;

use std::process::{Command, Stdio};

/// A command that opens no console window on Windows.
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
    let mut command = if cfg!(target_os = "macos") {
        let mut c = hidden_command("/usr/bin/open");
        c.arg(url);
        c
    } else if cfg!(windows) {
        let mut c = hidden_command("rundll32");
        c.args(["url.dll,FileProtocolHandler", url]);
        c
    } else {
        let mut c = hidden_command("xdg-open");
        c.arg(url);
        c
    };
    if let Err(error) = command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn() {
        tracing::warn!("Could not open {url}: {error}");
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
