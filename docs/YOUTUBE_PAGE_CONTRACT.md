# YouTube 视频与 Shorts 页面数据契约

> 目的：记录实测页面事实，防止后续迭代根据记忆或网络示例猜测 YouTube 数据。此文档不是 YouTube 的公开 API 文档；页面结构可能改变。

## 采样记录

- 采样日期：2026-08-24
- 页面：`https://www.youtube.com/watch?v=8vvWTz6N7Qg`
- 页面标题：`Temporal awareness with GPT-Live`
- 视频 ID：`8vvWTz6N7Qg`
- 时长：`119` 秒
- 当前页面语言：中文界面
- 字幕轨道：1 条英文自动字幕（`languageCode: en`，`vssId: a.en`，`kind: asr`）

采样时页面内联脚本中存在 `var ytInitialPlayerResponse = {...}`（约 111 KB）和 `var ytInitialData = {...}`（约 551 KB）。扩展隔离世界不能假设能直接读取 `window.ytInitialPlayerResponse`；实测读取应通过内联脚本文本解析，或通过明确的 MAIN world bridge 获取并校验数据。YouTube 单页切换后旧内联脚本可能暂时保留，因此 bridge 应优先读取当前播放器响应，并以地址栏视频 ID 校验；不匹配的响应不能用于挂载按钮、读取缓存或显示字幕。

**Shorts 补充采样（2026-08-26）：**页面 `https://www.youtube.com/shorts/hMMWdXVsKIw` 使用 `#shorts-player`，顶部可见工具栏为 `.ytp-chrome-top-buttons`。CC、更多和全屏控件并不都以可访问的 light-DOM 子节点出现，因此扩展按钮只能挂到该工具栏并按其实际坐标定位，不能假设可以插入 CC 节点内部。评论展开面板为 `ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-comments-section"]`，内部包含 `ytd-comments`、`ytd-comment-view-model`、`#content-text` 和带 `lc` 参数的评论链接。

## 视频与字幕

### 已验证的响应路径

```text
ytInitialPlayerResponse
├─ videoDetails
│  ├─ videoId
│  ├─ title
│  ├─ author
│  ├─ lengthSeconds
│  ├─ shortDescription
│  └─ viewCount
└─ captions.playerCaptionsTracklistRenderer
   ├─ captionTracks[]
   ├─ audioTracks[]
   ├─ translationLanguages[]
   └─ defaultAudioTrackIndex
```

字幕元数据不是所有视频都会返回：YouTube 可能省略 `captions` 或
`playerCaptionsTracklistRenderer`，这表示有效视频没有可用字幕，而不是观看页不受支持。
解析结果应保留视频快照并返回空的 `captionTracks`/`translationLanguages`；只要当前视频存在字幕轨道，无论原生字幕按钮开启、关闭还是不可用，都应挂载翻译按钮。仅当 `captionTracks` 为空时，才用以下 DOM 条件作为播放器已有字幕的兜底信号：按钮不含 `aria-disabled="true"`、`disabled` 属性或 `ytp-button-disabled` class，且 `aria-pressed="true"` 或含 `ytp-button-pressed` class。字幕轨道为空且不满足该条件时不挂载。按钮首次挂载前需等待播放器状态短暂稳定；同一视频已挂载后，临时不完整的播放器响应不得移除按钮。YouTube 的全局“默认开启字幕”偏好不作为单独的显示依据。

### 运行时数据模型

```ts
interface YouTubeCaptionTrack {
  baseUrl: string;
  vssId: string;
  languageCode: string;
  kind?: 'asr' | string;
  isTranslatable?: boolean;
  name: string;
}

interface YouTubeVideoSnapshot {
  videoId: string;
  title: string;
  author: string;
  lengthSeconds: number;
  shortDescription: string;
  captionTracks: YouTubeCaptionTrack[];
  translationLanguages: Array<{ languageCode: string; name: string }>;
}

interface TranscriptSegment {
  id: string;
  startMs: number;
  durationMs: number;
  sourceText: string;
  fragments?: Array<{
    text: string;
    offsetMs?: number;
  }>;
}
```

