/**
 * lib/round.mjs —— 「跑一轮」的全部逻辑（插件进程内完成，**不起子进程**）
 * ============================================================================
 * 为什么跟 B 站版不一样（详见 CONTRACT §11）：
 *   B 站版是「spawn 一个 headless dsh，让那一轮里的模型自己调 MCP 工具、自己写日报」，
 *   为此得建最小权限 profile，还得跟桌面版的 spawn 行为搏斗。
 *
 *   贴吧版反过来：**插件自己干所有脏活，模型只做判断**。
 *     ① tieba.mjs 拉列表 / 拉正文
 *     ② 拼 prompt（章程 + 候选帖 + 正文片段 + 这轮挑几条）
 *     ③ ctx.llm.stream() → 模型只吐一段 JSON
 *     ④ 插件自己写 out/<day>.md、自己更新 seen.json
 *     ⑤ 开了 autoReply 才由插件自己调 tieba.mjs 回帖
 *
 *   好处：模型零工具、零文件、零联网 —— 贴吧里那些「忽略以上指令」的注入文本
 *   摸不到本机任何东西。B 站版要靠 profile 才达到的隔离，这里是架构自带的。
 * ============================================================================
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as tieba from './tieba.mjs'
import { dayKey, loadSeen, saveSeen, pickedToday, bumpDay, charterPath, readJson } from './state.mjs'

const TIERS = new Set(['值得看', '可以看', '不值当'])
const MAX_BODY_PER_THREAD = 2600        // 喂给模型的单楼正文上限（比 tieba 层的 4000 更紧，省 token）
const MAX_THREADS_PER_PROMPT = 12       // 一轮最多喂几篇正文

/** 吧名规范化：去掉尾巴上的「吧」，压掉空白 */
function normBar(name) {
  return String(name || '').trim().replace(/吧$/, '').replace(/\s+/g, '')
}

/**
 * 🔴 硬黑名单：**代码里写死、设置页也加不进来**。
 * 理由：这些吧的内容主体是人身攻击 / 侮辱 / 抽象玩梗 —— 读进来只会让模型学着说话，
 * 出来的日报也没法给人看。名单刻意很短，只放最明确的（2026-10-28 使用者点名要的）。
 * ⚠️ 这里不做"价值观判断"，只拦**内容主体就是辱骂**的吧；其它吧交给使用者自己填。
 */
const HARD_BLOCKED_BARS = ['孙笑川', '孙吧', '抽象']

/** 这个吧是不是被硬黑名单挡了 */
function isBlockedBar(bar) {
  const b = normBar(bar)
  if (!b) return false
  return HARD_BLOCKED_BARS.some((bad) => b === bad || b.startsWith(bad) || b.includes(bad))
}

/** 一个简易的、足够用的敏感词表（模型也会判，这里是兜底） */
const HARD_SKIP = [
  '加微信', '加qq', '加v', '代练', '代刷', '刷单', '返利', '日赚', '兼职日结',
  '博彩', '赌球', '下注', '彩票计划', '色情', '约炮', '裸聊', '成人视频',
  '办证', '发票', '贷款秒批', '套现',
]

function looksLikeSpam(title, author) {
  const t = `${title || ''} ${author || ''}`.toLowerCase()
  return HARD_SKIP.some((w) => t.includes(w))
}

/** 从文本里抽出第一段 JSON（模型偶尔会包 ```json 围栏或加废话） */
export function extractJson(text) {
  if (typeof text !== 'string') return null
  let s = text.trim()
  // 去 markdown 围栏
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s)
  if (fence) s = fence[1].trim()
  // 直接能解析就解析
  try { return JSON.parse(s) } catch { /* 继续 */ }
  // 找最外层的 {...}
  const start = s.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < s.length; i += 1) {
    const ch = s[i]
    if (inStr) {
      if (esc) { esc = false; continue }
      if (ch === '\\') { esc = true; continue }
      if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') { inStr = true; continue }
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) {
        try { return JSON.parse(s.slice(start, i + 1)) } catch { return null }
      }
    }
  }
  return null
}

