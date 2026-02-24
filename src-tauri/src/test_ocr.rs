#[cfg(test)]
mod tests {
    use crate::ocr;

    #[test]
    fn test_ocr_from_file_with_icon() {
        let result = ocr::ocr_from_file("icons/icon.png");
        assert!(result.is_ok(), "OCR 图标不应崩溃: {:?}", result);
    }

    #[test]
    fn test_ocr_from_file_nonexistent() {
        let result = ocr::ocr_from_file("/tmp/nonexistent_test_image.png");
        assert!(result.is_ok(), "不存在的文件不应崩溃: {:?}", result);
    }

    #[test]
    fn test_ocr_from_pdf_nonexistent() {
        let result = ocr::ocr_from_pdf("/tmp/nonexistent_test.pdf");
        assert!(result.is_ok(), "不存在的 PDF 不应崩溃: {:?}", result);
    }
}
