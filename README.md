# AI for Science - Zotero 插件

一个功能强大的 Zotero 插件，集成了 AI 聊天、MCP（Model Context Protocol）支持、RAG（检索增强生成）和学术研究辅助功能。


## ✨ 功能特性

### 🤖 AI 聊天功能

- **多 LLM 提供商支持**
  - OpenAI (GPT-3.5, GPT-4 等)
  - DeepSeek (包括 DeepSeek-R1 推理模型)
  - Google Gemini
  - Anthropic Claude
  - 自定义 OpenAI 兼容 API

- **智能对话模式**
  - **Ask 模式**：快速问答，适合简单问题
  - **Agent 模式**：支持工具调用，可执行复杂任务和多轮对话

- **流式响应**：实时显示 AI 回复，提升用户体验

### 📄 PDF 处理

- 自动提取 PDF 文本内容
- 支持选中文本的上下文解释
- 智能识别论文标题和摘要
- PDF 文本缓存机制，提升性能

### 🔍 RAG (检索增强生成)

- **多种嵌入模型支持**
  - OpenAI Embeddings
  - Google Gemini Embeddings
  - 本地 TF-IDF 嵌入（无需 API，离线可用）
  - 自定义嵌入服务

- **智能文档分块**
  - 自动将长文档分割为语义块
  - 基于相似度的上下文检索
  - 支持大文档的高效处理

### 🔌 MCP (Model Context Protocol) 支持

- 连接 MCP 服务器
- 动态工具发现和调用
- 支持多个 MCP 服务器同时连接
- 工具选择和管理界面

### 📚 学术研究辅助

- **DBLP 集成**
  - 作者信息查询
  - 论文搜索和导入
  - 作者 ORCID 查询
  - 论文集合管理

- **学术简历生成**
  - 基于论文和数据集自动生成作者简介
  - 支持多语言输出

- **论文组对话**
  - 支持多篇论文的联合分析
  - 跨文档信息检索

### 🎨 用户界面

- 现代化的聊天界面
- 支持 Markdown 格式渲染
- 响应式设计，适配不同屏幕
- 中英文双语支持

## 🚀 安装方法

### 方法一：从源码构建（推荐）

1. **克隆仓库**
   ```bash
   git clone https://github.com/your-username/ai-for-science-zotero.git
   cd ai-for-science-zotero
   ```

2. **安装依赖**
   ```bash
   npm install
   ```

3. **构建插件**
   ```bash
   npm run build
   ```

4. **安装到 Zotero**
   - 打开 Zotero
   - 进入 `工具` → `插件` → `从文件安装...`
   - 选择 `.scaffold/build/ai_mcp.xpi` 文件

### 方法二：从 Release 下载

