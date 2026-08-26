# xTranslator

一个运行在 YouTube 普通视频与 Shorts 页面上的 Chrome Manifest V3 扩展。xTranslator 使用你自己的翻译服务和 API Key，为视频字幕、标题、简介、评论以及网页划词提供基于上下文的翻译。

> 项目仍在积极开发中。自动化测试覆盖核心逻辑；真实 YouTube 页面和真实翻译服务的组合仍建议在使用前自行验证。

## 功能

- 视频字幕翻译：支持普通 YouTube 视频和 Shorts，提供原文、译文和双语显示模式，默认显示双语字幕。
- 长视频分批翻译：已完成的字幕块会增量写入本地缓存，失败后可以只重试缺失部分。
- 评论翻译：翻译普通视频和 Shorts 中当前已经由 YouTube 渲染的可见评论，也支持已展开的评论线程。
- 划词翻译：选中网页文本即可翻译，也可以通过右键菜单触发；支持可选上下文。
- 多种翻译服务：内置 DeepSeek、OpenAI、Anthropic 和 Agnes AI 配置；除 Agnes AI 外，模型列表从服务商接口动态获取。
- 自动目标语言：跟随浏览器界面语言，不需要单独设置目标语言。
- 本地缓存管理：翻译结果保存在 IndexedDB，可按视频或全部清理。
- 隐私优先：API Key 只保存在扩展的本地存储中，不写入网页、同步存储或日志。

## 工作方式

字幕只使用 YouTube 播放器实际请求并被扩展捕获的 `fmt=json3` 字幕响应。扩展不会把 `.srt` 或 `.txt` 当作生产字幕源，也不会主动请求临时字幕地址。

字幕会先按照时间范围和自然停顿组成稳定的翻译块，再交给翻译模型处理。模型返回的译文通过 block ID 回填到原时间轴，避免因返回顺序变化导致字幕错位。有效视频没有可用字幕时，扩展保持安静，不显示无关的错误提示。

## 安装与使用

### 运行环境

- Google Chrome 或兼容的 Chromium 浏览器
- Node.js
- pnpm `11.6.0`
- 一个已配置额度的翻译服务 API Key

### 从源码构建

```bash
git clone https://github.com/LZKDreamer/xTranslator.git
cd xTranslator
pnpm install
pnpm build
```

### 在 Chrome 中加载

1. 打开 `chrome://extensions`。
2. 开启右上角的“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择本项目根目录。
5. 打开扩展的设置页，选择翻译服务并填写 API Key，点击“加载模型”后选择模型；服务商、API Key 和模型三项完整后会自动保存。
6. 打开 YouTube 视频或 Shorts 页面，使用评论区入口、划词浮层，或播放器中的翻译入口。Shorts 播放器入口默认关闭，可在设置页“字幕显示”中启用；此开关不影响 Shorts 评论翻译。

源码修改后需要重新执行 `pnpm build`，并在扩展管理页点击“重新加载”。

设置页底部的“版本更新”卡片会显示当前版本、更新检查结果和新版下载链接；弹窗也会在发现新版本时提示下载。

### 安装发布包

下载与安装包版本对应的 `xTranslator-版本号.zip`，解压后按上面的“在 Chrome 中加载”步骤选择解压目录。扩展弹窗会通过 jsDelivr 检查更新；发现新版本时会提供对应 zip 的下载链接。下载并解压新版后，在 `chrome://extensions` 中重新加载该目录即可完成更新。

### 发布新版本

发布新版本只需运行：

```powershell
pnpm release -- 0.1.2
```

发布脚本会同步版本号、构建扩展、生成安装包、更新 jsDelivr 所需的更新清单、创建提交与 tag、推送到 GitHub，并验证 CDN 下载链接。GitHub Release 不参与该流程。完整规则见 [发布流程](docs/RELEASE_WORKFLOW.md)。

## 支持的翻译服务