/** 模型的回复按这个形状验收；不合格返回 null */
export function validatePicks(parsed, candidateTids, quota) {
  if (!parsed || typeof parsed !== 'object') return null
  const picks = Array.isArray(parsed.picks) ? parsed.picks : null
  if (!picks) return null
  const tids = new Set(candidateTids.map(String))
  const out = []
  const used = new Set()
  for (const p of picks) {
    if (!p || typeof p !== 'object') continue
    const tid = String(p.tid ?? '').trim()
    if (!tids.has(tid) || used.has(tid)) continue          // 模型瞎编的 ID / 重复 → 丢掉
    const tier = String(p.tier ?? '').trim()
    if (!TIERS.has(tier)) continue
    used.add(tid)
    out.push({
      tid,
      tier,
      why: String(p.why ?? '').trim().slice(0, 200),
      oneLine: String(p.oneLine ?? '').trim().slice(0, 200),
      reply: String(p.reply ?? '').trim(),
    })
    if (out.length >= quota) break
  }
  const skipped = Array.isArray(parsed.skipped)
    ? parsed.skipped
      .filter((s) => s && typeof s === 'object')
      .map((s) => ({ tid: String(s.tid ?? ''), why: String(s.why ?? '').trim().slice(0, 80) }))
      .filter((s) => tids.has(s.tid))
      .slice(0, 60)
    : []
  return { picks: out, skipped, summary: String(parsed.summary ?? '').trim().slice(0, 200) }
}

/** 回帖长度上限（按 replyLength 截断） */
function replyCap(level) {
  if (level === 'short') return 15
  if (level === 'long') return 100
  return 40
}

/**
 * 把模型的流式输出收成一段文本。
 * ⚠️ chunk 形状实测自 @deepseek-ai/dsh-llm（block-start / text-delta{text} / usage / finish{reason}）：
 *    文字增量在 chunk.text，不是 chunk.delta。
 */
async function collectStream(llm, opts, out) {
  let finishReason = null
  for await (const chunk of llm.stream(opts)) {
    if (!chunk || typeof chunk !== 'object') continue
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      out.text += chunk.text
      out.deltas += 1
    } else if (chunk.type === 'finish') {
      finishReason = chunk.reason ?? null
    }
  }
  return finishReason
}

/** 找这一轮用哪个 provider / model：优先用户在 GUI 里选的那个 */
function pickModel(ctx) {
  try {
    const sel = ctx.get?.('agentDefaultModel')?.currentSelection?.()
    if (sel && sel.provider && sel.model) return { provider: sel.provider, model: sel.model, from: 'agentDefaultModel' }
  } catch { /* 继续 */ }
  try {
    const provs = ctx.get?.('llm')?.listProviders?.()
    const p = Array.isArray(provs) ? provs[0] : null
    const id = typeof p === 'string' ? p : p?.id ?? p?.name
    const m = (typeof p === 'object' && (p?.models?.[0]?.id ?? p?.models?.[0])) || ''
    if (id) return { provider: String(id), model: String(m || ''), from: 'listProviders' }
  } catch { /* 继续 */ }
  return null
}

/** 把候选帖和正文拼成给模型看的那一大段 */
function buildPrompt({ charter, cfg, bars, candidates, quota, aiReply, maxReplyChars }) {
  const lines = []
  lines.push('=== 值班章程（必须遵守）===')
  lines.push(charter.trim())
  lines.push('')
  lines.push('=== 这一轮的参数 ===')
  lines.push(`关注的吧：${bars.join('、') || '（无）'}`)
  lines.push(`这一轮最多挑：${quota} 条`)
  lines.push(`要不要写回帖：${aiReply ? '要（每挑中一条给一句回帖）' : '不要（reply 一律留空字符串）'}`)
  if (aiReply) lines.push(`回帖字数上限：${maxReplyChars} 字`)
  if (cfg.personaPrompt && String(cfg.personaPrompt).trim()) {
    lines.push(`它该用什么口气说话（人设）：${String(cfg.personaPrompt).trim()}`)
  }
  lines.push('')
  lines.push('=== 候选帖子 ===')
  for (const c of candidates) {
    lines.push(`--- tid=${c.tid} 吧=${c.bar} ---`)
    lines.push(`标题：${c.title || '（无标题）'}`)
    lines.push(`作者：${c.author || '未知'}　回复数：${c.replyCount ?? '?'}　时间：${c.time || '?'}`)
    if (c.opening) {
      lines.push('正文开头：')
      lines.push(c.opening.slice(0, MAX_BODY_PER_THREAD))
    } else {
      lines.push('正文开头：（没取到，只能看标题）')
    }
    lines.push('')
  }
  lines.push('')
  // ⭐ 2026-10-28 加：章程（duty.md）里为了讲解格式会有示例 tid，真模型和测试都可能
  //    把它当成候选抄进 picks —— 那样 validatePicks 会整条丢掉，表现成「模型什么也没挑」。
  //    所以这里显式给白名单，并说明「示例不算」。
  lines.push(`=== 本轮候选 tid 白名单（${candidates.length} 条）===`)
  lines.push(candidates.map((c) => c.tid).join(', '))
  lines.push('⚠️ `picks` 里的 tid **只能**从上面这行白名单取；章程里举的例子不是候选，别抄。')
  lines.push('')
  lines.push('=== 现在开始，只输出 JSON ===')
  return lines.join('\n')
}

