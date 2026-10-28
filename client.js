/**
 * dsh-tieba-scroll —— 浏览器半端（就是「设置」里那一页「刷贴吧」）
 * ============================================================================
 * ⭐ 这个文件**不是 ESM**，是自注册脚本（DSH client bundle 的约定，照抄 dsh-bili-scroll 2.3.0）：
 *
 *     window.__ModuleLoader__.load({
 *       id: 'dsh-tieba-scroll',                 // 必须 === package.json 的 name
 *       factory: (require) => { ... return { inject: ['slots'], apply(ctx) {...} } },
 *     })
 *
 * ⭐ 怎么进「设置」—— 抄的是 slots 那条正路，**别自己糊标题栏按钮 + 全屏 overlay**
 *    （那样跟别的插件长得不一样，使用者一眼就看得出来）：
 *
 *     const slots = ctx.get('slots') || ctx.slots
 *     slots.inject('settings.section', () => slots.register(
 *       { name: 'settings.section', id: 'tieba-scroll', order: 31, label: '刷贴吧' },
 *       () => h(Panel),
 *     ))
 *
 * ⭐ 这一页的形状（四页签，归属按 CONTRACT.md §5 / §6 / §11 划，别自己改）：
 *   日常 —— 总开关 → 峰谷自动刷（中午 / 晚上子开关）｜每天最多挑几条｜现在跑一轮｜它刷过的帖子
 *   偏好 —— 关注的吧｜关键词｜排除词｜每轮细读几篇｜每个吧取多少｜排序｜日报写多细｜保存
 *   互动 —— 自动回帖（**默认关**+警示）｜每轮最多回几条｜@ 谁｜回帖长度
 *           ｜允许发主题帖（**默认关**+警示）｜它按什么口气说话
 *   高级 —— 账号（BDUSS / STOKEN）｜它的地盘（家目录 / 日报 / 打开文件夹）｜
 *           手动跑一轮的上限｜复制诊断信息｜日志尾巴
 *
 * ⚠️ §11：贴吧版**不起子进程**，一轮是插件进程内调 `ctx.llm.stream()` 完成的
 *    ⇒ 这一页里**没有**「dsh 路径」「值班 profile」「工作目录」这类控件（B 站版才有）。
 *
 * ⚠️ 从 bili 版抄过来的三个坑，别再踩：
 *   1. **每个 fetch 都要看 res.ok。** 老版 jget/jpost 直接 `.json()`，于是 HTTP 500 里那坨
 *      `{ ok:false, error }` 会被调用方当成「已保存 / 成功」，界面还弹绿色提示把故障盖掉。
 *      ⇒ 这里统一走 asJson()：非 2xx 直接 throw，给用户看到「HTTP 500」。
 *   2. **输入框绑本地草稿，别直接绑 config。** 页面每 5 秒轮询 /status，服务端那份会把
 *      用户正在打的字冲掉（表现为「打一半跳回去」）。
 *   3. **颜色只用 --dsw-alias-* 里真实存在的变量。** 曾经用过不存在的层变量 ⇒ fallback 落到
 *      硬编码深色，浅色主题下变成黑底黑字看不见。
 */
