/**
 * dsh-tieba-scroll —— host 半端
 * ============================================================================
 * 它是什么：每天替你刷一轮贴吧的插件版。
 *   1. **零外部依赖**：列表 / 正文 / 回帖全走贴吧网页版（`lib/tieba.mjs`，纯 fetch），
 *      不装 Python、不装 MCP、不起子进程、不建 profile —— 这是跟 B 站版最大的区别。
 *   2. **跑一轮在插件进程内完成**（`lib/round.mjs`）：插件自己拉数据 → 调宿主 `ctx.llm.stream()`
 *      让模型只做判断 → 插件自己写日报 / 更新判重表 / 回帖。模型零工具、零文件、零联网。
 *   3. **峰谷定时器**：中午 12:00–14:00、晚上 18:00–09:00（`lib/state.mjs` 的 `WINDOWS`），
 *      开了哪个窗口才在哪个窗口自动跑；「定量刷」的数字是**每天总量上限**。
 *   4. **工具**（`tieba_*`）是给用户在正常会话里对话用的，跟跑一轮无关。
 *   5. **设置页**（`client.js`）通过 `/api/tieba-duty/*` 读写配置、看状态、粘登录凭证。
 *
 * 家里（`$DSH_HOME/tieba-duty/`）都有什么：
 *   `config.json` / `tieba_credential.json` / `duty.md` / `out/<日期>.md` / `seen.json` / `duty.log`
 * ============================================================================
 */
import { loadHostDeps } from './lib/hostdeps.mjs'

// ⭐ 这两样从**宿主那棵树**里取（拿不到就退到自己的依赖；再拿不到，defineTool 用本地等价实现）。
//    起因（B 站版 2026-10-16 的真实事故）：它们是 optional peer，桌面版 profile 是
//    `autoInstallPeers: false` ⇒ 永远不装 ⇒ **裸 import 会让整条插件不激活** ✗。
const hostDeps = await loadHostDeps()
const z = hostDeps.z
const defineTool = hostDeps.defineTool

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as tieba from './lib/tieba.mjs'
import { runRound } from './lib/round.mjs'
import {
  WINDOWS, stateDirOf, readJson, writeJson, logTo, ensureCharter, charterPath,
  inWindow, dayKey, yesterdayKey, windowKeyDay, loadSeen, saveSeen, pickedToday,
} from './lib/state.mjs'

export const name = 'tieba-scroll'
// tools / webServer 是必需品；settings 用来把配置写回宿主那层（写不进去也不致命，见 saveCfgHost）
export const inject = ['webServer', 'tools', 'settings']

/**
 * 🔴 每个字段都要 `.extra('volatile', true)`：DSH 的 settings.update() 只认 volatile 字段
 *    （`volatileForm(schema)`，见 dsh-settings），没有这个标记写设置时会抛
 *    "Plugin entry … has no volatile fields"。
 * ⚠️ 数值项**故意不写 `.max()`**：schema 校验不过 ⇒ cordis 拒收这条 entry ⇒ **整条插件不激活** ✗。
 *    范围一律在写入和读取两端用 clampPatch 钳。
 */
export const Config = !z ? undefined : z.object({
  /** 插件总开关 */
  enabled: z.boolean().default(true).extra('volatile', true),
  /** 峰谷自动刷（总开关） */
  peakValley: z.boolean().default(false).extra('volatile', true),
  /** 峰谷子开关：中午 12–14 */
  noon: z.boolean().default(true).extra('volatile', true),
  /** 峰谷子开关：晚上 18–09 */
  night: z.boolean().default(true).extra('volatile', true),
  /** 定量刷：每天最多挑几条（0 = 只手动） */
  perDay: z.natural().default(5).extra('volatile', true),
  /** 关注的吧（一行一个）；空则用内置默认几组 */
  bars: z.array(z.string()).default([]).extra('volatile', true),
  /** 只挑标题含这些词的（空 = 不过滤） */
  keywords: z.array(z.string()).default([]).extra('volatile', true),
  /** 标题/作者含这些词就跳过 */
  excludeWords: z.array(z.string()).default([]).extra('volatile', true),
  /** 每轮最多细读几篇正文 */
  fetchPerRound: z.natural().default(8).extra('volatile', true),
  /** 每个吧取多少条候选 */
  listPerBar: z.natural().default(30).extra('volatile', true),
  /** reply=按回复数 / time=按时间 */
  sortBy: z.string().default('reply').extra('volatile', true),
  /** 日报形态：full / brief / off */
  reportLevel: z.string().default('full').extra('volatile', true),
  /** 自动回帖 —— **拿用户账号说话**，默认关 */
  autoReply: z.boolean().default(false).extra('volatile', true),
  /** ⭐ 只在哪些吧里回帖（一行一个）；**留空 = 不限制**。
   *  典型用法：把「反XX吧」这类只读吧排除掉，避免被当水军/引战。 */
  replyBars: z.array(z.string()).default([]).extra('volatile', true),
  /** 每轮最多回几条（0–20，钳在 clampPatch） */
  replyPerRound: z.natural().default(1).extra('volatile', true),
  /** 回帖里 @ 谁（留空 = 不 @） */
  mentionName: z.string().default('').extra('volatile', true),
  /** 回帖长度：short ≤15 / medium ≤40 / long ≤100 */
  replyLength: z.string().default('medium').extra('volatile', true),
  /** 允许发主题帖（额外危险，默认关） */
  allowPost: z.boolean().default(false).extra('volatile', true),
  /** 它按什么口气说话 */
  personaPrompt: z.string().default('').extra('volatile', true),
  /** 手动跑一轮最多挑几条 */
  manualMax: z.natural().default(3).extra('volatile', true),
  /** 两次手动之间至少隔几分钟 */
  manualCooldownMin: z.natural().default(10).extra('volatile', true),
})

