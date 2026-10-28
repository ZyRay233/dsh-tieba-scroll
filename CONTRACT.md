# dsh-tieba-scroll 契约（所有实现者必须遵守）

> 本文件是并行开发的**唯一事实源**。改这里的任何签名都要先跟 lead 说一声。
> 参照物：`tmp/tieba-ref/package/`（dsh-bili-scroll 2.3.0 解包，可随时对照写法）。

## 0. 一句话

DSH 插件「**刷贴吧**」：按你关注的吧每天刷一轮 → 读楼层正文判断 → 写一份 Markdown 日报；
开到「自动回帖」时，每条都在楼中楼**回一句 @ 你**。默认不拿用户账号说任何话。

**与 B 站版的区别**：贴吧版**纯 Node，零 Python、零安装**（贴吧没有官方 API，网页版 HTML 就够用）。

## 1. 包与目录

包名 `dsh-tieba-scroll`，中文名「刷贴吧」，插件的 cordis 命名空间（patch entry id）= `tieba-scroll`。

```
work/dsh-tieba-scroll/
├── package.json            ← lead
├── cordis.patch.yml        ← lead
├── index.js                ← lead（host 半端：Config / 工具 / 定时 / HTTP API）
├── client.js               ← settings-ui（浏览器半端）
├── lib/
│   ├── hostdeps.mjs        ← lead（照抄 tmp/tieba-ref/package/lib/hostdeps.mjs）
│   ├── state.mjs           ← lead（家目录 / config / 日报 / 判重 / 窗口）
│   ├── round.mjs           ← lead（**跑一轮**：拉数据 → 调模型 → 落盘 → 回帖）
│   ├── html.mjs            ← tieba-net（极小 HTML 解析工具）
│   └── tieba.mjs           ← tieba-net（贴吧 HTTP 层，**本插件的心脏**）
├── prompts/duty.md         ← docs-pack（**给模型的一轮任务书**，不是给 agent 的章程）
├── test/tieba.test.mjs     ← tieba-net（node --test，不许联网也可以跑）
├── README.md               ← docs-pack
├── LICENSE                 ← docs-pack（MIT）
└── NOTICE.md               ← docs-pack
```

> ⚠️ **没有 `profile-template/`**（跟 B 站版最大的架构差异，见 §11）：贴吧版**不起子进程、不建专用 profile**。

## 2. DSH 插件骨架（照抄即可，别自由发挥）

host 半端 `index.js`：

```js
import { loadHostDeps } from './lib/hostdeps.mjs'
const hostDeps = await loadHostDeps()
const z = hostDeps.z
const defineTool = hostDeps.defineTool

export const name = 'tieba-scroll'          // 必须 === patch entry id
export const inject = ['webServer', 'tools', 'settings']
export const Config = !z ? undefined : z.object({ /* 每个字段都要 .extra('volatile', true) */ })
export function apply(ctx, config) { /* ... */ }
```

- `apply` 里传进来的 `config` **字段值不保证是标量**（可能是对象）⇒ 一律走 `loadCfg()` 从
  `<家>/config.json` 读，`config` 只当"宿主那边的最新值"看。
- 工具注册：`ctx.tools.register(defineTool({ name, description, parameters, output?, execute }))`
  - 🔴🔴 **`parameters` 不是完整 JSON Schema，是「字段名 → 描述」的 spec**：
    ```js
    parameters: {
      bar:  { type: 'string', description: '吧名' },
      page: { type: 'number', description: '第几页' },
    }
    ```
    宿主内部走 `parameterSchemaSpecToJsonSchema()` 编译。写成
    `{ type:'object', properties:{…}, required:[…], additionalProperties:false }` 会抛
    **`unsupported JSON schema: parameters.type must be a value schema object`**
    ⇒ `apply()` 中途崩 ⇒ **整条插件不激活**，`duty.log` 只留到「已铺好值班章程」就断。
    （2026-10-28 真机踩实；用 asar 里那份真 `dsh-tools` 复现并验证修法）
  - **spec 里没有 `required` 概念**：可选性靠 `execute` 里 `args.x ?? 默认值` 兜。
  - `output.schema` **仍然是** JSON Schema 形状（`{ type:'object', properties:{}, additionalProperties:true }`
    能过 `valueSchemaSpecToJsonSchema`）。
  - 返回值必须过 `safe()`（`JSON.parse(JSON.stringify(v))`），否则宿主报 `value is not lossless JSON`