window.__ModuleLoader__.load({
  id: 'dsh-tieba-scroll',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const API = '/api/tieba-duty'

    /* ⚠️ 所有 HTTP 都必须先过这里：res.ok === false 一律抛，绝不让 500 冒充成功。 */
    const asJson = async (res) => {
      if (res.ok) return res.json()
      const why = res.status === 401 ? '（未登录 / 没权限）'
        : res.status === 403 ? '（被宿主拦了）'
          : res.status === 404 ? '（路由不存在 —— 插件版本对不上？）' : ''
      throw new Error('HTTP ' + res.status + why)
    }
    const jget = async (p) => asJson(await fetch(API + p, { credentials: 'same-origin' }))
    const jpost = async (p, body) => asJson(await fetch(API + p, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }))
    const msgOf = (e) => String((e && e.message) || e)

    /* ────────────── 样式：全部取 DSH 的变量，不造自己一套配色 ────────────── */
    const CSS = `
[data-tb-page]{display:flex;flex-direction:column;gap:18px;padding:2px 2px 8px;max-width:680px;}
[data-tb-sec]{display:flex;flex-direction:column;gap:8px;}
[data-tb-h]{font-size:11px;font-weight:600;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-tb-row]{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
[data-tb-grow]{flex:1;min-width:0;}
[data-tb-label]{font-size:13px;color:var(--dsw-alias-label-primary,inherit);}
[data-tb-note]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-tb-sep]{height:1px;background:var(--dsw-alias-bg-layer-3,rgba(127,127,127,.22));margin:2px 0;}
[data-tb-sw]{flex:none;width:38px;height:22px;border-radius:11px;border:0;padding:0;cursor:pointer;position:relative;
  background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.35));transition:background .15s;}
[data-tb-sw][data-on]{background:var(--dsw-alias-brand-primary,#3b82f6);}
[data-tb-sw] i{position:absolute;top:3px;left:3px;display:block;width:16px;height:16px;border-radius:50%;
  background:#fff;transition:left .15s;}
[data-tb-sw][data-on] i{left:19px;}
[data-tb-sw][disabled]{opacity:.45;cursor:default;}
[data-tb-sub]{margin-left:14px;padding-left:12px;display:flex;flex-direction:column;gap:10px;
  border-left:2px solid var(--dsw-alias-bg-layer-3,rgba(127,127,127,.22));}
[data-tb-input]{width:100%;box-sizing:border-box;padding:7px 9px;border-radius:8px;font-size:12px;
  font-family:inherit;color:inherit;
  border:1px solid var(--dsw-alias-bg-layer-3,rgba(127,127,127,.28));
  background:var(--dsw-alias-bg-layer-4,rgba(127,127,127,.12));}
[data-tb-input]:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#3b82f6);}
[data-tb-num]{width:88px;text-align:center;}
[data-tb-btn]{padding:7px 12px;border-radius:8px;font-size:12px;cursor:pointer;font-family:inherit;
  white-space:nowrap;color:inherit;
  border:1px solid var(--dsw-alias-bg-layer-3,rgba(127,127,127,.28));
  background:var(--dsw-alias-bg-layer-4,rgba(127,127,127,.14));}
[data-tb-btn]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.24));}
[data-tb-btn][data-primary]{background:var(--dsw-alias-brand-primary,#3b82f6);
  border-color:var(--dsw-alias-brand-primary,#3b82f6);color:#fff;}
[data-tb-btn][data-danger]{color:#f85149;border-color:color-mix(in srgb,#f85149 45%,transparent);}
[data-tb-btn][disabled]{opacity:.5;cursor:default;}
[data-tb-msg]{font-size:11px;line-height:16px;padding:7px 9px;border-radius:8px;word-break:break-all;
  background:var(--dsw-alias-bg-layer-4,rgba(127,127,127,.12));
  color:var(--dsw-alias-label-secondary,#c9ccd1);}
[data-tb-msg][data-warn]{color:#f59e0b;}
[data-tb-msg][data-good]{color:#22c55e;}
[data-tb-warnbox]{font-size:11px;line-height:17px;padding:8px 10px;border-radius:8px;
  color:var(--dsw-alias-label-primary,inherit);
  border:1px solid color-mix(in srgb,#f59e0b 45%,transparent);
  background:color-mix(in srgb,#f59e0b 12%,transparent);}
[data-tb-warnbox][data-hard]{border-color:color-mix(in srgb,#f85149 50%,transparent);
  background:color-mix(in srgb,#f85149 14%,transparent);}
[data-tb-badge]{font-size:11px;padding:2px 7px;border-radius:6px;
  background:var(--dsw-alias-bg-layer-4,rgba(127,127,127,.14));
  color:var(--dsw-alias-label-secondary,#c9ccd1);}
[data-tb-badge][data-on]{color:#22c55e;}
[data-tb-badge][data-off]{color:#f59e0b;}
[data-tb-kv]{font-size:11px;line-height:18px;word-break:break-all;
  color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-tb-pre]{margin:6px 0 0;padding:8px 9px;border-radius:8px;max-height:220px;overflow:auto;
  font-size:11px;line-height:15px;white-space:pre-wrap;word-break:break-all;
  background:var(--dsw-alias-bg-layer-4,rgba(0,0,0,.2));
  color:var(--dsw-alias-label-secondary,#c9ccd1);}
[data-tb-tabs]{display:flex;gap:4px;padding:4px;border-radius:10px;
  background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.08));}
[data-tb-tab]{flex:1;min-width:0;cursor:pointer;font:inherit;font-size:13px;padding:7px 10px;border:0;
  border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,inherit);}
[data-tb-tab]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1));}
[data-tb-tab][aria-selected=true]{background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.16));
  color:var(--dsw-alias-label-primary,inherit);font-weight:600;}
[data-tb-away]{display:none !important;}
[data-tb-chip]{cursor:pointer;white-space:nowrap;font:inherit;font-size:12px;padding:3px 10px;
  border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary,inherit);
  border:1px solid var(--dsw-alias-bg-layer-3,rgba(127,127,127,.22));}
[data-tb-chip]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1));}
[data-tb-chip][aria-selected=true]{color:var(--dsw-alias-label-primary,inherit);
  border-color:var(--dsw-alias-brand-primary,rgba(76,141,255,.6));
  background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4c8dff) 16%,transparent);}
[data-tb-list]{margin:10px 0 0;display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px;}
[data-tb-item]{display:flex;flex-direction:column;gap:4px;overflow:hidden;border-radius:12px;padding:9px 11px;
  color:var(--dsw-alias-label-primary,inherit);
  background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.06));
  border:1px solid var(--dsw-alias-bg-layer-3,rgba(127,127,127,.22));}
[data-tb-item]:hover{border-color:var(--dsw-alias-brand-primary,rgba(76,141,255,.5));}
[data-tb-item-t]{font-size:13px;line-height:18px;font-weight:600;word-break:break-word;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}
[data-tb-item-t] a{color:inherit;text-decoration:none;}
[data-tb-item-t] a:hover{text-decoration:underline;}
[data-tb-item-n]{font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary,inherit);}
[data-tb-item-why]{font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary,inherit);
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}
[data-tb-tier]{font-weight:600;}
[data-tb-tier='值得看']{color:#3fb950;}
[data-tb-tier='可以看']{color:#d29922;}
[data-tb-tier='不值当']{color:var(--dsw-alias-label-tertiary,inherit);}
@media (max-width:520px){
  [data-tb-page]{gap:14px;}
  [data-tb-list]{grid-template-columns:1fr;}
  [data-tb-num]{width:72px;}
  [data-tb-tab]{padding:6px 4px;font-size:12px;}
  [data-tb-btn]{padding:6px 9px;}
}`

    const TIERS = ['值得看', '可以看', '不值当']
    const THREADS_PAGE = 24

    /* ────────────── 侧边栏整页面板的样式（前缀 data-tbm-，跟设置页的 data-tb-* 分开） ────────────── */
    const MAIN_CSS = `
[data-tb-main]{box-sizing:border-box;min-height:100%;padding:22px 24px 40px;display:flex;flex-direction:column;gap:14px;
  color:var(--dsw-alias-label-primary,inherit);overflow-y:auto;}
[data-tbm-bar]{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
[data-tbm-title]{font-size:17px;font-weight:600;letter-spacing:.01em;}
[data-tbm-sub]{font-size:12px;color:var(--dsw-alias-label-secondary,#9aa0a6);}
[data-tbm-grow]{flex:1;min-width:0;}
[data-tbm-card]{display:flex;flex-direction:column;gap:10px;border-radius:12px;padding:14px 16px;
  background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.06));
  border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.22));}
[data-tbm-h]{font-size:12px;font-weight:600;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-tbm-row]{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
[data-tbm-note]{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#9aa0a6);}
[data-tbm-badge]{font-size:12px;padding:3px 9px;border-radius:999px;white-space:nowrap;
  color:var(--dsw-alias-label-secondary,#c9ccd1);
  border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.22));}
[data-tbm-badge][data-on]{color:var(--dsw-alias-brand-primary,#4c8dff);
  border-color:color-mix(in srgb,var(--dsw-alias-brand-primary,#4c8dff) 45%,transparent);
  background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4c8dff) 12%,transparent);}
[data-tbm-badge][data-off]{color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-tbm-big]{border:0;border-radius:10px;padding:12px 26px;font:inherit;font-size:15px;font-weight:600;
  cursor:pointer;color:#fff;background:var(--dsw-alias-brand-primary,#4c8dff);display:inline-flex;
  align-items:center;gap:9px;}
[data-tbm-big]:hover{filter:brightness(1.06);}
[data-tbm-big][disabled]{opacity:.6;cursor:default;}
[data-tbm-btn]{border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.22));border-radius:9px;
  padding:7px 14px;font:inherit;font-size:13px;cursor:pointer;color:var(--dsw-alias-label-secondary,#c9ccd1);
  background:transparent;}
[data-tbm-btn]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));
  color:var(--dsw-alias-label-primary,inherit);}
[data-tbm-btn][data-on]{color:var(--dsw-alias-label-primary,inherit);
  border-color:var(--dsw-alias-brand-primary,#4c8dff);}
[data-tbm-btn][disabled]{opacity:.5;cursor:default;}
[data-tbm-msg]{font-size:12px;line-height:18px;padding:8px 11px;border-radius:8px;word-break:break-all;
  background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.1));color:var(--dsw-alias-label-secondary,#c9ccd1);}
[data-tbm-msg][data-warn]{color:var(--dsw-alias-state-warn-primary,#f59e0b);}
[data-tbm-msg][data-good]{color:var(--dsw-alias-state-success-primary,#22c55e);}
[data-tbm-spin]{width:14px;height:14px;border-radius:50%;display:inline-block;flex:none;
  border:2px solid rgba(255,255,255,.45);border-top-color:#fff;animation:tbmspin .8s linear infinite;}
@keyframes tbmspin{to{transform:rotate(360deg)}}
[data-tbm-empty]{font-size:13px;line-height:1.7;padding:18px 0;color:var(--dsw-alias-label-secondary,#9aa0a6);}
[data-tbm-grid]{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px;}
[data-tbm-cell]{display:flex;flex-direction:column;gap:5px;border-radius:11px;padding:11px 13px;text-decoration:none;
  color:var(--dsw-alias-label-primary,inherit);
  background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.1));
  border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.22));transition:border-color .12s,background .12s;}
[data-tbm-cell]:hover{border-color:var(--dsw-alias-brand-primary,rgba(76,141,255,.6));
  background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16));}
[data-tbm-cell-t]{font-size:13.5px;line-height:19px;font-weight:600;word-break:break-word;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}
[data-tbm-cell-n]{font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-tbm-cell-w]{font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary,#9aa0a6);
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}
[data-tbm-chip]{font-size:11.5px;padding:1px 8px;border-radius:999px;white-space:nowrap;
  background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.14));color:var(--dsw-alias-label-secondary,#c9ccd1);}
[data-tbm-chip='值得看']{color:#3fb950;}
[data-tbm-chip='可以看']{color:#d29922;}
[data-tbm-chip='不值当']{color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-tbm-md]{font-size:13.5px;line-height:1.75;word-break:break-word;}
[data-tbm-md] h1{font-size:18px;line-height:1.45;margin:0 0 10px;font-weight:650;}
[data-tbm-md] h2{font-size:15px;line-height:1.5;margin:16px 0 8px;font-weight:650;}
[data-tbm-md] h3{font-size:13.5px;line-height:1.5;margin:12px 0 6px;font-weight:600;
  color:var(--dsw-alias-label-secondary,#c9ccd1);}
[data-tbm-md] h3[data-tbm-tid]{font-family:ui-monospace,Consolas,monospace;letter-spacing:.02em;}
[data-tbm-md] p{margin:0 0 8px;}
[data-tbm-md] blockquote{margin:0 0 10px;padding:2px 0 2px 12px;color:var(--dsw-alias-label-secondary,#9aa0a6);
  border-left:3px solid var(--dsw-alias-border-l1,rgba(127,127,127,.3));}
[data-tbm-md] ul,[data-tbm-md] ol{margin:0 0 8px;padding-left:20px;}
[data-tbm-md] li{margin:2px 0;}
[data-tbm-md] hr{border:0;border-top:1px dashed var(--dsw-alias-border-l1,rgba(127,127,127,.3));margin:14px 0;}
[data-tbm-md] [data-tbm-round]{margin:16px 0 8px;padding-top:9px;font-size:11px;letter-spacing:.05em;
  color:var(--dsw-alias-label-tertiary,#9aa0a6);
  border-top:1px dashed var(--dsw-alias-border-l1,rgba(127,127,127,.3));}
[data-tbm-md] a{color:var(--dsw-alias-brand-primary,#4c8dff);text-decoration:none;word-break:break-all;}
[data-tbm-md] a:hover{text-decoration:underline;}
[data-tbm-md] strong{font-weight:650;}
[data-tbm-md] code{font-family:ui-monospace,Consolas,monospace;font-size:12px;padding:1px 5px;border-radius:5px;
  background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.16));}
[data-tbm-pre]{margin:0;padding:10px 12px;border-radius:8px;max-height:50vh;overflow:auto;
  font-size:12px;line-height:1.6;white-space:pre-wrap;word-break:break-word;
  background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.18));color:var(--dsw-alias-label-secondary,#c9ccd1);}
@media (max-width:560px){
  [data-tb-main]{padding:16px 14px 32px;gap:12px;}
  [data-tbm-grid]{grid-template-columns:1fr;}
  [data-tbm-big]{width:100%;justify-content:center;}
  [data-tbm-card]{padding:12px 13px;}
}`

    /* ────────────── 小零件 ────────────── */

    function Switch({ on, onChange, disabled }) {
      return h('button', {
        'data-tb-sw': '',
        'data-on': on ? '' : undefined,
        disabled: Boolean(disabled),
        title: on ? '已开' : '已关',
        'aria-pressed': on ? 'true' : 'false',
        onClick: () => { if (!disabled) onChange(!on) },
      }, h('i'))
    }

    function ToggleRow({ label, note, on, onChange, disabled }) {
      return h('div', { 'data-tb-row': '' },
        h('div', { 'data-tb-grow': '' },
          h('div', { 'data-tb-label': '' }, label),
          note ? h('div', { 'data-tb-note': '' }, note) : null),
        h(Switch, { on, onChange, disabled }))
    }

    function Msg({ text, tone }) {
      if (!text) return null
      return h('div', {
        'data-tb-msg': '',
        'data-good': tone === 'good' ? '' : undefined,
        'data-warn': tone === 'warn' ? '' : undefined,
      }, text)
    }

    function Chip({ label, active, onClick }) {
      return h('button', {
        'data-tb-chip': '', 'aria-selected': active ? 'true' : 'false', onClick,
      }, label)
    }

    const clampNum = (v, min, max, fallback) => {
      const n = Number(v)
      if (!Number.isFinite(n)) return fallback
      return Math.max(min, Math.min(Math.round(n), max))
    }
    const toLines = (s) => String(s || '').split('\n').map((x) => x.trim()).filter(Boolean)
    const isEmptyNew = (v) => v === '' || (Array.isArray(v) && v.length === 0)

    /* 家目录：优先用宿主给的 /log.path 倒推（…/tieba-duty/duty.log → …/tieba-duty），
     * 退一步用 /status 的 report.path（…/tieba-duty/out/<day>.md → …/tieba-duty）。
     * ⚠️ 日志文件名是 duty.log（CONTRACT §3 / lib/state.mjs），不是 tieba-duty.log。 */
    const deriveHomeFromLog = (logPath) => {
      const m = /^(.*)[\\/]duty\.log$/i.exec(String(logPath || ''))
      return m ? m[1] : ''
    }
    const deriveHomeFromReport = (reportPath) => {
      const m = /^(.*)[\\/]out[\\/][^\\/]+$/.exec(String(reportPath || ''))
      return m ? m[1] : ''
    }

    /* 状态 + 配置：/status 轮询；/config 一起拉（草稿是本地状态，不会被冲掉） */
    function usePluginData(intervalMs) {
      const [st, setSt] = React.useState(null)
      const [cfg, setCfg] = React.useState(null)
      const [fails, setFails] = React.useState(0)
      const [tick, setTick] = React.useState(0)
      React.useEffect(() => {
        let alive = true
        const run = async () => {
          let okAny = false
          try {
            const s = await jget('/status')
            if (!alive) return
            if (s && s.ok !== false) { setSt(s); okAny = true }
          } catch { /* 交给 fails 计数说话 */ }
          try {
            const c = await jget('/config')
            if (!alive) return
            if (c && c.ok !== false && c.config) { setCfg(c.config); okAny = true }
          } catch { /* 同上 */ }
          if (alive) setFails((n) => (okAny ? 0 : n + 1))
        }
        run()
        const t = setInterval(run, intervalMs || 5000)
        return () => { alive = false; clearInterval(t) }
      }, [intervalMs, tick])
      return { st, cfg, fails, setCfg, reload: () => setTick((n) => n + 1) }
    }

    /* 所有"要用本地草稿的字段"都在这里登记：CONTRACT §5 改了字段只改这一个函数 */
    function initDraft(cfg) {
      return {
        bars: (cfg.bars || []).join('\n'),
        // ⭐ 2026-10-28：按吧回帖白名单（留空 = 不限制）。典型用法是把「反XX吧」只读掉。
        replyBars: (cfg.replyBars || []).join('\n'),
        keywords: (cfg.keywords || []).join('\n'),
        excludeWords: (cfg.excludeWords || []).join('\n'),
        personaPrompt: cfg.personaPrompt || '',
        reportLevel: cfg.reportLevel || 'full',
        sortBy: cfg.sortBy || 'reply',
        replyLength: cfg.replyLength || 'medium',
        mentionName: cfg.mentionName || '',
        perDay: String(cfg.perDay ?? 5),
        fetchPerRound: String(cfg.fetchPerRound ?? 8),
        listPerBar: String(cfg.listPerBar ?? 30),
        replyPerRound: String(cfg.replyPerRound ?? 1),
        manualMax: String(cfg.manualMax ?? 3),
        manualCooldownMin: String(cfg.manualCooldownMin ?? 10),
        reportDay: '',
      }
    }

    /* ────────────── 设置页正文 ────────────── */

    function Panel() {
      const { st, cfg, fails, setCfg, reload } = usePluginData(5000)

      const [d, setD] = React.useState(null)          // 本地草稿（永远不要直接绑 cfg）
      const [tab, setTab] = React.useState('daily')   // daily | taste | social | adv
      const [busy, setBusy] = React.useState('')
      const [msg, setMsg] = React.useState('')
      const [msgTone, setMsgTone] = React.useState('')
      const [bduss, setBduss] = React.useState('')    // 凭证只活在输入框里
      const [stoken, setStoken] = React.useState('')
      const [acctMsg, setAcctMsg] = React.useState('')
      const [acctTone, setAcctTone] = React.useState('')
      const [report, setReport] = React.useState(null)
      const [reportPath, setReportPath] = React.useState('')
      const [logLines, setLogLines] = React.useState(null)
      const [logPathSeen, setLogPathSeen] = React.useState('')  // /log 回过的 path（/status 的 log.path 优先）
      const [diag, setDiag] = React.useState(null)
      const [rows, setRows] = React.useState(null)    // null = 还没读
      const [rowsTotal, setRowsTotal] = React.useState(0)
      const [tier, setTier] = React.useState('')
      const [offset, setOffset] = React.useState(0)
      const [rowState, setRowState] = React.useState('')   // '' | '1'（已回） | '0'（没回）→ 直接给 /threads?replied=

      // 草稿只初始化一次；之后服务端那份再怎么轮询都动不了用户手里的字
      React.useEffect(() => { if (cfg && d === null) setD(initDraft(cfg)) }, [cfg, d])
      const D = d || initDraft(cfg || {})
      const setDraft = (k, v) => setD((old) => ({ ...(old || initDraft(cfg || {})), [k]: v }))

      const say = (text, tone) => { setMsg(text || ''); setMsgTone(tone || '') }

      /* ⭐ 配置一律走 POST /config { patch }（CONTRACT §6 的形状，不是裸对象） */
      const patch = async (p, what) => {
        setBusy(JSON.stringify(p))
        try {
          const r = await jpost('/config', { patch: p })
          if (!r || r.ok === false) { say((what || '设置') + '没保存：' + ((r && r.error) || '未知原因'), 'warn'); return }
          if (r.config) setCfg(r.config)
          // ⚠️ 空值的语义两端约定过（别把「空 = 用默认」当成「没保存上」）：
          //    · bars 传 [] ⇒ 读回来是内置默认的那 4 个吧（原神 / 崩坏星穹铁道 / steam / 编程）——是设计如此
          //    · 其它字段传空串 / 空数组 ⇒ 真的存空值
          //    所以对账时**跳过 bars**，其余空值不一致才报警（bili 版真踩过：清空了却显示"已保存"）。
          const stuck = []
          if (r.config) {
            for (const k of Object.keys(p)) {
              if (k === 'bars') continue
              if (!isEmptyNew(p[k])) continue
              if (JSON.stringify(p[k]) !== JSON.stringify(r.config[k])) stuck.push(k)
            }
          }
          if (stuck.length) say((what || '设置') + '：' + stuck.join(' / ') + ' 没被清空（宿主留着旧值）—— 请把这几项填一个占位再保存，或反馈给作者', 'warn')
          else if (r.savedLocalOnly) say((what || '设置') + '：存进插件自己那份了，但 DSH 设置页那份没写进去（重启 dsh 后可能被旧值盖回去）', 'warn')
          else say(what ? what + '：已保存' : '已保存', 'good')
        } catch (e) { say((what || '设置') + '没保存：' + msgOf(e), 'warn') } finally { setBusy('') }
      }

      /* ── 它刷过的帖子（GET /threads：tier + replied 都由服务端筛，total 才准）── */
      const loadThreads = async (tr, rp, off) => {
        setBusy('threads')
        try {
          const q = '/threads?limit=' + THREADS_PAGE + '&offset=' + off
            + (tr ? '&tier=' + encodeURIComponent(tr) : '')
            + (rp ? '&replied=' + rp : '')
          const r = await jget(q)
          if (!r || r.ok === false) {
            setRows([]); setRowsTotal(0)
            say('读不到帖子记录：' + ((r && r.error) || '未知原因'), 'warn')
            return
          }
          setRows(Array.isArray(r.rows) ? r.rows : [])
          setRowsTotal(Number(r.total) || 0)
          setTier(tr); setRowState(rp); setOffset(off)
        } catch (e) { setRows([]); say('读不到帖子记录：' + msgOf(e), 'warn') } finally { setBusy('') }
      }
      React.useEffect(() => { loadThreads('', '', 0) }, [])   // 只在打开设置页时读一次

      const copyText = async (text, label) => {
        const v = String(text || '')
        try {
          await navigator.clipboard.writeText(v)
          say((label || '内容') + '已复制到剪贴板', 'good')
        } catch {
          // 兜底：至少把内容显示出来，让用户手动选中（剪贴板权限在某些宿主里会被拒）
          say((label || '内容') + '复制失败（浏览器不给剪贴板权限）—— 内容已显示在下面，手动选中复制', 'warn')
          setDiag(v)
        }
      }

      /* ── 动作 ── */

      const onRun = async () => {
        setBusy('run')
        try {
          const max = clampNum(D.manualMax, 0, 20, 3)
          const r = await jpost('/run', { max })
          if (!r || r.ok === false) { say('跑不起来：' + ((r && r.error) || '未知原因'), 'warn'); return }
          if (r.started) {
            say('已经在后台跑一轮了（最多挑 ' + max + ' 条）—— 跑完日报会写在「高级 → 它的地盘」里那个文件夹', 'good')
          } else {
            // ⭐ started:false 不算失败：还在跑上一轮 / 冷却没到 / 今天的额度用完了，宿主会把 reason 说清楚
            say('这一轮没开始：' + (r.reason || '上一轮还在跑，或者刚跑过（等一会儿再来）') + ' —— 这不是出错，别重复点', '')
          }
          reload()
        } catch (e) { say('跑不起来：' + msgOf(e), 'warn') } finally { setBusy('') }
      }

      const onLogin = async () => {
        const b = String(bduss || '').trim()
        const s = String(stoken || '').trim()
        if (!b) {
          setAcctTone('warn'); setAcctMsg('BDUSS 不能空。拿到它：浏览器登录 tieba.baidu.com → F12 → Application → Cookies → 抄 BDUSS 那一行（很长一串）。')
          return
        }
        setBusy('login')
        try {
          const r = await jpost('/login', { bduss: b, stoken: s })
          if (!r || r.ok === false) { setAcctTone('warn'); setAcctMsg('没登上：' + ((r && r.error) || '未知原因')); return }
          const w = r.whoami || {}
          if (w.ok === false) {
            setAcctTone('warn')
            setAcctMsg('凭证存下了，但贴吧没认出来' + (w.error ? '（' + w.error + '）' : '') +
              ' —— 多半是 BDUSS 过期，重新在网页端登录一次再抄一份。')
          } else {
            setAcctTone('good')
            setAcctMsg('登上了' + (w.uname ? '：' + w.uname : '') + '（自动回帖会用它说话）')
          }
          setBduss(''); setStoken('')     // 凭证不留在输入框里
          reload()
        } catch (e) { setAcctTone('warn'); setAcctMsg('登录失败：' + msgOf(e)) } finally { setBusy('') }
      }

      const onWhoami = async () => {
        setBusy('whoami')
        try {
          const r = await jget('/whoami')
          if (!r || r.ok === false) { setAcctTone('warn'); setAcctMsg('检查失败：' + ((r && r.error) || '未知原因')); return }
          if (r.loggedIn) { setAcctTone('good'); setAcctMsg('登录有效：' + (r.uname || '（贴吧没给昵称）')) }
          else { setAcctTone('warn'); setAcctMsg('没登录 / 已过期' + (r.error ? '：' + r.error : '') + ' —— 粘一份新的 BDUSS 再登一次') }
          reload()
        } catch (e) { setAcctTone('warn'); setAcctMsg('检查失败：' + msgOf(e)) } finally { setBusy('') }
      }

      const onLogout = async () => {
        setBusy('logout')
        try {
          const r = await jpost('/logout', {})
          if (!r || r.ok === false) { setAcctTone('warn'); setAcctMsg('退出没成功：' + ((r && r.error) || '未知原因')); return }
          setAcctTone('good'); setAcctMsg('已退出：凭证从这台机器上删掉了')
          reload()
        } catch (e) { setAcctTone('warn'); setAcctMsg('退出失败：' + msgOf(e)) } finally { setBusy('') }
      }

      const onShowReport = async () => {
        if (report !== null) { setReport(null); return }   // 再点一次收起
        setBusy('report')
        try {
          const day = String(D.reportDay || '').trim()
          const r = await jget('/report' + (day ? '?day=' + encodeURIComponent(day) : ''))
          if (!r || r.ok === false) { setReport('读不到日报：' + ((r && r.error) || '未知原因')); return }
          setReportPath(r.path || '')
          setReport(r.exists ? (r.text || '（日报是空的）') : ((r.day || day || '今天') + ' 还没有日报 —— 跑一轮之后就有了'))
        } catch (e) { setReport('读不到日报：' + msgOf(e)) } finally { setBusy('') }
      }

      const onOpenFolder = async (which) => {
        try {
          const r = await jpost('/open-folder', { which })
          if (!r || r.ok === false) { say('打不开（' + ((r && r.error) || '未知原因') + '）—— 路径是：' + ((r && r.path) || '看上面的诊断信息'), 'warn'); return }
          say('已请系统打开：' + (r.path || which), 'good')
          reload()
        } catch (e) { say('打不开：' + msgOf(e), 'warn') }
      }

      const onShowLog = async () => {
        if (logLines !== null) { setLogLines(null); return }
        setBusy('log')
        try {
          const r = await jget('/log?tail=200')
          if (!r || r.ok === false) { setLogLines([]); say('读不到日志：' + ((r && r.error) || '未知原因'), 'warn'); return }
          if (r.path) setLogPathSeen(String(r.path))
          setLogLines(Array.isArray(r.lines) ? r.lines : [])
        } catch (e) { setLogLines([]); say('读不到日志：' + msgOf(e), 'warn') } finally { setBusy('') }
      }

      /* ⭐ 契约 §6 没有 /diagnose ⇒ 这里用现有路由**在浏览器里拼**一份诊断信息。
       *    ⚠️ 只拼 /status /config /whoami /log 和 UA —— BDUSS / STOKEN 不在 config 里，
       *    所以诊断信息不会漏凭证；以后加字段也别把 credential 塞进来。 */
      const onDiag = async () => {
        setBusy('diag')
        const parts = ['# dsh-tieba-scroll 诊断信息', 'UA: ' + (navigator.userAgent || '?')]
        const grab = async (label, path, pick) => {
          try {
            const r = await jget(path)
            parts.push('', '## ' + label + '（GET ' + path + '）')
            parts.push(JSON.stringify(pick ? pick(r) : r, null, 2))
          } catch (e) { parts.push('', '## ' + label + '（GET ' + path + '）', '读取失败：' + msgOf(e)) }
        }
        await grab('状态', '/status')
        await grab('配置', '/config')
        await grab('账号', '/whoami')
        await grab('日志尾巴 120 行', '/log?tail=120', (r) => (r && r.lines) || [])
        const text = parts.join('\n')
        setDiag(text)
        await copyText(text, '诊断信息')
        setBusy('')
      }

      /* 偏好页签的保存：全是文本/下拉/数字，一次提交 */
      const onSavePrefs = async () => {
        const fpr = clampNum(D.fetchPerRound, 0, 100, 8)
        const lpb = clampNum(D.listPerBar, 1, 100, 30)
        setDraft('fetchPerRound', String(fpr))   // 钳过的值先回写，免得输入框跟服务端差一位
        setDraft('listPerBar', String(lpb))
        await patch({
          bars: toLines(D.bars),
          keywords: toLines(D.keywords),
          excludeWords: toLines(D.excludeWords),
          fetchPerRound: fpr,
          listPerBar: lpb,
          sortBy: D.sortBy || 'reply',
          reportLevel: D.reportLevel || 'full',
        }, '偏好设置')
      }

      /* 互动页签：人设是长文本，单独一个保存按钮 */
      const onSavePersona = async () => {
        const v = String(D.personaPrompt || '').trim()
        setDraft('personaPrompt', v)
        await patch({ personaPrompt: v }, '它按什么口气说话')
      }

      /* ── 数字框：失焦时钳范围 + 自动提交 ── */
      const numRow = (key, label, note, min, max, fallback) => h('div', { 'data-tb-row': '' },
        h('div', { 'data-tb-grow': '' },
          h('div', { 'data-tb-label': '' }, label),
          note ? h('div', { 'data-tb-note': '' }, note) : null),
        h('input', {
          'data-tb-input': '', 'data-tb-num': '', type: 'number', min, max,
          value: D[key] ?? '',
          onChange: (e) => setDraft(key, e.target.value),
          onBlur: () => {
            const n = clampNum(D[key], min, max, fallback)
            setDraft(key, String(n))
            patch({ [key]: n }, label)
          },
        }))

      const selectRow = (key, label, options, note) => h('div', { 'data-tb-sec': '' },
        h('div', { 'data-tb-label': '' }, label),
        h('select', {
          'data-tb-input': '', value: D[key],
          onChange: (e) => { setDraft(key, e.target.value); patch({ [key]: e.target.value }, label) },
        }, options.map(([v, t]) => h('option', { key: v, value: v }, t))),
        note ? h('div', { 'data-tb-note': '' }, note) : null)

      const textRow = (key, label, rows, placeholder, note) => h('div', { 'data-tb-sec': '' },
        h('div', { 'data-tb-label': '' }, label),
        h('textarea', {
          'data-tb-input': '', rows, placeholder,
          value: D[key] ?? '', onChange: (e) => setDraft(key, e.target.value),
        }),
        note ? h('div', { 'data-tb-note': '' }, note) : null)

      /* data-tb-group 标着"这块属于哪个页签"（也方便自检脚本核对归属） */
      const grp = (name) => ({ 'data-tb-sec': '', 'data-tb-group': name, 'data-tb-away': tab === name ? undefined : '' })

      /* ── 读不到配置：把话说清楚，别只显示"读取中…"让用户以为开关坏了 ── */
      if (!cfg) {
        return h('div', { 'data-tb-page': '' },
          h('div', { 'data-tb-note': '' }, fails >= 3
            ? '读不到插件配置（已经试了 ' + fails + ' 次）。常见原因：刚装完没重启 dsh；插件加载失败（终端里会有 warning）；或者插件版本跟设置页对不上。'
            : '读设置中…'),
          fails >= 6 ? h('div', { 'data-tb-row': '' },
            h('button', { 'data-tb-btn': '', onClick: reload }, '再试一次')) : null,
          fails >= 6 ? h('div', { 'data-tb-note': '' },
            '还不行就把「复制诊断信息」给作者 —— 想先自己看，打开 ' +
            '%USERPROFILE%\\.dsh\\tieba-duty\\duty.log 的最后几十行。') : null)
      }

      const sw = (k) => Boolean(cfg[k])
      const today = (st && st.today) || {}
      const cred = (st && st.credential) || {}
      const ready = (st && st.ready) || {}
      const rep = (st && st.report) || {}
      /* 日志路径：/status 的 log.path 优先（宿主已给），其次点过「看日志尾巴」拿到的 path */
      const logPath = (st && st.log && st.log.path) || logPathSeen
      // 家目录：宿主给了 st.home 就用；否则拿日志路径 / 日报路径倒推（两条都留着当兜底）
      const home = (st && st.home) || deriveHomeFromLog(logPath) || deriveHomeFromReport(rep.path)
      const running = Boolean(st && st.running)
      const lastRun = st && st.lastRun
      const lastRunText = !lastRun ? '' : (typeof lastRun === 'object'
        ? (lastRun.at || lastRun.time || lastRun.endedAt || '')
        : lastRun)
      // 档位和状态都由服务端筛了 ⇒ 这里不再本地过滤（total 也就是准的）
      const shownRows = rows || []

      return h('div', { 'data-tb-page': '' },

        /* ── 顶部：今天怎么样 ── */
        h('div', { 'data-tb-row': '' },
          h('span', { 'data-tb-badge': '' }, '今天挑了 ' + (today.picked ?? 0) + ' / ' + (cfg.perDay ?? 5) + ' 条'),
          h('span', { 'data-tb-badge': '' }, '回了 ' + (today.replied ?? 0) + ' 条'),
          h('span', {
            'data-tb-badge': '',
            'data-on': cred.loggedIn ? '' : undefined,
            'data-off': cred.loggedIn ? undefined : '',
          }, cred.loggedIn ? ('账号：' + (cred.uname || '已登录')) : '账号未登录'),
          // §11 没有子进程/profile 这回事了 ⇒ 只有宿主真给了 ready.profile 才显示
          ready.profile !== undefined ? h('span', {
            'data-tb-badge': '',
            'data-on': ready.profile ? '' : undefined,
            'data-off': ready.profile ? undefined : '',
          }, ready.profile ? '就绪' : '没就绪') : null,
          h('span', { 'data-tb-badge': '' }, 'v' + (st.version || '?')),
          h('div', { 'data-tb-grow': '' }),
          h('button', { 'data-tb-btn': '', disabled: busy === 'threads', onClick: reload }, '刷新')),
        lastRunText ? h('div', { 'data-tb-note': '' }, '上次跑一轮：' + lastRunText) : null,

        /* ── 四个页签 ── */
        h('div', { 'data-tb-tabs': '' },
          [['daily', '日常'], ['taste', '偏好'], ['social', '互动'], ['adv', '高级']].map(([v, label]) =>
            h('button', {
              key: v, 'data-tb-tab': '', 'aria-selected': tab === v ? 'true' : 'false',
              onClick: () => setTab(v),
            }, label))),

        /* 常驻消息条：切页签也看得见（老版把提示放在最底下，用户以为没生效） */
        h(Msg, { text: msg, tone: msgTone }),

        /* ══════════════ 日常 ══════════════ */
        h('div', grp('daily'),
          h('div', { 'data-tb-h': '' }, '要不要自己跑'),
          h(ToggleRow, {
            label: '刷贴吧（插件总开关）',
            note: '关掉之后就不再自动刷了；下面的开关和「现在跑一轮」都还在，随时能手动跑',
            on: sw('enabled'),
            onChange: (v) => patch({ enabled: v }, '总开关'),
          }),
          h(ToggleRow, {
            label: '峰谷时段自动刷',
            note: '只在这几个时段自己跑：中午 12–14 点、晚上 18 点之后到早上 9 点。关掉就只能手动跑',
            on: sw('peakValley'),
            onChange: (v) => patch({ peakValley: v }, '峰谷时段自动刷'),
          }),
          // ⭐ 总开关打开之后下面才展开子开关（使用者明确要的形状）
          sw('peakValley') ? h('div', { 'data-tb-sub': '' },
            h(ToggleRow, {
              label: '中午那一轮',
              note: '12:00 – 14:00',
              on: sw('noon'),
              onChange: (v) => patch({ noon: v }, '中午那一轮'),
            }),
            h(ToggleRow, {
              label: '晚上那一轮',
              note: '18:00 – 次日 09:00',
              on: sw('night'),
              onChange: (v) => patch({ night: v }, '晚上那一轮'),
            })) : null),

        h('div', grp('daily'),
          h('div', { 'data-tb-sep': '' }),
          h('div', { 'data-tb-h': '' }, '一轮挑几条'),
          numRow('perDay', '每天最多挑几条', '填 0 = 不自动挑（还是能手动跑）；条数上限在「高级」里调', 0, 50, 5),
          h('div', { 'data-tb-row': '' },
            h('button', { 'data-tb-btn': '', 'data-primary': '', disabled: busy === 'run' || running, onClick: onRun },
              running ? '正在跑…' : '现在跑一轮'),
            h('div', { 'data-tb-note': '' }, running
              ? '正在后台跑，稍等 —— 跑完日报会写在「高级 → 它的地盘」里那个文件夹'
              : ('手动跑一次最多挑 ' + (cfg.manualMax ?? 3) + ' 条' + ((cfg.manualCooldownMin ?? 0) > 0
                ? '，两次之间至少隔 ' + (cfg.manualCooldownMin ?? 10) + ' 分钟' : ''))))),

        /* 它刷过的帖子卡片墙 */
        h('div', grp('daily'),
          h('div', { 'data-tb-sep': '' }),
          h('div', { 'data-tb-h': '' }, '它刷过的帖子'),
          h('div', { 'data-tb-row': '' },
            h(Chip, { label: '全部档位', active: tier === '', onClick: () => loadThreads('', rowState, 0) }),
            TIERS.map((t) => h(Chip, {
              key: t, label: t, active: tier === t,
              onClick: () => loadThreads(tier === t ? '' : t, rowState, 0),
            })),
            h('div', { 'data-tb-grow': '' }),
            h('div', { 'data-tb-note': '' }, rows === null ? '读取中…' : ('共 ' + rowsTotal + ' 条'))),
          h('div', { 'data-tb-row': '' },
            // replied 由服务端筛（'1' / '0'），能跟档位叠加，total 也就是准的
            h(Chip, { label: '全部状态', active: rowState === '', onClick: () => loadThreads(tier, '', 0) }),
            h(Chip, { label: '已回帖', active: rowState === '1', onClick: () => loadThreads(tier, '1', 0) }),
            h(Chip, { label: '没回', active: rowState === '0', onClick: () => loadThreads(tier, '0', 0) })),
          rows && shownRows.length ? h('div', { 'data-tb-list': '' },
            shownRows.map((x) => h('div', { key: String(x.tid), 'data-tb-item': '' },
              h('div', { 'data-tb-item-t': '' },
                x.url
                  ? h('a', { href: x.url, target: '_blank', rel: 'noreferrer' }, x.title || ('#' + x.tid))
                  : (x.title || ('#' + x.tid))),
              h('div', { 'data-tb-item-n': '' },
                (x.bar || '?') + ' · ' + (x.at || '') + (x.replied ? ' · 已回' : ' · 没回'),
                x.tier ? h('span', { 'data-tb-tier': x.tier }, ' · ' + x.tier) : null),
              x.why ? h('div', { 'data-tb-item-why': '' }, x.why) : null)))
            : h('div', { 'data-tb-note': '' },
              rows === null ? '' : (tier || rowState
                ? '没有符合当前筛选的 —— 换个档位/状态看看'
                : '还没有记录 —— 跑一轮之后就有了')),
          rowsTotal > THREADS_PAGE ? h('div', { 'data-tb-row': '' },
            h('button', {
              'data-tb-btn': '', disabled: offset <= 0 || busy === 'threads',
              onClick: () => loadThreads(tier, rowState, Math.max(0, offset - THREADS_PAGE)),
            }, '上一页'),
            h('div', { 'data-tb-note': '' },
              (offset + 1) + '–' + Math.min(offset + THREADS_PAGE, rowsTotal) + ' / ' + rowsTotal),
            h('button', {
              'data-tb-btn': '', disabled: offset + THREADS_PAGE >= rowsTotal || busy === 'threads',
              onClick: () => loadThreads(tier, rowState, offset + THREADS_PAGE),
            }, '下一页')) : null),

        /* ══════════════ 偏好 ══════════════ */
        h('div', grp('taste'),
          h('div', { 'data-tb-h': '' }, '刷哪些吧'),
          textRow('bars', '关注的吧（一行一个，只写吧名）', 5,
            '比如：\n原神\n孙笑川\n崩坏3铁道',
            '留空 = 用内置默认的那 4 个吧（原神 / 崩坏星穹铁道 / steam / 编程）。写「原神吧」或「原神」都行，后面的「吧」会自动去掉。'),
          h('div', { 'data-tb-sep': '' }),
          h('div', { 'data-tb-h': '' }, '挑什么样的帖子'),
          textRow('keywords', '关键词（一行一个）', 4,
            '一行一个词；留空 = 这个吧里的都看看',
            '标题或正文里有这些词的优先细读。留空 = 不过滤。'),
          textRow('excludeWords', '排除词（一行一个）', 3,
            '一行一个词；留空 = 不排除',
            '标题或作者里出现这些词的，整条跳过（广告、引战、你不想看的东西）。'),
          selectRow('sortBy', '填了关键词时怎么挑', [
            ['reply', '按回复数（人多的先看，默认）'],
            ['time', '按时间（新的先看）'],
          ]),
          h('div', { 'data-tb-sep': '' }),
          h('div', { 'data-tb-h': '' }, '一轮读多少'),
          numRow('fetchPerRound', '每轮最多细读几篇正文', '填 0 = 只看标题、不读正文（省 token；候选标题会多带一些）', 0, 100, 8),
          numRow('listPerBar', '每个吧先取多少条候选', '从这些候选里挑上面几条', 1, 100, 30),
          h('div', { 'data-tb-sep': '' }),
          h('div', { 'data-tb-h': '' }, '日报'),
          selectRow('reportLevel', '日报写多细', [
            ['full', '完整 —— 每条：标题 / 链接 / 档位 / 为什么值得 / 回帖（默认）'],
            ['brief', '薄 —— 每条一两行，只留值不值得 + 链接'],
            ['off', '不写 —— 只在设置页里看「它刷过的帖子」，不生成日报文件'],
          ]),
          h('div', { 'data-tb-row': '' },
            h('button', { 'data-tb-btn': '', 'data-primary': '', disabled: Boolean(busy), onClick: onSavePrefs }, '保存偏好'),
            h('div', { 'data-tb-note': '' }, '吧 / 关键词 / 排除词 / 数字改完点这个保存；下拉选项是点了就存。'))),

        /* ══════════════ 互动 ══════════════ */
        h('div', grp('social'),
          h('div', { 'data-tb-h': '' }, '它拿你的账号说话'),
          // ⚠️ 默认关。开启位置必须有明确警示 —— 这是拿用户身份公开发言，不能只是个小开关。
          h('div', { 'data-tb-warnbox': '' },
            '⚠️ 打开下面这个开关，它就会用你登录的那个贴吧账号，在楼中楼里公开回帖。',
            h('br'),
            '发出去的话别人看得见、删不干净，也代表你本人的立场。建议先开着日报看几天，觉得它挑得准了再开。'),
          h(ToggleRow, {
            label: '自动回帖（默认关）',
            note: (cfg.autoReply ? '现在是开着的 —— 每轮最多回 ' : '现在是关的 —— 开了之后每轮最多回 ') +
              (cfg.replyPerRound ?? 1) + ' 条' + (cfg.mentionName ? ('，并且 @ ' + cfg.mentionName) : ''),
            on: sw('autoReply'),
            onChange: (v) => patch({ autoReply: v }, '自动回帖'),
          }),
          sw('autoReply') ? h('div', { 'data-tb-warnbox': '', 'data-hard': '' },
            '已开启：它现在真的会用你的号回帖。一觉得不对，先把上面的开关关掉，再去「高级」里点「退出登录」。') : null,
          sw('autoReply') ? h('div', { 'data-tb-sub': '' },
            numRow('replyPerRound', '每轮最多回几条', '0–20 条；填 0 = 这一轮只读不回', 0, 20, 1),
            // ⭐ 2026-10-28：按吧白名单 —— 站中间最容易被打，所以得能"某些吧只读"
            h('div', { 'data-tb-sec': '' },
              h('div', { 'data-tb-label': '' }, '只在这些吧里回帖（留空 = 所有吧都能回）'),
              h('textarea', {
                'data-tb-input': '', rows: 3,
                value: D.replyBars ?? '',
                placeholder: '一行一个吧名，例如：\nDeepSeek\n原神\n\n没列进来的吧 ⇒ 只写日报，一个字都不回',
                onChange: (e) => setDraft('replyBars', e.target.value),
                onBlur: () => {
                  const v = String(D.replyBars || '').split(/[\n,，]/).map((s) => s.trim()).filter(Boolean)
                  setDraft('replyBars', v.join('\n'))
                  patch({ replyBars: v }, '回帖白名单')
                },
              }),
              h('div', { 'data-tb-note': '' },
                '典型用法：把「反XX吧」这类只读吧排除掉 —— 在那类吧里说中立话，两边都会把你当水军。',
                ' 留空则不限制（订阅的每个吧都能回）。')),
            h('div', { 'data-tb-sec': '' },
              h('div', { 'data-tb-label': '' }, '@ 谁（留空 = 不 @）'),
              h('input', {
                'data-tb-input': '', value: D.mentionName ?? '',
                placeholder: '你（或朋友）的贴吧昵称 / 用户名；留空就在回帖里不 @ 人',
                onChange: (e) => setDraft('mentionName', e.target.value),
                onBlur: () => {
                  const v = String(D.mentionName || '').trim()
                  setDraft('mentionName', v)
                  patch({ mentionName: v }, '@ 谁')
                },
              }),
              h('div', { 'data-tb-note': '' },
                '回帖里会带一个 @，方便你在贴吧消息里看到它回了什么。贴吧的 @ 要昵称完全对得上才算。')),
            selectRow('replyLength', '回帖写多长', [
              ['short', '短 —— 不超过 15 字'],
              ['medium', '中 —— 不超过 40 字（默认）'],
              ['long', '长 —— 不超过 100 字'],
            ], '贴吧的楼中楼里太长容易被人烦；「中」最稳。')) : null,

          h('div', { 'data-tb-sep': '' }),
          h('div', { 'data-tb-h': '' }, '它能不能自己开新帖'),
          h('div', { 'data-tb-warnbox': '' },
            '⚠️ 下面这个开关让它能自己开新帖。开新帖比回帖更像广告号（尤其新号），默认关。'),
          h(ToggleRow, {
            label: '允许发主题帖（默认关）',
            note: '关着的时候它只能在楼中楼回话，不能开新帖',
            on: sw('allowPost'),
            onChange: (v) => patch({ allowPost: v }, '允许发主题帖'),
          }),
          sw('allowPost') ? h('div', { 'data-tb-warnbox': '', 'data-hard': '' },
            '已开启：它有可能自己开帖。标题和正文都要过值班章程里的红线（不吵架、不碰时政/色情/赌博、不引流）。') : null,

          h('div', { 'data-tb-sep': '' }),
          // ⚠️ 诚实提示：这两个开关决定「给模型的工具」注册不注册，而工具是 apply 时注册的
          //    ⇒ 不改完就以为立刻生效，会让人以为开关坏了（或以为已经关掉了其实还开着）。
          h('div', { 'data-tb-note': '' },
            '⚠️ 上面这两个开关（自动回帖 / 发主题帖）改完，建议重启一次 dsh 才彻底生效：' +
            '它们决定要不要给模型发「回帖 / 发帖」工具，而工具是插件加载时注册的。' +
            '（到点自动跑那一轮不看这两个工具，它是插件自己干的。）'),

          h('div', { 'data-tb-sep': '' }),
          h('div', { 'data-tb-h': '' }, '它怎么说话'),
          textRow('personaPrompt', '它按什么口气说话（留空 = 中性、像个吧友）', 6,
            '比如：叫我老王，说话简短点，别用 emoji，看不惯的就说看不惯。留空 = 不扮演任何人。',
            '这段会带进每次跑一轮：回帖的口气、日报里「它的一句话」都按这个来。'),
          h('div', { 'data-tb-note': '' }, '字数：' + String(D.personaPrompt || '').length +
            (String(D.personaPrompt || '').length > 2000 ? '（⚠️ 太长了，建议压到 2000 字以内）' : '')),
          h('div', { 'data-tb-row': '' },
            h('button', { 'data-tb-btn': '', 'data-primary': '', disabled: Boolean(busy), onClick: onSavePersona }, '保存人设'),
            h('div', { 'data-tb-note': '' }, '改完点保存；下一轮就按这个说话。')),

          h('div', { 'data-tb-sep': '' }),
          h('div', { 'data-tb-h': '' }, '现在的状态'),
          h('div', { 'data-tb-kv': '' },
            '今天已回 ' + (today.replied ?? 0) + ' 条' + (cfg.autoReply ? '' : '（自动回帖关着，所以是手动回的）'),
            h('br'),
            cfg.autoReply ? '自动回帖：开 · 每轮 ' + (cfg.replyPerRound ?? 1) + ' 条' : '自动回帖：关',
            h('br'),
            cfg.allowPost ? '发主题帖：允许' : '发主题帖：不允许')),

        /* ══════════════ 高级 ══════════════ */
        h('div', grp('adv'),
          h('div', { 'data-tb-h': '' }, '账号（贴吧）'),
          h('div', { 'data-tb-note': '' },
            '贴吧没有开放 API，所以只能粘浏览器里的 Cookie。步骤：电脑浏览器登录 tieba.baidu.com → F12 → ' +
            'Application（应用）→ Cookies → 找到 BDUSS 那一行，把「值」整串复制过来；STOKEN 同理。',
            h('br'),
            '🔒 它只存在这台机器的 %USERPROFILE%\\.dsh\\tieba-duty\\tieba_credential.json，不会上传、不会写进日报，也不会出现在诊断信息里。'),
          h('div', { 'data-tb-sec': '' },
            h('div', { 'data-tb-label': '' }, 'BDUSS'),
            h('textarea', {
              'data-tb-input': '', rows: 3, spellCheck: false, autoComplete: 'off',
              placeholder: '很长一大串；粘完点下面「登录」',
              value: bduss, onChange: (e) => setBduss(e.target.value),
            })),
          h('div', { 'data-tb-sec': '' },
            h('div', { 'data-tb-label': '' }, 'STOKEN'),
            h('textarea', {
              'data-tb-input': '', rows: 2, spellCheck: false, autoComplete: 'off',
              placeholder: '一般 40 位左右；没有它也能登，但回帖 / 发帖可能失败',
              value: stoken, onChange: (e) => setStoken(e.target.value),
            })),
          h('div', { 'data-tb-row': '' },
            h('button', { 'data-tb-btn': '', 'data-primary': '', disabled: busy === 'login', onClick: onLogin }, '登录'),
            h('button', { 'data-tb-btn': '', disabled: busy === 'whoami', onClick: onWhoami }, '检查登录'),
            h('button', { 'data-tb-btn': '', 'data-danger': '', disabled: busy === 'logout', onClick: onLogout }, '退出登录'),
            h('div', {
              'data-tb-badge': '',
              'data-on': cred.loggedIn ? '' : undefined,
              'data-off': cred.loggedIn ? undefined : '',
            }, cred.loggedIn ? ('当前：' + (cred.uname || '已登录')) : '当前：未登录')),
          h(Msg, { text: acctMsg, tone: acctTone }),

          h('div', { 'data-tb-sep': '' }),
          h('div', { 'data-tb-h': '' }, '它的地盘'),
          h('div', { 'data-tb-kv': '' },
            '家目录：' + (home || '（宿主没给，点一下「打开家目录」就知道）'),
            h('br'),
            '今天的日报：' + (rep.path ? rep.path + (rep.exists === false ? '（还没生成）' : '') : '（还没生成）'),
            h('br'),
            '日志：' + (logPath || '（还没读到 —— 点下面「看日志尾巴」）')),
          h('div', { 'data-tb-row': '' },
            h('input', {
              'data-tb-input': '', type: 'date', style: { width: '150px', flex: 'none' },
              value: D.reportDay ?? '', title: '留空 = 今天',
              onChange: (e) => setDraft('reportDay', e.target.value),
            }),
            h('button', { 'data-tb-btn': '', disabled: busy === 'report', onClick: onShowReport },
              report !== null ? '收起日报' : '看日报'),
            h('button', { 'data-tb-btn': '', onClick: () => onOpenFolder('out') }, '打开日报文件夹'),
            h('button', { 'data-tb-btn': '', onClick: () => onOpenFolder('home') }, '打开家目录'),
            h('div', { 'data-tb-note': '' }, '日期留空就是今天')),
          // ⚠️ 同一天中午/晚上各跑一轮 ⇒ 都追加在同一个文件里（每轮之间有分隔）。
          //    这不是重复 bug，别让用户以为出错了。
          h('div', { 'data-tb-note': '' },
            '同一天跑了好几轮的话，几轮的内容都追加在同一个文件里（每轮之间有分隔线），一次看到好几轮是正常的。'),
          reportPath && reportPath !== rep.path ? h('div', { 'data-tb-kv': '' }, '日报文件：' + reportPath) : null,
          report !== null ? h('pre', { 'data-tb-pre': '' }, report) : null,

          h('div', { 'data-tb-sep': '' }),
          h('div', { 'data-tb-h': '' }, '手动跑一轮的上限'),
          numRow('manualMax', '手动跑一轮最多挑几条', '就是「日常」里那个「现在跑一轮」的条数', 0, 20, 3),
          numRow('manualCooldownMin', '两次手动之间至少隔几分钟', '防止连点把贴吧刷出风控', 0, 240, 10),

          h('div', { 'data-tb-sep': '' }),
          h('div', { 'data-tb-h': '' }, '出问题了怎么查'),
          h('div', { 'data-tb-row': '' },
            h('button', { 'data-tb-btn': '', disabled: busy === 'diag', onClick: onDiag }, '复制诊断信息'),
            h('button', { 'data-tb-btn': '', disabled: busy === 'log', onClick: onShowLog },
              logLines !== null ? '收起日志' : '看日志尾巴'),
            h('div', { 'data-tb-note': '' }, '诊断信息 = 状态 + 配置 + 账号 + 日志尾巴（已自动复制，里面没有 BDUSS / STOKEN）')),
          diag ? h('pre', { 'data-tb-pre': '' }, diag) : null,
          logLines !== null ? (logLines.length
            ? h('pre', { 'data-tb-pre': '' }, logLines.join('\n'))
            : h('div', { 'data-tb-note': '' }, '日志还是空的 —— 跑一轮之后就有了')) : null)
      )
    }

    /* ════════════════════════════════════════════════════════════════════════
     * 侧边栏整页：图标 + 主面板
     * ────────────────────────────────────────────────────────────────────────
     * 注册契约（从安装包里 @deepseek-ai/dsh-cordis-client-runner 的 slot 目录核过）：
     *   · sidebar.panellist —— list 槽；register { id*, order?, label? }；图标组件收到
     *     ownerProps { size, active }（size = 要求的正方形边长，active = 当前是否被选中）
     *   · main —— keyed 槽；register { key* }，ownerProps 为 **空**
     *     ⇒ 侧边栏那一项的 id 必须等于主面板的 key，点了才会显示这一页
     *   ⚠️ main 面板拿不到任何「打开设置对话框」的能力（ownerProps 空、也没有全局桥），
     *      所以下面那个「设置」按钮的做法是：把**同一份设置页组件**渲染在主面板里。
     *      这样点一下一定有用，而不是假装跳转然后什么都不发生。
     * ════════════════════════════════════════════════════════════════════════ */

    /** 侧边栏图标：对话框 + 三条横线（贴吧＝一堆楼，别用 emoji）。 */
    function TiebaIcon(props) {
      const edge = props && props.size ? props.size : 18
      return h('svg', {
        width: edge,
        height: edge,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
        // 对话框外框 + 左下角的小尖角
        h('path', { d: 'M4 5h16v11H9l-5 4V5z' }),
        // 三条横线（楼层）
        h('path', { d: 'M8 9h8' }),
        h('path', { d: 'M8 12.5h5' }))
    }

    /* ── 极简 markdown（日报是插件自己写的，格式固定；不引第三方库） ──
     * 支持：# ## ### 标题、> 引用、- 列表、1. 列表、--- 分隔线、**粗体**、`代码`
     *       [文字](链接)、裸 http(s) 链接、``` 代码块。
     * 认不出来的行当普通段落 —— 至少不会丢字。全程不碰 dangerouslySetInnerHTML。 */

    function mdInline(text, tag) {
      const src = String(text == null ? '' : text)
      const re = /(\*\*[^*]+\*\*)|(`[^`]+`)|(\[[^\]]+\]\([^)\s]+\))|(https?:\/\/[^\s)）]+)/g
      const out = []
      let last = 0
      let m
      let i = 0
      while ((m = re.exec(src)) !== null) {
        if (m.index > last) out.push(src.slice(last, m.index))
        const tok = m[0]
        const key = tag + '-' + (i++)
        if (tok.slice(0, 2) === '**') out.push(h('strong', { key }, tok.slice(2, -2)))
        else if (tok.charAt(0) === '`') out.push(h('code', { key }, tok.slice(1, -1)))
        else if (tok.charAt(0) === '[') {
          const mm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok)
          out.push(h('a', { key, href: mm[2], target: '_blank', rel: 'noreferrer' }, mm[1]))
        } else out.push(h('a', { key, href: tok, target: '_blank', rel: 'noreferrer' }, tok))
        last = m.index + tok.length
      }
      if (last < src.length) out.push(src.slice(last))
      return out
    }

    const MD_BREAK = /^(#{1,6}\s|>\s?|```|\s*[-*+]\s+|\s*\d+[.)]\s+|\s*-{3,}\s*$)/

    function mdBlocks(text) {
      const lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n')
      const out = []
      let i = 0
      let k = 0
      while (i < lines.length) {
        const line = lines[i]
        if (!line.trim()) { i++; continue }

        // 同一天多轮会在同一个日报里追加，每轮前有 `<!-- round: N -->`：
        // 别把裸 HTML 注释显示给用户，渲染成一条「第 N 轮」的分隔
        const round = /^\s*<!--\s*round:\s*(\d+)\s*-->\s*$/.exec(line)
        if (round) {
          out.push(h('div', { key: 'rd' + (k++), 'data-tbm-round': round[1] }, '第 ' + round[1] + ' 轮'))
          i++
          continue
        }
        if (/^\s*<!--.*-->\s*$/.test(line)) { i++; continue }   // 其它注释直接吞掉

        if (line.trim().slice(0, 3) === '```') {           // 代码块：原样吐出来
          const buf = []
          i++
          while (i < lines.length && lines[i].trim().slice(0, 3) !== '```') { buf.push(lines[i]); i++ }
          i++
          out.push(h('pre', { key: 'pre' + (k++), 'data-tbm-pre': '' }, buf.join('\n')))
          continue
        }
        if (/^\s*-{3,}\s*$/.test(line)) { out.push(h('hr', { key: 'hr' + (k++) })); i++; continue }

        const hd = /^(#{1,6})\s+(.*)$/.exec(line)
        if (hd) {
          const lvl = Math.min(hd[1].length, 6)
          const body = hd[2].trim()
          // 日报里「### 11141821521」那种行 = 帖子 tid，标出来给样式用
          const isTid = lvl === 3 && /^\d+$/.test(body)
          out.push(h('h' + lvl, { key: 'h' + (k++), 'data-tbm-tid': isTid ? body : undefined }, mdInline(body, 'h' + k)))
          i++
          continue
        }
        if (/^>\s?/.test(line)) {
          const buf = []
          while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, '')); i++ }
          out.push(h('blockquote', { key: 'q' + (k++) }, mdInline(buf.join('\n'), 'q' + k)))
          continue
        }
        if (/^\s*[-*+]\s+/.test(line)) {
          const items = []
          while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
            items.push(h('li', { key: 'li' + (k++) }, mdInline(lines[i].replace(/^\s*[-*+]\s+/, ''), 'li' + k)))
            i++
          }
          out.push(h('ul', { key: 'ul' + (k++) }, items))
          continue
        }
        if (/^\s*\d+[.)]\s+/.test(line)) {
          const items = []
          while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
            items.push(h('li', { key: 'oi' + (k++) }, mdInline(lines[i].replace(/^\s*\d+[.)]\s+/, ''), 'oi' + k)))
            i++
          }
          out.push(h('ol', { key: 'ol' + (k++) }, items))
          continue
        }
        // 普通段落：吃到空行或下一个块标记
        const buf = []
        while (i < lines.length && lines[i].trim() && !MD_BREAK.test(lines[i])) { buf.push(lines[i]); i++ }
        if (buf.length) out.push(h('p', { key: 'p' + (k++) }, mdInline(buf.join('\n'), 'p' + k)))
        else i++   // 保险：任何一行都得往前走，别死循环
      }
      return out
    }

    function TiebaMarkdown({ text }) {
      let body = null
      try { body = mdBlocks(text) } catch { body = null }   // 解析炸了就退化，别让整页白掉
      if (!body || !body.length) {
        return h('pre', { 'data-tbm-pre': '' }, String(text == null ? '' : text))
      }
      return h('div', { 'data-tbm-md': '' }, body)
    }

    /* ────────────── 主面板（侧边栏点「刷贴吧」后，铺满主区域） ────────────── */

    const RUN_STEPS = ['正在读楼…', '正在问模型…', '正在写日报…']

    function TiebaMainPanel(props) {
      // ctx 由 apply 透传进来（目前用不上，但留着，将来 shell 真给了跳转能力就能接上）
      const { st, cfg, reload } = usePluginData(8000)
      const [rows, setRows] = React.useState(null)
      const [rowsTotal, setRowsTotal] = React.useState(0)
      const [offset, setOffset] = React.useState(0)
      const [report, setReport] = React.useState(null)     // null=还没读 | {text,day,path} | 字符串=错误/空态
      const [reportBusy, setReportBusy] = React.useState(false)
      const [run, setRun] = React.useState({ busy: false, step: '', note: '', tone: '' })
      const [showSettings, setShowSettings] = React.useState(false)
      const [now, setNow] = React.useState(Date.now())

      const alive = React.useRef(true)
      React.useEffect(() => () => { alive.current = false }, [])

      // 30 秒刷一次「现在在不在窗口」，跟 /status 的轮询错开
      React.useEffect(() => {
        const t = setInterval(() => { if (alive.current) setNow(Date.now()) }, 30000)
        return () => clearInterval(t)
      }, [])

      const loadThreads = async (off) => {
        try {
          const r = await jget('/threads?limit=' + THREADS_PAGE + '&offset=' + off)
          if (!alive.current) return
          if (!r || r.ok === false) { setRows([]); setRowsTotal(0); return }
          setRows(Array.isArray(r.rows) ? r.rows : [])
          setRowsTotal(Number(r.total) || 0)
          setOffset(off)
        } catch { if (alive.current) { setRows([]); setRowsTotal(0) } }
      }

      const loadReport = async () => {
        setReportBusy(true)
        try {
          const r = await jget('/report')
          if (!alive.current) return
          if (!r || r.ok === false) { setReport('读不到日报：' + ((r && r.error) || '未知原因')); return }
          setReport(r.exists
            ? { text: r.text || '（日报是空的）', day: r.day || '', path: r.path || '' }
            : '今天还没有日报 —— 点上面「现在跑一轮」就有了')
        } catch (e) { if (alive.current) setReport('读不到日报：' + msgOf(e)) } finally { if (alive.current) setReportBusy(false) }
      }

      React.useEffect(() => { loadThreads(0); loadReport() }, [])

      /* ⚠️ POST /run 是**同步等待**的（可能几十秒）：必须给转圈的反馈 + 分阶段文案，
       *    否则用户会以为点了没反应，然后连点。 */
      const onRun = async () => {
        if (run.busy) return
        const max = clampNum(cfg && cfg.manualMax, 0, 20, 3)
        setRun({ busy: true, step: RUN_STEPS[0], note: '', tone: '' })
        let stepIdx = 0
        const timer = setInterval(() => {
          stepIdx = Math.min(stepIdx + 1, RUN_STEPS.length - 1)
          if (alive.current) setRun((old) => (old.busy ? { ...old, step: RUN_STEPS[stepIdx] } : old))
        }, 5000)
        try {
          const r = await jpost('/run', { max })
          if (!alive.current) return
          if (!r || r.ok === false) {
            setRun({ busy: false, step: '', note: '没跑成：' + ((r && r.error) || '未知原因'), tone: 'warn' })
            return
          }
          if (r.started === false) {
            // ⭐ started:false 不算失败（还在跑上一轮 / 冷却没到）：把 reason 原样摆出来
            setRun({ busy: false, step: '', note: '这一轮没开始：' + (r.reason || '上一轮还在跑，或者刚跑过（等一会儿再来）'), tone: '' })
            return
          }
          setRun({ busy: false, step: '', note: '跑完了 —— 日报和下面的帖子都已经刷新', tone: 'good' })
          await Promise.all([loadThreads(0), loadReport()])
          reload()
        } catch (e) {
          if (alive.current) setRun({ busy: false, step: '', note: '跑不起来：' + msgOf(e), tone: 'warn' })
        } finally { clearInterval(timer) }
      }

      /* 现在在不在谷时窗口（跟 config 里那两个窗口一致：中午 12–14、夜间 18–09） */
      const windowState = () => {
        if (!cfg) return { text: '读设置中…' }
        const d = new Date(now)
        const hour = d.getHours() + d.getMinutes() / 60
        const inNoon = hour >= 12 && hour < 14
        const inNight = hour >= 18 || hour < 9
        if (!cfg.enabled) return { text: '插件总开关：关', off: true }
        if (!cfg.peakValley) return { text: '峰谷自动刷：关', off: true }
        if (inNoon) return cfg.noon ? { text: '中午谷时 12–14 · 在窗口', on: true } : { text: '中午谷时，但这一轮关着', off: true }
        if (inNight) return cfg.night ? { text: '夜间谷时 18–09 · 在窗口', on: true } : { text: '夜间谷时，但这一轮关着', off: true }
        return { text: '现在不在谷时窗口', off: true }
      }

      // 内联设置页：点「设置」就把同一份组件渲染在这儿（main 面板拿不到设置对话框）
      if (showSettings) {
        return h('div', { 'data-tb-main': '' },
          h('div', { 'data-tbm-bar': '' },
            h('button', { 'data-tbm-btn': '', onClick: () => setShowSettings(false) }, '‹ 返回'),
            h('div', { 'data-tbm-title': '' }, '刷贴吧 · 设置'),
            h('div', { 'data-tbm-grow': '' }),
            h('div', { 'data-tbm-sub': '' }, '跟「设置 → 刷贴吧」是同一份内容')),
          // 设置页组件自己也有一条常驻消息条/刷新按钮，直接复用，别维护两份
          h(Panel))
      }

      const today = (st && st.today) || {}
      const cred = (st && st.credential) || {}
      const ready = (st && st.ready) || {}
      const win = windowState()
      const perDay = cfg ? (cfg.perDay ?? 5) : '?'
      const shown = rows || []

      return h('div', { 'data-tb-main': '' },

        /* ── 1. 顶部状态条 ── */
        h('div', { 'data-tbm-bar': '' },
          h('div', { 'data-tbm-title': '' }, '刷贴吧'),
          h('span', { 'data-tbm-badge': '' }, '今天 ' + (today.picked ?? 0) + '/' + perDay + ' 条'),
          h('span', {
            'data-tbm-badge': '',
            'data-on': cred.loggedIn ? '' : undefined,
            'data-off': cred.loggedIn ? undefined : '',
          }, cred.loggedIn ? ('已登录' + (cred.uname ? ' ' + cred.uname : '')) : '未登录'),
          h('span', {
            'data-tbm-badge': '',
            'data-on': win.on ? '' : undefined,
            'data-off': win.off ? '' : undefined,
          }, win.text),
          ready.profile !== undefined
            ? h('span', { 'data-tbm-badge': '', 'data-on': ready.profile ? '' : undefined, 'data-off': ready.profile ? undefined : '' },
              ready.profile ? '就绪' : '没就绪')
            : null,
          h('span', { 'data-tbm-badge': '' }, 'v' + ((st && st.version) || '?')),
          h('div', { 'data-tbm-grow': '' }),
          st && st.running ? h('span', { 'data-tbm-badge': '', 'data-on': '' }, '后台正在跑') : null,
          h('button', { 'data-tbm-btn': '', onClick: () => { setShowSettings(true) }, title: '打开设置（同一个面板里）' }, '设置')),

        /* ── 2. 行动区 ── */
        h('div', { 'data-tbm-card': '' },
          h('div', { 'data-tbm-row': '' },
            h('button', {
              'data-tbm-big': '',
              disabled: run.busy || Boolean(st && st.running),
              onClick: onRun,
            },
              run.busy || (st && st.running) ? h('span', { 'data-tbm-spin': '' }) : null,
              run.busy ? '正在跑…' : ((st && st.running) ? '后台正在跑…' : '现在跑一轮')),
            h('div', { 'data-tbm-note': '' },
              run.busy
                ? '同步等待中，可能几十秒 —— 别重复点'
                : (cfg && cfg.autoReply
                  ? '开着自动回帖：跑完会用你的号回帖'
                  : '只读不写：不开自动回帖的话，它不会发任何东西'))),
          run.busy && run.step ? h('div', { 'data-tbm-note': '' }, run.step) : null,
          run.note ? h('div', {
            'data-tbm-msg': '',
            'data-good': run.tone === 'good' ? '' : undefined,
            'data-warn': run.tone === 'warn' ? '' : undefined,
          }, run.note) : null,
          !cred.loggedIn ? h('div', { 'data-tbm-note': '' },
            '还没登录贴吧 —— 照样能跑（只读），但「自动回帖」得先去「设置 → 高级」粘 BDUSS。') : null),

        /* ── 3. 今天的日报 ── */
        h('div', { 'data-tbm-card': '' },
          h('div', { 'data-tbm-row': '' },
            h('div', { 'data-tbm-h': '' }, '今天的日报'),
            report && report.path ? h('span', { 'data-tbm-chip': '' }, report.day || '') : null,
            h('div', { 'data-tbm-grow': '' }),
            h('button', { 'data-tbm-btn': '', disabled: reportBusy, onClick: loadReport },
              reportBusy ? '读取中…' : '重新读')),
          report === null
            ? h('div', { 'data-tbm-empty': '' }, '读取中…')
            : (typeof report === 'string'
              ? h('div', { 'data-tbm-empty': '' }, report)
              : h(TiebaMarkdown, { text: report.text })),
          report && report.path ? h('div', { 'data-tbm-note': '' }, report.path) : null),

        /* ── 4. 刷过的帖子 ── */
        h('div', { 'data-tbm-card': '' },
          h('div', { 'data-tbm-row': '' },
            h('div', { 'data-tbm-h': '' }, '刷过的帖子'),
            h('span', { 'data-tbm-badge': '' }, rows === null ? '读取中…' : ('共 ' + rowsTotal + ' 条')),
            h('div', { 'data-tbm-grow': '' }),
            h('button', { 'data-tbm-btn': '', onClick: () => loadThreads(offset) }, '刷新')),
          rows === null
            ? h('div', { 'data-tbm-empty': '' }, '读取中…')
            : (shown.length
              ? h('div', { 'data-tbm-grid': '' },
                shown.map((x) => h('a', {
                  key: String(x.tid),
                  'data-tbm-cell': '',
                  href: x.url || ('https://tieba.baidu.com/p/' + x.tid),
                  target: '_blank',
                  rel: 'noreferrer',
                  title: '在贴吧打开',
                },
                  h('div', { 'data-tbm-cell-t': '' }, x.title || ('#' + x.tid)),
                  h('div', { 'data-tbm-cell-n': '' },
                    (x.bar || '?') + (x.at ? ' · ' + x.at : '') + (x.replied ? ' · 已回' : ' · 没回'),
                    x.tier ? h('span', { 'data-tbm-chip': x.tier }, ' ' + x.tier) : null),
                  x.why ? h('div', { 'data-tbm-cell-w': '' }, x.why) : null)))
              : h('div', { 'data-tbm-empty': '' },
                '还没刷过帖子 —— 点上面的「现在跑一轮」，跑完这里就有东西了')),
          rowsTotal > THREADS_PAGE ? h('div', { 'data-tbm-row': '' },
            h('button', {
              'data-tbm-btn': '', disabled: offset <= 0,
              onClick: () => loadThreads(Math.max(0, offset - THREADS_PAGE)),
            }, '上一页'),
            h('div', { 'data-tbm-note': '' },
              (offset + 1) + '–' + Math.min(offset + THREADS_PAGE, rowsTotal) + ' / ' + rowsTotal),
            h('button', {
              'data-tbm-btn': '', disabled: offset + THREADS_PAGE >= rowsTotal,
              onClick: () => loadThreads(offset + THREADS_PAGE),
            }, '下一页')) : null))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // 样式：挂一份 <style>，靠 ctx.effect 在插件卸载时收掉（不然热重载会叠好几份）
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'dsh-tieba-scroll')
        style.textContent = CSS + MAIN_CSS
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove(), 'dsh-tieba-scroll: 设置页样式')

        // slots 可能还没起来：拿不到就安静退出（照 dsh-draw 的写法）
        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots || typeof slots.register !== 'function') return

        // ① 设置 → 刷贴吧（一节设置页）
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'tieba-scroll', order: 31, label: '刷贴吧' },
          () => h(Panel),
        ))

        // ② 侧边栏图标（order 61 = 排在「画图」(60) 后面）
        slots.inject('sidebar.panellist', () => slots.register(
          { name: 'sidebar.panellist', id: 'tieba-scroll', order: 61, label: '刷贴吧' },
          TiebaIcon,
        ))

        // ③ 点侧边栏那一项 → 主区域显示这一页（key 必须 === 上面的 id）
        slots.inject('main', () => slots.register(
          { name: 'main', key: 'tieba-scroll' },
          () => h(TiebaMainPanel, { ctx }),
        ))
      },
    }
  },
})
