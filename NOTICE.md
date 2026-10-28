# 第三方代码与署名说明

本插件（`dsh-tieba-scroll` / 刷贴吧）本体以 **MIT** 协议发布，正文见仓库根目录的 `LICENSE`。

## 架构来源：dsh-bili-scroll

- 项目：**dsh-bili-scroll**（中文名「刷B站」）
- 作者：**c1overzz**
- 许可证：**MIT**，Copyright (c) 2026 c1overzz
- 仓库：<https://github.com/c1overzz/dsh-bili-scroll>

「刷贴吧」是照它的架构改出来的姐妹插件，沿用了这些**设计**（代码按贴吧重写）：

| 沿用的部分 | 说明 |
|---|---|
| 插件骨架 | host 半端 `index.js` / 浏览器半端 `client.js` / `cordis.patch.yml` bundle patch / `lib/hostdeps.mjs` 的宿主依赖取法 |
| 状态目录与家目录约定 | `$DSH_HOME/tieba-duty/`、配置与运行数据**不写进插件包目录** |
| 值班章程的写法 | 一轮的判定口径 + 输出格式 + 红线；用户改过就保留他那份、新版落 `.new`（`charter.sha256` 对账） |
| 设置页四页签 | 日常 / 偏好 / 互动 / 高级；配置在 `config.json` 与 DSH 原生设置页之间**逐字段对账** |
| HTTP 接口的鉴权 | 宿主信任栅栏 + 本机同源 |

## 本插件的改动（贴吧跟 B 站不一样的地方）

- **没有任何 Python、没有 MCP、没有扫码登录** —— 贴吧没有官方 API，直接读网页版 HTML（`https://tieba.baidu.com/mo/q/m`）就够了，
  所以整个插件是**纯 Node**：装完即用，不建 venv、不下 uv、不起子进程。这是与 B 站版最大的区别。
- **跑一轮的方式整个换了**：B 站版是「到点起一个 `dsh --profile bili-duty` headless 子进程，那一轮里模型自己调工具、自己写日报」，
  为此还要建专用 profile、还要修桌面版 spawn 的坑。贴吧版**全部在插件进程内完成**：
  插件自己拉列表 / 拉正文 → 拼 prompt → `ctx.llm.stream()` 让模型只吐一段判断用的 JSON → 插件自己写日报、自己更新判重表、自己回帖。
  模型**零工具、零文件、零联网** —— B 站版要靠专用 profile 才达到的隔离，这里靠架构本身达到。**没有子进程、不用建 profile。**
- **登录方式换成粘 Cookie**（浏览器 F12 → Cookies → `tieba.baidu.com` → `BDUSS`，顺带 `STOKEN`），不涉及二维码。
- 判据与产物换成贴吧的：吧内列表 → 楼主那一楼的正文 → 日报 / 回帖（楼中楼只给会话里的 `tieba_subposts` 工具用，跑一轮不碰）。
- `lib/html.mjs`（轻量 HTML 解析）、`lib/tieba.mjs`（贴吧 HTTP 层）、`lib/round.mjs`（跑一轮）、`prompts/duty.md` 全部为本插件新写。

## 第三方依赖

- **无**。运行时只用 Node 自带的 `node:fs` / `node:https` / `node:crypto` 等，**不引任何第三方包**
  （`@deepseek-ai/*` 是 DSH 宿主自己的包，属于 peer，随宿主一起存在；取不到时 `lib/hostdeps.mjs` 会退回本地等价实现）。

## 关于版权署名

`LICENSE` 第一行写的是 `Copyright (c) 2026 dsh-tieba-scroll contributors`。
如果你要基于本仓库做二次分发，保留这一行和 MIT 正文即可，不必另行取得授权（MIT 本身就允许改、再发、商用）。
因为架构来自 dsh-bili-scroll，二次分发时**顺手保留一句「基于 dsh-bili-scroll 改的」**会更合适。

---

*本文件只是说明，不构成额外限制。*