- HTTP：`ctx.effect(() => ctx.webServer.register({ kind:'prefix', path:'/api/tieba-duty', handler }), 'label')`
- 收摊：`ctx.effect(() => () => cleanup(), 'label')`
- 家目录：`ctx.get('dshHomePath')` 是**函数** → `p('tieba-duty')`（不是字符串！）

浏览器半端 `client.js`：**不是 ESM**，是自注册脚本。

```js
window.__ModuleLoader__.load({
  id: 'dsh-tieba-scroll',                 // === package.json name
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    // ...
    return {
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'dsh-tieba-scroll')
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove(), 'dsh-tieba-scroll: 设置页样式')
        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'tieba-scroll', order: 31, label: '刷贴吧' },
          () => h(Panel),
        ))
      },
    }
  },
})
```

## 3. 家目录与文件

`$DSH_HOME/tieba-duty/`（`DSH_HOME` 缺省 `~/.dsh`）：

| 文件 | 内容 |
|---|---|
| `config.json` | 用户配置（字段见 §5，与 Config schema **逐字段对账**） |
| `tieba_credential.json` | `{ bduss, stoken, uname, savedAt }`，权限敏感的凭证，绝不外传 |
| `duty.md` | 值班章程副本（从 `prompts/duty.md` 铺，改过就保留、新版落 `.new`） |
| `charter.sha256` | 上次铺出去的章程指纹 |
| `seen.json` | 判重表：`{ threads: { "<tid>": { at, bar, title, tier } }, day: { "<YYYY-MM-DD>": count } }` |
| `out/<YYYY-MM-DD>.md` | 日报 |
| `duty.log` | 追加式日志 |

**绝不写进插件包目录**（装进 node_modules 后可能只读，升级会被覆盖）。

## 4. lib/tieba.mjs —— 导出契约（tieba-net 必须逐条实现）

全部 `async`，**不抛异常**，统一返回 `{ ok: true, ... }` 或 `{ ok: false, error: '人话原因', hint?: '怎么办' }`。
所有请求带 UA + 超时（默认 15s）+ 最多重试 1 次。**不做任何登录态以外的副作用**。

```js
export const UA_MOBILE
export const UA_DESKTOP

// ── 凭证 ──────────────────────────────────────────────
export function loadCredential(stateDir)            // → {bduss,stoken,uname} | null
export function saveCredential(stateDir, cred)      // → void
export function clearCredential(stateDir)           // → void
export async function whoami({ bduss, stoken })     // → {ok, uname, ok?:bool} | {ok:false,error}
export async function ensureTbs({ bduss })          // → string（失败抛/返回 ''）

// ── 读 ────────────────────────────────────────────────
export async function listThreads({ kw, pn = 0, good = false })
// → { ok, bar: { name, url, intro?, memberCount?, threadCount? },
//     threads: [{ tid, title, author, time, replyCount, pinned, hasImage, isGood, url }] }

export async function readThread({ tid, pn = 1 })
// → { ok, tid, title, bar, author, createdAt, page, totalPage,
//     floors: [{ pid, floor, author, time, content, images: string[], likeCount,
//                subPostCount, isOp }] }

export async function readSubPosts({ tid, pid })
// → { ok, replies: [{ author, time, content }] }

// ── 写（必须登录；未登录 ⇒ {ok:false,error:'未登录'}） ──
export async function postThread({ bduss, stoken, kw, title, content, fid? })
// → { ok, tid, url } | {ok:false,error,hint}
export async function replyPost({ bduss, stoken, tid, content })
// → { ok, pid } | {ok:false,error,hint}
export async function replySubPost({ bduss, stoken, tid, pid, content })
// → { ok } | {ok:false,error,hint}
```

### 数据来源（已由 lead 实测，不要再猜）

