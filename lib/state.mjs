/**
 * lib/state.mjs —— 插件的"家"、配置、判重表、峰谷窗口
 * ============================================================================
 * 规矩：**配置、凭证、报告、日志都放插件自己的家** —— `$DSH_HOME/tieba-duty/`，
 * **绝不写进插件包目录**（装进 node_modules 后可能只读，升级也会被覆盖）。
 *
 * ⚠️ 2026-10-14 真机上踩过的坑（照抄 dsh-bili-scroll 的经验）：
 *    `ctx.get('dshHomePath')` 返回的是**函数**，不是字符串！
 *    形状：`dshHomePath(...segments) => join(resolveDshHome(), ...segments)`。
 *    当成字符串用（`String(p)`）⇒ 路径成了「函数源码 + \tieba-duty」⇒ mkdir ENOENT
 *    ⇒ apply 抛错 ⇒ **整条插件不激活** ✗
 * ============================================================================
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { homedir } from 'node:os'

/**
 * 谷时窗口（北京时间）—— 想改就改这一处。
 * ⭐ 官方口径（2026-09-10 起的新定价）：**高峰 = 工作日 9:00–12:00 与 14:00–18:00，其余全是谷时**
 *    ⇒ 12:00–14:00 ✓、18:00 之后一整晚 ✓、以及**整个周末** ✓ 都便宜。
 */
export const WINDOWS = {
  noon: { label: '中午谷时', start: '12:00', end: '14:00' },
  night: { label: '晚上/夜间谷时', start: '18:00', end: '09:00' },
}

export const HOME_NAME = 'tieba-duty'

/** 解析插件家目录（顺带建好）；拿不到宿主路径就退到 DSH_HOME / ~/.dsh */
export function stateDirOf(ctx) {
  let dir = ''
  try {
    const p = ctx?.get?.('dshHomePath')
    if (typeof p === 'function') {
      const v = p(HOME_NAME)                     // ← 函数形态：把目录名传进去
      if (v) dir = String(v)
    } else if (typeof p === 'string' && p) {
      dir = join(p, HOME_NAME)
    }
  } catch { /* 拿不到就用下面的兜底 */ }
  if (!dir) dir = join(process.env.DSH_HOME || join(homedir(), '.dsh'), HOME_NAME)
  mkdirSync(dir, { recursive: true })
  return dir
}

export function readJson(file, fallback) {
  try {
    // ⚠️ 2026-10-28 真机踩实：Windows 上用记事本 / `Set-Content -Encoding utf8`
    //    （PowerShell 5.1）改过 config.json，文件头会带 **UTF-8 BOM**（EF BB BF），
    //    而 `JSON.parse` 见到 U+FEFF 直接抛 `Unexpected token` ⇒ 整份配置被当成空 ⇒
    //    全部退回默认值（症状：关注吧变成内置默认、fetchPerRound 变 0、只跑标题）。
    //    ⇒ 读任何 JSON 都先剥 BOM，不跟编辑器赌。
    const txt = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    return JSON.parse(txt)
  } catch { return fallback }
}

export function writeJson(file, value) {
  // 写的时候绝不带 BOM（`JSON.stringify` 本来就没有，这里只是把意图写下来）
  writeFileSync(file, JSON.stringify(value, null, 2), 'utf8')
}

export function logTo(logFile, msg, logger) {
  const line = `${new Date().toISOString()}  ${msg}`
  try { appendFileSync(logFile, line + '\n', 'utf8') } catch { /* 日志写不进去不致命 */ }
  try { logger?.info?.(`[tieba-duty] ${msg}`) } catch { /* 没有 logger 就算了 */ }
}

/**
 * 值班章程（prompts/duty.md）怎么升级 —— 记账制。
 *   · 家里那份 === 我们上次铺的 ⇒ 他没动过 ⇒ 直接用 shipped 覆盖（升级 ✓）
 *   · 家里那份变过           ⇒ 他改过 ⇒ **一个字都不动**，新版另存 duty.md.new ✓
 *   · 没有账本（第一次）      ⇒ 分不清「没改只是版本旧」和「改过」⇒ 按「改过」处理 ✓
 */
export function ensureCharter(pluginDir, stateDir, log = () => {}) {
  const shipped = join(pluginDir, 'prompts', 'duty.md')
  const home = join(stateDir, 'duty.md')
  const ledger = join(stateDir, 'charter.sha256')
  const fresh = join(stateDir, 'duty.md.new')
  const readIf = (f) => { try { return readFileSync(f, 'utf8') } catch { return '' } }
  try {
    if (!existsSync(shipped)) { log(`缺文件：${shipped}`); return }
    const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex')
    const newText = readFileSync(shipped, 'utf8')
    const hShip = sha(newText)
    const hLast = readIf(ledger).trim()
    if (!existsSync(home)) {
      writeFileSync(home, newText, 'utf8'); writeFileSync(ledger, hShip, 'utf8')
      log('已铺好值班章程')
      return
    }
    const hHome = sha(readFileSync(home, 'utf8'))
    if (hHome === hShip) {                        // 家里那份就是最新版
      if (hLast !== hShip) writeFileSync(ledger, hShip, 'utf8')
      return
    }
    if (!hLast || hHome !== hLast) {              // 他改过（或没账本）⇒ 只另存新版
      if (hShip !== hLast && readIf(fresh) !== newText) {
        writeFileSync(fresh, newText, 'utf8')
        log(`值班章程有新版、但家里那份你改过 ⇒ 新版另存为 ${fresh}，自己合一下`)
      }
      return
    }
    writeFileSync(home, newText, 'utf8'); writeFileSync(ledger, hShip, 'utf8')
    log('值班章程已更新到插件里这一版')
  } catch (e) { log(`铺值班章程失败：${e?.message ?? e}`) }
}

