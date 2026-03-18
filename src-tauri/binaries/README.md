Bundled `pdftotext` sidecars live in this directory.

Source:
- Xpdf command line tools 4.06
- Download page: https://www.xpdfreader.com/download.html
- macOS archive: https://dl.xpdfreader.com/xpdf-tools-mac-4.06.tar.gz

Expected filenames:
- `pdftotext-universal-apple-darwin`
- `pdftotext-aarch64-apple-darwin`
- `pdftotext-x86_64-apple-darwin`

Notes:
- The GitHub release workflow builds with `--target universal-apple-darwin`, so Tauri expects the universal sidecar file above at bundle time.
- Inside the packaged app, Tauri strips the target suffix and ships the executable as plain `pdftotext`.