- **列表**：`GET https://tieba.baidu.com/mo/q/m?kw=<urlencoded 吧名>` + `UA_MOBILE`
  - 30 条/页；翻页 `&pn=<页码>`（从 1 开始，首页可省略）
  - 每个帖子是 `<li class="tl_shadow ...">`，含：
    - `data-tid="<帖子ID>"`、`data-thread-type`
    - `<div class="ti_title"><span>标题</span></div>`
    - `<span class="ti_author"> 作者名</span>`、`<span class="ti_time">20:35</span>`
    - `<span class="btn_icon">114</span>`（在 `.btn_reply` 里，= 回复数）
    - 有图：`medias_wrap` / `medias_one_pic`；置顶：`tl_top` / `ti_icon_zhiding`
  - 页面里还有 `<title>`、吧名、关注人数等，能取多少取多少，取不到就留空字符串
- **正文**：`GET https://tieba.baidu.com/mo/q/m?kz=<tid>` + `UA_MOBILE`（翻页 `&pn=<n>`）
  - 楼层节点：`list_item_wrapper` / `list_main` / `list_item_top clearfix`
  - `.user_name` = 作者；`.list_item_time` = 时间；`.content` = 正文 HTML
  - 楼层号在 `.j_floor_num`，楼中楼回复数在 `j_nreply_btn`
  - 一页约 30 楼
- **楼中楼**：`GET https://tieba.baidu.com/mo/q/m?kz=<tid>&pid=<pid>&lzl=1`（**tieba-net 负责实测确认**）
- **tbs**：`GET http://tieba.baidu.com/dc/common/tbs`（带 Cookie `BDUSS=...`），返回 `{"tbs":"..."}`
- **发帖 / 回复**：优先网页端表单接口（`https://tieba.baidu.com/f/commit/post/add` 系），
  **tieba-net 必须实测出可用的那条**，把签名/参数写进注释。失败要给出人话 `hint`。
  - 贴吧有 `sign` 校验的接口（`c.tieba.baidu.com/c/...`）需要 MD5 签名，能绕开就绕开（用网页端）。
  - ⚠️ 实测不到、需要真实账号才能验证的部分，**允许实现但必须在注释里标明"未验证"**，
    并且错误信息要能指导用户（"可能是风控/未登录/tbs 过期，去设置页重新粘 BDUSS"）。

### 解析要求

- 用正则 + 轻量 DOM 走查，**不引第三方依赖**（这个插件的卖点就是零安装）。
- HTML 实体要解：`&amp; &lt; &gt; &quot; &#39; &nbsp;` 和 `&#xxxx;`。
- 正文里的 `<br>` → `\n`，其余标签剥掉；图片 `data-url` / `src` 收集到 `images`。
- 内容截断：单楼正文最多留 4000 字（防止一条爆上下文），截断处加 `…`。