/** 章程用哪一份：家里那份优先，没有才用插件里那份 */
export function charterPath(pluginDir, stateDir) {
  const home = join(stateDir, 'duty.md')
  try { if (existsSync(home)) return home } catch { /* 兜底 */ }
  return join(pluginDir, 'prompts', 'duty.md')
}

/** 'HH:MM' → 当天分钟数 */
function minutesOf(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm).trim())
  if (!m) return null
  return Number(m[1]) * 60 + Number(m[2])
}

/** 北京时间的「当天第几分钟」（0–1439），不受机器时区影响 */
export function beijingMinutes(now = new Date()) {
  try {
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false,
    })
    const [hh, mm] = fmt.format(now).split(':').map(Number)
    return hh * 60 + mm
  } catch {
    return now.getHours() * 60 + now.getMinutes()
  }
}

/**
 * 现在是不是落在某个窗口里（北京时间，跨零点也认）。
 * @returns {string} 窗口名（'noon' / 'night'）或 ''
 */
export function inWindow(now = new Date()) {
  const mins = beijingMinutes(now)
  for (const [key, w] of Object.entries(WINDOWS)) {
    const a = minutesOf(w.start)
    const b = minutesOf(w.end)
    if (a == null || b == null) continue
    if (a <= b) { if (mins >= a && mins < b) return key }
    else { if (mins >= a || mins < b) return key }       // 跨零点
  }
  return ''
}

/**
 * 这个窗口的「账该记在哪一天」。
 * ⭐ 为什么需要它：`night` 窗口是 18:00–09:00 **跨夜**的。如果守卫 key 直接用
 *    `dayKey()`（今天），那昨晚 20:00 跑过一次（key=昨天）、今天凌晨 02:00 又变成
 *    key=今天 ⇒ **同一个夜窗口会跑两轮**（2026-10-28 发现的既存 bug）。
 * ⇒ 跨夜窗口：当前时刻若还没到结束时间（说明刚过零点），这个窗口算**昨天**开始的。
 */
export function windowKeyDay(winKey, now = new Date()) {
  const w = WINDOWS[winKey]
  if (!w) return dayKey(now)
  const mins = beijingMinutes(now)
  const a = minutesOf(w.start)
  const b = minutesOf(w.end)
  if (a != null && b != null && a > b && mins < b) {
    return yesterdayKey(now)                 // 跨夜且现在还在凌晨 ⇒ 归昨天那个窗口
  }
  return dayKey(now)
}

/** 北京时间昨天是哪天 */
export function yesterdayKey(now = new Date()) {
  return dayKey(new Date(now.getTime() - 86_400_000))
}

/** 北京时间今天是哪天（'YYYY-MM-DD'）—— 日报和配额都按它算 */
export function dayKey(now = new Date()) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(now)
  } catch {
    const d = new Date(now.getTime())
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }
}

/** 判重表：`{ threads: { tid: {at, bar, title, tier, replied} }, day: { 'YYYY-MM-DD': n } }` */
export function loadSeen(stateDir) {
  const f = join(stateDir, 'seen.json')
  const j = readJson(f, {})
  const threads = j && typeof j.threads === 'object' && j.threads ? j.threads : {}
  const day = j && typeof j.day === 'object' && j.day ? j.day : {}
  return { file: f, threads, day }
}

export function saveSeen(seen) {
  // 判重表只留最近 4000 条，别让它无限长
  try {
    const rows = Object.entries(seen.threads)
    if (rows.length > 4000) {
      rows.sort((a, b) => (b[1]?.at || 0) - (a[1]?.at || 0))
      seen.threads = Object.fromEntries(rows.slice(0, 4000))
    }
    const days = Object.entries(seen.day)
    if (days.length > 90) {
      days.sort((a, b) => String(b[0]).localeCompare(String(a[0])))
      seen.day = Object.fromEntries(days.slice(0, 90))
    }
    writeJson(seen.file, { threads: seen.threads, day: seen.day })
  } catch { /* 存不下就算了，下一轮再试 */ }
}

/** 今天已经挑了几条 */
export function pickedToday(seen, day = dayKey()) {
  return Number(seen.day?.[day] || 0) || 0
}

export function bumpDay(seen, n = 1, day = dayKey()) {
  seen.day[day] = (Number(seen.day[day] || 0) || 0) + n
}
