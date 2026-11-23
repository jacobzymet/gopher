//! Native desktop shell: local Axum server + OS webview window (not a browser tab).

use std::{
    net::SocketAddr,
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

use anyhow::{Context, Result};
use tao::{
    dpi::LogicalSize,
    event::{Event, WindowEvent},
    event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy},
    platform::run_return::EventLoopExtRunReturn,
    window::WindowBuilder,
};
use wry::WebViewBuilder;

const WINDOW_TITLE: &str = "Gopher";
const READY_TIMEOUT: Duration = Duration::from_secs(8);
const READY_POLL: Duration = Duration::from_millis(40);
const QUIT_POLL: Duration = Duration::from_millis(200);

#[derive(Debug, Clone, Copy)]
enum DesktopEvent {
    Focus,
    Quit,
}

static FOCUS_PROXY: Mutex<Option<EventLoopProxy<DesktopEvent>>> = Mutex::new(None);
static QUIT_REQUESTED: AtomicBool = AtomicBool::new(false);
static QUIT_ACKED: AtomicBool = AtomicBool::new(false);
static QUIT_WATCHDOG: AtomicBool = AtomicBool::new(false);

/// How long a requested quit may take before the process is terminated outright.
/// A wedged window loop must never leave `cargo run` (or a packaged app) alive.
const QUIT_WATCHDOG_GRACE: Duration = Duration::from_secs(2);

/// Ask the running desktop window to come forward (used by `/api/focus`).
pub fn request_focus() -> bool {
    let Ok(guard) = FOCUS_PROXY.lock() else {
        return false;
    };
    let Some(proxy) = guard.as_ref() else {
        return false;
    };
    proxy.send_event(DesktopEvent::Focus).is_ok()
}

/// Ask the desktop event loop to exit (Ctrl+C / SIGTERM).
pub fn request_quit() -> bool {
    QUIT_REQUESTED.store(true, Ordering::SeqCst);
    spawn_quit_watchdog();
    let Ok(guard) = FOCUS_PROXY.lock() else {
        return false;
    };
    let Some(proxy) = guard.as_ref() else {
        return false;
    };
    proxy.send_event(DesktopEvent::Quit).is_ok()
}

/// If the window loop does not acknowledge the quit promptly, force the exit so a
/// Ctrl+C can never leave the process (and its console) alive.
fn spawn_quit_watchdog() {
    if QUIT_WATCHDOG.swap(true, Ordering::SeqCst) {
        return;
    }
    let _ = thread::Builder::new()
        .name("quit-watchdog".into())
        .spawn(|| {
            thread::sleep(QUIT_WATCHDOG_GRACE);
            if !QUIT_ACKED.load(Ordering::SeqCst) {
                std::process::exit(0);
            }
        });
}

pub fn quit_requested() -> bool {
    QUIT_REQUESTED.load(Ordering::SeqCst)
}

pub fn is_desktop_shell() -> bool {
    FOCUS_PROXY
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().map(|_| ()))
        .is_some()
}

fn wait_until_ready(url: &str) -> Result<()> {
    let client = crate::http::app_blocking_client(Duration::from_secs(2));
    let deadline = Instant::now() + READY_TIMEOUT;
    let mut last_error = String::from("server did not respond");
    while Instant::now() < deadline {
        match client.get(url).send() {
            Ok(response)
                if response.status().is_success() || response.status().is_redirection() =>
            {
                return Ok(());
            }
            Ok(response) => {
                last_error = format!("HTTP {}", response.status());
            }
            Err(error) => {
                last_error = error.to_string();
            }
        }
        thread::sleep(READY_POLL);
    }
    anyhow::bail!("Gopher UI did not become ready at {url}: {last_error}")
}

fn exit_desktop_loop(
    window: &std::cell::RefCell<Option<tao::window::Window>>,
    control_flow: &mut ControlFlow,
) {
    QUIT_ACKED.store(true, Ordering::SeqCst);
    if let Ok(mut guard) = FOCUS_PROXY.lock() {
        *guard = None;
    }
    *window.borrow_mut() = None;
    *control_flow = ControlFlow::Exit;
}

#[cfg(unix)]
extern "C" fn handle_term_signal(_: libc::c_int) {
    // Async-signal-safe: atomic + _exit only. Cocoa's NSApp.run can replace
    // SIGINT with SIG_IGN; we reinstall this after the event loop starts.
    if QUIT_REQUESTED.swap(true, Ordering::SeqCst) {
        unsafe { libc::_exit(130) };
    }
}

