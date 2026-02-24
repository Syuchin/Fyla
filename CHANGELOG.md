# Changelog

## v1.0.0

### Highlights
- **i18n** — Chinese / English interface with one-click language toggle
- **Auto-update** — silent background updates via GitHub Releases (Tauri updater)
- **Code quality** — cargo clippy clean, English doc comments on all public APIs

### New Features
- **LLM Streaming** — real-time token streaming during AI rename, via Tauri Channel
- **Finder Services** — right-click files in Finder → "Rename with Fyla"
- **Folder recursion** — drag-drop folders auto-expand to file list (walkdir)
- **Keyboard shortcuts** — Cmd+Enter confirm all, Esc dismiss, Tab/Shift+Tab navigate, Cmd+Z undo
- **Filename validation** — illegal chars, length limits, empty fallback, duplicate detection
- **Train-Case** — new naming style option

### Improvements
- OpenAI structured outputs (response_format), Ollama num_predict limit
- Batch rename with per-file success/failure results
- FSEvents debouncing via notify-debouncer-full
- Shared prompt builder for Ollama/OpenAI
- Auto-save settings (no save button needed)

### Infra
- Rust edition 2024
- GitHub Actions CI for automated releases
- Ad-hoc signing for distribution without Apple Developer account
- Tauri v2 capabilities and security scopes

## v0.1.0

- Initial release: AI-powered file renaming
- Ollama / OpenAI dual backend
- PDF, Office, image EXIF, OCR text extraction
- Folder watching with auto-rename
- Rename history and undo
- macOS native vibrancy UI
