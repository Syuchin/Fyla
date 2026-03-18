use crate::ocr;
use anyhow::{anyhow, Context, Result};
use std::path::{Path, PathBuf};
use std::process::Command;

const MAX_EXTRACTED_CHARS: usize = 2000;
const MIN_PDF_TEXT_CHARS: usize = 50;

#[cfg(target_arch = "aarch64")]
const PDFTOTEXT_BINARY_NAME: &str = "pdftotext-aarch64-apple-darwin";
#[cfg(target_arch = "x86_64")]
const PDFTOTEXT_BINARY_NAME: &str = "pdftotext-x86_64-apple-darwin";
#[cfg(not(any(target_arch = "aarch64", target_arch = "x86_64")))]
compile_error!("Unsupported macOS architecture for bundled pdftotext sidecar");

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PdfExtractor {
    Pdftotext,
    PdfKit,
    Ocr,
}

impl PdfExtractor {
    fn label(self) -> &'static str {
        match self {
            Self::Pdftotext => "pdftotext",
            Self::PdfKit => "pdfkit",
            Self::Ocr => "ocr",
        }
    }
}

#[derive(Debug)]
struct PdfSelection {
    extractor: PdfExtractor,
    text: String,
}

/// Extracts text from PDF, DOCX, PPTX, XLSX, TXT, and MD files (truncated to 2000 chars).
pub fn extract_text(path: &str) -> Result<String> {
    let p = Path::new(path);
    let ext = p
        .extension()
        .unwrap_or_default()
        .to_ascii_lowercase()
        .to_string_lossy()
        .to_string();

    let text = match ext.as_str() {
        "pdf" => extract_pdf_text(path)?,
        "docx" => extract_docx(path)?,
        "pptx" => extract_pptx(path)?,
        "xlsx" | "xls" => extract_xlsx(path)?,
        "txt" | "md" | "markdown" => extract_txt(path)?,
        other => return Err(anyhow!("不支持的文件格式: .{}", other)),
    };

    if text.trim().is_empty() {
        return Err(anyhow!("无法读取文件内容（可能是扫描版或加密文件）"));
    }

    Ok(text)
}

pub fn extract_pdf_text(path: &str) -> Result<String> {
    let sidecar = extract_pdf_with_pdftotext(path);
    log_pdf_attempt(path, PdfExtractor::Pdftotext, &sidecar);

    let pdfkit = if effective_len_from_result(&sidecar) >= MIN_PDF_TEXT_CHARS {
        Ok(String::new())
    } else {
        eprintln!(
            "[pdf] falling back to PDFKit for {} after {} chars from pdftotext",
            path,
            effective_len_from_result(&sidecar)
        );
        let result = ocr::pdf_text_from_pdf(path)
            .map(|text| normalize_pdf_text(&text))
            .map_err(|err| anyhow!(err));
        log_pdf_attempt(path, PdfExtractor::PdfKit, &result);
        result
    };

    let ocr = if effective_len_from_result(&sidecar) >= MIN_PDF_TEXT_CHARS
        || effective_len_from_result(&pdfkit) >= MIN_PDF_TEXT_CHARS
    {
        Ok(String::new())
    } else {
        eprintln!(
            "[pdf] falling back to OCR for {} after short text extraction output",
            path
        );
        let result = ocr::ocr_from_pdf(path)
            .map(|text| normalize_pdf_text(&text))
            .map_err(|err| anyhow!(err));
        log_pdf_attempt(path, PdfExtractor::Ocr, &result);
        result
    };

    let selection = select_pdf_text(sidecar, pdfkit, ocr)?;
    eprintln!(
        "[pdf] using {} extractor for {}",
        selection.extractor.label(),
        path
    );
    Ok(smart_truncate(&selection.text, MAX_EXTRACTED_CHARS))
}

fn effective_len_from_result(result: &Result<String>) -> usize {
    result
        .as_ref()
        .map(|text| effective_len(text))
        .unwrap_or_default()
}

fn effective_len(text: &str) -> usize {
    text.trim().chars().count()
}