#[cfg(unix)]
fn install_term_signal_handlers() {
    unsafe {
        let mut action: libc::sigaction = std::mem::zeroed();
        action.sa_sigaction = handle_term_signal as *const () as libc::sighandler_t;
        action.sa_flags = libc::SA_RESTART;
        libc::sigemptyset(&mut action.sa_mask);
        libc::sigaction(libc::SIGINT, &action, std::ptr::null_mut());
        libc::sigaction(libc::SIGTERM, &action, std::ptr::null_mut());
    }
}

/// Decide a console control event. Split from the `extern "system"` trampoline so
/// the quit flag behavior is testable without a console.
#[cfg(target_os = "windows")]
fn handle_console_event(kind: u32) -> i32 {
    use windows_sys::Win32::System::Console::{CTRL_BREAK_EVENT, CTRL_C_EVENT};

    if kind == CTRL_C_EVENT || kind == CTRL_BREAK_EVENT {
        // Wakes the event loop immediately; the loop also polls the flag every
        // QUIT_POLL in case the proxy message is dropped during teardown.
        request_quit();
        return 1;
    }
    0
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn console_ctrl_handler(kind: u32) -> i32 {
    handle_console_event(kind)
}

/// Re-enable console Ctrl+C for processes launched in their own process group.
/// `cargo run`, IDEs, and task runners can disable it, which otherwise makes
/// Ctrl+C appear to do nothing at all.
#[cfg(target_os = "windows")]
pub fn enable_console_interrupts() {
    use windows_sys::Win32::System::Console::SetConsoleCtrlHandler;

    // SAFETY: clearing the NULL-handler ignore flag is a plain console call.
    unsafe {
        SetConsoleCtrlHandler(None, 0);
    }
}

/// Windows delivers Ctrl+C to console handler threads, not to Tokio's async
/// watcher reliably (the terminal also signals the parent `cargo` process), so a
/// native handler owns the event: set the quit flag and let the window loop exit.
#[cfg(target_os = "windows")]
fn install_console_quit_handler() {
    use windows_sys::Win32::System::Console::SetConsoleCtrlHandler;

    // SAFETY: the handler only touches an atomic and posts an event-loop message.
    unsafe {
        enable_console_interrupts();
        SetConsoleCtrlHandler(Some(console_ctrl_handler), 1);
    }
}

/// Window / taskbar icon (Windows and Linux). macOS ignores `with_window_icon`;
/// the Dock image is applied separately via AppKit.
#[cfg(not(target_os = "macos"))]
fn load_window_icon() -> Option<tao::window::Icon> {
    // The bundled icon is already 256x256, the largest size window managers use.
    let image = image::load_from_memory(crate::web::APP_ICON_PNG)
        .ok()?
        .into_rgba8();
    let (width, height) = image.dimensions();
    tao::window::Icon::from_rgba(image.into_raw(), width, height).ok()
}

#[cfg(target_os = "macos")]
fn apply_macos_dock_icon() {
    use objc2::{AllocAnyThread, MainThreadMarker};
    use objc2_app_kit::{NSApp, NSImage};
    use objc2_foundation::NSData;

    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let data = NSData::with_bytes(crate::web::APP_ICON_PNG);
    let Some(image) = NSImage::initWithData(NSImage::alloc(), &data) else {
        return;
    };
    // SAFETY: we are on the main thread with a live NSApplication.
    unsafe {
        NSApp(mtm).setApplicationIconImage(Some(&image));
    }
}

/// AppKit only dispatches Cmd+C/V/X/A/Z to the webview when an Edit menu
/// binds those key equivalents to the first-responder selectors. Without it,
/// the chat composer (and every other field) ignores copy / select-all.
#[cfg(target_os = "macos")]
fn apply_macos_edit_menu() {
    use objc2::{MainThreadMarker, MainThreadOnly, sel};
    use objc2_app_kit::{NSApp, NSMenu, NSMenuItem};
    use objc2_foundation::ns_string;

    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let app = NSApp(mtm);
    let menu_bar = app.mainMenu().unwrap_or_else(|| NSMenu::new(mtm));

    let existing_edit = (0..menu_bar.numberOfItems()).any(|index| {
        menu_bar
            .itemAtIndex(index)
            .is_some_and(|item| &*item.title() == ns_string!("Edit"))
    });
    if existing_edit {
        return;
    }

    let edit_menu = NSMenu::initWithTitle(NSMenu::alloc(mtm), ns_string!("Edit"));

    let add = |title, action, key: &objc2_foundation::NSString| {
        let item = unsafe {
            NSMenuItem::initWithTitle_action_keyEquivalent(
                NSMenuItem::alloc(mtm),
                title,
                action,
                key,
            )
        };
        edit_menu.addItem(&item);
    };
    add(ns_string!("Undo"), Some(sel!(undo:)), ns_string!("z"));
    add(ns_string!("Redo"), Some(sel!(redo:)), ns_string!("Z"));
    edit_menu.addItem(&NSMenuItem::separatorItem(mtm));
    add(ns_string!("Cut"), Some(sel!(cut:)), ns_string!("x"));
    add(ns_string!("Copy"), Some(sel!(copy:)), ns_string!("c"));
    add(ns_string!("Paste"), Some(sel!(paste:)), ns_string!("v"));
    add(
        ns_string!("Select All"),
        Some(sel!(selectAll:)),
        ns_string!("a"),
    );

    let edit_item = NSMenuItem::new(mtm);
    edit_item.setTitle(ns_string!("Edit"));
    edit_item.setSubmenu(Some(&edit_menu));
    menu_bar.addItem(&edit_item);
    app.setMainMenu(Some(&menu_bar));
}

fn spawn_quit_listeners(runtime: &tokio::runtime::Handle, proxy: EventLoopProxy<DesktopEvent>) {
    let interrupt_proxy = proxy.clone();
    runtime.spawn(async move {
        let _ = tokio::signal::ctrl_c().await;
        QUIT_REQUESTED.store(true, Ordering::SeqCst);
        let _ = interrupt_proxy.send_event(DesktopEvent::Quit);
    });

    #[cfg(unix)]
    {
        let term_proxy = proxy;
        runtime.spawn(async move {
            let Ok(mut terminate) =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            else {
                return;
            };
            let _ = terminate.recv().await;
            QUIT_REQUESTED.store(true, Ordering::SeqCst);
            let _ = term_proxy.send_event(DesktopEvent::Quit);
        });
    }
}

/// Block on the main thread with a native window until the user closes it.
pub fn run_window(url: &str, bind: SocketAddr, runtime: &tokio::runtime::Handle) -> Result<()> {
    // Chrome maps `*.localhost` to loopback itself; reqwest uses Windows DNS, which does not.
    wait_until_ready(&crate::config::loopback_ui_url(bind))?;
    QUIT_REQUESTED.store(false, Ordering::SeqCst);
    QUIT_ACKED.store(false, Ordering::SeqCst);

    let mut event_loop = EventLoopBuilder::<DesktopEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();
    if let Ok(mut guard) = FOCUS_PROXY.lock() {
        *guard = Some(proxy.clone());
    }

    #[cfg(target_os = "macos")]
    {
        use tao::platform::macos::{ActivationPolicy, EventLoopExtMacOS};
        event_loop.set_activation_policy(ActivationPolicy::Regular);
    }

    // Cocoa's run loop can swallow default SIGINT handling; restore a handler
    // after the app is configured so terminal Ctrl+C still exits.
    #[cfg(unix)]
    install_term_signal_handlers();
    #[cfg(target_os = "windows")]
    install_console_quit_handler();
    spawn_quit_listeners(runtime, proxy);

    #[allow(unused_mut)]
    let mut window_builder = WindowBuilder::new()
        .with_title(WINDOW_TITLE)
        .with_inner_size(LogicalSize::new(1280.0, 840.0))
        .with_min_inner_size(LogicalSize::new(720.0, 520.0));

    #[cfg(not(target_os = "macos"))]
    {
        let icon = load_window_icon();
        #[cfg(target_os = "windows")]
        {
            use tao::platform::windows::WindowBuilderExtWindows;
            window_builder = window_builder
                .with_window_icon(icon.clone())
                .with_taskbar_icon(icon);
        }
        #[cfg(not(target_os = "windows"))]
        {
            window_builder = window_builder.with_window_icon(icon);
        }
    }

    let window = window_builder
        .build(&event_loop)
        .context("could not create desktop window")?;
    let main_window_id = window.id();

    #[cfg(target_os = "macos")]
    apply_macos_dock_icon();

    let app_origin = url.trim_end_matches('/').to_string();
    let stay_origin = app_origin.clone();
    let window_origin = app_origin.clone();
    let builder = WebViewBuilder::new()
        .with_url(url)
        .with_background_color((22, 24, 30, 255))
        .with_devtools(cfg!(debug_assertions))
        .with_navigation_handler(move |target| {
            if crate::system::url_stays_in_webview(&stay_origin, &target) {
                return true;
            }
            if crate::system::is_openable_external_url(&target) {
                let _ = crate::system::open_in_browser(&target);
            }
            false
        })
        .with_new_window_req_handler(move |target, _features| {
            if !crate::system::url_stays_in_webview(&window_origin, &target)
                && crate::system::is_openable_external_url(&target)
            {
                let _ = crate::system::open_in_browser(&target);
            }
            wry::NewWindowResponse::Deny
        })
        .with_initialization_script(
            r#"(function () {
  document.addEventListener('click', function (event) {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    var host = event.target && event.target.closest ? event.target.closest('a[href]') : null;
    if (!host || host.hasAttribute('download')) return;
    var href = host.href;
    if (!href) return;
    var url;
    try { url = new URL(href, location.href); } catch (e) { return; }
    if (url.origin === location.origin) {
      if (host.getAttribute('target') === '_blank') {
        event.preventDefault();
        location.assign(url.href);
      }
      return;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'mailto:') return;
    event.preventDefault();
    fetch('/api/open-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: url.href }),
      keepalive: true
    }).catch(function () {});
  }, true);
})();"#,
        );

    #[cfg(any(target_os = "windows", target_os = "macos"))]
    let _webview = builder
        .build(&window)
        .context("could not create desktop webview")?;

    #[cfg(all(unix, not(target_os = "macos")))]
    let _webview = {
        use tao::platform::unix::WindowExtUnix;
        use wry::WebViewBuilderExtUnix;
        let vbox = window
            .default_vbox()
            .context("could not create GTK container for webview")?;
        builder
            .build_gtk(vbox)
            .context("could not create desktop webview")?
    };

    let window = std::cell::RefCell::new(Some(window));
    #[cfg(target_os = "macos")]
    let mut applied_dock_icon = false;

    event_loop.run_return(move |event, _, control_flow| {
        if QUIT_REQUESTED.load(Ordering::SeqCst) {
            exit_desktop_loop(&window, control_flow);
            return;
        }
        // Wake often enough to notice a SIGINT that only set the atomic.
        *control_flow = ControlFlow::WaitUntil(Instant::now() + QUIT_POLL);
        match event {
            Event::NewEvents(_) => {
                // NSApplication may ignore SIGINT once it is running; restore ours.
                #[cfg(unix)]
                install_term_signal_handlers();
                // Dock tile exists once NSApp is running; set the image then.
                #[cfg(target_os = "macos")]
                if !applied_dock_icon {
                    apply_macos_dock_icon();
                    apply_macos_edit_menu();
                    applied_dock_icon = true;
                }
            }
            Event::UserEvent(DesktopEvent::Quit) => {
                exit_desktop_loop(&window, control_flow);
            }
            Event::UserEvent(DesktopEvent::Focus) => {
                if let Some(window) = window.borrow().as_ref() {
                    window.set_minimized(false);
                    window.set_visible(true);
                    window.set_focus();
                }
            }
            Event::WindowEvent {
                window_id,
                event: WindowEvent::CloseRequested,
                ..
            } if window_id == main_window_id
                || window
                    .borrow()
                    .as_ref()
                    .is_some_and(|window| window.id() == window_id) =>
            {
                exit_desktop_loop(&window, control_flow);
            }
            _ => {}
        }
    });

    if let Ok(mut guard) = FOCUS_PROXY.lock() {
        *guard = None;
    }
    Ok(())
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;

    /// The quit flag is process-global; these tests must not interleave.
    static QUIT_FLAG_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn ctrl_c_requests_quit_without_terminating_the_process() {
        use windows_sys::Win32::System::Console::CTRL_C_EVENT;

        let _guard = QUIT_FLAG_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        QUIT_REQUESTED.store(false, Ordering::SeqCst);
        // The watchdog request_quit starts must not terminate the test binary.
        QUIT_ACKED.store(true, Ordering::SeqCst);
        assert_eq!(handle_console_event(CTRL_C_EVENT), 1);
        assert!(quit_requested());
        QUIT_REQUESTED.store(false, Ordering::SeqCst);
    }

    #[test]
    fn other_console_events_keep_default_handling() {
        use windows_sys::Win32::System::Console::CTRL_CLOSE_EVENT;

        let _guard = QUIT_FLAG_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        QUIT_REQUESTED.store(false, Ordering::SeqCst);
        assert_eq!(handle_console_event(CTRL_CLOSE_EVENT), 0);
        assert!(!quit_requested());
    }
}
