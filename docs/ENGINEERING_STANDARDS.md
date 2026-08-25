# 工程规范

## 技术基线

- Chrome Manifest V3、TypeScript 严格模式、pnpm。
- 业务模块不能直接依赖 YouTube 全局变量、原始 DOM 或具体 LLM HTTP 格式。
- **唯一例外**：MAIN world bridge（`content/main-world-bridge.ts`，在 `manifest.json` 中声明为 `world: "MAIN"`）是被允许访问页面全局/播放器内部以获取字幕正文（含 `pot` 的 timedtext 请求）的专属模块；它通过命名空间 `window.postMessage` 协议把数据回传给隔离世界的内容脚本。除此之外，任何业务代码不得直接读 `ytInitial*`、播放器内部或 DOM 结构。
- 所有跨层消息使用显式 TypeScript 类型和 runtime validation；不使用 `any`。
- 不记录 API Key、完整字幕、评论正文或 LLM 完整请求体。

## 推荐包结构

```text
src/
  background/          # service worker、请求队列、缓存调度
  content/             # YouTube DOM 观察与受控注入
  options/             # 设置页
  popup/               # 扩展弹窗
  shared/
    contracts/         # 消息、存储、领域模型
    locale/            # 目标语言解析与 BCP-47 规范化
    providers/         # LLM adapter 与 provider registry
    youtube/           # 页面契约、脚本解析、字幕/评论适配器
    translation/       # 分块、提示词、结果校验
    storage/           # IndexedDB repository
    icons/             # 唯一图标出口（内联已用图标，不依赖图标库）
public/                # Manifest、Popup/设置页静态源文件、设计 token 与品牌资产
docs/
tests/
  fixtures/youtube/    # 仅存脱敏静态 fixture
```

## 命名规则

- 文件和目录：`kebab-case`，例如 `youtube-page-contract.ts`。
- 类型、接口、类、React 组件：`PascalCase`，例如 `CaptionTrack`。
- 变量、函数、字段：`camelCase`，例如 `resolveTargetLocale`。
- 常量：`UPPER_SNAKE_CASE`，仅用于不可变且有跨模块意义的值。
- 布尔值以 `is`、`has`、`can` 或 `should` 开头。
- 异步函数使用动词命名：`loadCaptionTracks`、`translateSegments`。

## 禁止硬编码

禁止把以下内容散落为字符串、数组下标或组件内常量：

- YouTube 选择器、`ytInitial*` 路径、continuation token 与临时字幕 URL；
- LLM Base URL、模型 ID、请求头和上下文窗口；
- 目标语言、提示词版本、分块 token 预算和缓存版本；
- UI 图标路径、颜色、间距、圆角与 z-index。

这些值只能存在于版本化 registry、design token、设置 schema 或测试 fixture 中。动态数据必须先验证再使用；缺失数据必须进入明确的失败状态。

## 图标政策

- 图标是**可选**的：既可以从图标库（如 lucide）按需引入，也可以把实际用到的图标**内联**进项目。本仓库即采用内联：`src/shared/icons/index.ts` 存放当前用到的图标，扩展包不依赖任何图标库运行时。**不强制**使用某一图标库，项目**不硬依赖**图标库。
- `src/shared/icons/index.ts` 是唯一图标出口，只暴露实际使用的图标；禁止在业务代码里手写 SVG、复制 SVG、内联 `<svg>` 字符串或使用 emoji / 图标字体。
- Popup/设置页的 CSS 源文件位于 `public/`；根目录下对应的 `popup/`、`options/`、`styles/` 由构建生成，禁止直接修改生成产物。
- 初始允许的图标语义：`Captions`、`MousePointer2`、`Settings`、`Trash2`、`RefreshCw`、`Copy`、`Check`、`ChevronDown`、`CircleAlert`、`LoaderCircle`、`Eye`、`PanelRight`、`Sparkles`、`X`。三个翻译主入口使用已选品牌方向的 PNG 品牌标记，不把 logo 当作功能图标登记。
- 新增图标必须在该图标确实是当前功能需要时，且在设计系统的“图标语义”表登记后才可引入。

## 完成标准

每项功能合入前至少满足：类型检查、单元测试、对应 fixture 解析测试、错误/空状态验证、无 API Key 泄漏检查，以及手动验证 YouTube 观看页切换后不会重复注入 UI。