fn select_pdf_text(
    sidecar: Result<String>,
    pdfkit: Result<String>,
    ocr: Result<String>,
) -> Result<PdfSelection> {
    let sidecar_err = sidecar.as_ref().err().map(|err| err.to_string());
    let pdfkit_err = pdfkit.as_ref().err().map(|err| err.to_string());
    let ocr_err = ocr.as_ref().err().map(|err| err.to_string());

    let sidecar_text = sidecar.unwrap_or_default();
    if effective_len(&sidecar_text) >= MIN_PDF_TEXT_CHARS {
        return Ok(PdfSelection {
            extractor: PdfExtractor::Pdftotext,
            text: sidecar_text,
        });
    }

    let pdfkit_text = pdfkit.unwrap_or_default();
    if effective_len(&pdfkit_text) >= MIN_PDF_TEXT_CHARS {
        return Ok(PdfSelection {
            extractor: PdfExtractor::PdfKit,
            text: pdfkit_text,
        });
    }

    let ocr_text = ocr.unwrap_or_default();
    if !ocr_text.trim().is_empty() {
        return Ok(PdfSelection {
            extractor: PdfExtractor::Ocr,
            text: ocr_text,
        });
    }

    if !pdfkit_text.trim().is_empty() {
        return Ok(PdfSelection {
            extractor: PdfExtractor::PdfKit,
            text: pdfkit_text,
        });
    }

    if !sidecar_text.trim().is_empty() {
        return Ok(PdfSelection {
            extractor: PdfExtractor::Pdftotext,
            text: sidecar_text,
        });
    }

    Err(anyhow!(
        "无法提取 PDF 文本；pdftotext: {}; PDFKit: {}; OCR: {}",
        sidecar_err.unwrap_or_else(|| "empty output".into()),
        pdfkit_err.unwrap_or_else(|| "empty output".into()),
        ocr_err.unwrap_or_else(|| "empty output".into()),
    ))
}

fn log_pdf_attempt(path: &str, extractor: PdfExtractor, result: &Result<String>) {
    match result {
        Ok(text) if !text.trim().is_empty() => {
            eprintln!(
                "[pdf] {} produced {} chars for {}",
                extractor.label(),
                effective_len(text),
                path
            );
        }
        Ok(_) => {
            eprintln!(
                "[pdf] {} produced empty output for {}",
                extractor.label(),
                path
            );
        }
        Err(err) => {
            eprintln!("[pdf] {} failed for {}: {}", extractor.label(), path, err);
        }
    }
}

fn extract_pdf_with_pdftotext(path: &str) -> Result<String> {
    let binary = resolve_pdftotext_sidecar()
        .with_context(|| format!("未找到 pdftotext sidecar for {}", PDFTOTEXT_BINARY_NAME))?;

    let output = Command::new(&binary)
        .args(["-enc", "UTF-8", "-nopgbrk", path, "-"])
        .output()
        .with_context(|| format!("调用 pdftotext 失败: {}", binary.display()))?;

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !stderr.is_empty() {
        eprintln!("[pdf] pdftotext stderr for {}: {}", path, stderr);
    }

    if !output.status.success() {
        let code = output
            .status
            .code()
            .map(|value| value.to_string())
            .unwrap_or_else(|| "terminated by signal".into());
        return Err(anyhow!("退出码 {}: {}", code, stderr));
    }

    Ok(normalize_pdf_text(&String::from_utf8_lossy(&output.stdout)))
}

fn resolve_pdftotext_sidecar() -> Result<PathBuf> {
    if let Ok(path) = std::env::var("FYLA_PDFTOTEXT_PATH") {
        let candidate = PathBuf::from(path);
        if candidate.is_file() {
            return Ok(candidate);
        }
    }

    let mut candidates = Vec::new();
    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(exe_dir) = current_exe.parent() {
            let base_dir = if exe_dir.ends_with("deps") {
                exe_dir.parent().unwrap_or(exe_dir)
            } else {
                exe_dir
            };
            candidates.push(base_dir.join(PDFTOTEXT_BINARY_NAME));
        }
    }

    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(PDFTOTEXT_BINARY_NAME),
    );

    candidates
        .into_iter()
        .find(|candidate| candidate.is_file())
        .ok_or_else(|| anyhow!("未找到 {}", PDFTOTEXT_BINARY_NAME))
}

