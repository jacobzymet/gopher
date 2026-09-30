//! Build updates locally from the current master commit.

use std::ffi::OsString;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use std::{env, fs, thread};

use serde::Serialize;
use tokio::sync::{Mutex as TokioMutex, Notify};

use crate::http;

const REPOSITORY: &str = "https://github.com/jacobzymet/gopher";
const BRANCH: &str = "master";
const CACHE_TTL: Duration = Duration::from_secs(6 * 60 * 60);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(12);
const MAX_GITHUB_RESPONSE_BYTES: usize = 1024 * 1024;
const RESTART_BIND_ATTEMPTS: u32 = 40;
const RESTART_BIND_DELAY: Duration = Duration::from_millis(50);
const RESTART_SPAWN_DELAY: Duration = Duration::from_millis(350);
const APPLY_RESPONSE_DELAY: Duration = Duration::from_millis(450);
const UPDATE_RESTART_FLAG: &str = "--update-restart";

#[derive(Debug, Clone, Serialize)]
pub struct UpdateStatus {
    pub current: String,
    pub current_commit: Option<String>,
    pub latest: Option<String>,
    pub branch: &'static str,
    pub commit_url: String,
    pub update_available: bool,
    pub can_install: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub install_blocked: Option<String>,
    pub checked: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ApplyResult {
    pub ok: bool,
    pub restarting: bool,
    pub commit: String,
}

struct CachedCheck {
    at: Instant,
    commit: String,
}

#[derive(Debug, Clone)]
struct RestartPlan {
    exe: PathBuf,
    args: Vec<OsString>,
    cwd: Option<PathBuf>,
    detached: bool,
}

static CACHE: OnceLock<Mutex<Option<CachedCheck>>> = OnceLock::new();
static APPLYING: OnceLock<Arc<TokioMutex<()>>> = OnceLock::new();
static RESTART_PLAN: OnceLock<Mutex<Option<RestartPlan>>> = OnceLock::new();
static RESTART_NOTIFY: OnceLock<Notify> = OnceLock::new();
static RESTART_FLAG: AtomicBool = AtomicBool::new(false);

fn cache() -> &'static Mutex<Option<CachedCheck>> {
    CACHE.get_or_init(|| Mutex::new(None))
}

fn applying() -> &'static Arc<TokioMutex<()>> {
    APPLYING.get_or_init(|| Arc::new(TokioMutex::new(())))
}

fn restart_plan() -> &'static Mutex<Option<RestartPlan>> {
    RESTART_PLAN.get_or_init(|| Mutex::new(None))
}

fn restart_notify() -> &'static Notify {
    RESTART_NOTIFY.get_or_init(Notify::new)
}

pub fn build_label() -> &'static str {
    env!("GOPHER_BUILD_ID")
}

fn valid_commit(commit: &str) -> bool {
    commit.len() == 40 && commit.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn current_commit() -> Option<&'static str> {
    let commit = env!("GOPHER_BUILD_COMMIT");
    valid_commit(commit).then_some(commit)
}

fn needs_update(current: Option<&str>, dirty: bool, latest: &str) -> bool {
    dirty || !current.is_some_and(|commit| commit.eq_ignore_ascii_case(latest))
}

fn parse_master_commit(payload: &serde_json::Value) -> Result<String, String> {
    payload
        .get("sha")
        .and_then(|value| value.as_str())
        .filter(|commit| valid_commit(commit))
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| "GitHub did not return a valid master commit.".to_string())
}

fn base_status() -> UpdateStatus {
    UpdateStatus {
        current: build_label().to_string(),
        current_commit: current_commit().map(str::to_string),
        latest: None,
        branch: BRANCH,
        commit_url: format!("{REPOSITORY}/commits/{BRANCH}"),
        update_available: false,
        can_install: false,
        install_blocked: None,
        checked: true,
        error: None,
    }
}

fn quiet_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut command = Command::new(program);
    command.stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    command
}