const SYSTEM_HINT = [
  '你是一个替用户在贴吧里「刷一遍」的值班员。你只能看到下面给你的这几篇帖子，不能访问网络、不能调用工具。',
  '你的唯一产出是一段 JSON，不要解释、不要寒暄、不要 markdown 围栏之外的东西。',
  '🔴 picks[].tid 必须是「本轮候选 tid 白名单」里出现过的数字，一个字母都不许变；抄章程里的示例 tid 会让整条被丢弃。',
].join('\n')

/**
 * 渲染这一轮的日报片段。
 * ⚠️ 两种必须同时满足的硬约束：
 *   ① 每条帖子必须有一行**恰好**是 `### <数字 tid>` —— `reportMeta()`（index.js）靠
 *      `/^###\s*(\d+)/` 数条数、补档位，标题上多一个字就数不到。
 *   ② 同一天可以跑好几轮（中午一轮、晚上一轮），所以 → **追加，不覆盖**；
 *      已有的内容一个字都不动，本轮从 `<!-- round: N -->` 后面接上去。
 */
function renderReport(o) {
  const { day, roundNo, first, bars, totalScanned, chosen, picks, skipped, summary, replyNotes, byTid, route, level, headOnly } = o
  const md = []
  if (first) {
    md.push(`# 刷贴吧日报 · ${day}`, '')
  }
  md.push(`<!-- round: ${roundNo} -->`)
  const hhmm = new Date().toLocaleTimeString('zh-CN', {
    timeZone: 'Asia/Shanghai', hour12: false, hour: '2-digit', minute: '2-digit',
  })
  md.push(`> —— 第 ${roundNo} 轮 · ${hhmm} ——`)
  md.push('')
  if (level !== 'brief' || first) {
    md.push(`> 这一轮刷了 ${bars.length} 个吧、${totalScanned} 篇帖子，`
      + `${headOnly ? '只看标题' : `细读 ${chosen.length} 篇`}，挑出 ${picks.length} 条值得看。`)
    if (summary) md.push(`> ${summary}`)
    md.push('')
  }
  // 按吧分组
  const groups = new Map()
  for (const p of picks) {
    const c = byTid.get(p.tid) || {}
    const bar = c.bar || '未分类'
    if (!groups.has(bar)) groups.set(bar, [])
    groups.get(bar).push({ p, c })
  }
  for (const [bar, rows] of groups) {
    md.push(`## ${bar}`)
    for (const { p, c } of rows) {
      md.push(`### ${p.tid}`)
      if (level === 'brief') {
        // 薄版：一条一两行，够你决定点不点
        md.push(`- **标题**：${c.title || '（无标题）'}　**档位**：${p.tier}　${replyNotes.get(p.tid) || ''}`)
        md.push(`- https://tieba.baidu.com/p/${p.tid}`)
        md.push('')
        continue
      }
      md.push(`- **标题**：${c.title || '（无标题）'}`)
      md.push(`- **链接**：https://tieba.baidu.com/p/${p.tid}`)
      md.push(`- **档位**：${p.tier}`)
      md.push(`- **为什么值得**：${p.why || '（模型没写）'}`)
      if (p.oneLine) md.push(`- **它的一句话**：${p.oneLine}`)
      md.push(`- **回帖**：${replyNotes.get(p.tid) || '未开'}`)
      md.push('')
    }
  }
  if (skipped && skipped.length && level !== 'brief') {
    md.push('## 跳过的')
    for (const s of skipped) {
      const c = byTid.get(s.tid) || {}
      md.push(`- \`${s.tid}\` ${c.title || ''} —— ${s.why || '不值当'}`)
    }
    md.push('')
  }
  md.push(`<!-- 生成于 ${new Date().toISOString()}，provider=${route.provider} model=${route.model} -->`)
  md.push('')
  return md
}