## 5. 配置字段（Config schema === config.json，逐字段对账）

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enabled` | boolean | true | 插件总开关 |
| `peakValley` | boolean | false | 峰谷时段自动刷（总开关） |
| `noon` | boolean | true | 中午 12–14 点那轮 |
| `night` | boolean | true | 晚上 18–09 点那轮 |
| `perDay` | natural | 5 | 每天最多挑几条（0 = 只手动） |
| `bars` | string[] | [] | 关注的吧（一行一个，空则用内置默认几组） |
| `keywords` | string[] | [] | 只挑标题/正文含这些词的（空 = 不过滤） |
| `excludeWords` | string[] | [] | 标题/作者含这些词就跳过 |
| `fetchPerRound` | natural | 8 | 每轮最多细读几篇正文 |
| `listPerBar` | natural | 30 | 每个吧取多少条候选 |
| `sortBy` | string | 'reply' | `reply`=按回复数 / `time`=按时间 |
| `reportLevel` | string | 'full' | `full` / `brief`（每条一两行）/ `off` |
| `autoReply` | boolean | **false** | 自动回帖（**拿用户账号说话**，默认关） |
| `replyBars` | string[] | [] | ⭐ **只在哪些吧回帖**；**留空 = 不限制**。典型用法：把「反XX吧」这类只读吧排除掉 |
| `replyPerRound` | natural | 1 | 每轮最多回几条（0–20，**schema 里不写 .max()**，两端钳） |
| `mentionName` | string | '' | 回帖里 @ 谁（留空 = 不 @） |
| `replyLength` | string | 'medium' | `short` ≤15 字 / `medium` ≤40 字 / `long` ≤100 字 |
| `personaPrompt` | string | '' | 它按什么口气说话（留空 = 中性） |
| `allowPost` | boolean | **false** | 允许模型发主题帖（额外危险，默认关；开关见 §7） |
| `manualMax` | natural | 3 | 手动跑一轮最多挑几条 |
| `manualCooldownMin` | natural | 10 | 两次手动之间至少隔几分钟 |

> 没有 `dshBin` / `headlessProfile` / `workspace` —— 贴吧版不起子进程，见 §11。

凭证**不进 Config schema**（单独 `tieba_credential.json`，设置页走 `POST /api/tieba-duty/login`）。

## 6. HTTP API（host 实现 == client 消费，路径一字不差）

前缀 `/api/tieba-duty`，全部返回 JSON。鉴权：宿主信任栅栏 + 本机同源（照抄 bili 的
`fenceReject` / `sameOriginOk`，在 `tmp/tieba-ref/package/index.js` 2960–3055 行）。

| 方法 | 路径 | 入参 | 返回 |
|---|---|---|---|
| GET | `/status` | — | `{ ok, version, enabled, ready:{cred,profile}, credential:{loggedIn,uname}, today:{picked, replied}, lastRun, running, report:{path,exists} }` |
| GET | `/config` | — | `{ ok, config }` |
| POST | `/config` | `{ patch: {...} }` | `{ ok, config, savedLocalOnly?:bool }` |
| POST | `/login` | `{ bduss, stoken, uname? }` | `{ ok, whoami:{ok,uname}?, error? }` |
| POST | `/logout` | — | `{ ok }` |
| GET | `/whoami` | — | `{ ok, loggedIn, uname, error? }` |
| POST | `/run` | `{ max? }` | `{ ok, started, reason?, error? }` |
| GET | `/report?day=YYYY-MM-DD` | — | `{ ok, day, path, exists, text }` |
| GET | `/threads?limit=&offset=&tier=` | — | `{ ok, total, rows:[{tid,bar,title,tier,why,at,replied,url}] }` |
| POST | `/open-folder` | `{ which:'out'|'home' }` | `{ ok, path }` |
| GET | `/log?tail=200` | — | `{ ok, lines:string[] }` |

## 7. 工具（注册给模型；危险的两个只在这两个开关同时满足时才注册）

> ⚠️ 这些工具是给**用户在正常会话里对话**用的（「帮我看看原神吧今天有啥」）。
> **「跑一轮」不走工具** —— 那一轮是插件自己在进程里完成的（见 §11），模型拿不到任何工具。

| 工具名 | 注册条件 | 参数 | 说明 |
|---|---|---|---|
| `tieba_whoami` | 总是 | `{}` | 看登录状态 |
| `tieba_list` | 总是 | `{ bar, page?, sort? }` | 吧内帖子列表；`bar`=吧名（不带「吧」字也行），`page` 从 0 开始，`sort`=`reply`/`time` |
| `tieba_thread` | 总是 | `{ tid, page? }` | 读一篇帖子的楼层；`page` 从 1 开始 |
| `tieba_subposts` | 总是 | `{ tid, pid }` | 读楼中楼 |
| `tieba_reply` | `cfg.autoReply === true` | `{ tid, content, pid? }` | 回帖（给了 `pid` = 楼中楼回复） |
| `tieba_post_thread` | `cfg.allowPost === true` | `{ bar, title, content }` | 发主题帖 |

> 工具参数用**工具级**的 `bar` / `page`；`lib/tieba.mjs` 用 `kw` / `pn`。两套名字在 `index.js` 里做一次转换，
> 别互相污染。

## 8. 日报格式（`out/<YYYY-MM-DD>.md`，docs-pack 写进章程、lead 写进代码）

```md
# 刷贴吧日报 · 2026-11-08

<!-- round: 1 -->
> —— 第 1 轮 · 12:31 ——

> 这一轮刷了 3 个吧、47 篇帖子，细读 8 篇，挑出 3 条值得看。

## 原神吧
### 11141821521
- **标题**：话说木偶一命到底有啥用
- **链接**：https://tieba.baidu.com/p/11141821521
- **档位**：值得看
- **为什么值得**：（一句话）
- **它的一句话**：（它自己的吐槽）
- **回帖**：已回（@主人）