| 服务 | 协议 | 模型来源 |
| --- | --- | --- |
| DeepSeek | OpenAI-compatible | `/models` 动态获取 |
| OpenAI | OpenAI-compatible | `/v1/models` 动态获取 |
| Anthropic | Anthropic Messages | `/v1/models` 动态获取 |
| Agnes AI | OpenAI-compatible | 静态：`agnes-2.5-flash` |

模型列表会根据服务配置和 API 返回动态更新；切换已配置的服务商时会恢复该服务商自己的 API Key 和模型。不同服务的计费、限流、数据保留和隐私政策不同，请在使用前阅读对应服务商的条款。翻译请求会发送到你在设置页选择的服务。

设置页的字幕模式、原文/译文颜色和字号、字幕位置、Shorts 播放器翻译开关、划词翻译开关和上下文选项独立自动保存。Shorts 播放器翻译开关默认关闭，只控制播放器图标，不影响评论翻译；Shorts 字幕使用独立的固定字号。字幕默认自动位于 YouTube 进度条上方；也可在播放器内上下拖动以避开视频自带文字，并可一键恢复默认样式与自动位置。API Key 变更后必须重新加载模型，未完成的翻译服务配置不会覆盖当前已保存配置。

## 开发

```bash
# 类型检查
pnpm typecheck

# 运行自动化测试
pnpm test

# 构建扩展
pnpm build

# 一次执行全部检查
pnpm check
```

项目使用 TypeScript、esbuild、Vitest 和 Chrome Extension Manifest V3。`src/` 是源码目录；`public/` 保存静态资源和 Manifest 模板；构建后会在项目根目录生成 Chrome 可加载的扩展文件，这些文件已被 `.gitignore` 排除。

### 目录结构

```text
src/
├── background/     Service Worker、翻译调度与缓存写入
├── content/        YouTube 页面适配、字幕层、评论和划词翻译
├── options/        扩展设置页
├── popup/          扩展弹窗
└── shared/         消息契约、设置、Provider、YouTube 解析和翻译逻辑
docs/               产品需求、页面契约、工程规范和设计系统
public/             构建时复制到扩展根目录的静态资源
tests/              单元测试与 YouTube fixture
scripts/build.mjs   扩展构建脚本
```

## 隐私与安全

- API Key 通过 `chrome.storage.local` 保存在本机，不使用 `chrome.storage.sync`。
- API Key 不会注入网页 DOM、页面脚本变量或控制台日志。
- 翻译缓存保存在本地 IndexedDB，不保存短期有效的字幕 URL、API Key 或完整请求日志。
- xTranslator 只处理 YouTube 已渲染的页面内容，不调用 YouTube 内部 continuation 接口来预取评论。
- 请不要把 API Key、个人配置或本地调试文件提交到仓库；项目已提供对应的忽略规则。

## 已知限制

- 当前只匹配 `https://www.youtube.com/*` 页面，不支持任意视频网站。
- YouTube 页面结构不是稳定的公开 API；页面改版可能影响字幕、评论或入口挂载。
- 字幕依赖 YouTube 播放器捕获到的真实字幕响应；视频没有可用字幕时不会生成翻译按钮。
- 目标语言跟随浏览器语言，设置页不提供手动覆盖。
- 需要用户自行提供翻译服务 Key，并承担相应的网络请求和服务费用。
- 自动化测试不能替代真实 YouTube 页面 smoke test，尤其是评论懒加载、直播、短视频和服务商限流场景。

## 相关文档

- [产品需求](docs/PRODUCT_REQUIREMENTS.md)
- [YouTube 页面契约](docs/YOUTUBE_PAGE_CONTRACT.md)
- [工程规范](docs/ENGINEERING_STANDARDS.md)
- [设计系统](docs/DESIGN_SYSTEM.md)
- [开发计划](docs/DEVELOPMENT_PLAN.md)

## 贡献

欢迎提交 Issue 和 Pull Request。提交代码前，请至少运行：

```bash
pnpm check
```

涉及 YouTube DOM 结构的修改，请同时更新页面契约、测试 fixture 或相关说明，并避免在日志中输出 API Key、原文请求或服务商响应正文。

## License

本仓库当前未附带许可证。正式添加许可证前，请不要将代码用于再分发或商业化发布。