fn working_tool(path: &Path) -> bool {
    quiet_command(path)
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

fn cargo_path() -> Result<PathBuf, String> {
    let name = if cfg!(windows) { "cargo.exe" } else { "cargo" };
    let mut candidates: Vec<PathBuf> = env::var_os("PATH")
        .map(|path| env::split_paths(&path).map(|dir| dir.join(name)).collect())
        .unwrap_or_default();
    if let Some(home) = env::var_os("CARGO_HOME") {
        candidates.push(PathBuf::from(home).join("bin").join(name));
    }
    let user = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    if let Some(home) = env::var_os(user) {
        candidates.push(PathBuf::from(home).join(".cargo").join("bin").join(name));
    }
    let cargo = candidates.into_iter().find(|candidate| candidate.is_file() && working_tool(candidate))
        .ok_or_else(|| "Install Rust with Cargo from https://rustup.rs, then retry. Gopher builds updates on your computer.".to_string())?;
    let rustc_name = if cfg!(windows) { "rustc.exe" } else { "rustc" };
    let mut compilers = vec![cargo.with_file_name(rustc_name)];
    if let Some(path) = env::var_os("PATH") {
        compilers.extend(env::split_paths(&path).map(|dir| dir.join(rustc_name)));
    }
    if !compilers
        .iter()
        .any(|compiler| compiler.is_file() && working_tool(compiler))
    {
        return Err("The Rust compiler is missing. Install a Rust toolchain from https://rustup.rs, then retry.".to_string());
    }
    Ok(cargo)
}

fn build_environment(command: &mut Command, cargo: &Path) -> Result<(), String> {
    // A desktop process may still have the PATH from before Rust was installed.
    let mut paths = vec![
        cargo
            .parent()
            .ok_or("Could not locate the Rust toolchain.")?
            .to_path_buf(),
    ];
    if let Some(path) = env::var_os("PATH") {
        paths.extend(env::split_paths(&path));
    }
    command.env(
        "PATH",
        env::join_paths(paths).map_err(|error| error.to_string())?,
    );
    Ok(())
}

fn install_block_reason() -> Option<String> {
    if let Err(error) = cargo_path() {
        return Some(error);
    }
    install_destination().err()
}

fn status_for_commit(commit: String) -> UpdateStatus {
    let mut status = base_status();
    status.update_available = needs_update(
        current_commit(),
        env!("GOPHER_BUILD_DIRTY") == "true",
        &commit,
    );
    status.commit_url = format!("{REPOSITORY}/commit/{commit}");
    status.latest = Some(commit);
    if status.update_available {
        status.install_blocked = install_block_reason();
        status.can_install = status.install_blocked.is_none();
    }
    status
}

async fn fetch_master_commit() -> Result<String, String> {
    let response = http::public_client()
        .get("https://api.github.com/repos/jacobzymet/gopher/commits/master")
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .header("User-Agent", concat!("gopher/", env!("GOPHER_BUILD_ID")))
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|error| format!("Could not check master on GitHub: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("Could not check master on GitHub (HTTP {status})."));
    }
    let bytes = http::response_bytes_limited(response, MAX_GITHUB_RESPONSE_BYTES)
        .await
        .map_err(|error| format!("Invalid GitHub response: {error}"))?;
    let payload = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Invalid GitHub response: {error}"))?;
    parse_master_commit(&payload)
}

async fn load_master_commit(force: bool) -> Result<String, String> {
    if !force
        && let Ok(guard) = cache().lock()
        && let Some(cached) = guard.as_ref()
        && cached.at.elapsed() < CACHE_TTL
    {
        return Ok(cached.commit.clone());
    }
    let commit = fetch_master_commit().await?;
    if let Ok(mut guard) = cache().lock() {
        *guard = Some(CachedCheck {
            at: Instant::now(),
            commit: commit.clone(),
        });
    }
    Ok(commit)
}

/// Cache only the remote commit; reevaluate local prerequisites on every check.
pub async fn check(force: bool) -> UpdateStatus {
    let result = match load_master_commit(force).await {
        Ok(commit) => tokio::task::spawn_blocking(move || status_for_commit(commit))
            .await
            .map_err(|error| format!("Could not check build prerequisites: {error}")),
        Err(error) => Err(error),
    };
    result.unwrap_or_else(|error| UpdateStatus {
        error: Some(error),
        ..base_status()
    })
}

fn build_command(
    cargo: &Path,
    commit: &str,
    staging: &Path,
    target: &Path,
) -> Result<Command, String> {
    if !valid_commit(commit) {
        return Err("Refusing to build an invalid commit.".to_string());
    }
    let mut command = quiet_command(cargo);
    command
        .args([
            "install",
            "--git",
            "https://github.com/jacobzymet/gopher",
            "--rev",
            commit,
            "--locked",
            "--force",
            "--bin",
            "gopher",
            "--target",
            env!("GOPHER_BUILD_TARGET"),
        ])
        .arg("--root")
        .arg(staging)
        .arg("--target-dir")
        .arg(target)
        .current_dir(staging)
        .env("GOPHER_BUILD_COMMIT", commit);
    build_environment(&mut command, cargo)?;
    Ok(command)
}

fn log_tail(log: &Path) -> String {
    let Ok(mut file) = fs::File::open(log) else {
        return String::new();
    };
    let _ = file.seek(SeekFrom::End(-12_000));
    let mut bytes = Vec::new();
    let _ = file.take(12_000).read_to_end(&mut bytes);
    String::from_utf8_lossy(&bytes).trim().to_string()
}

fn build_and_replace_with(
    cargo: &Path,
    commit: &str,
    dest: &Path,
    target: &Path,
) -> Result<(), String> {
    let staging = tempfile::tempdir()
        .map_err(|error| format!("Could not create build staging folder: {error}"))?;
    let log = staging.path().join("build.log");
    let stdout = fs::File::create(&log).map_err(|error| error.to_string())?;
    let stderr = stdout.try_clone().map_err(|error| error.to_string())?;
    let status = build_command(cargo, commit, staging.path(), target)?
        .stdout(stdout)
        .stderr(stderr)
        .status()
        .map_err(|error| format!("Could not start Cargo: {error}"))?;
    if !status.success() {
        return Err(format!(
            "The local build failed. Check Rust and your platform's build dependencies, then retry.\n{}",
            log_tail(&log)
        ));
    }
    let binary = staging.path().join("bin").join(if cfg!(windows) {
        "gopher.exe"
    } else {
        "gopher"
    });
    let output = quiet_command(&binary)
        .arg("--version")
        .output()
        .map_err(|error| format!("Could not verify the locally built app: {error}"))?;
    let version = String::from_utf8_lossy(&output.stdout);
    if !output.status.success()
        || !version
            .lines()
            .any(|line| line == format!("Commit: {commit}"))
    {
        return Err(
            "The locally built app does not identify the requested master commit.".to_string(),
        );
    }
    let bytes = fs::read(&binary)
        .map_err(|error| format!("Could not read the locally built app: {error}"))?;
    replace_executable(dest, &bytes)
}

/// Compile a pinned master commit before replacing the installed executable.
pub async fn apply() -> Result<ApplyResult, String> {
    let guard = applying()
        .clone()
        .try_lock_owned()
        .map_err(|_| "An update is already building.".to_string())?;
    let commit = load_master_commit(true).await?;
    let built_commit = tokio::task::spawn_blocking(move || {
        // Keep the lock even if the HTTP request disconnects during compilation.
        let _guard = guard;
        if !needs_update(
            current_commit(),
            env!("GOPHER_BUILD_DIRTY") == "true",
            &commit,
        ) {
            return Err("Gopher is already on the current master commit.".to_string());
        }
        let cargo = cargo_path()?;
        let dest = install_destination()?;
        let project = directories::ProjectDirs::from("", "", "gopher")
            .ok_or("Could not locate the build cache folder.")?;
        let target = project
            .cache_dir()
            .join("update-build")
            .join(env!("GOPHER_BUILD_TARGET"));
        build_and_replace_with(&cargo, &commit, &dest, &target)?;
        arm_restart(dest);
        Ok::<_, String>(commit)
    })
    .await
    .map_err(|error| format!("Local update build failed: {error}"))??;
    Ok(ApplyResult {
        ok: true,
        restarting: true,
        commit: built_commit,
    })
}

pub fn bind_retry_budget(retry: bool) -> (u32, Duration) {
    if retry {
        (RESTART_BIND_ATTEMPTS, RESTART_BIND_DELAY)
    } else {
        (1, Duration::ZERO)
    }
}

/// Remove leftover `.old` binaries from a previous in-place replace.
pub fn cleanup_previous_install() {
    let Ok(exe) = env::current_exe() else {
        return;
    };
    let Some(dir) = exe.parent() else {
        return;
    };
    if let Some(name) = exe.file_name() {
        let mut old = PathBuf::from(dir);
        old.push(name);
        old.set_extension(match exe.extension().and_then(|ext| ext.to_str()) {
            Some(ext) => format!("{ext}.old"),
            None => "old".to_string(),
        });
        let _ = fs::remove_file(old);
    }
    let _ = fs::remove_file(dir.join(".gopher-update-write-test"));
}

pub(crate) fn looks_like_cargo_build(path: &Path) -> bool {
    let parts: Vec<_> = path.iter().collect();
    parts
        .windows(2)
        .any(|pair| pair[0] == "target" && (pair[1] == "debug" || pair[1] == "release"))
        || parts
            .windows(3)
            .any(|parts| parts[0] == "target" && (parts[2] == "debug" || parts[2] == "release"))
}

fn default_user_binary() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        let local = env::var_os("LOCALAPPDATA")?;
        Some(
            PathBuf::from(local)
                .join("gopher")
                .join("bin")
                .join("gopher.exe"),
        )
    }
    #[cfg(not(windows))]
    {
        let home = env::var_os("HOME")?;
        Some(
            PathBuf::from(home)
                .join(".local")
                .join("bin")
                .join("gopher"),
        )
    }
}

