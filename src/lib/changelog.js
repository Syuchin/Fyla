// 每次发版在数组头部加一条即可
export const changelog = [
  {
    version: '1.0.0',
    date: '2026-02-24',
    notes: [
      'i18n: Chinese / English interface with one-click toggle',
      'Auto-update: silent background updates via GitHub Releases',
      'LLM streaming: real-time AI rename progress',
      'Finder right-click menu integration',
      'Drag-and-drop folder recursive scanning',
      'Keyboard shortcuts: Cmd+Enter confirm, Esc dismiss, Tab navigate',
      'Filename validation: illegal chars, duplicates, length limits',
      'Five naming styles: kebab-case, Train-Case, snake_case, camelCase, PascalCase',
      'Auto-save settings',
    ],
  },
  {
    version: '0.1.1',
    date: '2026-02-23',
    notes: [
      'Non-intrusive new file detection (notification only)',
      'Tray badge shows pending file count',
      'Titlebar pending badge with navigation',
      'Default destination folder setting',
    ],
  },
  {
    version: '0.1.0',
    date: '2026-02-23',
    notes: [
      'AI file rename (PDF, Word, Excel, ZIP)',
      'Folder watch mode with auto-detection',
      'Batch confirm panel',
      'Ollama local / OpenAI-compatible API support',
      'Naming templates and style customization',
      'One-click undo',
      'macOS native: vibrancy, dark mode',
    ],
  },
]