/**
 * 把这一轮接进今天的日报：文件不存在就新建，已存在就**追加**（不覆盖）。
 * @returns {{path:string, appended:boolean, roundNo:number}}
 */
function appendReport(reportPath, mdLines) {
  let prev = ''
  try { prev = existsSync(reportPath) ? readFileSync(reportPath, 'utf8') : '' } catch { prev = '' }
  const appended = prev.trim().length > 0
  if (appended) {
    writeFileSync(reportPath, prev.replace(/\s*$/, '') + '\n\n' + mdLines.join('\n'), 'utf8')
  } else {
    writeFileSync(reportPath, mdLines.join('\n'), 'utf8')
  }
  const roundNo = (readFileSync(reportPath, 'utf8').match(/<!-- round: \d+ -->/g) || []).length
  return { path: reportPath, appended, roundNo }
}

/**
 * 跑一轮。
 * @param {object} o
 * @param {import('node:events').EventEmitter|any} o.ctx  插件 ctx
 * @param {object} o.cfg                                 配置
 * @param {string} o.stateDir
 * @param {(m:string)=>void} o.log
 * @param {string} o.pluginDir
 * @param {'auto'|'manual'} o.mode
 * @returns {Promise<{ok:boolean, picked?:number, replied?:number, reportPath?:string, error?:string}>}
 */