fn dir_is_writable(dir: &Path) -> bool {
    if fs::create_dir_all(dir).is_err() {
        return false;
    }
    let probe = dir.join(".gopher-update-write-test");
    match fs::write(&probe, b"ok") {
        Ok(()) => {
            let _ = fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

pub(crate) fn install_destination() -> Result<PathBuf, String> {
    if let Ok(current) = env::current_exe()
        && let Some(dir) = current.parent()
        && !looks_like_cargo_build(&current)
        && dir_is_writable(dir)
    {
        return Ok(current);
    }
    let dest = default_user_binary()
        .ok_or_else(|| "Could not locate a writable Gopher install folder.".to_string())?;
    let dir = dest
        .parent()
        .ok_or_else(|| "Could not locate a writable Gopher install folder.".to_string())?;
    if dir_is_writable(dir) {
        return Ok(dest);
    }
    Err("Gopher cannot write to its install folder. Reinstall with the install script.".to_string())
}

pub(crate) fn replace_executable(dest: &Path, new_bytes: &[u8]) -> Result<(), String> {
    let dir = dest
        .parent()
        .ok_or_else(|| "could not locate the Gopher install folder".to_string())?;
    fs::create_dir_all(dir)
        .map_err(|error| format!("could not create the Gopher install folder: {error}"))?;
    let file_name = dest
        .file_name()
        .ok_or_else(|| "could not locate the Gopher executable".to_string())?;
    let staged = dir.join(format!("{}.new", file_name.to_string_lossy()));
    let backup = {
        let mut path = dir.join(file_name);
        path.set_extension(match dest.extension().and_then(|ext| ext.to_str()) {
            Some(ext) => format!("{ext}.old"),
            None => "old".to_string(),
        });
        path
    };
    fs::write(&staged, new_bytes).map_err(|error| {
        let _ = fs::remove_file(&staged);
        format!("could not write the new Gopher binary: {error}")
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Err(error) = fs::set_permissions(&staged, fs::Permissions::from_mode(0o755)) {
            let _ = fs::remove_file(&staged);
            return Err(format!(
                "could not mark the new Gopher binary executable: {error}"
            ));
        }
        if let Err(error) = fs::rename(&staged, dest) {
            let _ = fs::remove_file(&staged);
            return Err(format!("could not replace Gopher: {error}"));
        }
        let _ = fs::remove_file(&backup);
        Ok(())
    }
    #[cfg(windows)]
    {
        let _ = fs::remove_file(&backup);
        if dest.exists()
            && let Err(error) = fs::rename(dest, &backup)
        {
            let _ = fs::remove_file(&staged);
            return Err(format!(
                "could not replace the running app ({error}). Quit other Gopher windows and retry."
            ));
        }
        if let Err(error) = fs::rename(&staged, dest) {
            if backup.exists() {
                let _ = fs::rename(&backup, dest);
            }
            let _ = fs::remove_file(&staged);
            return Err(format!("could not install the new Gopher binary: {error}"));
        }
        Ok(())
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = fs::remove_file(&staged);
        Err("self-update is not supported on this platform".to_string())
    }
}

fn restart_args() -> Vec<OsString> {
    env::args_os()
        .skip(1)
        .filter(|arg| arg != UPDATE_RESTART_FLAG)
        .collect()
}

fn arm_restart(exe: PathBuf) {
    let plan = RestartPlan {
        exe,
        args: restart_args(),
        cwd: env::current_dir().ok(),
        detached: crate::desktop::is_desktop_shell(),
    };
    if let Ok(mut guard) = restart_plan().lock() {
        *guard = Some(plan);
    }
}

fn take_restart_plan() -> Option<RestartPlan> {
    restart_plan()
        .lock()
        .ok()
        .and_then(|mut guard| guard.take())
}

pub async fn wait_for_restart_request() {
    if RESTART_FLAG.load(AtomicOrdering::SeqCst) {
        return;
    }
    restart_notify().notified().await;
}

fn request_app_restart() {
    RESTART_FLAG.store(true, AtomicOrdering::SeqCst);
    restart_notify().notify_waiters();
    if crate::desktop::is_desktop_shell() {
        crate::desktop::request_quit();
    }
}

pub fn spawn_restart_if_pending() {
    let Some(plan) = take_restart_plan() else {
        return;
    };
    thread::sleep(RESTART_SPAWN_DELAY);
    let mut cmd = Command::new(&plan.exe);
    cmd.args(&plan.args).arg(UPDATE_RESTART_FLAG);
    if let Some(cwd) = &plan.cwd {
        cmd.current_dir(cwd);
    }
    if plan.detached {
        cmd.stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const DETACHED_PROCESS: u32 = 0x00000008;
            const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;
            cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
        }
    } else {
        cmd.stdin(Stdio::inherit())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit());
    }
    if let Err(error) = cmd.spawn() {
        eprintln!("could not restart Gopher: {error}");
    }
}

pub fn schedule_restart_after_response() {
    tokio::spawn(async {
        tokio::time::sleep(APPLY_RESPONSE_DELAY).await;
        request_app_restart();
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const COMMIT: &str = "0123456789abcdef0123456789abcdef01234567";

    #[test]
    fn compares_source_identity_without_ordering_hashes() {
        assert!(!needs_update(Some(COMMIT), false, COMMIT));
        assert!(!needs_update(Some(&COMMIT.to_uppercase()), false, COMMIT));
        assert!(needs_update(
            Some("ffffffffffffffffffffffffffffffffffffffff"),
            false,
            COMMIT
        ));
        assert!(needs_update(None, false, COMMIT));
        assert!(needs_update(Some(COMMIT), true, COMMIT));
    }

    #[test]
    fn master_response_requires_a_full_commit() {
        assert_eq!(
            parse_master_commit(&serde_json::json!({"sha": COMMIT})).unwrap(),
            COMMIT
        );
        for bad in [
            serde_json::json!({}),
            serde_json::json!({"sha": "master"}),
            serde_json::json!({"sha": "v1.0.0"}),
            serde_json::json!({"sha": "a".repeat(39)}),
        ] {
            assert!(parse_master_commit(&bad).is_err());
        }
    }

    #[test]
    fn command_builds_a_pinned_source_revision_in_staging() {
        let command = build_command(
            Path::new("cargo"),
            COMMIT,
            Path::new("staging"),
            Path::new("cache"),
        )
        .unwrap();
        let args: Vec<_> = command
            .get_args()
            .map(|arg| arg.to_string_lossy())
            .collect();
        assert!(args.windows(2).any(|pair| pair == ["--rev", COMMIT]));
        assert!(args.windows(2).any(|pair| pair == ["--git", REPOSITORY]));
        assert!(args.iter().any(|arg| arg == "--locked"));
        assert!(args.windows(2).any(|pair| pair == ["--root", "staging"]));
        assert!(
            build_command(
                Path::new("cargo"),
                "master",
                Path::new("staging"),
                Path::new("cache")
            )
            .is_err()
        );
    }

    #[test]
    fn failed_compilation_leaves_existing_app_untouched() {
        // The test binary exits nonzero on an unknown argument, acting as a failed Cargo invocation.
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("installed-app");
        fs::write(&dest, b"existing app").unwrap();
        let result = build_and_replace_with(
            &env::current_exe().unwrap(),
            COMMIT,
            &dest,
            &dir.path().join("cache"),
        );
        assert!(result.unwrap_err().contains("local build failed"));
        assert_eq!(fs::read(dest).unwrap(), b"existing app");
    }

    #[test]
    fn source_builds_are_detected() {
        assert!(looks_like_cargo_build(&env::current_exe().unwrap()));
        assert!(looks_like_cargo_build(Path::new(
            "repo/target/release/gopher"
        )));
        assert!(looks_like_cargo_build(Path::new(
            "repo/target/x86_64-pc-windows-msvc/release/gopher.exe"
        )));
        assert!(!looks_like_cargo_build(Path::new("bin/gopher")));
    }

    #[test]
    fn replacement_creates_and_updates_the_destination() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("gopher");
        replace_executable(&dest, b"first build").unwrap();
        assert_eq!(fs::read(&dest).unwrap(), b"first build");
        replace_executable(&dest, b"second build").unwrap();
        assert_eq!(fs::read(&dest).unwrap(), b"second build");
    }
}