字幕片段进一步经 `shared/translation/block-builder.ts` 处理：同一事件中的多句先按句末标点拆开，再按 500ms 自然停顿、16 秒硬时长上限、token 预算与可读性上限合并为“翻译块”（`TranslationBlockInput`：`id/segmentIds/startMs/endMs/sourceText/isSilent`）。block 默认约束为 48 个估算源 token，并有语言相关的字符可读性保护，以优先保持连续句在同一时间范围；块 ID 由片段稳定 ID 与源文本派生。相同开始时间保持原始 JSON3 顺序；解析阶段会合并重叠的重复事件，但不同事件保留原始时间；标记与前一条字幕重叠时不强制切块；短的无标点续句在满足缺口、token 和总时长条件时合并。显示层只裁短前一条的视觉重叠，不把后一条字幕开始时间往后推；标点-only 或非语言标记块不送入 LLM。LLM 对整块做合并断句与去标签翻译，译文以稳定块 ID 回填并写入缓存，不能按模型返回顺序匹配。

译文进入缓存和显示前经 `cleanTranslatedCaptionText` 统一处理：所有目标语言保留自然标点，只移除字幕专用标记和装饰性噪声；中文不人为插入词间空格，英文、数字和专有名词之间的有效空格予以保留。由于当前 YouTube JSON3 主要提供事件级/片段级时间而非词级时间，字符上限只作为可读性保护，不单独按固定字符数截断完整原始事件；长句优先依靠句末、停顿、token 和 16 秒时长边界处理。

时间职责由程序独占：LLM 只接收 block ID 和源文本，不接收可修改的时间字段，也不返回时间字段。非静音 block 的空译文或缺失 ID 必须重试；最终仍缺失时报告可恢复错误，不把原文单独显示伪装成成功译文。

`baseUrl` 是带签名和有效期的临时 URL。不得写入缓存，也不得作为稳定接口地址。请求结果的格式必须在 `YouTubeTranscriptParser` 中验证（已验证的格式见下）。

### 缓存身份

缓存以 `videoId` 作为记录键，但命中和增量续译必须同时校验 `sourceTrackFingerprint`、`sourceLanguage` 与 `targetLanguage`。其中 `sourceTrackFingerprint` 由字幕轨道的 `vssId`、`languageCode`、`kind` 组成，不包含临时 `baseUrl`。不匹配的记录视为未命中，不能把其他轨道或其他目标语言的译文混入当前字幕；数据库 schema v4 会在升级时清理不兼容的旧记录。缓存保存完整的定时 `TranslatedBlock`，包括源文、译文、`startMs/endMs` 与 `segmentIds`。

**实测（2026-08-24，用无头 Chrome 拦截 timedtext 请求/响应复核）：**

- 该视频当前有效的字幕请求 URL 形如：
  `https://www.youtube.com/api/timedtext?v=<videoId>&…&caps=asr&…&key=yt8&kind=asr&lang=en&variant=gemini&potc=1&pot=<Proof-of-Origin>&fmt=json3&xorb=2&xobt=3&xovt=3&cbr=Chrome&cbrver=<ver>&c=WEB&cver=<ver>&cplayer=UNIPLAYER&cos=Windows&cosver=10.0&cplatform=DESKTOP`
- **缺少 `pot` 时，返回 HTTP 200 与空 body**（`Content-Length: 0`，`Server: video-timedtext`）。加 `fmt=json3` / `c=WEB` / 携带会话 Cookie 均无效。`pot` 由页面 BotGuard 运行时按视频 ID 铸造，无法从静态 HTML 或普通 HTTP 反推；headless/无用户会话时播放器甚至不铸造 `pot`。
- **不要用“挂载时 `baseUrl` + 单独捕获的 `pot`”去做二次请求**：`pot` 与 `baseUrl` 来自不同上下文，实测会得到空响应。可靠取回是 **MAIN world bridge 捕获播放器自身那次字幕请求的响应正文**（那次请求自带有效 `pot` 与同一签名上下文），将原文通过消息回传给内容脚本解析。
- 播放器字幕请求经 `fetch`/`XMLHttpRequest` 发出（可用 `performance.getEntriesByType("resource")` 观察，命中 URL 含 `pot`/`fmt=json3`/`cplayer=UNIPLAYER`）。
- **响应格式为 `fmt=json3` 的 pb3 JSON**：`{ "wireMagic": "pb3", "pens": […], "wsWinStyles": […], "wpWinPositions": […], "events": […] }`。
  - `events` 里既有**窗口/样式事件**（仅含 `tStartMs`/`dDurationMs`/`id`/`wpWinPosId`/`wsWinStyleId`，**无 `segs`**）；
  - 也有**文本事件**（含 `wWinId` 与 `segs:[{ "utf8": <文本>, "tOffsetMs": … }, …]`）。
  - 解析器必须**跳过无 `segs` 的事件**，并接受 `tStartMs`/`dDurationMs` 为**数字或数字字符串**，不能因单个畸形事件而整体失败。

