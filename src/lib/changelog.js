// 每次发版在数组头部加一条即可
export const changelog = [
  {
    version: '1.0.1',
    date: '2026-02-24',
    notes: [
      '修复检查更新 UI 布局',
      '修复检查更新报错问题',
      '修复 release workflow 自动发布',
    ],
  },
  {
    version: '1.0.0',
    date: '2026-02-24',
    notes: [
      '国际化：中英文界面一键切换',
      '自动更新：通过 GitHub Releases 静默后台更新',
      'LLM 流式输出：实时 AI 重命名进度',
      'Finder 右键菜单集成',
      '拖拽文件夹递归扫描',
      '快捷键：Cmd+Enter 确认、Esc 关闭、Tab 导航',
      '文件名校验：非法字符、重复名称、长度限制',
      '五种命名风格：kebab-case、Train-Case、snake_case、camelCase、PascalCase',
      '设置自动保存',
    ],
  },
  {
    version: '0.1.1',
    date: '2026-02-23',
    notes: [
      '无打扰式新文件检测（仅通知）',
      '托盘图标显示待处理文件数量',
      '标题栏待处理徽标与导航',
      '默认目标文件夹设置',
    ],
  },
  {
    version: '0.1.0',
    date: '2026-02-23',
    notes: [
      'AI 文件重命名（PDF、Word、Excel、ZIP）',
      '文件夹监听模式自动检测',
      '批量确认面板',
      '支持 Ollama 本地 / OpenAI 兼容 API',
      '命名模板与风格自定义',
      '一键撤销',
      'macOS 原生体验：毛玻璃效果、深色模式',
    ],
  },
]