## 跳过的
- `11101947186` 感觉以后主c都要废 —— 纯情绪发泄，没信息量
```

**三条硬规矩（代码靠它们工作，改格式会让功能失效）：**

1. **判重靠 `### <tid>` 这一行**：正则 `/^###\s*(\d+)/`。挑了几条 = 数这些行。
2. **同一天多轮要追加，不覆盖**：中午一轮、晚上一轮是常态。追加时保留已有内容一个字不动，
   本轮开头写 `<!-- round: N -->` + `> —— 第 N 轮 · HH:MM ——`。
       （2026-10-28 审查修：原来 `writeFileSync` 直接覆盖 ⇒ 晚上的把中午那份整个盖掉，
       但配额 `seen.day` 是累加的 ⇒ 用户看到的条数和配额对不上 ✗）
3. **`reportLevel` 三档都要真的生效**：
   - `full` = 上面那个完整样子
   - `brief` = 每条只留「标题 + 档位 + 链接」一行，不写 why/oneLine/跳过节
   - `off` = **根本不写文件**（只更新判重表和配额，回帖照发）

> `fetchPerRound = 0` 是「只看标题」模式：不读正文，多带一些标题进 prompt。
> 正文截断 2600 字（喂给模型的上限，比 tieba 层的 4000 更紧）。

## 9. 红线（写进 `prompts/duty.md`，不靠模型自觉）

1. 不透露账号、机器路径、用户私聊内容 —— 一个字都不进回帖
2. 每轮按 `replyPerRound` 发；同一帖只回一次；不刷屏、不吵架、不引战、不碰时政/色情/赌博
3. 不确定的事**不编**（日报里如实写「没查到」）
4. 见到广告/诈骗/引流贴 → 只记录不互动
5. 回帖口吻跟随 `personaPrompt`；为空就用中性、简短、像吧友的口吻
6. ⭐ **硬黑名单**（`lib/round.mjs` 的 `HARD_BLOCKED_BARS`，设置页也加不进来）：
   `孙笑川` / `孙吧` / `抽象` —— 内容主体是人身攻击和抽象辱骂，读进来只会让模型学着说话。
   这几个吧**连订阅都进不来**，日志里会说一句「跳过」。
7. ⭐ **`replyBars` 白名单**：填了就只在列出来的吧回帖，其余吧**只写日报、一个字都不回**。
   典型用法：`DeepSeek` 可回、`反DeepSeek` 只读。留空 = 不限制。
8. **站中间的代价**：在「反XX吧」里说中立话，两边都会当你是水军 ⇒ 那类吧默认只读。

## 10. 验收（**实际结果，2026-11-08**）

| 检查 | 结果 |
|---|---|
| `node test/tieba.test.mjs`（解析层） | ✅ **23/23** |
| `node test/round.test.mjs`（纯函数层） | ✅ **14/14** |
| 假 ctx 跑 `apply()`（模拟宿主） | ✅ 4 个只读工具注册、危险工具默认不注册、`/api/tieba-duty` 路由挂上 |
| HTTP API（status/config/threads/log/report） | ✅ 全部 200 |
| `prompts/duty.md` 铺进家目录 + `charter.sha256` | ✅ |
| **降级路径**（拿不到 `@deepseek-ai/*`，桌面版场景） | ✅ `Config=undefined`、`defineTool` 用本地等价实现，**插件照常加载** |
| `dsh plugin --profile X add link:<目录>` | ✅ 装得进，`--dump-default-config` 里出现 `id: tieba-scroll` |
| 贴吧读接口（列表 / 正文 / 楼中楼 / tbs） | ✅ 用真实页面跑通（**当前 IP 已被风控，复测要先等 5–10 分钟**） |
| 贴吧写接口（发帖 / 回帖 / 楼中楼回复） | ⚠️ **未验证** —— 需要真实 BDUSS 才能跑成功路径。端点存在性已实测，失败文案覆盖 未登录/验证码/tbs/权限/限流 |
| 设置页 UI 真浏览器渲染 | ⚠️ 未跑真浏览器；用最小 hooks 运行时冒烟过一遍渲染树（29 个按钮 / 11 条路由） |
| 真 DSH 进程内加载 | ⚠️ 需重启才生效（会中断当前会话），留给使用者 |