fn normalize_pdf_text(input: &str) -> String {
    let mut text = input
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .replace('\u{c}', "")
        .replace('ﬁ', "fi")
        .replace('ﬂ', "fl")
        .replace('ﬀ', "ff")
        .replace('ﬃ', "ffi")
        .replace('ﬄ', "ffl");

    text = text
        .lines()
        .map(|line| line.split_whitespace().collect::<Vec<_>>().join(" "))
        .collect::<Vec<_>>()
        .join("\n");

    let mut lines = Vec::new();
    let mut blank_run = 0usize;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            blank_run += 1;
            if blank_run <= 1 && !lines.is_empty() {
                lines.push(String::new());
            }
            continue;
        }

        blank_run = 0;
        lines.push(trimmed.to_string());
    }

    while matches!(lines.last(), Some(last) if last.is_empty()) {
        lines.pop();
    }

    lines.join("\n")
}

fn smart_truncate(text: &str, max_chars: usize) -> String {
    let char_count = text.chars().count();
    if char_count <= max_chars {
        return text.to_string();
    }
    let head_size = max_chars * 3 / 4;
    let tail_size = max_chars - head_size;

    let head_end = text
        .char_indices()
        .nth(head_size)
        .map(|(i, _)| i)
        .unwrap_or(text.len());
    let tail_start = text
        .char_indices()
        .rev()
        .nth(tail_size - 1)
        .map(|(i, _)| i)
        .unwrap_or(0);

    if tail_start <= head_end {
        return text.to_string();
    }

    format!(
        "{}\n\n[...中间内容省略...]\n\n{}",
        &text[..head_end],
        &text[tail_start..]
    )
}

fn extract_docx(path: &str) -> Result<String> {
    use std::io::Read;
    let file = std::fs::File::open(path)?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| anyhow!("无法读取 docx: {}", e))?;

    let mut xml = String::new();
    archive
        .by_name("word/document.xml")
        .map_err(|_| anyhow!("docx 格式异常，找不到 document.xml"))?
        .read_to_string(&mut xml)?;

    // 去掉所有 XML 标签，只保留文本
    let mut text = String::new();
    let mut in_tag = false;
    let mut last_was_space = false;
    for ch in xml.chars() {
        match ch {
            '<' => {
                in_tag = true;
                text.push(' ');
            }
            '>' => {
                in_tag = false;
            }
            _ if !in_tag => {
                if ch.is_whitespace() {
                    if !last_was_space {
                        text.push(' ');
                    }
                    last_was_space = true;
                } else {
                    text.push(ch);
                    last_was_space = false;
                }
            }
            _ => {}
        }
    }
    Ok(smart_truncate(&clean_text(&text), MAX_EXTRACTED_CHARS))
}

fn extract_xlsx(path: &str) -> Result<String> {
    use calamine::{open_workbook_auto, Data, Reader};
    let mut workbook = open_workbook_auto(path).map_err(|e| anyhow!("无法读取 xlsx: {}", e))?;

    let sheet_names = workbook.sheet_names().to_vec();
    let first = sheet_names
        .first()
        .ok_or_else(|| anyhow!("xlsx 没有 sheet"))?
        .clone();

    let range = workbook
        .worksheet_range(&first)
        .map_err(|e| anyhow!("读取 sheet 失败: {}", e))?;

    let mut lines = Vec::new();
    for row in range.rows().take(30) {
        let cells: Vec<String> = row
            .iter()
            .filter_map(|c| match c {
                Data::Empty => None,
                other => Some(other.to_string()),
            })
            .collect();
        if !cells.is_empty() {
            lines.push(cells.join("\t"));
        }
    }
    Ok(smart_truncate(&lines.join("\n"), MAX_EXTRACTED_CHARS))
}

fn extract_txt(path: &str) -> Result<String> {
    Ok(smart_truncate(
        &clean_text(&std::fs::read_to_string(path)?),
        MAX_EXTRACTED_CHARS,
    ))
}

