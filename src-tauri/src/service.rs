use std::ffi::CStr;
use std::os::raw::c_char;
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter};

unsafe extern "C" {
    fn register_services_provider();
    fn set_files_callback(cb: extern "C" fn(*const c_char));
}

static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

extern "C" fn on_files_from_finder(json_ptr: *const c_char) {
    if json_ptr.is_null() {
        return;
    }
    let json = unsafe { CStr::from_ptr(json_ptr) }
        .to_string_lossy()
        .into_owned();

    if let Some(app) = APP_HANDLE.get() {
        let _ = app.emit("finder-service-files", &json);
    }
}

/// Registers the macOS Finder Services provider and sets up the file-receive callback.
pub fn init(app: &AppHandle) {
    let _ = APP_HANDLE.set(app.clone());
    unsafe {
        set_files_callback(on_files_from_finder);
        register_services_provider();
    }
}