### 已知限制

- **贴吧风控很凶**：模块内做了 700ms 全局节流 + 15s 超时 + 失败重试 1 次 + 风控页识别人话。
  `listPerBar` / `fetchPerRound` 别调太大；被拦了等 5–10 分钟或换网络。
- **移动版正文页没有点赞数**：`likeCount` 如实给 `0`。
- **`good`（精品）过滤**：`&lm=4` 实测没有过滤效果，所以 URL 带上 + 本地按 `is_good` 再筛一道。
- **楼层号 / 楼中楼回复数**：楼层号在 `li[fn]` 与 `data-info.floor_num`；
  `.j_floor_num` 其实是「收藏」按钮、`.j_nreply_btn` 是「回复」按钮，**都不是楼层号**（别踩）。
  楼中楼回复数在 `.j_floor_panel[data-list-count]`。
- **`pn` 不是页码**：贴吧的 `pn` 是「从第几条开始」（1 基），`lib/tieba.mjs` 内部换算，
  对外仍按页码用（`listThreads({pn:0})` = 首页，`readThread({pn:1})` = 第 1 页）。**别在 index.js 再换算一次**。
- **楼中楼读接口**：`GET https://tieba.baidu.com/p/comment?tid=<tid>&pid=<pid>&pn=1`（桌面 UA），
  返回 `li.lzl_single_post`。**不是** `&pid=&lzl=1`（那个 URL 返回整页正文，`mo/q/m` 根本不认 lzl）。

## 11. 「跑一轮」的机制（**这一节推翻了 B 站版的做法，最重要**）

B 站版是：「到点 → `dsh --profile bili-duty <prompt>` 起一个 headless 子进程 → 那一轮里模型自己调 MCP 工具
→ 模型自己写日报」。它为此专门建了最小权限 profile，还花了几个版本修桌面版上 spawn 的坑。

**贴吧版不这么干。** 实测本机 `ctx.llm.stream()` 可用（`@deepseek-ai/dsh-llm` 是宿主的唯一受支持模型调用路径，
见 `tmp/tieba-ref/dsh-llm.README.zh.md`），所以：

```
到点（或在设置页点「现在跑一轮」）
  ↓ 插件进程内
① lib/tieba.mjs 拉列表 / 拉正文        ← 纯 HTTP，插件自己干
② 拼一个 prompt（章程 + 候选帖 + 正文片段 + 这轮要挑几条）
③ ctx.llm.stream({ messages: [...] })  ← 模型**只**做判断，吐一段 JSON
④ 插件解析 JSON → 自己写 out/<day>.md、自己更新 seen.json
⑤ 开了 autoReply 才由插件自己调 tieba.mjs 回帖
```

为什么这样更好：

- **模型零工具、零文件、零联网** —— 它只看到插件递给它的文本，只吐一段 JSON。
  B 站版要用专用 profile 才达到的隔离，这里靠架构本身达到（贴吧内容里的注入文本摸不到本机任何东西）。
- **没有子进程** —— 不依赖 dsh 是否在 PATH、不依赖桌面版 spawn 行为、不用建 profile。
- **便宜且快**：一次模型调用，没有多轮工具循环。

模型必须返回的 JSON 形状（插件端严格校验，坏了就当这轮失败、不写日报、不更判重表）：

```json
{
  "picks": [
    { "tid": "11145600862", "tier": "值得看", "why": "一句话", "oneLine": "它的吐槽", "reply": "要回的话（不开自动回帖就留空）" }
  ],
  "skipped": [ { "tid": "11101947186", "why": "广告" } ],
  "summary": "今天整体的感觉，一句话"
}
```

- `tier` 只能是 `值得看` / `可以看` / `不值当` 三者之一
- `picks` 条数不得超过这一轮的配额（`perDay` 剩余 / `manualMax`）
- `tid` 必须是**本轮喂进去的候选 tid** 之一（防止模型瞎编 ID）
- `reply` 超过 `replyLength` 上限就截断；`autoReply` 关着时忽略

`prompts/duty.md` 因此是**给模型的一轮任务书**（判断口径 + 输出格式 + 红线），而不是「教你怎么调工具」。
它会被插件读出来内联进 prompt。