fn extract_pptx(path: &str) -> Result<String> {
    use std::io::Read;
    let file = std::fs::File::open(path)?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| anyhow!("无法读取 pptx: {}", e))?;

    let mut slides: Vec<(usize, String)> = Vec::new();
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| anyhow!("pptx 读取失败: {}", e))?;
        let name = entry.name().to_string();
        if let Some(num) = name
            .strip_prefix("ppt/slides/slide")
            .and_then(|s| s.strip_suffix(".xml"))
            .and_then(|s| s.parse::<usize>().ok())
        {
            let mut xml = String::new();
            entry.read_to_string(&mut xml)?;
            let text = strip_xml_tags(&xml);
            if !text.is_empty() {
                slides.push((num, text));
            }
        }
    }
    slides.sort_by_key(|(num, _)| *num);
    let result = slides
        .into_iter()
        .map(|(num, text)| format!("[Slide {}] {}", num, text))
        .collect::<Vec<_>>()
        .join("\n");
    Ok(smart_truncate(&result, MAX_EXTRACTED_CHARS))
}

fn strip_xml_tags(xml: &str) -> String {
    let mut text = String::new();
    let mut in_tag = false;
    let mut last_was_space = false;
    for ch in xml.chars() {
        match ch {
            '<' => {
                in_tag = true;
            }
            '>' => {
                in_tag = false;
                text.push(' ');
            }
            _ if !in_tag => {
                if ch.is_whitespace() {
                    if !last_was_space {
                        text.push(' ');
                    }
                    last_was_space = true;
                } else {
                    text.push(ch);
                    last_was_space = false;
                }
            }
            _ => {}
        }
    }
    text.trim().to_string()
}

fn clean_text(text: &str) -> String {
    text.lines()
        .map(|line| line.trim())
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_pdf_text_replaces_ligatures_and_page_breaks() {
        let text = normalize_pdf_text("A ﬁne ﬂow\u{c}\n\nB  test");
        assert_eq!(text, "A fine flow\n\nB test");
    }

    #[test]
    fn normalize_pdf_text_collapses_whitespace_and_blank_runs() {
        let text = normalize_pdf_text(" Line   one \n\n\n\tLine\t two \n");
        assert_eq!(text, "Line one\n\nLine two");
    }

    #[test]
    fn select_pdf_text_falls_back_after_primary_error() {
        let selection = select_pdf_text(
            Err(anyhow!("parser failed")),
            Ok("Recovered from PDFKit".into()),
            Ok(String::new()),
        )
        .expect("should choose fallback extractor");

        assert_eq!(selection.extractor, PdfExtractor::PdfKit);
        assert_eq!(selection.text, "Recovered from PDFKit");
    }

    #[test]
    fn select_pdf_text_prefers_ocr_for_effectively_empty_text_layers() {
        let selection = select_pdf_text(
            Ok("too short".into()),
            Ok("still short".into()),
            Ok("OCR extracted content".into()),
        )
        .expect("should choose OCR");

        assert_eq!(selection.extractor, PdfExtractor::Ocr);
        assert_eq!(selection.text, "OCR extracted content");
    }

    #[test]
    fn bundled_pdftotext_extracts_repo_sample_pdf() {
        let sample = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("test-data")
            .join("sample-text.pdf");
        let text = extract_pdf_with_pdftotext(sample.to_string_lossy().as_ref())
            .expect("bundled pdftotext should extract sample pdf");

        assert!(text.contains("Hello PDF sidecar sample for regression tests."));
    }

    #[test]
    #[ignore = "set FYLA_REGRESSION_PDF to manually verify a problematic PDF"]
    fn manual_regression_pdf_extracts_title_without_ocr() {
        let path = std::env::var("FYLA_REGRESSION_PDF")
            .expect("set FYLA_REGRESSION_PDF to the problematic PDF path");
        let sidecar_text =
            extract_pdf_with_pdftotext(&path).expect("pdftotext sidecar should handle the PDF");
        assert!(
            effective_len(&sidecar_text) >= MIN_PDF_TEXT_CHARS,
            "reported PDF should not require OCR"
        );

        let text = extract_pdf_text(&path).expect("full extractor should succeed");
        assert!(
            text.contains("Emotional intelligence of Large Language Models"),
            "expected extracted title in text preview"
        );
    }
}