/** 内置的默认吧（用户没填 bars 时用）—— 挑的是够日常、内容量大的 */
const DEFAULT_BARS = ['原神', '崩坏星穹铁道', 'steam', '编程']

/** 配置字段 → 类型 / 范围，读写两端都过一遍（schema 里不能写 .max()，所以这里兜） */
const NUMERIC = {
  // ⚠️ fetchPerRound 的下限是 **0**（不是 1）：0 = 「只看标题」模式，不读正文、省 token
  perDay: [0, 100], fetchPerRound: [0, 12], listPerBar: [1, 60],
  replyPerRound: [0, 20], manualMax: [1, 20], manualCooldownMin: [0, 1440],
}
const BOOLS = ['enabled', 'peakValley', 'noon', 'night', 'autoReply', 'allowPost']
const STRINGS = ['sortBy', 'reportLevel', 'mentionName', 'replyLength', 'personaPrompt']
const ARRAYS = ['bars', 'keywords', 'excludeWords', 'replyBars']

/** 把一份 patch 钳成合法值；不认识的 key 直接丢掉（防设置页塞垃圾进来） */
function clampPatch(patch) {
  const out = {}
  if (!patch || typeof patch !== 'object') return out
  for (const [k, v] of Object.entries(patch)) {
    if (BOOLS.includes(k)) { out[k] = v === true; continue }
    if (NUMERIC[k]) {
      const n = Number(v)
      // ⚠️ 非法值**直接跳过**，别退回下界 —— fetchPerRound 的下界是 0，
      //    以前退回 0 会让它误判成「只看标题」模式（2026-10-28 真机撞到过）
      if (!Number.isFinite(n)) continue
      const [lo, hi] = NUMERIC[k]
      out[k] = Math.max(lo, Math.min(hi, Math.round(n)))
      continue
    }
    if (ARRAYS.includes(k)) {
      // ⭐ 2026-10-28 真机踩到：宿主 apply() 传来的 `bars` 可能不是数组（是包装对象），
      //    以前 `String(v).split()` 会得到 `["[object Object]"]`，然后真的去请求
      //    一个叫「[objectObject]」的吧 ⇒ 风控 + 一轮白跑。
      //    ⇒ 不是数组 / 字符串就直接**丢弃这个键**（不猜、不转），另两种正常形态才收。
      let arr
      if (Array.isArray(v)) arr = v
      else if (typeof v === 'string') arr = v.split(/[\n,，]/)
      else continue
      out[k] = arr.map((s) => String(s).trim()).filter(Boolean).slice(0, 200)
      continue
    }
    if (STRINGS.includes(k)) { out[k] = String(v ?? '').slice(0, 2000); continue }
  }
  if (out.reportLevel && !['full', 'brief', 'off'].includes(out.reportLevel)) out.reportLevel = 'full'
  if (out.sortBy && !['reply', 'time'].includes(out.sortBy)) out.sortBy = 'reply'
  if (out.replyLength && !['short', 'medium', 'long'].includes(out.replyLength)) out.replyLength = 'medium'
  return out
}

