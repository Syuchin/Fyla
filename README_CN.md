<div align="center">
  <img src="assets/title.png" height="80" alt="Fyla" />
  <p><strong>AI 驱动的智能文件重命名工具。</strong><br>拖入文件，自动生成有意义的文件名。</p>

  <p>
    <a href="https://github.com/Syuchin/Fyla/releases"><img src="https://img.shields.io/github/v/release/Syuchin/Fyla?style=flat-square&color=00c853" alt="Release" /></a>
    <a href="https://github.com/Syuchin/Fyla/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="License" /></a>
    <a href="https://github.com/Syuchin/Fyla"><img src="https://img.shields.io/github/stars/Syuchin/Fyla?style=flat-square" alt="Stars" /></a>
    <a href="https://github.com/Syuchin/Fyla/releases"><img src="https://img.shields.io/badge/platform-macOS%2013%2B-lightgrey?style=flat-square" alt="Platform" /></a>
  </p>

  <p>
    <a href="./README.md">English</a> ·
    <a href="https://github.com/Syuchin/Fyla/releases">下载</a> ·
    <a href="https://github.com/Syuchin/Fyla/issues">反馈问题</a>
  </p>

  <img src="assets/Demonstration.gif" width="680" alt="Fyla 演示" />
</div>

## 功能

- **AI 重命名** -- 用大语言模型读取文件内容，生成描述性文件名
- **本地优先** -- 支持 [Ollama](https://ollama.com)，完全离线运行，文件不会离开你的电脑
- **兼容云端** -- 同时支持任何 OpenAI 兼容 API（OpenAI、DeepSeek、Groq 等）
- **文本提取** -- 读取 PDF、DOCX、PPTX、XLSX 及纯文本文件内容
- **图片理解** -- 基于 macOS Vision 框架的 OCR、EXIF 元数据读取，可选 VLM 多模态模型支持
- **文件夹监听** -- 监控指定文件夹，新文件出现时自动重命名
- **Finder 集成** -- 在 Finder 中右键选择文件，通过 macOS 服务菜单直接发送到 Fyla
- **批量重命名** -- 一次处理多个文件，实时流式显示进度
- **撤销** -- 完整的重命名历史记录，一键还原
- **命名模板** -- 自定义输出格式，支持 `{type}`、`{title}`、`{date}`、`{author}` 等变量
- **命名风格** -- kebab-case、camelCase、PascalCase、snake_case、Train-Case
- **轻量** -- 二进制约 8MB，内存占用低。基于 Tauri + Rust 构建，不是 Electron

## 安装

### 下载

从 [GitHub Releases](https://github.com/Syuchin/Fyla/releases) 下载 `.dmg` 安装包。

> 要求 macOS 13.0+。应用使用 ad-hoc 签名（无 Apple 开发者证书），首次打开可能需要右键 > 打开。

### 从源码构建

前置要求：
- [Rust](https://rustup.rs/)（stable）
- [Node.js](https://nodejs.org/)（v18+）
- Xcode 命令行工具（`xcode-select --install`）

```bash
git clone https://github.com/Syuchin/Fyla.git
cd fyla
npm install
npm run tauri build
```

构建产物在 `src-tauri/target/release/bundle/dmg/` 目录下。

## 配置

从状态栏托盘图标菜单打开设置。

### Ollama（本地离线）

1. 安装并启动 [Ollama](https://ollama.com)
2. 拉取模型：`ollama pull llama3.2`
3. 在 Fyla 设置中选择 **Ollama** 作为提供商
4. 默认地址 `http://localhost:11434`，按需修改
5. 模型名称填写你拉取的模型名

### OpenAI 兼容 API

1. 选择 **OpenAI** 作为提供商
2. 填入 API Key
3. 设置 Base URL（默认：`https://api.openai.com/v1`）
   - DeepSeek：`https://api.deepseek.com/v1`
   - Groq：`https://api.groq.com/openai/v1`
4. 设置模型名（如 `gpt-4o-mini`、`deepseek-chat`）

### VLM（视觉语言模型）

处理图片文件时，可以启用 VLM 让多模态模型直接「看」图片，而不仅依赖 OCR 文字。支持 Ollama 视觉模型（如 `llava`）或支持图片输入的云端 API。

## 技术栈

- **后端**：Rust，Tauri v2
- **前端**：Preact，Vite
- **OCR**：macOS Vision 框架（通过原生 C 桥接）
- **文件解析**：pdf-extract、calamine、quick-xml、zip
- **macOS 原生特性**：窗口毛玻璃效果、状态栏托盘图标、NSServices 服务菜单、FSEvents 文件监听

## 参与贡献

欢迎提 Issue 和 PR。前往 [Issue 页面](https://github.com/Syuchin/Fyla/issues) 查看。

## 许可证

[MIT](LICENSE)
