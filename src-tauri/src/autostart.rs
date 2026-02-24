unsafe extern "C" {
    fn autostart_enable() -> i32;
    fn autostart_disable() -> i32;
    fn autostart_is_enabled() -> i32;
}

/// Enables or disables launch-at-login via the native macOS API.
pub fn set_autostart(enabled: bool) -> Result<(), String> {
    let result = unsafe {
        if enabled {
            autostart_enable()
        } else {
            autostart_disable()
        }
    };
    if result == 0 {
        Ok(())
    } else {
        Err("设置开机自启失败".into())
    }
}

/// Returns whether launch-at-login is currently enabled.
pub fn is_enabled() -> bool {
    unsafe { autostart_is_enabled() == 1 }
}
