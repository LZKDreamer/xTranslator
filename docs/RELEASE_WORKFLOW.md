# Chrome 扩展发布流程

本文件是 xTranslator 的唯一发布流程说明。只要用户提出“发布版本”“更新版本”或给出目标版本号，执行者必须完整遵循本文件。

## 用户需要说什么

用户只需给出目标版本，例如：

> 发布 0.1.2

这等同于授权完成本文件中的全部操作：版本同步、打包、提交、创建 tag、推送 GitHub 和验证 jsDelivr 下载链接。不要要求用户执行命令，也不要创建 GitHub Release，除非用户明确要求。

## 发布前条件

- 当前分支必须是 `main`。
- 工作区必须干净；存在无关改动时停止，不得混入发布提交。
- 版本必须为 Chrome 扩展版本格式：1 至 4 段整数，每段范围为 `0` 至 `65535`，例如 `0.1.2`。
- 已存在的 tag 永远不可复用；若已发布版本有问题，发布一个更高的新版本修复。

## 执行方式

运行：

```powershell
pnpm release -- 0.1.2
```

`scripts/release.ps1` 会依次执行：

1. 检查分支、工作区和 tag。
2. 同步 `package.json` 和 `public/manifest.json` 的版本号。
3. 构建扩展，并生成 `releases/xTranslator-0.1.2.zip`。
4. 生成 `public/updates/latest.json`。扩展通过 jsDelivr 的 `@latest` 读取此文件；文件中的下载链接使用不可变的 `v0.1.2` tag。
5. 创建 `release: v0.1.2` 提交、创建带注释的 `v0.1.2` tag，并推送到 GitHub。
6. 验证 jsDelivr 安装包链接返回 HTTP 200。
7. 调用 jsDelivr purge 刷新 `@latest` 更新清单，并轮询确认清单中的版本号和下载地址都已经对应本次发布；清单未刷新时，发布流程失败，不报告发布完成。

安装包下载地址固定为：

```text
https://cdn.jsdelivr.net/gh/LZKDreamer/xTranslator@v版本号/releases/xTranslator-版本号.zip
```

## 分发与更新

- 不使用 GitHub Release 附件，也不请求 GitHub API。
- 用户首次安装时下载 zip、解压，并在 `chrome://extensions` 中选择“加载已解压的扩展程序”。
- 已安装的扩展打开弹窗或设置页时检查 `https://cdn.jsdelivr.net/gh/LZKDreamer/xTranslator@latest/public/updates/latest.json`；弹窗会提示新版本，设置页底部的“版本更新”卡片会显示当前版本、检查结果和下载链接。用户手动安装新版。
- `@latest` 是 jsDelivr 的可变版本别名，可能被 CDN 缓存。发布脚本会在推送后调用 purge，并验证清单内容，而不仅仅验证安装包是否返回 HTTP 200。
- jsDelivr purge 失败或清单仍返回旧版本时，发布流程会停止并明确报告；不得复用已经创建的 tag，应等待 CDN 恢复后再发布更高版本。
- 版本检测不是 Chrome 后台自动更新：只有打开扩展弹窗或设置页时才会检查。