1. 访问 [Releases 页面](https://github.com/whu-totemdb/DB4S)
2. 下载最新版本的 `.xpi` 文件
3. 在 Zotero 中通过 `工具` → `插件` → `从文件安装...` 安装

### 系统要求

- Zotero 7.0 或更高版本

## ⚡ 快速开始

### 1. 配置 AI 提供商

安装插件后，首次使用需要配置 AI 提供商：

1. 打开 Zotero 设置（`编辑` → `首选项`）
2. 找到 `AI for Science` 标签页
3. 选择 AI 提供商（如 OpenAI、DeepSeek 等）
4. 输入 API Key 和 Base URL（如需要）
5. 选择模型（如 `gpt-4`、`deepseek-chat` 等）

### 2. 开始对话

1. 在 Zotero 中选中一篇论文
2. 点击论文，选择 `AI Assistant` → `Chat with Paper`
3. 在弹出的聊天窗口中输入问题
4. 选择对话模式：
   - **Ask 模式**：快速问答
   - **Agent 模式**：支持工具调用

### 3. 使用选中文本

1. 在 PDF 阅读器中选中一段文本
2. 选择 `AI Assistant` → `Explain Selected Text`
3. AI 将基于上下文解释选中的内容

## ⚙️ 配置说明

### AI 提供商配置

#### OpenAI

```
Provider: OpenAI
Base URL: https://api.openai.com/v1 (默认)
API Key: sk-...
Model: gpt-4, gpt-3.5-turbo 等
```

#### DeepSeek

```
Provider: DeepSeek
Base URL: https://api.deepseek.com/v1 (默认)
API Key: sk-...
Model: deepseek-chat, deepseek-reasoner 等
```

#### Google Gemini

```
Provider: Gemini
API Key: (从 Google AI Studio 获取)
Model: gemini-pro, gemini-pro-vision 等
```

#### Anthropic Claude

```
Provider: Claude
Base URL: https://api.anthropic.com/v1 (默认)
API Key: sk-ant-...
Model: claude-3-opus, claude-3-sonnet 等
```

#### 自定义提供商

```
Provider: Custom
Base URL: (你的 API 端点)
API Key: (你的 API Key)
Model: (你的模型名称)
```

### RAG 配置

#### 嵌入提供商

- **Local/TF-IDF**：本地 TF-IDF 嵌入，无需 API，完全离线
- **OpenAI**：使用 OpenAI 的嵌入模型
- **Gemini**：使用 Google Gemini 的嵌入模型
- **Custom**：自定义嵌入服务

#### 配置参数

- **Chunk Size**：文档分块大小（默认 1000 字符）
- **Chunk Overlap**：分块重叠大小（默认 200 字符）
- **Top K**：检索的相似块数量（默认 5）

### MCP 配置

1. 在设置中找到 `MCP Servers` 部分
2. 添加 MCP 服务器：
   - **Name**：服务器名称
   - **SSE URL**：服务器事件流 URL
   - **API Key**：（如需要）
3. 连接后，可用工具将自动显示
4. 在 Agent 模式下选择要使用的工具

## 📖 使用指南

### 基础对话

#### 论文摘要
```
请总结这篇论文的主要内容
```

#### 论文解释
```
请解释这篇论文的方法部分
```

#### 选中文本解释
1. 在 PDF 中选中文本
2. 选择 `Explain Selected Text`
3. AI 将基于上下文解释选中内容

### Agent 模式功能

#### 作者信息查询
```
请查找这篇论文第一作者的其他论文
```

#### 相关论文搜索
```
请帮我找一些与这篇论文相关的研究
```

#### 学术简历生成
```
请为这篇论文的第一作者生成学术简历
```

### 论文组分析

1. 选择多篇论文（Ctrl/Cmd + 点击）
2. 选择 `AI Assistant` → `Chat with Papers`
3. 可以询问跨论文的问题：
   ```
   请比较这几篇论文的研究方法
   ```

### MCP 工具使用

1. 在设置中配置并连接 MCP 服务器
2. 在 Agent 模式下，工具会自动可用
3. 询问需要使用工具的问题：
   ```
   请查询作者在 SciSciNet 上的研究轨迹
   ```


### 添加新功能

1. **添加新的 AI 提供商**
   - 在 `src/modules/chat.ts` 中的 `callLLMStream` 函数添加新的 provider 分支
   - 在设置界面添加相应的配置项

2. **添加新的工具**
   - 通过 MCP 服务器添加工具（推荐）
   - 或直接在代码中实现工具函数

3. **自定义提示词**
   - 提示词定义在 `src/modules/chat.ts` 中
   - 可以修改 `systemPrompt` 变量来自定义行为

## ❓ 常见问题

### Q: 插件无法加载？

A: 请检查：
1. Zotero 版本是否 >= 6.0
2. 插件文件是否完整
3. 查看 Zotero 错误日志（`帮助` → `调试输出`）

### Q: API 调用失败？

A: 请确认：
1. API Key 是否正确
2. Base URL 是否正确（注意不要有多余的斜杠）
3. 网络连接是否正常
4. API 配额是否充足

### Q: PDF 文本提取失败？

A: 可能原因：
1. PDF 文件已加密或受保护
2. PDF 是扫描件（图片格式）
3. PDF 文件损坏

### Q: RAG 功能不工作？

A: 检查：
1. 嵌入提供商配置是否正确
2. API Key 是否有效（如果使用 API 提供商）
3. 文档是否足够长（RAG 仅在文档 > 15000 字符时启用）

### Q: MCP 工具无法使用？

A: 确认：
1. MCP 服务器是否已连接
2. 是否在 Agent 模式下
3. 工具是否已选择启用
4. 服务器 URL 和 API Key 是否正确



## 📝 更新日志

### v1.0.0

- ✨ 初始版本发布
- 🤖 支持多 LLM 提供商
- 🔍 RAG 功能
- 🔌 MCP 支持
- 📚 DBLP 集成
- 📄 PDF 处理



## 🌟 Star History

如果这个项目对你有帮助，请考虑给它一个 Star ⭐

---

**注意**：使用本插件需要配置相应的 AI API Key，可能产生费用。请根据你的使用情况合理配置和使用。