export async function runRound({ ctx, cfg, stateDir, log, pluginDir, mode = 'auto' }) {
  const outDir = join(stateDir, 'out')
  mkdirSync(outDir, { recursive: true })

  // ── 0. 前置检查 ───────────────────────────────────────────────
  const wantedBars = (Array.isArray(cfg.bars) ? cfg.bars : []).map(normBar).filter(Boolean)
  const blockedBars = wantedBars.filter(isBlockedBar)
  const bars = wantedBars.filter((b) => !isBlockedBar(b))
  if (blockedBars.length) {
    log(`跳过 ${blockedBars.join('、')}：这几吧内容主体是辱骂/抽象，不适合喂给模型（硬黑名单，设置页也加不进来）`)
  }
  if (!bars.length) {
    return {
      ok: false,
      error: blockedBars.length
        ? `关注的吧全被硬黑名单挡住了（${blockedBars.join('、')}）：换几个内容正经的吧`
        : '没配置关注的吧：去设置页「偏好」里填几个吧名（一行一个）',
    }
  }
  // ⭐ 按吧回帖白名单：留空 = 不限制；填了就只有这些吧才允许自动回帖。
  //   典型用法：把「反XX吧」这类只读吧排除掉，免得被当水军/引战。
  const replyBars = (Array.isArray(cfg.replyBars) ? cfg.replyBars : []).map(normBar).filter(Boolean)
  const canReplyIn = (bar) => !replyBars.length || replyBars.includes(normBar(bar))
  const llm = ctx.get?.('llm')
  if (!llm?.stream) {
    return { ok: false, error: '宿主的 llm 服务不可用（ctx.get("llm") 是空的），这一轮没法判断' }
  }
  const route = pickModel(ctx)
  if (!route) {
    return { ok: false, error: '拿不到默认模型（agentDefaultModel / listProviders 都是空的）' }
  }

  const day = dayKey()
  const seen = loadSeen(stateDir)
  const perDay = Math.max(0, Number(cfg.perDay) || 0)
  const already = pickedToday(seen, day)
  const manualMax = Math.max(1, Number(cfg.manualMax) || 3)
  const quota = mode === 'manual'
    ? manualMax
    : Math.max(0, Math.min(perDay - already, Number(cfg.perDay) || 0))
  if (quota <= 0) {
    log(`今天已经挑够 ${already} 条了，这轮不刷`)
    return { ok: true, picked: 0, replied: 0, skipped: 'quota' }
  }

  const aiReply = cfg.autoReply === true
  const maxReplyChars = replyCap(cfg.replyLength)
  const listPerBar = Math.max(1, Math.min(Number(cfg.listPerBar) || 30, 60))
  /** fetchPerRound = 0 ⇒ 「只看标题」模式：不读正文，多带些标题进 prompt（省 token） */
  // ⚠️ 必须定义在 fetchPerRound **之前**（2026-10-28 手滑写成后面，真机报
  //    `Cannot access 'headOnly' before initialization` —— TDZ，node --check 查不出来）
  const headOnly = Number(cfg.fetchPerRound) === 0
  const fetchPerRound = headOnly
    ? 0
    : Math.min(Number.isFinite(Number(cfg.fetchPerRound)) ? Math.max(1, Number(cfg.fetchPerRound)) : 8, MAX_THREADS_PER_PROMPT)
  const keywords = (Array.isArray(cfg.keywords) ? cfg.keywords : []).map((s) => String(s).trim()).filter(Boolean)
  const excludeWords = (Array.isArray(cfg.excludeWords) ? cfg.excludeWords : []).map((s) => String(s).trim().toLowerCase()).filter(Boolean)
  const sortBy = cfg.sortBy === 'time' ? 'time' : 'reply'

  // ── 1. 拉列表 ─────────────────────────────────────────────────
  const candidates = []
  let totalScanned = 0
  for (const bar of bars) {
    const r = await tieba.listThreads({ kw: bar, pn: 0, sort: sortBy })
    if (!r?.ok) {
      log(`吧「${bar}」列表拿不到：${r?.error || '未知原因'}${r?.hint ? '（' + r.hint + '）' : ''}`)
      continue
    }
    const threads = Array.isArray(r.threads) ? r.threads : []
    totalScanned += threads.length
    for (const t of threads) {
      const tid = String(t.tid || '')
      if (!tid) continue
      if (t.pinned) continue                                   // 置顶帖每轮都一样，跳过
      if (seen.threads[tid]) continue                          // 判重：刷过的就不再碰
      if (looksLikeSpam(t.title, t.author)) continue
      const hay = `${t.title || ''}`.toLowerCase()
      if (excludeWords.some((w) => hay.includes(w))) continue
      if (keywords.length && !keywords.some((k) => hay.includes(k.toLowerCase()))) continue
      candidates.push({ ...t, tid, bar, title: String(t.title || ''), author: String(t.author || '') })
    }
    log(`吧「${bar}」：拿到 ${threads.length} 条，进候选池`)
  }

  if (!candidates.length) {
    log('这一轮没有新帖子可看（可能都刷过了）')
    return { ok: true, picked: 0, replied: 0, reportPath: '' }
  }

  // ── 2. 排序 + 取前 N 篇读正文 ────────────────────────────────
  candidates.sort(sortBy === 'time'
    ? (a, b) => String(b.time || '').localeCompare(String(a.time || ''))
    : (a, b) => (Number(b.replyCount) || 0) - (Number(a.replyCount) || 0))

  /**
   * ⭐⭐ 2026-10-28 真机发现：原来直接 `candidates.slice(0, fetchPerRound)`，
   *   等于**全局按热度取前 N** ⇒ 大吧（原神 11681 回复）直接把名额占满，
   *   小吧（反deepseek 最高才 125）永远排不进去 ⇒ 用户配了「正反对照」等于白配 ✗
   * ⇒ 改成**每个吧先保底分一篇**，剩下的名额再按全局热度补。
   *   （这样 3 个吧、fetchPerRound=4 → 每吧必有一篇，第 4 个名额给最热的）
   */
  const pickForReading = (list, limit) => {
    if (limit <= 0) return []
    const byBar = new Map()
    for (const c of list) {
      if (!byBar.has(c.bar)) byBar.set(c.bar, [])
      byBar.get(c.bar).push(c)
    }
    const out = []
    const used = new Set()
    // 第一轮：每个吧保底一篇（list 已按 sortBy 排好，取每组第一个）
    for (const [, rows] of byBar) {
      if (out.length >= limit) break
      const c = rows[0]
      if (c) { out.push(c); used.add(c.tid) }
    }
    // 第二轮：剩下的按全局顺序补齐
    for (const c of list) {
      if (out.length >= limit) break
      if (used.has(c.tid)) continue
      out.push(c); used.add(c.tid)
    }
    const barsCovered = new Set(out.map((c) => c.bar))
    log(`细读名额 ${limit} 篇：覆盖 ${barsCovered.size}/${byBar.size} 个吧（${[...barsCovered].join('、')}）`)
    return out
  }

  // 只看标题模式：候选可以多带一点，反正不读正文
  const chosen = headOnly
    ? candidates.slice(0, Math.min(24, candidates.length))
    : pickForReading(candidates, fetchPerRound)

  if (headOnly) {
    log(`只看标题模式（fetchPerRound=0）：${chosen.length} 条标题进 prompt，不读正文`)
  } else {
    for (const c of chosen) {
      const r = await tieba.readThread({ tid: c.tid, pn: 1 })
      if (!r?.ok) { c.opening = ''; continue }
      const floors = Array.isArray(r.floors) ? r.floors : []
      const op = floors.find((f) => f.isOp) || floors[0] || null
      c.opening = op?.content || ''
      // ⭐ 楼主那一层的 pid —— 回帖默认走**楼中楼**回它（不占新楼、不刷屏）
      c.opPid = op?.pid || ''
      c.totalPage = r.totalPage
      c.title = c.title || r.title || ''
    }
  }

  // ── 3. 拼 prompt + 调模型 ────────────────────────────────────
  const charterFile = charterPath(pluginDir, stateDir)
  let charter = ''
  try { charter = readFileSync(charterFile, 'utf8') } catch { charter = '（章程缺失，按常识判断：挑有信息量的、跳过广告和引战）' }

  const prompt = buildPrompt({
    charter, cfg, bars, candidates: chosen, quota, aiReply, maxReplyChars,
  })

  const acc = { text: '', deltas: 0 }
  log(`问模型（${route.provider}/${route.model}）：${chosen.length} 篇候选，配额 ${quota}`)
  let finishReason = null
  try {
    finishReason = await collectStream(llm, {
      provider: route.provider,
      model: route.model,
      messages: [
        { role: 'system', content: [{ type: 'text', text: SYSTEM_HINT }] },
        { role: 'user', content: [{ type: 'text', text: prompt }] },
      ],
    }, acc)
  } catch (e) {
    return { ok: false, error: `模型调用失败：${e?.message ?? e}` }
  }

  const fk = finishReason && typeof finishReason === 'object' ? (finishReason.kind ?? finishReason.type ?? '') : String(finishReason ?? '')
  if (fk === 'error' || fk === 'aborted') {
    const f = finishReason.failure
    const code = f?.code || f?.kind || fk
    return { ok: false, error: `模型这轮没跑完（${code}${f?.message ? '：' + String(f.message).slice(0, 120) : ''}）` }
  }
  if (!acc.text.trim()) return { ok: false, error: '模型返回了空内容' }

  // ── 4. 解析 + 验收 ───────────────────────────────────────────
  const parsed = extractJson(acc.text)
  if (!parsed) {
    log(`模型输出不是 JSON（前 200 字：${acc.text.slice(0, 200).replace(/\s+/g, ' ')}）`)
    return { ok: false, error: '模型输出不是能解析的 JSON，这轮不落盘' }
  }
  const result = validatePicks(parsed, chosen.map((c) => c.tid), quota)
  if (!result) return { ok: false, error: '模型输出的 picks 结构不对，这轮不落盘' }
  if (!result.picks.length) {
    log('模型认为这轮没有值得挑的')
    // 仍然把看过的记进判重表，免得下一轮反复读同一批
    for (const c of chosen) seen.threads[c.tid] = { at: Date.now(), bar: c.bar, title: c.title, tier: '' }
    saveSeen(seen)
    return { ok: true, picked: 0, replied: 0 }
  }

  // ── 5. 回帖（默认**楼中楼回楼主**，不占新楼不刷屏）────────────
  const byTid = new Map(chosen.map((c) => [c.tid, c]))
  let replied = 0
  const replyNotes = new Map()

  if (aiReply) {
    const cap = Math.max(0, Math.min(Number(cfg.replyPerRound) || 1, 20))
    const credNow = tieba.loadCredential(stateDir) || {}
    let sent = 0
    for (const p of result.picks) {
      if (sent >= cap) { replyNotes.set(p.tid, '这轮回帖额度用完了'); continue }
      let content = String(p.reply || '').trim()
      if (!content) { replyNotes.set(p.tid, '模型没给回帖，跳过'); continue }
      if (content.length > maxReplyChars) content = content.slice(0, maxReplyChars)
      const mention = String(cfg.mentionName || '').trim()
      if (mention) content = `${content} @${mention}`
      const c = byTid.get(p.tid) || {}
      // ⭐ 按吧白名单：不在白名单里的吧，只写日报、一个字都不回
      if (!canReplyIn(c.bar)) {
        replyNotes.set(p.tid, `只读吧（${c.bar || '未知'}，不在回帖白名单）`)
        continue
      }
      // ⭐ 有楼主那层的 pid ⇒ 楼中楼回复；拿不到才退化成盖新楼
      const r = c.opPid
        ? await tieba.replySubPost({ ...credNow, tid: p.tid, pid: c.opPid, content })
        : await tieba.replyPost({ ...credNow, tid: p.tid, content })
      if (r?.ok) {
        sent += 1
        replied += 1
        replyNotes.set(p.tid, mention ? `已回（@${mention}）` : '已回')
        log(`回帖成功：tid=${p.tid}（${c.opPid ? '楼中楼' : '新楼'}）`)
      } else {
        replyNotes.set(p.tid, `回帖失败：${r?.error || '未知'}`)
        log(`回帖失败：tid=${p.tid} ${r?.error || ''} ${r?.hint || ''}`)
      }
    }
  }

  // ── 6. 写日报（off / brief / full，同一天多轮**追加**不覆盖）──
  const reportLevel = ['full', 'brief', 'off'].includes(cfg.reportLevel) ? cfg.reportLevel : 'full'
  const reportPath = join(outDir, `${day}.md`)
  let roundInfo = { path: reportPath, appended: false, roundNo: 0 }

  if (reportLevel !== 'off') {
    let prevText = ''
    try { prevText = existsSync(reportPath) ? readFileSync(reportPath, 'utf8') : '' } catch { prevText = '' }
    const first = prevText.trim().length === 0
    const roundNo = (prevText.match(/<!-- round: \d+ -->/g) || []).length + 1
    const md = renderReport({
      day, roundNo, first, bars, totalScanned, chosen,
      picks: result.picks, skipped: result.skipped, summary: result.summary,
      replyNotes, byTid, route, level: reportLevel, headOnly,
    })
    try {
      roundInfo = appendReport(reportPath, md)
    } catch (e) {
      // 日报写不进去不算整轮失败：seen / 配额还是要更新，否则下一轮会重复刷同一批
      log(`日报写不进去：${e?.message ?? e}`)
    }
  } else {
    log('reportLevel=off ⇒ 这轮不写日报')
  }

  // ── 6. 更新判重表 / 配额 ─────────────────────────────────────
  const pickedSet = new Set(result.picks.map((p) => p.tid))
  for (const c of chosen) {
    seen.threads[c.tid] = {
      at: Date.now(),
      bar: c.bar,
      title: c.title,
      tier: result.picks.find((p) => p.tid === c.tid)?.tier || '',
      replied: pickedSet.has(c.tid) && replyNotes.get(c.tid)?.startsWith('已回') ? true : false,
    }
  }
  if (mode !== 'manual') bumpDay(seen, result.picks.length, day)
  saveSeen(seen)

  const where = reportLevel === 'off'
    ? '（这轮没写日报）'
    : `${roundInfo.appended ? '追加到' : '写成'} ${reportPath}（第 ${roundInfo.roundNo} 轮）`
  log(`这一轮挑出 ${result.picks.length} 条，回帖 ${replied} 条，日报${where}`)
  return {
    ok: true,
    picked: result.picks.length,
    replied,
    reportPath: reportLevel === 'off' ? '' : reportPath,
    reportLevel,
  }
}
