use anyhow::{Result, anyhow};
use std::path::Path;

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
        "pdf" => extract_pdf(path)?,
        "docx" => extract_docx(path)?,
        "pptx" => extract_pptx(path)?,
        "xlsx" | "xls" => extract_xlsx(path)?,
        "txt" | "md" | "markdown" => extract_txt(path)?,
        other => return Err(anyhow!("不支持的文件格式: .{}", other)),
    };

    if text.trim().is_empty() {
        return Err(anyhow!("无法读取文件内容（可能是扫描版或加密文件）"));
    }

    Ok(smart_truncate(&text, 2000))
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

fn extract_pdf(path: &str) -> Result<String> {
    let bytes = std::fs::read(path)?;
    let text = pdf_extract::extract_text_from_mem(&bytes).unwrap_or_default();
    Ok(clean_text(text))
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
    Ok(clean_text(text))
}

fn extract_xlsx(path: &str) -> Result<String> {
    use calamine::{Data, Reader, open_workbook_auto};
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
    Ok(lines.join("\n"))
}

fn extract_txt(path: &str) -> Result<String> {
    Ok(clean_text(std::fs::read_to_string(path)?))
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
    Ok(result)
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

fn clean_text(text: String) -> String {
    text.lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}
