use std::ffi::{CStr, CString};
use std::os::raw::c_char;

unsafe extern "C" {
    fn recognize_text_from_path(path: *const c_char) -> *mut c_char;
    fn recognize_text_from_pdf(path: *const c_char) -> *mut c_char;
}

/// Recognizes text from an image file using macOS Vision framework OCR.
pub fn ocr_from_file(path: &str) -> Result<String, String> {
    let c_path = CString::new(path).map_err(|e| format!("路径编码错误: {}", e))?;
    unsafe { read_and_free(recognize_text_from_path(c_path.as_ptr())) }
}

/// Recognizes text from the first page of a PDF (fallback for scanned PDFs).
pub fn ocr_from_pdf(path: &str) -> Result<String, String> {
    let c_path = CString::new(path).map_err(|e| format!("路径编码错误: {}", e))?;
    unsafe { read_and_free(recognize_text_from_pdf(c_path.as_ptr())) }
}

unsafe fn read_and_free(ptr: *mut c_char) -> Result<String, String> {
    if ptr.is_null() {
        return Err("OCR 返回空指针".into());
    }
    let result = unsafe { CStr::from_ptr(ptr) }
        .to_string_lossy()
        .into_owned();
    unsafe { libc::free(ptr as *mut _) };
    Ok(result)
}