实测转写导出是按时间顺序的片段（例如 `[0:00]`、`[0:02]`）。同一次采样中原始轨道标记为英文，导出文本却受中文界面影响呈中文，因此源语言判断必须基于实际传给翻译请求的 `captionTrack.languageCode`，不能基于播放器当前可见字幕。

### 已验证的 DOM 锚点

| 目的 | 当前锚点 | 实现规则 |
| --- | --- | --- |
| 播放器 | `#movie_player, #shorts-player` | 不修改原播放器节点结构。普通视频使用右侧控制组；Shorts 优先使用 `.ytp-chrome-top-buttons`，播放器入口由 `settings.subtitles.shortsTranslationEnabled` 控制，默认关闭。 |
| 右侧/顶部控制组 | `.ytp-right-controls`、`.ytp-chrome-top-buttons` | 普通视频翻译按钮插入右侧控制组首位；Shorts 插入顶部工具栏并按实际坐标定位。Shorts 开关不影响评论入口。 |
| 原字幕按钮 | `.ytp-subtitles-button` | 先排除 `aria-disabled="true"`、`disabled` 属性和 `ytp-button-disabled` class；仅对可用按钮使用 `aria-pressed="true"` 或 `ytp-button-pressed` class 判断是否实际开启；不读取 aria 文案。全局字幕偏好不作为当前视频有无字幕的依据。仅在不改变播放器字幕状态的前提下触发字幕加载时点击。 |
| 字幕层容器 | `.ytp-caption-window-container` | 捕获字幕那一瞬用注入样式临时隐藏以防原生字幕闪现，捕获后恢复；当观看页字幕叠加层激活时，再由 `body.xtranslator-captions-suppressed` 隐藏以“取代”原字幕。 |
| 扩展字幕叠加层 | `#movie_player [data-xtranslator-mount="caption"]`、`#shorts-player [data-xtranslator-mount="caption"]` | 由内容脚本追加到播放器内；运行时按实际 `<video>` 的 viewport 矩形映射为播放器内绝对坐标，默认读取 `.ytp-progress-bar-container` 的实际边界，使字幕卡片底边位于进度条上方 8px。双语为译文在上（默认黄色）、原文在下，共享一个紧凑字幕卡片；用户可在播放器内上下拖动卡片，位置按播放器高度比例保存。Shorts 原文固定 15px、译文固定 19px，不使用普通视频字号缩放。 |
| 设置按钮 | `.ytp-settings-button` | 不覆盖其事件或样式。 |
| 标题 | `ytd-watch-metadata h1` | 命名空间兄弟节点仅用于状态/错误提示，不渲染译文。 |
| 简介 | `#description-inline-expander` | 命名空间兄弟节点仅用于状态/错误提示，不渲染译文；不能改写原简介。 |
| 评论根节点 | `#comments`、`ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-comments-section"]` | 必须等待动态内容出现。播放器导航清理只移除播放器、标题、简介和字幕挂载点，不得移除评论挂载点。 |
| 翻译可见评论批量控制 | 当前视口内第一个完整可见的顶级评论前 | 通过 `data-xtranslator-mount="comment-batch-control"` 唯一挂载；滚动或懒加载扫描时重新锚定，不调用 continuation API。 |

选择器只允许集中在 `youtube-page-contract.ts` 中。每次 YouTube 变更只改适配器和契约测试，不允许让功能代码各自查询 DOM。