export function apply(ctx, config) {
  const pluginDir = dirname(fileURLToPath(import.meta.url))

  // 自己的版本号（设置页要显示）
  let myVer = ''
  const myVersion = () => {
    if (myVer) return myVer
    try { myVer = String(JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8')).version || '') } catch { myVer = '' }
    return myVer
  }

  const stateDir = stateDirOf(ctx)
  // ⭐ 让 lib/tieba.mjs 的**读接口**也知道家目录在哪 —— 贴吧风控要求每个请求都带 cookie。
  //    只带 BDUSS 会被 403「百度安全验证」；要带浏览器那整串（BDORZ/BAIDUID/ZFY…），
  //    详见 lib/tieba.mjs 的 cookieOf 注释（2026-10-28 真机实测）。
  try { tieba.configure({ stateDir }) } catch { /* 老版本没这函数也不致命 */ }
  const cfgFile = join(stateDir, 'config.json')
  const logFile = join(stateDir, 'duty.log')
  const outDir = join(stateDir, 'out')
  const guardFile = join(stateDir, 'windows.json')
  mkdirSync(outDir, { recursive: true })

  const log = (msg) => logTo(logFile, msg, ctx.logger)
  for (const n of hostDeps.notes) log(n)

  /**
   * ⚠️ 2026-10-14 事故（B 站版第一次挂上就炸了整个 DSH）：
   *   `apply(ctx, config)` 传进来的 `config`，字段值**不保证是标量** ——
   *   `config.pythonPath` 是对象、`config.keywords` 不是数组。对象是"真值"，
   *   于是 `if (!cfg.enabled) return` 这种守卫全部失效，一路炸到底。
   * ⇒ 一律以 `config.json` 为准，`config` 只当"宿主那边最新值"合一次进来。
   */
  const hostCfg = clampPatch(config && typeof config === 'object' ? config : {})

  const loadCfg = () => {
    const disk = readJson(cfgFile, {})
    const base = {
      enabled: true, peakValley: false, noon: true, night: true, perDay: 5,
      bars: [], keywords: [], excludeWords: [],
      fetchPerRound: 8, listPerBar: 30, sortBy: 'reply', reportLevel: 'full',
      autoReply: false, replyBars: [], replyPerRound: 1, mentionName: '', replyLength: 'medium',
      allowPost: false, personaPrompt: '', manualMax: 3, manualCooldownMin: 10,
    }
    // ⚠️ 顺序要紧：**磁盘（config.json）最后覆盖**。
    //    2026-10-28 真机踩到：宿主 apply() 传来的 config 里 `bars` 是个包装对象，
    //    它盖掉了磁盘上正确的 `["原神"]`，于是真去请求「[objectObject]」这个吧。
    //    磁盘那份是用户在设置页亲手存下来的，永远该以它为准。
    const merged = { ...base, ...hostCfg, ...clampPatch(disk) }
    // 本地覆盖优先（DSH 某些启动方式下 ctx.settings.update 写不进去，见下）
    const ov = readJson(join(stateDir, 'local-override.json'), {})
    for (const k of Object.keys(ov || {})) {
      if (k in merged && disk[k] !== undefined) merged[k] = clampPatch(disk)[k]
    }
    if (!Array.isArray(merged.bars) || !merged.bars.length) merged.bars = DEFAULT_BARS.slice()
    return merged
  }

  /**
   * 写回宿主那层设置（尽力而为）。
   * 2026-10-18 两个用户实证：某些启动方式下 `ctx.settings.update` 会抛
   *   `profile reload requires the root Include entry` ⇒ 写不进宿主。
   * ⇒ 先落本地 config.json（一定成功），再试宿主；失败就记进 local-override 当"本地为准"。
   */
  const saveCfgHost = async (patch) => {
    let hostOk = false
    try {
      if (typeof ctx.settings?.describe === 'function' && typeof ctx.settings?.update === 'function') {
        const rows = ctx.settings.describe() || []
        const row = rows.find((r) => r && (r.ns === name || r.id === name))
        if (row?.ns) {
          await ctx.settings.update(row.ns, patch, row.revision)
          hostOk = true
        }
      }
    } catch (e) {
      log('写宿主设置失败（照本地为准）：' + (e?.message ?? e))
    }
    return hostOk
  }

  const saveCfg = async (rawPatch) => {
    const patch = clampPatch(rawPatch)
    if (!Object.keys(patch).length) return { ok: false, error: '没有可保存的字段' }
    const cur = readJson(cfgFile, {})
    const next = { ...cur, ...patch }
    writeJson(cfgFile, next)
    const hostOk = await saveCfgHost(patch)
    // 宿主没同步成功 ⇒ 把这些键记成"本地为准"
    try {
      const ovf = join(stateDir, 'local-override.json')
      const ov = readJson(ovf, {})
      if (!hostOk) { for (const k of Object.keys(patch)) ov[k] = Date.now() }
      else { for (const k of Object.keys(patch)) delete ov[k] }
      writeJson(ovf, ov)
    } catch { /* 记不上就下次再说 */ }
    return { ok: true, config: loadCfg(), savedLocalOnly: !hostOk }
  }

  // 铺值班章程（给模型读的任务书）
  try { ensureCharter(pluginDir, stateDir, log) } catch { /* 上面已记日志 */ }

  /* ═══════════════ 工具（给用户在会话里对话用） ═══════════════ */

  const textOutput = {
    schema: { type: 'object', properties: {}, additionalProperties: true },
    render: (_args, value) => [{
      type: 'text',
      text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
    }],
  }
  const safe = (v) => {
    if (v === undefined || v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
    try { return JSON.parse(JSON.stringify(v)) } catch { return String(v) }
  }
  const tool = (spec) => ctx.tools.register(defineTool({
    ...spec,
    output: spec.output || textOutput,
    async execute(args, exec) { return safe(await spec.execute(args, exec)) },
  }))

  const cred = () => tieba.loadCredential(stateDir)

  tool({
    name: 'tieba_whoami',
    description: '看贴吧那边登录的是谁（BDUSS 凭证是否有效、昵称）。第一次用要先在「刷贴吧」设置页里粘 BDUSS。',
    parameters: {},
    async execute() {
      const c = cred()
      if (!c?.bduss) {
        return { ok: false, loggedIn: false, hint: '还没登录：去 dsh 设置页的「刷贴吧 → 高级」里粘 BDUSS（浏览器 F12 → Application → Cookies → tieba.baidu.com）' }
      }
      const r = await tieba.whoami(c)
      return { ok: true, ...(r && typeof r === 'object' ? r : { raw: r }) }
    },
  })

  tool({
    name: 'tieba_list',
    description: '看一个吧的帖子列表（标题 / 作者 / 回复数 / 时间 / 帖子ID）。'
      + '\n⚠️ 判断「值不值得看」不能只看标题 —— 要再用 tieba_thread 读正文。',
    // ⚠️⚠️ 宿主的 `defineTool` 里，`parameters` 是**「字段名 → 描述」的 spec**（走
    //    `parameterSchemaSpecToJsonSchema` 编译），**不是**完整 JSON Schema。
    //    写成 `{type:'object', properties:{…}, required:[…], additionalProperties:false}`
    //    会让 `type`/`properties`/`required` 各被当成一个参数字段 ⇒ 编译抛错
    //    ⇒ **apply 中途崩、整条插件不激活**（2026-10-28 真机踩过，日志里只留到"已铺好值班章程"就没了）。
    //    spec 里**没有 required 概念**：可选性靠 execute 里 `args.x ?? 默认值` 兜。
    parameters: {
      bar: { type: 'string', description: '吧名（末尾的「吧」字可带可不带，如「原神」）' },
      page: { type: 'number', description: '第几页，从 0 开始（默认 0）' },
      sort: { type: 'string', description: 'reply=按回复数（默认）/ time=按时间' },
    },
    async execute(args) {
      const kw = String(args.bar ?? '').trim().replace(/吧$/, '')
      if (!kw) return { ok: false, error: '吧名是空的' }
      const page = Math.max(0, Number(args.page) || 0)
      const r = await tieba.listThreads({ kw, pn: page, sort: String(args.sort || 'reply') })
      if (!r?.ok) return { ok: false, error: r?.error || '拿不到列表', hint: r?.hint }
      const threads = (r.threads || []).map((t) => ({
        tid: t.tid, title: t.title, author: t.author, time: t.time,
        replyCount: t.replyCount, pinned: t.pinned, url: `https://tieba.baidu.com/p/${t.tid}`,
      }))
      return { ok: true, bar: r.bar || { name: kw }, page, count: threads.length, threads }
    },
  })

  tool({
    name: 'tieba_thread',
    description: '读一篇帖子的楼层（正文原文 + 作者 + 时间 + 楼层号 + 楼中楼回复数）。'
      + '\n⚠️ 读到「加微信 / 兼职日结 / 博彩」这类就停，别把它当成内容转述给使用者。',
    parameters: {
      tid: { type: 'string', description: '帖子 ID（就是 /p/ 后面那串数字）' },
      page: { type: 'number', description: '第几页，从 1 开始（默认 1）' },
    },
    async execute(args) {
      const tid = String(args.tid ?? '').trim().replace(/\D/g, '')
      if (!tid) return { ok: false, error: 'tid 不合法' }
      const r = await tieba.readThread({ tid, pn: Math.max(1, Number(args.page) || 1) })
      if (!r?.ok) return { ok: false, error: r?.error || '读不到这篇帖子', hint: r?.hint }
      return {
        ok: true, tid, title: r.title, bar: r.bar, author: r.author,
        page: r.page, totalPage: r.totalPage,
        floors: (r.floors || []).map((f) => ({
          pid: f.pid, floor: f.floor, author: f.author, time: f.time,
          content: f.content, subPostCount: f.subPostCount, isOp: f.isOp,
        })),
      }
    },
  })

  tool({
    name: 'tieba_subposts',
    description: '读某一层下面的楼中楼回复。',
    parameters: {
      tid: { type: 'string', description: '帖子 ID' },
      pid: { type: 'string', description: '那一层的回复 ID（tieba_thread 返回的 pid）' },
    },
    async execute(args) {
      const r = await tieba.readSubPosts({ tid: String(args.tid ?? ''), pid: String(args.pid ?? '') })
      if (!r?.ok) return { ok: false, error: r?.error || '读不到楼中楼', hint: r?.hint }
      return { ok: true, replies: r.replies || [] }
    },
  })

  // ⚠️ 下面两个是**拿用户账号说话**的。
  //    以前是「开关关着就根本不注册」，可工具只在 apply 时注册一次 ⇒ 用户打开开关后
  //    还得重启 dsh 才生效，太反人类（2026-10-28 实测踩到）。
  //    现在**总是注册、execute 里查开关**：模型能看见名字，但没开开关就调不动 ——
  //    安全边界没松（照样发不出去），体验好得多。
  tool({
    name: 'tieba_reply',
    description: '在贴吧回一句（给了 pid 就是楼中楼回复）。'
      + '\n⚠️ 这是拿使用者的账号说话：绝不透露账号/路径/私聊内容，不引战，不长篇大论。'
      + '\n需要使用者先在「设置 → 刷贴吧 → 互动」里打开「自动回帖」，否则会被直接拒绝。',
    parameters: {
      tid: { type: 'string', description: '帖子 ID' },
      content: { type: 'string', description: '要说的话（短、像吧友）' },
      pid: { type: 'string', description: '可选：楼中楼要回到的那一层的 pid' },
    },
    async execute(args) {
      if (loadCfg().autoReply !== true) {
        return { ok: false, error: '「自动回帖」开关没开', hint: '去 设置 → 刷贴吧 → 互动 里打开它（不用重启，立刻生效）' }
      }
      const c = cred()
      if (!c?.bduss) return { ok: false, error: '未登录：先去设置页粘 BDUSS', hint: '没有凭证就发不出回帖' }
      const content = String(args.content ?? '').trim()
      if (!content) return { ok: false, error: '内容为空' }
      if (content.length > 100) return { ok: false, error: `太长了（${content.length} 字），回帖别超过 100 字` }
      const r = args.pid
        ? await tieba.replySubPost({ ...c, tid: String(args.tid), pid: String(args.pid), content })
        : await tieba.replyPost({ ...c, tid: String(args.tid), content })
      return r?.ok ? { ok: true, ...r } : { ok: false, error: r?.error || '回帖失败', hint: r?.hint }
    },
  })

  tool({
    name: 'tieba_post_thread',
    description: '发一个主题帖。⚠️ 这是拿使用者的账号发内容，发出去删不掉。'
      + '\n需要使用者先在「设置 → 刷贴吧 → 互动」里打开「允许发主题帖」，否则会被直接拒绝。',
    parameters: {
      bar: { type: 'string', description: '吧名' },
      title: { type: 'string', description: '标题' },
      content: { type: 'string', description: '正文' },
    },
    async execute(args) {
      if (loadCfg().allowPost !== true) {
        return { ok: false, error: '「允许发主题帖」开关没开', hint: '去 设置 → 刷贴吧 → 互动 里打开它（不用重启，立刻生效）' }
      }
      const c = cred()
      if (!c?.bduss) return { ok: false, error: '未登录：先去设置页粘 BDUSS' }
      const r = await tieba.postThread({
        ...c,
        kw: String(args.bar ?? '').replace(/吧$/, ''),
        title: String(args.title ?? ''),
        content: String(args.content ?? ''),
      })
      return r?.ok ? { ok: true, ...r } : { ok: false, error: r?.error || '发帖失败', hint: r?.hint }
    },
  })

  /* ═══════════════ 峰谷定时器 + 手动跑一轮 ═══════════════ */

  let running = false
  let lastRun = { at: 0, ok: null, error: '', picked: 0, replied: 0, mode: '' }

  const doRun = async (mode) => {
    if (running) return { ok: false, started: false, reason: '还在跑上一轮，等它结束' }
    const cfg = loadCfg()
    if (mode === 'manual') {
      const cool = Math.max(0, Number(cfg.manualCooldownMin) || 0) * 60_000
      const since = Date.now() - (lastRun.at || 0)
      if (lastRun.at && since < cool) {
        const wait = Math.ceil((cool - since) / 60_000)
        return { ok: false, started: false, reason: `刚跑过，再等 ${wait} 分钟左右` }
      }
    }
    running = true
    const started = Date.now()
    try {
      log(`开始跑一轮（${mode}）`)
      const r = await runRound({ ctx, cfg, stateDir, log, pluginDir, mode })
      lastRun = {
        at: Date.now(), ok: r.ok, error: r.error || '', picked: r.picked || 0,
        replied: r.replied || 0, mode,
      }
      if (!r.ok) log(`这一轮没跑成：${r.error}`)
      return { ok: r.ok, started: true, ...r, ms: Date.now() - started }
    } catch (e) {
      lastRun = { at: Date.now(), ok: false, error: String(e?.message ?? e), picked: 0, replied: 0, mode }
      log('跑一轮炸了：' + (e?.stack || e?.message || e))
      return { ok: false, started: true, error: String(e?.message ?? e) }
    } finally {
      running = false
    }
  }

  /** 窗口守卫：`{ 'YYYY-MM-DD:noon': ts }` —— 同一个窗口一天只自动跑一次 */
  /**
   * 窗口守卫：`{ 'YYYY-MM-DD:noon': { planAt, ran, ranAt } }`
   *
   * ⭐ 2026-10-28 两个改动（第二个是使用者点的）：
   *   ① **不再整点跑** —— 以前是「窗口一打开就执行」，于是 12:00:00 整、18:00:00 整各跑一轮。
   *      整点执行是最典型的机器特征，贴吧风控一眼就认出来。现在进入窗口后**随机等 5–80 分钟**
   *      再跑，每天每个窗口的落点都不一样（也更像"人想起来才去看一眼"）。
   *   ② **修跨夜双跑** —— 夜窗口 18:00–09:00 是跨夜的，key 以前用 `dayKey()`（今天）⇒
   *      昨晚 20:00 跑一次（key=昨天）、今天凌晨 02:00 又变成 key=今天再跑一次。
   *      现在用 `windowKeyDay()`，凌晨那段归「昨天」那个窗口。
   */
  const readGuard = () => readJson(guardFile, {})
  const saveGuard = (g) => {
    const keep = Object.entries(g)
      .filter(([k]) => k.startsWith(dayKey()) || k.startsWith(yesterdayKey()))
      .slice(-20)
    writeJson(guardFile, Object.fromEntries(keep))
  }
  /** 第一次进这个窗口时随机摊一个落点，之后一直用它 */
  const planOf = (key, label) => {
    const g = readGuard()
    let ent = g[key]
    if (!ent || typeof ent !== 'object' || typeof ent.planAt !== 'number') {
      const delayMin = 5 + Math.floor(Math.random() * 76)        // 5–80 分钟
      ent = { planAt: Date.now() + delayMin * 60_000, ran: false }
      g[key] = ent
      saveGuard(g)
      log(`${label}：落点随机定在 ${delayMin} 分钟后（不整点跑）`)
    }
    return ent
  }

  let timer = null
  const tick = async () => {
    try {
      const cfg = loadCfg()
      if (!cfg.enabled || !cfg.peakValley) return
      const perDay = Math.max(0, Number(cfg.perDay) || 0)
      if (perDay <= 0) return                                      // 0 = 只手动，不排期
      const w = inWindow()
      if (!w) return
      if (w === 'noon' && !cfg.noon) return
      if (w === 'night' && !cfg.night) return

      const label = WINDOWS[w]?.label || w
      const key = `${windowKeyDay(w)}:${w}`
      const ent = planOf(key, label)
      if (ent.ran) return                                          // 这个窗口已经跑过了
      if (Date.now() < ent.planAt) return                          // 还没到它自己的落点

      const seen = loadSeen(stateDir)
      if (pickedToday(seen) >= perDay) return                      // 今天的量够了
      // 先记账再跑：跑一轮要几十秒，别让下一次 tick 又撞进来
      const g2 = readGuard()
      g2[key] = { ...ent, ran: true, ranAt: Date.now() }
      writeJson(guardFile, g2)
      log(`${label}：到落点了，自动跑一轮`)
      await doRun('auto')
    } catch (e) {
      log('定时器出错：' + (e?.message ?? e))
    }
  }
  // 启动 30 秒后先看一次，之后每分钟看一次
  const boot = setTimeout(() => { tick() }, 30_000)
  timer = setInterval(() => { tick() }, 60_000)
  ctx.effect(() => () => { clearTimeout(boot); if (timer) clearInterval(timer) }, 'tieba-duty: 峰谷定时器')

  /* ═══════════════ 给设置页用的 HTTP API ═══════════════ */

  const sendJson = (res, code, obj) => {
    try {
      const body = JSON.stringify(obj)
      res.statusCode = code
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.end(body)
    } catch { try { res.end() } catch { /* 客户端可能已经走了 */ } }
  }

  const sameOriginOk = (req) => {
    try {
      const origin = req.headers?.origin || req.headers?.referer
      if (!origin) return true                       // 非浏览器（curl / 本地脚本）
      const u = new URL(String(origin))
      const host = req.headers?.host
      if (!host) return false
      if (String(u.host).toLowerCase() === String(host).toLowerCase()) return true
      const def = u.protocol === 'https:' ? '443' : '80'
      return `${u.hostname}:${u.port || def}`.toLowerCase() === String(host).toLowerCase()
    } catch { return false }
  }

  // ⭐ 走 DSH 自己的信任栅栏（隧道把 Host 改写成回环时，本机同源这层会被绕过）
  let connCached = null
  let connTried = false
  const getConnection = () => {
    if (connTried) return connCached
    connTried = true
    const tries = [
      () => (typeof ctx.get === 'function' ? ctx.get('connection') : null),
      () => Reflect.get(ctx, 'connection'),
      () => (ctx.root && typeof ctx.root === 'object' ? ctx.root.connection : null),
    ]
    for (const fn of tries) {
      try {
        const c = fn()
        if (c && typeof c.requestRejection === 'function') { connCached = c; return c }
      } catch { /* 换下一个 */ }
    }
    return null
  }
  const fenceReject = (req, res) => {
    const conn = getConnection()
    if (!conn) return false                        // 拿不到栅栏 ⇒ 靠本机同源这一道
    try {
      const rej = conn.requestRejection({ headers: req.headers })
      if (rej === undefined) return false
      res.statusCode = typeof rej === 'number' ? rej : 403
      try { res.end() } catch { /* 忽略 */ }
      return true
    } catch {
      res.statusCode = 403
      try { res.end() } catch { /* 忽略 */ }
      return true
    }
  }

  /** 日报里每条帖子的档位 / 为什么——给「它刷过的帖子」列表补信息 */
  const reportMeta = () => {
    const map = new Map()
    let files = []
    try {
      files = readdirSync(outDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort().reverse().slice(0, 60)
    } catch { return map }
    for (const f of files) {
      let text = ''
      try { text = readFileSync(join(outDir, f), 'utf8') } catch { continue }
      const day = f.replace(/\.md$/, '')
      for (const b of text.split(/\n(?=###\s*\d+)/)) {
        const m = /^###\s*(\d+)/.exec(b)
        if (!m) continue
        const tierM = /\*\*档位\*\*\s*[：:]\s*(值得看|可以看|不值当)/.exec(b)
        const whyM = /\*\*为什么值得\*\*\s*[：:]\s*([\s\S]*?)(?=\n\s*\*\*|$)/.exec(b)
        const replyM = /\*\*回帖\*\*\s*[：:]\s*(.+)/.exec(b)
        map.set(m[1], {
          day,
          tier: tierM ? tierM[1] : '',
          why: whyM ? whyM[1].replace(/\s+/g, ' ').trim().slice(0, 160) : '',
          replied: replyM ? /^已回/.test(replyM[1].trim()) : false,
        })
      }
    }
    return map
  }

  const statusOf = () => {
    const cfg = loadCfg()
    const c = cred()
    const seen = loadSeen(stateDir)
    const day = dayKey()
    const reportPath = join(outDir, `${day}.md`)
    return {
      ok: true,
      version: myVersion(),
      enabled: cfg.enabled,
      home: stateDir,
      ready: { credential: !!c?.bduss, plugin: true },
      credential: { loggedIn: !!c?.bduss, uname: c?.uname || '' },
      today: { picked: pickedToday(seen, day), perDay: cfg.perDay, replied: 0 },
      lastRun,
      running,
      report: { path: reportPath, exists: existsSync(reportPath) },
      log: { path: logFile },
      window: inWindow(),
    }
  }

  const readLogTail = (n) => {
    try {
      const txt = readFileSync(logFile, 'utf8')
      const lines = txt.split('\n').filter(Boolean)
      return lines.slice(-Math.max(1, Math.min(n, 1000)))
    } catch { return [] }
  }

  const handle = async (req, res, url) => {
    const p = url.pathname.replace(/^\/api\/tieba-duty/, '') || '/'
    const method = (req.method || 'GET').toUpperCase()

    const readBody = async () => {
      const chunks = []
      for await (const c of req) chunks.push(c)
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return {}
      try { return JSON.parse(raw) } catch { return {} }
    }

    if (method === 'GET' && p === '/status') return sendJson(res, 200, statusOf())

    if (method === 'GET' && p === '/config') return sendJson(res, 200, { ok: true, config: loadCfg() })

    if (method === 'POST' && p === '/config') {
      const body = await readBody()
      const r = await saveCfg(body.patch ?? body)
      return sendJson(res, r.ok ? 200 : 400, r)
    }

    if (method === 'POST' && p === '/login') {
      const body = await readBody()
      const bduss = String(body.bduss ?? '').trim()
      const stoken = String(body.stoken ?? '').trim()
      if (!bduss) return sendJson(res, 400, { ok: false, error: 'BDUSS 是空的' })
      if (!/^[A-Za-z0-9+/=_-]{20,}$/.test(bduss)) {
        return sendJson(res, 400, { ok: false, error: 'BDUSS 看着不像（一般是一长串字母数字）' })
      }
      // ⭐ cookieRaw：浏览器那**整串** cookie（贴吧风控要 BDORZ/BAIDUID/ZFY 这些）。
      //    只存 BDUSS 的时候，所有请求都会被 403「百度安全验证」—— 实测过的坑。
      const cookieRaw = String(body.cookie ?? body.cookieRaw ?? '').trim()
      const prev = tieba.loadCredential(stateDir) || {}
      tieba.saveCredential(stateDir, {
        bduss,
        stoken,
        uname: String(body.uname ?? '').trim() || prev.uname || '',
        cookieRaw: cookieRaw || prev.cookieRaw || '',
      })
      const who = await tieba.whoami({ bduss, stoken, cookieRaw: cookieRaw || prev.cookieRaw || '' })
      if (who?.ok && who.uname) {
        tieba.saveCredential(stateDir, { bduss, stoken, uname: who.uname })
      }
      log(`登录凭证已保存${who?.ok ? `（${who.uname || '未知昵称'}）` : '（但没验通过）'}`)
      return sendJson(res, 200, { ok: true, whoami: who })
    }

    if (method === 'POST' && p === '/logout') {
      tieba.clearCredential(stateDir)
      log('登录凭证已清除')
      return sendJson(res, 200, { ok: true })
    }

    if (method === 'GET' && p === '/whoami') {
      const c = cred()
      if (!c?.bduss) return sendJson(res, 200, { ok: true, loggedIn: false, uname: '' })
      const r = await tieba.whoami(c)
      return sendJson(res, 200, { ok: true, loggedIn: !!r?.ok, uname: r?.uname || '', error: r?.ok ? '' : r?.error })
    }

    if (method === 'POST' && p === '/run') {
      const body = await readBody()
      if (body.max) { /* 保留位：暂不支持临时改配额 */ }
      const r = await doRun('manual')
      return sendJson(res, 200, r)
    }

    if (method === 'GET' && p === '/report') {
      const day = String(url.searchParams.get('day') || dayKey()).replace(/[^0-9-]/g, '') || dayKey()
      const f = join(outDir, `${day}.md`)
      const exists = existsSync(f)
      let text = ''
      try { if (exists) text = readFileSync(f, 'utf8') } catch { /* 读不到就当空 */ }
      return sendJson(res, 200, { ok: true, day, path: f, exists, text })
    }

    if (method === 'GET' && p === '/threads') {
      const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit')) || 60))
      const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0)
      const wantTier = String(url.searchParams.get('tier') || '')
      // replied=1 只看已回过的 / replied=0 只看没回的 / 缺省 = 不看这个维度
      const wantReplied = url.searchParams.get('replied')
      const seen = loadSeen(stateDir)
      const meta = reportMeta()
      let rows = Object.entries(seen.threads)
        .map(([tid, v]) => ({
          tid,
          bar: v?.bar || '',
          title: v?.title || '',
          at: v?.at || 0,
          tier: meta.get(tid)?.tier || v?.tier || '',
          why: meta.get(tid)?.why || '',
          replied: meta.get(tid)?.replied ?? Boolean(v?.replied),
          day: meta.get(tid)?.day || '',
          url: `https://tieba.baidu.com/p/${tid}`,
        }))
        .filter((r) => (wantTier ? r.tier === wantTier : true))
        .filter((r) => (wantReplied === '1' ? r.replied : wantReplied === '0' ? !r.replied : true))
        .sort((a, b) => b.at - a.at)
      const total = rows.length
      rows = rows.slice(offset, offset + limit)
      return sendJson(res, 200, { ok: true, total, offset, limit, rows })
    }

    if (method === 'POST' && p === '/open-folder') {
      const body = await readBody()
      const which = String(body.which || 'home')
      const target = which === 'out' ? outDir : stateDir
      try {
        if (process.platform === 'win32') spawn('explorer.exe', [target], { detached: true, stdio: 'ignore' }).unref()
        else if (process.platform === 'darwin') spawn('open', [target], { detached: true, stdio: 'ignore' }).unref()
        else spawn('xdg-open', [target], { detached: true, stdio: 'ignore' }).unref()
        return sendJson(res, 200, { ok: true, path: target })
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: `打不开：${e?.message ?? e}`, path: target })
      }
    }

    if (method === 'GET' && p === '/log') {
      const tail = Math.max(1, Math.min(1000, Number(url.searchParams.get('tail')) || 200))
      return sendJson(res, 200, { ok: true, lines: readLogTail(tail), path: logFile })
    }

    return sendJson(res, 404, { ok: false, error: `没有这个接口：${method} ${p}` })
  }

  try {
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: '/api/tieba-duty',
      handler: async (req, res) => {
        if (fenceReject(req, res)) return
        if (!sameOriginOk(req)) {
          try { sendJson(res, 403, { ok: false, error: '只接受本机同源请求' }) } catch { /* 忽略 */ }
          return
        }
        try {
          await handle(req, res, new URL(req.url || '/', 'http://127.0.0.1'))
        } catch (err) {
          sendJson(res, 500, { ok: false, error: err?.message ?? String(err) })
        }
      },
    }), 'tieba-duty: /api/tieba-duty 路由')
  } catch (e) { log(`HTTP 路由没挂上：${e?.message ?? e}`) }

  const c0 = loadCfg()
  log(`已挂载（家=${stateDir}，版本=${myVersion()}，峰谷=${c0.peakValley ? '开' : '关'}，`
    + `自动回帖=${c0.autoReply ? '开' : '关'}，发主题帖=${c0.allowPost ? '开' : '关'}）`)
}
