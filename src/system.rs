use std::{io, path::Path, process::Command};

/// True for http(s) and mailto URLs that are safe to hand to the OS opener.
pub fn is_openable_external_url(url: &str) -> bool {
    let url = url.trim();
    if url.is_empty() || url.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return false;
    }
    let Some((scheme, _)) = url.split_once(':') else {
        return false;
    };
    scheme.eq_ignore_ascii_case("http")
        || scheme.eq_ignore_ascii_case("https")
        || scheme.eq_ignore_ascii_case("mailto")
}

/// Keep local UI routes in the webview; everything else belongs in the OS browser.
pub fn url_stays_in_webview(app_origin: &str, url: &str) -> bool {
    let url = url.trim();
    if url.is_empty() || url == "about:blank" || url.starts_with("about:") {
        return true;
    }
    let origin = app_origin.trim_end_matches('/');
    let Some(rest) = url.strip_prefix(origin) else {
        return false;
    };
    rest.is_empty()
        || matches!(
            rest.as_bytes().first(),
            Some(b'/') | Some(b'?') | Some(b'#')
        )
}

pub fn open_in_browser(url: &str) -> io::Result<()> {
    if !is_openable_external_url(url) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "unsupported url",
        ));
    }
    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::{
            UI::Shell::ShellExecuteW, UI::WindowsAndMessaging::SW_SHOWNORMAL,
        };

        let verb: Vec<u16> = "open\0".encode_utf16().collect();
        let target: Vec<u16> = url.encode_utf16().chain(std::iter::once(0)).collect();
        // ShellExecute asks Windows to use the registered handler for HTTPS.
        // explorer.exe can interpret long OAuth URLs as filesystem targets and
        // open File Explorer instead of the default browser.
        let result = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                verb.as_ptr(),
                target.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                SW_SHOWNORMAL,
            )
        };
        if result as isize <= 32 {
            return Err(io::Error::other(format!(
                "Windows could not open the URL (ShellExecuteW code {})",
                result as isize
            )));
        }
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open").args(["--", url]).spawn()?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open").arg(url).spawn()?;
    }
    Ok(())
}

pub fn open_in_file_manager(path: &Path) -> std::io::Result<()> {
    #[cfg(target_os = "windows")]
    {
        Command::new("explorer").arg(path).spawn()?;
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open").arg(path).spawn()?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open").arg(path).spawn()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn openable_urls() {
        assert!(is_openable_external_url("https://x.ai/news"));
        assert!(is_openable_external_url("HTTPS://x.ai/news"));
        assert!(is_openable_external_url("http://127.0.0.1:8787/"));
        assert!(is_openable_external_url("mailto:hi@example.com"));
        assert!(!is_openable_external_url("javascript:alert(1)"));
        assert!(!is_openable_external_url("file:///etc/passwd"));
        assert!(!is_openable_external_url("https://x.ai/news\n-a"));
    }

    #[test]
    fn webview_origin_check() {
        let origin = "http://127.0.0.1:8787";
        assert!(url_stays_in_webview(
            origin,
            "http://127.0.0.1:8787/settings"
        ));
        assert!(url_stays_in_webview(origin, "http://127.0.0.1:8787"));
        assert!(!url_stays_in_webview(origin, "https://x.ai/blog"));
        assert!(!url_stays_in_webview(origin, "http://127.0.0.1:8787.evil"));
    }
}