> 字幕读取依赖 **MAIN world bridge**（`content/main-world-bridge.ts`，`manifest.json` 中声明为 `world: "MAIN"`）。它是唯一允许访问页面全局/播放器内部以获得 `pot` 与字幕正文的模块；隔离世界的内容脚本只通过命名空间 `window.postMessage` 协议拿到字幕正文。bridge 不把任意历史 timedtext 响应当作当前结果，而是只在有待处理的当前视频/轨道请求时接收正文，并校验 URL 中出现的 `vss_id`、`lang`、`kind`。业务模块不得直接依赖 YouTube 全局变量或原始 DOM。

## 评论懒加载

该采样的 `ytInitialData` 中：

- 初始 `commentThreadRenderer` 数量为 0；
- 初始 `commentRenderer` 数量为 0；
- 已有 `commentsHeaderRenderer`；
- 有 `continuationItemRenderer.continuationEndpoint`，其 `commandMetadata.webCommandMetadata.apiUrl` 为 `/youtubei/v1/next`；
- 评论排序与回复继续加载也使用 continuation token。

这证明评论不是首屏静态数据。生产代码的契约是“观察 YouTube 已渲染的评论 DOM”，而不是直接调用上述内部接口。评论适配器必须接受 DOM 生命周期中的新增、删除、折叠与展开。

YouTube 可能保留已经离开视口的旧评论节点，同时把后续评论追加到 DOM。“翻译可见评论”按钮不能永久挂在初始评论前：每次评论结构变更或滚动扫描时，优先挂到当前视口内第一个完整可见的顶级评论前；没有完整可见节点时退回部分可见节点，再退回首个顶级评论。批量范围仍只由当前可见、且已由 YouTube 渲染的 DOM 评论决定。

## 划词翻译契约

- 选区浮层通过约 100ms 防抖等待最终选区，双击或连续选区动作期间不展示中间单词的翻译浮层。
- `settings.selection.enabled` 控制划词翻译总开关，默认 `true`；关闭时页面不显示选区浮层，后台不创建“翻译所选文本”右键菜单，已有浮层立即关闭。
- `settings.selection.includeContext` 独立控制是否把选区前后句作为翻译上下文；旧设置缺少 `enabled` 字段时按 `true` 迁移。

**实测（2026-08-25，Chrome 真实观看页）：**目标视频滚动到后续评论后，页面仍保留初始评论节点，新增评论已经出现在视口内；旧实现的批量按钮仍位于初始评论前、视口上方，导致当前可见评论看不到入口。该现象确认是 DOM 锚点随懒加载失位，不是“只翻译了最初几条评论”的数据接口结论。

**多层回复实测（2026-08-25，目标视频）：**当前观看页使用 `ytd-comment-view-model` 作为评论本体。顶层评论位于 `ytd-comment-thread-renderer` 内；回复通过 `ytd-comment-replies-renderer`、`yt-sub-thread` 再嵌套新的 `ytd-comment-thread-renderer`。回复中的回复继续沿用这一嵌套结构，父子关系必须由最近的所属线程 DOM 推导，不能通过评论 ID 的后缀猜测。折叠回复只有在用户点击 YouTube 自己的展开控件并完成渲染后才进入可翻译范围。

长评论会由 `ytd-expander#content` 以 CSS 截断，并显示 `#more` / “了解详情”。实测 `#content-text` 仍包含完整文本，因此翻译不应强制展开评论；翻译结果必须挂在 `#expander` 外部，避免被 `#content` 的 `overflow: hidden` 一起裁掉。

```ts
interface RenderedComment {
  commentId: string;
  parentCommentId?: string;
  authorName: string;
  sourceText: string;
  replyCount?: number;
  isReply: boolean;
}
```

`commentId`、文本与父子关系均需要在真实评论 DOM 出现后再验证。若缺少任一字段，跳过该节点并记录非敏感诊断码，不得猜测 ID 或文本。

## 变更检测与测试

- 为此页面建立去除签名 URL、追踪参数与个人化数据的脱敏 fixture。
- 每次升级适配器前，运行 fixture 解析测试与真实页面 smoke test。
- 真实页面 smoke test 必须覆盖评论滚动/懒加载后的批量控制重新锚定，以及当前视口评论收集范围。
- 对不存在字幕、多个字幕轨道、直播、短视频、评论关闭、折叠回复分别建立 fixture。
- 任一关键字段缺失时展示“当前 YouTube 页面暂不支持读取”，而不是抛异常或用猜测数据继续翻译。
