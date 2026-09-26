/**
 * 拾遗录 · LX 音乐播放器（运行时）
 * ---------------------------------------------------------------------------
 * 数据来自 _config.butterfly.yml → lx_music.api 指定的第三方音乐接口（默认 lx-music-api），
 * 本文件不含任何音源，只负责界面与播放控制。可调参数全部在 _config.butterfly.yml → lx_music，
 * 由 scripts/lx-music.js 在构建期以 window.__LX_MUSIC__ 注入。
 *
 * 相对原始 pug 模板修掉的问题：
 *   1. 收起按钮（.lx-player-close）原本没有任何事件绑定，点了没反应 → 重写贴边收起 + 记忆状态
 *   2. getLyric() 取了歌词却只算了个下标、从不显示 → 补上歌词浮层（自动滚动 + 当前行高亮 + 翻译）
 *   3. song.types 缺失时 .map() 直接抛错整块中断 → 全部加保护
 *   4. 每次播放 new Audio() 会让旧实例泄漏且监听器重复叠加 → 全程复用同一个 <audio>
 *   5. 音质按钮默认高亮第一个（最低档）却按最高档播放，显示与实际不符 → 按实际选中的档位高亮
 *   6. 接口失败时静默无反应 → 统一 toast + 空态 + 加载态
 *   7. 歌名直接 innerHTML 拼接（自建接口返回第三方数据）→ 转义
 *   8. 只有一个 API 地址、写死在代码里 → 支持主/备两个地址，主地址不通自动切备用
 *      （本地 http 预览走直连、线上 https 走同源反代，同一份代码两处都能跑）
 *   9. 贴边图标原本是蓝色实心竖条、钉死在视口中间且不能动 → 换成「白色胶囊 + 绿色音符」
 *      （见 source/css/lx-music.css 的 .lx-rail），默认落在左下角、收起，
 *      可拖动但**横向只能贴左沿或右沿**（过中线自动翻边），纵向自由，位置记在 localStorage
 *  10. 榜单 / 歌单 / 热搜每次切 tab、每次返回都重新请求（同一份榜单一览最短路径里被拉 3 次）
 *      → 加了两级缓存（内存 + localStorage）+ stale-while-revalidate，见 CACHE_V 那一节。
 *      ⚠️ /api/play-url 返回的是带签名的临时直链，**绝不能缓存**（会拿到 403 死链）。
 *  11. 点歌后要等 1~3s 取播放地址（接口故障时十几秒），这期间界面毫无变化 → 加了「正在加载」三件套：
 *      歌曲行转圈 + 播放按钮转圈 + 播放条「正在加载…」文字。撤除时机统一挂在 audio 的
 *      playing / canplay 上（地址拿到 ≠ 能出声，还要缓冲），失败与切换歌曲都走同一个出口。
 *  12. 歌词原本是面板里固定 172px 的一条：把歌曲列表挤掉三成，而且只能 12.5px 小字居中排，
 *      观感像在面板里贴了张纸条 → 拎出来做成**独立浮层**（不再占面板任何空间）：
 *      可自由拖动（位置记 localStorage）、两种形态随时切换（多行窗 / 单行条）、
 *      点歌词里任意一句还能直接跳到那一句。相关配置：lyric_mode / lyric_seek。
 */
;(function () {
  'use strict'

  var CFG = window.__LX_MUSIC__
  if (!CFG || !CFG.enable) return
  if (window.__lxMusicMounted) return
  window.__lxMusicMounted = true

  var LS_COLLAPSED = 'lx-music:collapsed'
  var LS_VOLUME = 'lx-music:volume'
  var LS_POS = 'lx-music:pos'
  var LS_CACHE = 'lx-music:cache:'
  var LS_FAV = 'lx-music:fav'
  var LS_RECENT = 'lx-music:recent'
  var LS_LYRIC = 'lx-music:lyric'
  var MOBILE_MAX = 768
  // 本地内置封面：无图片或远程封面加载失败时显示，不依赖外部图床。
  var DEFAULT_COVER = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96">' +
    '<defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="#e4f6ee"/>' +
    '<stop offset="1" stop-color="#cce9e0"/></linearGradient></defs>' +
    '<rect width="96" height="96" rx="14" fill="url(#g)"/>' +
    '<circle cx="48" cy="48" r="29" fill="#fff" fill-opacity=".65"/>' +
    '<circle cx="48" cy="48" r="20" fill="#167e72" fill-opacity=".14"/>' +
    '<path d="M54 27v30.5a9 9 0 1 1-5-8V34l18-4v18.5a9 9 0 1 1-5-8V25z" fill="#167e72"/>' +
    '</svg>')

  // 歌词字体族的合法取值（字体栈在 CSS 里，按 .lx-lrc[data-font] 映射）
  var LRC_FONT_KEYS = ['', 'hei', 'song', 'kai', 'yuan', 'mono']

  /* ==========================================================
   * 图标（内联 SVG，避免依赖 FontAwesome 是否加载成功）
   * ========================================================== */
  function svg (d, extra) {
    return '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
      (extra || '') + '<path d="' + d + '"/></svg>'
  }
  var ICON = {
    play: svg('M8 5.14v13.72c0 .83.92 1.35 1.63.92l10.79-6.86a1.09 1.09 0 0 0 0-1.84L9.63 4.22A1.09 1.09 0 0 0 8 5.14z'),
    pause: svg('M7 4.5h3.2v15H7zM13.8 4.5H17v15h-3.2z'),
    prev: svg('M7 5h2.2v14H7zm11 0v14l-9-7z'),
    next: svg('M14.8 5H17v14h-2.2zM6 5l9 7-9 7z'),
    chevronRight: svg('M9.3 5.3a1 1 0 0 1 1.4 0l6 6a1 1 0 0 1 0 1.4l-6 6a1 1 0 1 1-1.4-1.4L14.6 12 9.3 6.7a1 1 0 0 1 0-1.4z'),
    chevronLeft: svg('M14.7 5.3a1 1 0 0 1 0 1.4L9.4 12l5.3 5.3a1 1 0 1 1-1.4 1.4l-6-6a1 1 0 0 1 0-1.4l6-6a1 1 0 0 1 1.4 0z'),
    // 单八分音符 ♪：贴边挡板用（Material music_note 的标准路径，渲染稳定）
    note: svg('M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z'),
    lyric: svg('M4 5h16v1.8H4zm0 4.2h11v1.8H4zm0 4.2h16v1.8H4zm0 4.2h8v1.8H4z'),
    // 「当前播放列表」：圆点 + 三条横线（Material 的 format_list_bulleted）。
    // 刻意与 lyric（四条纯横线）在形状上拉开距离 —— 两个按钮挨着放，光看横线会认错。
    queue: svg('M4 4.5c-.83 0-1.5.67-1.5 1.5S3.17 7.5 4 7.5 5.5 6.83 5.5 6 4.83 4.5 4 4.5zm0 6c-.83 0-1.5.67-1.5 1.5s.67 1.5 1.5 1.5 1.5-.67 1.5-1.5-.67-1.5-1.5-1.5zm0 6c-.83 0-1.5.67-1.5 1.5s.67 1.5 1.5 1.5 1.5-.67 1.5-1.5-.67-1.5-1.5-1.5zM7.5 19h13v-2h-13v2zm0-6h13v-2h-13v2zm0-8v2h13V5h-13z'),
    volume: svg('M4 9.2h3.2L11.6 5v14l-4.4-4.2H4zm11.2-.6a4.4 4.4 0 0 1 0 6.8l1.3 1.4a6.3 6.3 0 0 0 0-9.6z'),
    mute: svg('M4 9.2h3.2L11.6 5v14l-4.4-4.2H4zm10.3.4 1.3-1.3 2 2 2-2 1.3 1.3-2 2 2 2-1.3 1.3-2-2-2 2-1.3-1.3 2-2z'),
    close: svg('M6.2 4.8 12 10.6l5.8-5.8 1.4 1.4L13.4 12l5.8 5.8-1.4 1.4L12 13.4l-5.8 5.8-1.4-1.4L10.6 12 4.8 6.2z'),
    lock: svg('M17 8h-1V6a4 4 0 0 0-8 0v2H7a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2zm-7-2a2 2 0 0 1 4 0v2h-4V6zm7 13H7v-9h10v9z'),
    unlock: svg('M17 8h-1V6a4 4 0 0 0-7.46-2.05l1.73 1A2 2 0 0 1 14 6v2H7a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2zm0 11H7v-9h10v9z'),
    // 齿轮（Material settings）：歌词浮层的「歌词样式」设置入口
    gear: svg('M12 8.4a3.6 3.6 0 1 0 0 7.2 3.6 3.6 0 0 0 0-7.2zm7.14 3.6c0 .32-.02.64-.07.94l2.03 1.58a.49.49 0 0 1 .12.61l-1.92 3.32a.48.48 0 0 1-.59.22l-2.39-.96c-.5.38-1.03.7-1.62.94l-.36 2.54a.48.48 0 0 1-.47.41h-3.84a.48.48 0 0 1-.48-.41l-.36-2.54a6.6 6.6 0 0 1-1.62-.94l-2.39.96a.48.48 0 0 1-.59-.22l-1.92-3.32a.49.49 0 0 1 .12-.61l2.03-1.58a6.9 6.9 0 0 1 0-1.88L2.74 8.87a.49.49 0 0 1-.12-.61l1.92-3.32a.48.48 0 0 1 .59-.22l2.39.96c.5-.38 1.03-.7 1.62-.94l.36-2.54a.48.48 0 0 1 .48-.41h3.84c.24 0 .43.17.47.41l.36 2.54c.59.24 1.13.57 1.62.94l2.39-.96a.48.48 0 0 1 .59.22l1.92 3.32c.12.21.08.47-.12.61l-2.03 1.58c.05.3.07.62.07.94z'),
    refresh: svg('M12 4V1.5L8 5.5l4 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z'),
    // 歌词浮层的形态切换键：多行（三条居中递减的横线）/ 单行（一条居中横线）。
    // 刻意都从「居中」起笔 —— 播放条上那个 lyric 图标是四条左对齐横线，两者挨着也不会认错。
    lrcWindow: svg('M4 6.5h16v1.9H4zM7 11.1h10v1.9H7zM9.5 15.7h5v1.9h-5z'),
    lrcBar: svg('M4 11h16v1.9H4z'),
    // 爱心两态（Material 的 favorite / favorite_border）：空心=未收藏、实心=已收藏。
    // 两版都给，由 CSS 按 [data-on] 挑一个显示 —— 与播放按钮同一套做法，切换不重建 DOM。
    heartLine: svg('M16.5 3c-1.74 0-3.41.81-4.5 2.09C10.91 3.81 9.24 3 7.5 3 4.42 3 2 5.42 2 8.5c0 3.78 3.4 6.86 8.55 11.54L12 21.35l1.45-1.32C18.6 15.36 22 12.28 22 8.5 22 5.42 19.58 3 16.5 3zm-4.4 15.55l-.1.1-.1-.1C7.14 14.24 4 11.39 4 8.5 4 6.5 5.5 5 7.5 5c1.54 0 3.04.99 3.57 2.36h1.87C13.46 5.99 14.96 5 16.5 5c2 0 3.5 1.5 3.5 3.5 0 2.89-3.14 5.74-7.9 10.05z'),
    heartFill: svg('M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z'),
    // 「正在加载」转圈：一段开口圆环（周长 2πr ≈ 56.5，dashoffset 42 ⇒ 露出约 90° 的弧），
    // 旋转交给 CSS 的 .lx-spin —— 不能用 svg() 生成，它没地方挂 class。
    spin: '<svg class="lx-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
      '<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2.6" ' +
      'stroke-linecap="round" stroke-dasharray="56.5" stroke-dashoffset="42"/></svg>'
  }

  /* ==========================================================
   * 小工具
   * ========================================================== */
  var elRoot = null
  var $ = function (sel) { return elRoot ? elRoot.querySelector(sel) : null }
  var $$ = function (sel) { return elRoot ? Array.prototype.slice.call(elRoot.querySelectorAll(sel)) : [] }

  function esc (v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
  }

  function fmt (sec) {
    if (!isFinite(sec) || sec < 0) return '00:00'
    var m = Math.floor(sec / 60)
    var s = Math.floor(sec % 60)
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s
  }

  function isMobile () { return window.innerWidth <= MOBILE_MAX }

  // 是否「页面内嵌版」（挂在正文容器里、常驻展开），见 mount()
  function isEmbed () { return !!(elRoot && elRoot.classList.contains('lx-embed')) }

  function store (key, val) {
    try {
      if (val === undefined) return localStorage.getItem(key)
      if (val === null) localStorage.removeItem(key)
      else localStorage.setItem(key, val)
    } catch (e) { /* 隐私模式下 localStorage 可能不可用 */ }
    return null
  }

  /* ==========================================================
   * 接口层：主地址 + 备用地址，谁通用谁，并记住结果
   * ========================================================== */
  var bases = [CFG.api, CFG.api_fallback].filter(function (b) { return !!b })
  if (!bases.length) bases = ['']
  var baseIdx = 0

  function join (base, path) {
    if (!base) return path
    return String(base).replace(/\/+$/, '') + path
  }

  function ApiError (msg, kind) {
    var e = new Error(msg)
    e.kind = kind || 'api'
    return e
  }

  function req (path, opts) {
    opts = opts || {}

    var attempt = function (i) {
      var base = bases[i]
      var init = { method: opts.method || 'GET', headers: {} }
      if (opts.method === 'POST') {
        init.headers['Content-Type'] = 'application/json'
        init.body = JSON.stringify(opts.body || {})
      }
      var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null
      var timer = null
      if (ctrl) {
        init.signal = ctrl.signal
        timer = setTimeout(function () { ctrl.abort() }, Number(CFG.timeout) || 15000)
      }

      return fetch(join(base, path), init).then(function (res) {
        if (timer) clearTimeout(timer)
        if (!res.ok) throw ApiError('HTTP ' + res.status, 'http')
        return res.json()
      }).then(function (json) {
        if (json && typeof json.code !== 'undefined' && json.code !== 0) {
          throw ApiError(json.msg || ('接口返回 code=' + json.code), 'biz')
        }
        baseIdx = i // 记住这次成功的地址
        return json
      }).catch(function (err) {
        if (timer) clearTimeout(timer)
        // 业务错误（参数不对之类）换地址也没用，直接抛；网络/协议问题才继续试下一个
        if (err && err.kind === 'biz') throw err
        if (i + 1 < bases.length) return attempt(i + 1)
        throw err
      })
    }

    return attempt(baseIdx)
  }

  /* ==========================================================
   * 缓存层：榜单 / 歌单
   * ----------------------------------------------------------
   * 两级：内存 Map（本次会话，零延迟）+ localStorage（跨会话，按 TTL 过期）。
   * 策略是 stale-while-revalidate：
   *   · TTL 内   直接吃缓存，**一个请求都不发**（这才是「不要每次都请求」）
   *   · 已过期   先把旧数据渲染出来，再后台静默刷新；刷新失败也保持沉默
   *   · 没缓存   老老实实等网络（调用方这时才显示骨架屏）
   * 写不进缓存（体积过大 / 配额满 / 隐私模式）一律静默放弃，绝不影响播放。
   *
   * ⚠️ 只用于「目录 / 列表」这类可重复获取的数据。
   *    /api/play-url 返回的是**带签名的临时直链**（几十分钟~几小时失效），
   *    缓存后必然拿到 403 死链，表现为「点了没声音、过一阵自己又好了」——严禁走这里。
   * ========================================================== */
  var CACHE_V = 'v1'          // 结构版本：以后改了缓存里存的字段，改这里即可整体作废
  var CACHE_MAX = 30          // 最多保留 30 条，超出按写入时间淘汰最旧的
  var CACHE_ITEM_MAX = 200 * 1024
  var memCache = Object.create(null)

  function cacheTtl () {
    var t = Number(CFG.cache_ttl)
    if (!isFinite(t) || t <= 0) t = 21600
    return t * 1000
  }

  // 读：返回 null（未命中）或 { v: 数据, stale: 是否已过 TTL }
  function cacheGet (name) {
    var key = CACHE_V + ':' + name
    var rec = memCache[key]
    if (!rec) {
      var raw = store(LS_CACHE + key)
      if (raw) {
        try { rec = JSON.parse(raw) } catch (e) { rec = null }
        // 结构不对（被手改过 / 旧版本残留）一律当没有，绝不拿它去渲染
        if (!rec || typeof rec.e !== 'number' || typeof rec.v === 'undefined') rec = null
        if (rec) memCache[key] = rec   // 回填内存层，本次会话后面都走内存
      }
    }
    if (!rec) return null
    return { v: rec.v, stale: rec.e <= Date.now() }
  }

  // 写：内存层必写；localStorage 写失败就算了，不影响主流程
  function cacheSet (name, v) {
    var key = CACHE_V + ':' + name
    var now = Date.now()
    var rec = { e: now + cacheTtl(), t: now, v: v }
    memCache[key] = rec
    var raw = null
    try { raw = JSON.stringify(rec) } catch (e) { return }
    if (!raw || raw.length > CACHE_ITEM_MAX) return
    store(LS_CACHE + key, raw)
    pruneCache()
  }

  // 淘汰：顺手清掉损坏的条目，再把超出上限的最旧几条删掉
  function pruneCache () {
    try {
      var items = []
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i)
        if (!k || k.indexOf(LS_CACHE) !== 0) continue
        var rec = null
        try { rec = JSON.parse(localStorage.getItem(k) || '') } catch (e) { rec = null }
        if (!rec || typeof rec.e !== 'number') { localStorage.removeItem(k); continue }
        items.push({ k: k, t: Number(rec.t) || 0 })
      }
      if (items.length <= CACHE_MAX) return
      items.sort(function (a, b) { return a.t - b.t })
      for (var j = 0; j < items.length - CACHE_MAX; j++) localStorage.removeItem(items[j].k)
    } catch (e) { /* localStorage 不可用就算了 */ }
  }

  // 空列表不写缓存：接口偶发返空，写进去会被钉住一整个 TTL
  function cacheUsable (d) {
    if (!d) return false
    if (Object.prototype.toString.call(d) === '[object Array]') return d.length > 0
    return true
  }

  // 手动清空两级缓存（控制台：__lxMusic.cache.clear()）
  function clearCache () {
    memCache = Object.create(null)
    try {
      var keys = []
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i)
        if (k && k.indexOf(LS_CACHE) === 0) keys.push(k)
      }
      keys.forEach(function (k) { localStorage.removeItem(k) })
    } catch (e) { /* localStorage 不可用就算了 */ }
  }

  // 面板顶部的「刷新」按钮：清空榜单/歌单/热搜的本地缓存，并重载当前视图。
  // ★ 只清「目录/列表」那几份缓存 —— 播放地址与歌词本来就不缓存（前者是带签名死链、
  //   后者要随歌实时取），清缓存解决不了「播放/歌词」的问题，别让按钮名误导用户。
  function refreshCache () {
    clearCache()
    toast('已清空本地缓存，重新加载', 'ok')
    switchTab(state.tab)   // search 无缓存、走空态；rank/playlist/mine 会重新拉
  }

  /**
   * 带缓存的读取。
   * @param name   缓存键（不含版本号），如 'boards' / 'board:<bangid>:1'
   * @param path   接口路径（同 req）
   * @param opts   { method, body }
   * @param pick   function(res) → 要缓存的规范化数据（空数组不写）
   * @param onData function(data, meta) → 渲染；meta.refresh 为 true = 后台刷新回来的重绘
   * @returns Promise：无缓存时失败会 reject，调用方据此显示错误 / 重试
   */
  function fetchCached (name, path, opts, pick, onData) {
    var on = CFG.cache !== false
    if (on) {
      var hit = cacheGet(name)
      if (hit) {
        onData(hit.v, { cached: true, stale: hit.stale })
        if (!hit.stale) return Promise.resolve(hit.v)   // TTL 内：不发请求
        return req(path, opts).then(function (res) {
          var data = pick(res)
          // 接口偶发返空时继续展示旧列表，别让后台刷新把可用内容清掉。
          if (cacheUsable(data)) {
            cacheSet(name, data)
            onData(data, { cached: true, stale: false, refresh: true })
          }
          return data
        }).catch(function () {
          // 后台刷新失败保持沉默：界面上已经有旧数据了，再弹个错反而更差
          return null
        })
      }
    }
    return req(path, opts).then(function (res) {
      var data = pick(res)
      if (on && cacheUsable(data)) cacheSet(name, data)
      onData(data, { cached: false, stale: false })
      return data
    })
  }

  /* ==========================================================
   * 我的音乐库：收藏（我喜欢）+ 最近播放
   * ----------------------------------------------------------
   * 纯前端、纯 localStorage —— 站点没有账号体系，所以粒度就是
   * 「每个浏览器一份」：换浏览器 / 清站点数据就没了，但也不需要登录。
   *
   * 存的是歌曲对象的裁剪副本（只剔掉 _types / 歌词这类大字段，其余原样保留）：
   * /api/play-url 是拿整个 songInfo 去换播放链接的，字段缺一个都可能换不到地址，
   * 所以这里只做减法、绝不做「挑几个字段存」的白名单——那样迟早会漏。
   * ========================================================== */
  var DROP_FIELDS = { _types: 1, lrc: 1, lyric: 1, tlyric: 1 }
  var lib = { fav: [], recent: [] }

  // 收藏 / 最近播放的总开关（_config.butterfly.yml → lx_music.favorite）
  function favOn () { return CFG.favorite !== false }

  function libStoreKey (name) { return name === 'fav' ? LS_FAV : LS_RECENT }

  function libMax (name) {
    var n = Number(name === 'fav' ? CFG.fav_max : CFG.recent_max)
    if (!isFinite(n) || n <= 0) n = name === 'fav' ? 200 : 100
    return Math.floor(n)
  }

  // 同一首歌的判据：优先「源 + 歌曲 mid」，兜底 songId / id / 歌名
  function songKey (s) {
    if (!s) return ''
    return String(s.source || '') + '|' + String(s.songmid || s.songId || s.id || s.name || '')
  }

  function slimSong (s) {
    var o = {}
    for (var k in s) {
      if (!Object.prototype.hasOwnProperty.call(s, k)) continue
      if (DROP_FIELDS[k]) continue
      o[k] = s[k]
    }
    return o
  }

  function libRead (name) {
    var raw = null
    try { raw = localStorage.getItem(libStoreKey(name)) } catch (e) { return [] }
    if (!raw) return []
    var arr = null
    try { arr = JSON.parse(raw) } catch (e) { return [] }
    if (Object.prototype.toString.call(arr) !== '[object Array]') return []
    return arr.filter(function (s) { return s && typeof s === 'object' && (s.name || s.songmid) })
  }

  // 写：超上限先截断；再遇配额满（QuotaExceededError）就把列表砍半重试，
  // 宁可少存几首，也不能让「收藏」整个失效。这里不用 store() 是因为它把异常吞了，
  // 而我们要靠异常来决定「退一步再试」。
  function libWrite (name) {
    var max = libMax(name)
    if (lib[name].length > max) lib[name] = lib[name].slice(0, max)
    for (var attempt = 0; attempt < 3; attempt++) {
      var raw = null
      try { raw = JSON.stringify(lib[name]) } catch (e) { return }
      try { localStorage.setItem(libStoreKey(name), raw); return } catch (e) {
        lib[name] = lib[name].slice(0, Math.floor(lib[name].length / 2))
      }
    }
  }

  function libLoad () {
    lib.fav = libRead('fav')
    lib.recent = libRead('recent')
  }

  function libFind (name, s) {
    var k = songKey(s)
    if (!k) return -1
    var list = lib[name]
    for (var i = 0; i < list.length; i++) { if (songKey(list[i]) === k) return i }
    return -1
  }

  function isFav (s) { return libFind('fav', s) >= 0 }

  // 返回收藏后的状态：true = 已收藏
  function toggleFav (s) {
    if (!s || !songKey(s)) return false
    var at = libFind('fav', s)
    if (at >= 0) lib.fav.splice(at, 1)
    else lib.fav.unshift(slimSong(s))
    libWrite('fav')
    return at < 0
  }

  // 起播时记一笔。同一首重复播只更新时间、不产生重复条目（移到最前）。
  function pushRecent (s) {
    if (!s || !songKey(s)) return
    var at = libFind('recent', s)
    if (at >= 0) lib.recent.splice(at, 1)
    lib.recent.unshift(slimSong(s))
    libWrite('recent')
  }

  function clearLib (name) {
    lib[name] = []
    libWrite(name)
  }

  /* ==========================================================
   * 状态
   * ========================================================== */
  var state = {
    tab: CFG.default_tab || 'search',
    songs: [],
    index: -1,
    song: null,
    quality: '',
    lyric: [],
    lyricIdx: -1,
    // 歌词请求序号：快速切歌时上一首的歌词响应可能后到 —— 比对它，别把新歌的歌词盖掉
    lyricSeq: 0,
    view: 'list',      // list | boards | playlists | mine
    mine: 'fav',       // 「我的」里的子视图：fav（我喜欢）| recent（最近播放）
    trail: [],         // 面包屑
    // 当前列表的来源名（榜单名 / 歌单名 / 搜索词 / 我喜欢 / 最近播放）—— 给「播放列表」当标题
    src: '',
    // 打开「播放列表」之前的位置（视图 / 面包屑 / 搜索面板可见性…），用于再点一次返回
    queueFrom: null,
    searchPage: 1,
    searchKeyword: '',
    searchTotal: 0,
    busy: false,
    // 导航序号：每次「换视图」自增。异步回来的渲染要先比对它，
    // 否则「进 A 榜 → 请求还没回来就返回 → 去看 B 榜」时，A 的迟到响应会把 B 覆盖掉。
    nav: 0,
    // 取播放地址的序号：点歌/换音质都会自增。取链要走网络（正常 1~3s、接口故障时更久），
    // 这期间必须给出「正在加载」的反馈，否则用户会以为点了没反应/卡死。
    // 迟到的响应比对它，避免把「已经切走的那首歌」的加载态错清到新歌上。
    load: 0
  }

  var audio = null
  var toastTimer = null
  // 悬浮挡板左上角的视口坐标（默认左下角，或由上次拖动的位置覆盖）
  var pos = { x: 0, y: 16 }

  /* ==========================================================
   * 骨架
   * ========================================================== */
  function mount () {
    // 页面内嵌版：正文存在 #lx-music-page 时挂入容器。
    // 容器存在 → 播放器常驻嵌进去（挡板与收起按钮由 CSS 隐藏）；
    // 容器不存在（页面没放 / 写错了）→ 静默回落到贴边悬浮版，不留一块空白。
    var host = CFG.page_embed !== false ? document.querySelector('#lx-music-page') : null

    var wrap = document.createElement('div')
    wrap.id = 'lx-music'
    // lx-boot：从插入那一刻起就不可见、且禁用了过渡（样式见 lx-music.css）。
    // init() 把位置与收起态都算定后由 reveal() 摘掉。
    wrap.className = 'lx-music' + (host ? ' lx-embed' : '') + ' lx-boot'
    wrap.setAttribute('data-tab', state.tab)
    // 收起态在这里就定下来，而不是等 init() 末尾的 setCollapsed()：
    // 首帧渲染时属性已经是终值，才不会出现「先展开、再滑走」的闪烁。
    wrap.setAttribute('data-collapsed', initialCollapsed() ? 'true' : 'false')
    wrap.innerHTML = [
      '<div class="lx-panel" role="region" aria-label="音乐播放器">',

      '  <div class="lx-head">',
      '    <span class="lx-head-dot"></span>',
      '    <span class="lx-head-title">拾遗 · 音乐</span>',
      '    <button class="lx-ibtn lx-refresh" type="button" data-act="refresh-cache" title="清空本地缓存并重新加载" aria-label="清空本地缓存并重新加载">' + ICON.refresh + '</button>',
      '    <button class="lx-ibtn lx-collapse" type="button" title="收起" aria-label="收起">' + ICON.chevronLeft + '</button>',
      '  </div>',

      '  <div class="lx-tabs">',
      '    <button class="lx-tab" type="button" data-tab="search">搜索</button>',
      '    <button class="lx-tab" type="button" data-tab="rank">榜单</button>',
      '    <button class="lx-tab" type="button" data-tab="playlist">歌单</button>',
      favOn() ? '    <button class="lx-tab" type="button" data-tab="mine">我的</button>' : '',
      '  </div>',

      '  <div class="lx-panes">',
      '    <div class="lx-pane" data-pane="search">',
      '      <div class="lx-searchbar">',
      '        <input class="lx-input" type="search" placeholder="搜索歌曲 / 歌手" autocomplete="off">',
      '        <button class="lx-go" type="button">搜索</button>',
      '      </div>',
      '      <div class="lx-hot"></div>',
      '    </div>',
      '    <div class="lx-crumb" hidden><button class="lx-back" type="button">' + ICON.chevronLeft + '返回</button><span class="lx-crumb-text"></span></div>',
      '    <div class="lx-main"></div>',
      '  </div>',

      '  <div class="lx-toast" hidden></div>',

      '  <div class="lx-bar">',
      '    <div class="lx-now">',
      '      <img class="lx-cover" alt="" referrerpolicy="no-referrer" src="' + DEFAULT_COVER + '">',
      '      <div class="lx-meta">',
      '        <div class="lx-name" title="">未选择歌曲</div>',
      '        <div class="lx-singer"></div>',
      '        <div class="lx-hint" hidden></div>',
      '      </div>',
      favOn() ? '      <button class="lx-ibtn lx-bar-fav" type="button" data-act="fav" data-on="0" title="喜欢" aria-label="喜欢">' + ICON.heartLine + ICON.heartFill + '</button>' : '',
      '      <div class="lx-eq" aria-hidden="true"><i></i><i></i><i></i></div>',
      '    </div>',
      CFG.lyric === false ? '' : [
        '    <div class="lx-page-lyrics" aria-label="当前歌曲歌词">',
        '      <div class="lx-page-lyrics-title">歌词 <span class="lx-page-lyrics-rule"></span></div>',
        '      <div class="lx-page-lyrics-lines"><div class="lx-page-lyrics-roll"></div></div>',
        '    </div>'
      ].join(''),
      '    <div class="lx-progress">',
      '      <span class="lx-tcur">00:00</span>',
      '      <div class="lx-track" role="slider" tabindex="0" aria-label="播放进度"><div class="lx-fill"></div><div class="lx-knob"></div></div>',
      '      <span class="lx-tdur">00:00</span>',
      '    </div>',
      '    <div class="lx-controls">',
      '      <button class="lx-ibtn" type="button" data-act="prev" title="上一首">' + ICON.prev + '</button>',
      '      <button class="lx-play" type="button" data-act="play" title="播放 / 暂停">' + ICON.play + ICON.pause + ICON.spin + '</button>',
      '      <button class="lx-ibtn" type="button" data-act="next" title="下一首">' + ICON.next + '</button>',
      '      <span class="lx-spacer"></span>',
      '      <button class="lx-ibtn lx-queue-toggle" type="button" data-act="queue" title="播放列表" aria-label="播放列表">' + ICON.queue + '</button>',
      '      <button class="lx-ibtn lx-lyric-toggle" type="button" data-act="lyric" title="歌词">' + ICON.lyric + '</button>',
      '      <button class="lx-ibtn lx-mute" type="button" data-act="mute" title="静音">' + ICON.volume + '</button>',
      '      <input class="lx-vol" type="range" min="0" max="1" step="0.01" aria-label="音量">',
      '    </div>',
      '    <div class="lx-quality"></div>',
      '  </div>',

      '</div>',

      // 歌词浮层：独立于面板的一层（挂在 #lx-music 里、用视口坐标定位）。
      // 面板里的固定高度歌词条会把歌曲列表挤掉三成，而且只有 12.5px 小字居中排，观感像贴了张纸条；
      // 拎出来之后面板回归纯列表，歌词拿到完整高度、可自由拖动、还能一键收成单行条。
      // 两种形态共用这一份 DOM，由 .lx-lrc[data-mode] 切换（样式见 lx-music.css「歌词浮层」一节）。
      CFG.lyric === false ? '' : [
        '<div class="lx-lrc" data-mode="' + lrcMode + '" hidden>',
        // 头部只留「齿轮 + 关闭」两个图标，整条头仍是拖动手柄；形态切换并进了齿轮浮板。
        // 封面 / 歌名 / 歌手 / 底部进度条与时间都不做了 —— 浮层默认透明，只留歌词文字。
        '  <div class="lx-lrc-head">',
        // 单行条形态的正文（多行窗形态下被 CSS 藏起来）。它留在头部里，
        // 所以「头部只剩图标」只在多行窗形态下成立 —— 单行条本来就只有这一句要显示。
        '    <div class="lx-lrc-one"><span class="lx-lrc-one-text"></span><span class="lx-lrc-one-trans"></span></div>',
        '    <button class="lx-ibtn lx-lrc-lock" type="button" data-act="lrc-lock" title="锁定歌词位置" aria-label="锁定歌词位置">' + ICON.lock + '</button>',
        '    <button class="lx-ibtn lx-lrc-gear" type="button" data-act="lrc-gear" title="歌词样式" aria-label="歌词样式">' + ICON.gear + '</button>',
        '    <button class="lx-ibtn lx-lrc-close" type="button" data-act="lrc-close" title="关闭歌词" aria-label="关闭歌词">' + ICON.close + '</button>',
        '  </div>',
        // ★ 滚动不靠原生滚动条，而是平移内层这条轨道（见 lrcScrollTo）：
        //   vertical-rl 下 scrollLeft 从 0 起、随内容向后为负，横排那套
        //   「scrollTop + 差 − 居中补偿」再 clamp 到 ≥0 的写法在竖排下会把位移压成 0
        //   ⇒ 永远停在第一列。平移量的取值天然非负，横竖两个方向于是共用一套算式。
        '  <div class="lx-lrc-lines"><div class="lx-lrc-roll">' +
          '<div class="lx-lrc-empty lx-lrc-status" data-type="idle"><span class="lx-lrc-empty-ic">' + ICON.note +
            '</span><span class="lx-lrc-empty-msg">先选一首歌，歌词会显示在这里</span></div></div></div>',
        '</div>',
        lrcPopHtml()
      ].join('\n'),

      // 贴边挡板只在悬浮版需要（内嵌版本身就是常驻展开的）
      [
        '<button class="lx-rail" type="button" title="展开播放器（可拖动）" aria-label="展开播放器">',
        '  <span class="lx-rail-disc">' + ICON.note + '</span>',
        '</button>'
      ].join('\n')
    ].join('\n')

    ;(host || document.body).appendChild(wrap)
    elRoot = wrap
  }

  /* ==========================================================
   * 视图：歌曲列表 / 榜单列表 / 歌单网格
   * ========================================================== */
  function setBusy (on, text) {
    state.busy = on
    var main = $('.lx-main')
    if (!main) return
    if (on) {
      main.innerHTML = '<div class="lx-skeleton" role="status" aria-live="polite">' +
        '<p class="lx-busy-text">' + esc(text || '正在加载…') + '</p>' +
        new Array(6).join('<div class="lx-sk-row" aria-hidden="true"></div>') + '</div>'
    }
  }

  function empty (text, retry) {
    var main = $('.lx-main')
    main.innerHTML = '<div class="lx-empty"><p>' + esc(text) + '</p>' +
      (retry ? '<button class="lx-retry" type="button">' + ICON.refresh + '重试</button>' : '') + '</div>'
    if (typeof retry === 'function') $('.lx-retry').addEventListener('click', retry)
  }

  function toast (msg, kind) {
    var box = $('.lx-toast')
    if (!box) return
    box.textContent = msg
    box.setAttribute('data-kind', kind || 'error')
    box.hidden = false
    clearTimeout(toastTimer)
    toastTimer = setTimeout(function () { box.hidden = true }, 4200)
  }

  function renderSongs (list, more, opts) {
    opts = opts || {}
    var main = $('.lx-main')
    var head = opts.head || ''

    if (!list || !list.length) {
      main.innerHTML = head + '<div class="lx-empty"><p>' + esc(opts.emptyText || '没有找到歌曲') + '</p></div>'
      return
    }

    var html = list.map(function (s, i) {
      var q = (s.types && s.types.length) ? s.types[s.types.length - 1].type : ''
      return '<div class="lx-song" data-i="' + i + '" data-on="' + (state.index === i ? '1' : '0') + '" role="button" tabindex="0">' +
        '<span class="lx-song-no">' + (i + 1) + '</span>' +
        '<span class="lx-song-body">' +
          '<span class="lx-song-name">' + esc(s.name) + '</span>' +
          '<span class="lx-song-singer">' + esc(s.singer || '未知歌手') + '</span>' +
        '</span>' +
        (q ? '<span class="lx-song-badge">' + esc(q) + '</span>' : '') +
        (favOn() ? '<button class="lx-song-fav" type="button" data-fav="' + (isFav(s) ? '1' : '0') +
          '" title="喜欢" aria-label="喜欢">' + ICON.heartLine + ICON.heartFill + '</button>' : '') +
        // 播放图标与转圈共用这一个固定宽度的槽位，靠 visibility 切换。
        // ★ 不能用 display 切换：那样 hover 时图标一出现就会把左边的爱心挤走，
        //   鼠标「按下」和「抬起」之间爱心已经移位 —— 浏览器会把这次 click 判给
        //   两者的共同祖先（整行），表现为「点爱心却开始播放」。
        '<span class="lx-song-act">' +
          '<span class="lx-song-pick">' + ICON.play + '</span>' +
          '<span class="lx-song-spin">' + ICON.spin + '</span>' +
        '</span>' +
      '</div>'
    }).join('')

    if (more) {
      html += '<button class="lx-more" type="button">加载更多</button>'
    }

    main.innerHTML = head + html

    $$('.lx-song').forEach(function (row) {
      var go = function (e) {
        // 点的是行内那颗爱心：只收藏，不能顺带把歌也播了
        if (e && e.target && e.target.closest && e.target.closest('.lx-song-fav')) return
        playIndex(parseInt(row.getAttribute('data-i'), 10))
      }
      row.addEventListener('click', go)
      row.addEventListener('keydown', function (e) {
        if (e.target && e.target.closest && e.target.closest('.lx-song-fav')) return
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go() }
      })
    })

    // 行内爱心单独绑：绑定与渲染同源，重绘出来的新行自然不会漏
    $$('.lx-song-fav').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation()
        var i = parseInt(b.parentNode.getAttribute('data-i'), 10)
        applyFav(list[i], b)
      })
      b.addEventListener('keydown', function (e) {
        // 爱心在行内，空格/回车默认会被行监听器当成「播放」，这里拦掉
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); b.click() }
      })
    })

    var moreBtn = $('.lx-more')
    if (moreBtn) moreBtn.addEventListener('click', loadMoreSearch)
  }

  // 收藏状态变动的**唯一入口**：行内按钮、播放条按钮、正在看的列表三处一起同步
  function applyFav (song, btn) {
    if (!song || !songKey(song)) return
    var now = toggleFav(song)
    if (btn) btn.setAttribute('data-fav', now ? '1' : '0')
    syncBarFav()
    toast(now ? '已加入「我喜欢」' : '已取消喜欢', 'ok')
    // 正在看「我的」：列表内容本身就变了，就地重绘（保持滚动位置）
    if (state.view === 'mine') redrawKeepingScroll(function () { renderMine() })
  }

  // 播放条那颗爱心跟着当前歌曲走（没选歌时置灰不可用）
  function syncBarFav () {
    if (!favOn()) return
    var b = $('.lx-bar-fav')
    if (!b) return
    b.setAttribute('data-on', isFav(state.song) ? '1' : '0')
    b.disabled = !state.song
  }

  function renderBoards (list) {
    var main = $('.lx-main')
    var items = (list || []).filter(function (b) { return b && b.bangid })
    if (!items.length) { empty('榜单列表是空的'); return }

    main.innerHTML = items.map(function (b) {
      return '<div class="lx-entry" data-id="' + esc(b.bangid) + '" role="button" tabindex="0">' +
        '<span class="lx-entry-name">' + esc(b.name) + '</span>' +
        '<span class="lx-entry-go">' + ICON.chevronRight + '</span>' +
      '</div>'
    }).join('')

    $$('.lx-entry').forEach(function (row) {
      var go = function () { openBoard(row.getAttribute('data-id'), row.querySelector('.lx-entry-name').textContent) }
      row.addEventListener('click', go)
      row.addEventListener('keydown', function (e) { if (e.key === 'Enter') go() })
    })
  }

  function renderPlaylists (list) {
    var main = $('.lx-main')
    if (!list || !list.length) { empty('歌单列表是空的'); return }

    main.innerHTML = '<div class="lx-grid">' + list.map(function (p, i) {
      var id = p.id || p.dissid || p.songListId || ''
      var cover = p.img || p.picUrl || p.cover || ''
      return '<div class="lx-card" data-i="' + i + '" data-id="' + esc(id) + '" role="button" tabindex="0">' +
        '<div class="lx-card-pic" ' + (cover ? 'style="background-image:url(\'' + esc(cover) + '\')"' : '') + '></div>' +
        '<div class="lx-card-name">' + esc(p.name || p.title || '未命名歌单') + '</div>' +
      '</div>'
    }).join('') + '</div>'

    $$('.lx-card').forEach(function (card) {
      var go = function () {
        var i = parseInt(card.getAttribute('data-i'), 10)
        openPlaylist(card.getAttribute('data-id'), list[i])
      }
      card.addEventListener('click', go)
      card.addEventListener('keydown', function (e) { if (e.key === 'Enter') go() })
    })
  }

  function setCrumb (text) {
    var crumb = $('.lx-crumb')
    if (!text) { crumb.hidden = true; $('.lx-crumb-text').textContent = '' }
    else { crumb.hidden = false; $('.lx-crumb-text').textContent = text }
    syncQueueBtn()
  }

  // 「播放列表」按钮的亮灭跟着 state.view 走。
  // 挂在 setCrumb 末尾是因为**每一次换视图都会调它**（含 setCrumb('')）——
  // 一处覆盖全部入口，不必去每个 loader 里各加一行、更不会漏。
  function syncQueueBtn () {
    var b = $('.lx-queue-toggle')
    if (b) b.setAttribute('data-on', state.view === 'queue' ? '1' : '0')
  }

  // 后台刷新回来的重绘：.lx-main 就是滚动容器，innerHTML 一重建滚动位置就归零 ——
  // 无论内容变没变都必须放回去，否则用户正挑歌时会被弹回列表顶部。
  function redrawKeepingScroll (render) {
    var main = $('.lx-main')
    if (!main) { render(); return }
    var top = main.scrollTop
    render()
    if (main.scrollTop !== top) main.scrollTop = top
  }

  // 后台刷新把列表换成了新对象，让「正在播放」的高亮跟着歌曲走，而不是死守原来的下标
  function resyncIndex (list) {
    if (!state.song || state.index < 0) return
    var mid = state.song.songmid
    var at = -1
    for (var i = 0; i < list.length; i++) {
      var s = list[i]
      if (s && (s === state.song || (mid && s.songmid === mid))) { at = i; break }
    }
    if (at >= 0) { state.song = list[at]; state.index = at } else { state.index = -1 }
  }

  function showSearchPane (on) {
    var pane = $('.lx-pane[data-pane="search"]')
    if (pane) pane.hidden = !on
  }

  /* ==========================================================
   * 数据流
   * ========================================================== */
  function loadHot () {
    var paint = function (words) {
      var box = $('.lx-hot')
      if (!words.length) { box.hidden = true; return }
      box.hidden = false
      box.innerHTML = words.slice(0, 8).map(function (w) {
        return '<button class="lx-chip" type="button" data-w="' + esc(w) + '">' + esc(w) + '</button>'
      }).join('')
      $$('.lx-chip').forEach(function (chip) {
        chip.addEventListener('click', function () {
          var w = chip.getAttribute('data-w')
          $('.lx-input').value = w
          doSearch(w)
        })
      })
    }
    fetchCached('hot', '/api/hot-search', null, function (res) {
      return (res.data && res.data.list) || []
    }, paint).catch(function () {
      var box = $('.lx-hot')
      if (box) box.hidden = true
    })
  }

  function doSearch (kw, append) {
    if (!kw) return
    if (!append) {
      state.searchPage = 1
      state.searchKeyword = kw
      state.view = 'list'
      state.trail = []
      state.src = '搜索：' + kw
      setCrumb('')
    }
    var token = ++state.nav
    var page = append ? state.searchPage + 1 : 1
    var moreBtn = append ? $('.lx-more') : null
    if (append && !moreBtn) return
    if (append) {
      moreBtn.disabled = true
      moreBtn.textContent = '正在加载更多歌曲…'
      moreBtn.setAttribute('aria-busy', 'true')
    } else setBusy(true, '正在搜索“' + kw + '”…')
    showSearchPane(true)

    var q = '/api/search?keyword=' + encodeURIComponent(kw) + '&page=' + page + '&limit=30'
    req(q).then(function (res) {
      if (token !== state.nav || state.tab !== 'search' || state.view !== 'list') return
      var d = res.data || {}
      var list = d.list || []
      state.songs = append ? state.songs.concat(list) : list
      state.searchPage = page
      state.searchTotal = d.total || state.songs.length
      renderSongs(state.songs, state.songs.length < state.searchTotal)
    }).catch(function (e) {
      if (token !== state.nav || state.tab !== 'search' || state.view !== 'list') return
      if (append) {
        moreBtn.disabled = false
        moreBtn.textContent = '加载更多'
        moreBtn.removeAttribute('aria-busy')
        toast('加载更多失败：' + friendly(e))
      } else empty(friendly(e), function () { doSearch(kw) })
    })
  }

  function loadMoreSearch () {
    if (!$('.lx-more') || $('.lx-more').disabled) return
    doSearch(state.searchKeyword, true)
  }

  function loadBoards () {
    state.view = 'boards'
    state.trail = []
    setCrumb('')
    showSearchPane(false)
    var token = ++state.nav
    // 只有在「一点缓存都没有」时才显示骨架屏 —— 有缓存（哪怕过期）就同步渲染，不给它闪的机会
    if (CFG.cache === false || !cacheGet('boards')) setBusy(true, '正在加载榜单…')
    fetchCached('boards', '/api/leaderboard', null, function (res) {
      return (res.data && res.data.list) || []
    }, function (items, meta) {
      if (token !== state.nav) return       // 期间用户已经切走了，别拿迟到响应覆盖当前画面
      if (meta.refresh) redrawKeepingScroll(function () { renderBoards(items) })
      else renderBoards(items)
    }).catch(function (e) {
      if (token === state.nav) empty(friendly(e), loadBoards)
    })
  }

  function openBoard (bangid, name) {
    state.view = 'list'
    state.trail = [{ type: 'boards', label: name }]
    state.src = name
    setCrumb(name)
    var token = ++state.nav
    var key = 'board:' + bangid + ':1'
    if (CFG.cache === false || !cacheGet(key)) setBusy(true, '正在加载榜单歌曲…')
    fetchCached(key, '/api/leaderboard/list?bangid=' + encodeURIComponent(bangid) + '&page=1', null,
      function (res) { return (res.data && res.data.list) || [] },
      function (songs, meta) {
        if (token !== state.nav) return
        // ★ 渲染与 state.songs 必须同源：点歌是按下标取 state.songs[i] 的，
        //   只把 DOM 画出来而不给数据，点下去会播成另一首
        if (meta.refresh) resyncIndex(songs)
        state.songs = songs
        if (meta.refresh) redrawKeepingScroll(function () { renderSongs(songs, false) })
        else renderSongs(songs, false)
      }
    ).catch(function (e) {
      if (token === state.nav) empty(friendly(e), function () { openBoard(bangid, name) })
    })
  }

  function loadPlaylists () {
    state.view = 'playlists'
    state.trail = []
    setCrumb('')
    showSearchPane(false)
    var token = ++state.nav
    if (CFG.cache === false || !cacheGet('playlists')) setBusy(true, '正在加载歌单…')
    fetchCached('playlists', '/api/songlist?sortId=-1&page=1', null, function (res) {
      var raw = (res.data && (res.data.list || res.data.info || res.data.data)) || []
      return Array.isArray(raw) ? raw : []
    }, function (items, meta) {
      if (token !== state.nav) return
      if (meta.refresh) redrawKeepingScroll(function () { renderPlaylists(items) })
      else renderPlaylists(items)
    }).catch(function (e) {
      if (token === state.nav) empty(friendly(e), loadPlaylists)
    })
  }

  function openPlaylist (id, info) {
    if (!id) { toast('这个歌单没有 id，接口数据里可能用的是别的字段名'); return }
    state.view = 'list'
    var label = (info && (info.name || info.title)) || '歌单'
    state.trail = [{ type: 'playlists', label: label }]
    state.src = label
    setCrumb(label)
    var token = ++state.nav
    var key = 'playlist:' + id + ':1'
    if (CFG.cache === false || !cacheGet(key)) setBusy(true, '正在加载歌单歌曲…')
    fetchCached(key, '/api/songlist/detail?id=' + encodeURIComponent(id) + '&page=1', null,
      function (res) {
        var d = res.data || {}
        return d.list || d.songs || d.tracks || []
      },
      function (songs, meta) {
        if (token !== state.nav) return
        if (meta.refresh) resyncIndex(songs)
        state.songs = songs
        if (meta.refresh) redrawKeepingScroll(function () { renderSongs(songs, false) })
        else renderSongs(songs, false)
      }
    ).catch(function (e) {
      if (token === state.nav) empty(friendly(e), function () { openPlaylist(id, info) })
    })
  }

  function goBack () {
    // 在「播放列表」里，返回 = 回到打开它之前的那个视图
    if (state.view === 'queue') { closeQueue(); return }
    var last = state.trail.pop()
    if (!last) return
    if (last.type === 'boards') loadBoards()
    else loadPlaylists()
  }

  /* ==========================================================
   * 当前播放列表（= 正在听的那一份 state.songs）
   * ----------------------------------------------------------
   * 纯本地渲染，一个请求都不发：数据本来就在内存里。
   * 解决的是「切走之后回不来」——在榜单点了第 3 首，又去搜索页翻了几屏，
   * 想回到榜单接着往下听，原来只能重新进榜（走网络 + 丢滚动位置）。
   * ========================================================== */
  function queueHeadHtml () {
    var n = state.songs.length
    return '<div class="lx-queue-head">' +
      '<span class="lx-queue-src">' + esc(state.src || '当前列表') + '</span>' +
      '<span class="lx-queue-num">' + n + ' 首' +
        (state.index >= 0 && state.index < n ? ' · 正在播第 ' + (state.index + 1) + ' 首' : '') +
      '</span>' +
    '</div>'
  }

  function renderQueue () {
    // ★ 与 renderSongs 同源：这里「看」的那一份就是「播」的那一份，点第 N 行就播第 N 首
    renderSongs(state.songs, false, {
      head: queueHeadHtml(),
      emptyText: '还没有歌曲 —— 先搜索或进榜单点一首，播放列表就有了'
    })
  }

  function openQueue () {
    // 再点一次 = 收起（按钮本身就是开关，符合直觉，也省一个关闭按钮）
    if (state.view === 'queue') { closeQueue(); return }
    var crumb = $('.lx-crumb')
    var pane = $('.lx-pane[data-pane="search"]')
    state.queueFrom = {
      view: state.view,
      mine: state.mine,
      trail: state.trail.slice(),
      src: state.src,
      crumb: crumb.hidden ? '' : $('.lx-crumb-text').textContent,
      searchPane: pane ? !pane.hidden : false,
      // 搜索结果可能还留着「加载更多」，返回时别把它弄丢
      more: state.songs.length < state.searchTotal
    }
    state.view = 'queue'
    // 作废在途请求的渲染权：否则榜单/歌单的迟到响应会把这份列表盖掉
    state.nav++
    showSearchPane(false)
    setCrumb('播放列表')
    renderQueue()
  }

  function closeQueue () {
    var f = state.queueFrom
    state.queueFrom = null
    if (!f) {   // 兜底：拿不到原位置就退回搜索结果
      state.nav++
      state.view = 'list'
      setCrumb('')
      showSearchPane(true)
      renderSongs(state.songs, false)
      return
    }
    // 榜单 / 歌单目录：交给各自的 loader 重画。缓存必然命中 ⇒ 不会发请求。
    if (f.view === 'boards') { loadBoards(); return }
    if (f.view === 'playlists') { loadPlaylists(); return }
    // 歌曲列表 / 我的：数据都在内存里（state.songs / lib），直接重画
    state.view = f.view
    state.mine = f.mine
    state.trail = f.trail
    state.src = f.src
    state.nav++
    showSearchPane(f.searchPane)
    setCrumb(f.crumb)
    if (f.view === 'mine') renderMine()
    else renderSongs(state.songs, f.more)
  }

  /* ==========================================================
   * 「我的」：我喜欢 / 最近播放（纯本地数据，不走接口、也不需要骨架屏）
   * ========================================================== */
  function loadMine () {
    state.view = 'mine'
    state.trail = []
    setCrumb('')
    showSearchPane(false)
    // 作废在途请求的渲染权：否则「榜单还没回来就切到我的」时，榜单会把这份列表盖掉
    state.nav++
    renderMine()
  }

  function mineHeadHtml () {
    var chips = [['fav', '我喜欢', lib.fav.length], ['recent', '最近播放', lib.recent.length]]
    var h = '<div class="lx-mine-head">'
    chips.forEach(function (c) {
      // 类名刻意不叫 .lx-chip —— 那个名字被「热搜词」按钮占着（见 loadHot），
      // 重名会让两边的样式与事件委托互相串。
      h += '<button class="lx-seg" type="button" data-mine="' + c[0] + '" data-on="' +
        (state.mine === c[0] ? '1' : '0') + '">' + c[1] +
        '<span class="lx-seg-num">' + c[2] + '</span></button>'
    })
    h += '<button class="lx-seg-clear" type="button" data-mine-clear="1" title="清空当前列表">' +
      ICON.close + '</button>'
    return h + '</div>'
  }

  function renderMine () {
    var list = lib[state.mine] || []
    // ★ 与 renderSongs 保持同源：点歌是按下标取 state.songs[i] 的，
    //   只把 DOM 画出来而不给数据，点下去会播成另一首
    state.songs = list
    state.src = state.mine === 'fav' ? '我喜欢' : '最近播放'
    resyncIndex(list)
    renderSongs(list, false, {
      head: mineHeadHtml(),
      emptyText: state.mine === 'fav'
        ? '还没有喜欢的歌 —— 在歌曲行或播放条上点一下爱心，就会收进这里'
        : '还没有播放记录 —— 听过的歌会自动出现在这里'
    })
  }

  function clearMine () {
    var label = state.mine === 'fav' ? '我喜欢' : '最近播放'
    if (!lib[state.mine].length) return
    if (!window.confirm('清空「' + label + '」？此操作不可恢复。')) return
    clearLib(state.mine)
    renderMine()
    toast('已清空「' + label + '」', 'ok')
  }

  function friendly (e) {
    var msg = (e && e.message) || ''
    if (e && e.kind === 'http') return '服务暂时不可用，请稍后重试。'
    if (e && e.kind === 'biz') return '当前内容暂不可用，请换一首或稍后重试。'
    if (e && e.name === 'AbortError') return '请求超时，请稍后重试。'
    if (/aborted|AbortError/i.test(msg)) return '请求超时，请稍后重试。'
    return '连接失败，请检查网络后重试。'
  }

  /* ==========================================================
   * 播放
   * ========================================================== */
  var QUALITY_RANK = { '128k': 1, '320k': 2, flac: 3, flac24bit: 4, hires: 4, atmos: 4, atmos_plus: 5, master: 5 }

  function rank (q) { return QUALITY_RANK[String(q || '').toLowerCase()] || 0 }

  function pickBest (types, pref) {
    if (!types || !types.length) return ''
    var names = types.map(function (t) { return t && t.type }).filter(Boolean)
    if (!names.length) return ''
    if (pref) {
      var hit = names.filter(function (n) { return String(n).toLowerCase() === String(pref).toLowerCase() })
      if (hit.length) return hit[0]
    }
    var limit = pref ? rank(pref) : 0
    var best = names[0]
    names.forEach(function (n) {
      if (rank(n) > rank(best)) best = n
    })
    if (limit) {
      var capped = names.filter(function (n) { return rank(n) > 0 && rank(n) <= limit })
      if (capped.length) {
        capped.sort(function (a, b) { return rank(b) - rank(a) })
        return capped[0]
      }
    }
    return best
  }

  function renderQuality (song, active) {
    var box = $('.lx-quality')
    var types = (song && song.types) || []
    if (!types.length) { box.hidden = true; box.innerHTML = ''; return }
    box.hidden = false
    box.innerHTML = types.map(function (t) {
      var name = (t && t.type) || ''
      return '<button class="lx-q" type="button" data-q="' + esc(name) + '"' +
        (name === active ? ' data-on="1"' : '') + '>' + esc(name) + '</button>'
    }).join('')
    $$('.lx-q').forEach(function (b) {
      b.addEventListener('click', function () { loadUrl(state.song, b.getAttribute('data-q')) })
    })
  }

  function playIndex (i) {
    var song = state.songs[i]
    if (!song) return
    state.index = i
    state.song = song

    $$('.lx-song').forEach(function (row) {
      var on = parseInt(row.getAttribute('data-i'), 10) === i
      row.setAttribute('data-on', on ? '1' : '0')
    })

    var cover = $('.lx-cover')
    // 先撤掉上一首的 onerror，再换地址；失败只回退一次，避免损坏地址反复触发。
    cover.onerror = null
    cover.src = song.img || DEFAULT_COVER
    if (song.img) cover.onerror = function () { cover.onerror = null; cover.src = DEFAULT_COVER }
    $('.lx-name').textContent = song.name || '未命名'
    $('.lx-name').setAttribute('title', song.name || '')
    $('.lx-singer').textContent = song.singer || ''
    syncBarFav()   // 播放条那颗爱心跟着这首歌走

    // 不在这里画音质按钮：loadUrl() 会带上实际选中的档位再画一次，避免先画后改的闪烁
    state.quality = pickBest(song.types, CFG.quality)
    loadLyric(song)
    loadUrl(song, state.quality)
    // 浮层头部的封面 / 歌名已经去掉，所以切歌不用再去同步它；
    // 但「还没选歌」那种空态得撤掉 —— 新歌的歌词正在路上。
  }

  function loadUrl (song, quality) {
    if (!song) return
    state.quality = quality
    renderQuality(song, quality)

    // 先作废旧请求，旧音源随后触发的事件不得撤掉新歌的加载态。
    var token = ++state.load
    // 切歌或切音质时立即停掉旧音源；新地址还在请求时不能继续播放上一首。
    audio.pause()
    audio.removeAttribute('src')
    audio.load()
    setPlaying(false)
    $('.lx-tcur').textContent = '00:00'
    $('.lx-tdur').textContent = '00:00'
    $('.lx-fill').style.width = '0%'
    $('.lx-knob').style.left = '0%'

    // 取链期间先给反馈。这一步正常 1~3s，接口故障时能拖到十几秒（前端 timeout 15s），
    // 全程界面毫无变化的话，用户只会认定「点了没反应 / 卡死了」。
    setSongLoading(state.index)

    req('/api/play-url', { method: 'POST', body: { songInfo: song, quality: quality } })
      .then(function (res) {
        // 已经切到别的歌 ⇒ 这份响应作废（加载态归新歌管，别去清它的）
        if (token !== state.load) return
        var url = res.data && res.data.url
        if (!url) throw ApiError('接口没返回播放链接（可能是该音质不可用或版权受限）')
        // 到这里还不能撤加载态：地址拿到 ≠ 能出声，音频还要缓冲。
        // 统一等 audio 的 playing / canplay 事件来撤（见 bindAudio）。
        audio.src = url
        audio.volume = currentVolume()
        var p = audio.play()
        if (p && p.catch) p.catch(function (e) {
          if (token !== state.load) return
          clearSongLoading()
          toast('播放未能启动，请点击播放重试。')
        })
      })
      .catch(function (e) {
        if (token !== state.load) return
        clearSongLoading()   // 失败也必须撤，否则那个圈会一直转下去
        toast(friendly(e))
      })
  }

  function loadLyric (song) {
    if (CFG.lyric === false) return   // 关掉歌词就别再发这个请求了
    var seq = ++state.lyricSeq
    lrcStatus('歌词加载中…', 'loading')

    // 网络抖动 / 偶发超时最多再试 2 次；业务错误（code≠0）重试也没用，直接报
    var fetchLyric = function (left) {
      req('/api/lyric', { method: 'POST', body: { songInfo: song } })
        .then(function (res) {
          // 已经切到别的歌 ⇒ 这份歌词作废（否则新歌那几句会被上一首的残句盖掉）
          if (seq !== state.lyricSeq) return
          try {
            var d = res.data || {}
            var merged = mergeLyric(d.lyric, d.tlyric)
            if (!merged.length) { lrcStatus('这首歌暂无歌词', 'empty'); return }
            // 逐字时间点不一定与普通歌词的字符一一对应；不匹配的行按句均摊。
            var lx = parseLx(d.lxlyric)
            merged.forEach(function (l) {
              var w = lx[l.t.toFixed(2)]
              if (w && w.length === Array.from(l.text).length) l.words = w
            })
            state.lyric = merged
            state.lyricIdx = -1
            rebuildLrcWords()
            renderLyricLines()
          } catch (err) {
            console.error('歌词渲染失败', err)
            lrcStatus('歌词显示失败', 'fail')
          }
        }, function (err) {
          if (seq !== state.lyricSeq) return
          if (left > 0 && (!err || err.kind !== 'biz')) return fetchLyric(left - 1)
          lrcStatus('歌词获取失败', 'fail')
        })
    }
    fetchLyric(2)
  }

  // LRC → [{t, text, trans}]，按时间排序；trans 与 lyric 同时刻的合并到一行
  function mergeLyric (lyric, tlyric) {
    var parse = function (raw) {
      var map = {}
      String(raw || '').split('\n').forEach(function (line) {
        var text = line.replace(/\[[^\]]*\]/g, '').trim()
        var re = /\[(\d+):(\d+)(?:[.:](\d+))?\]/g
        var m
        while ((m = re.exec(line)) !== null) {
          var frac = m[3] ? Number('0.' + m[3]) : 0
          var t = parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + frac
          map[t.toFixed(2)] = text
        }
      })
      return map
    }

    var main = parse(lyric)
    var trans = parse(tlyric)
    var keys = Object.keys(main)
    if (!keys.length) return []

    return keys.sort(function (a, b) { return Number(a) - Number(b) }).map(function (k) {
      return { t: Number(k), text: main[k], trans: trans[k] || '' }
    }).filter(function (l) { return l.text })
  }

  /* lxlyric（逐字歌词）→ { '行起点秒': [{t, d, text}] }。
     实测格式（lx-music-api 的真实回包）：
       [00:12.340]<0,160>晴<160,160>天<320,160> <480,160>...
     行头 [mm:ss.mmm] 是行起点；内容里 <起点,时长> 的偏移是**相对行起点**的毫秒。
     两个标签之间可能有裸文本（空格、或末尾没打标签的尾巴，如 "...俊<1926,321>Again"）：
     空格并进前一个字（跟着它一起变色），行首裸文本没时间可挂、丢弃。 */
  function parseLx (raw) {
    var out = {}
    String(raw || '').split('\n').forEach(function (line) {
      var head = /\[(\d+):(\d+)(?:[.:](\d+))?\]/.exec(line)
      if (!head) return
      var frac = head[3] ? Number('0.' + head[3]) : 0
      var base = parseInt(head[1], 10) * 60 + parseInt(head[2], 10) + frac
      var body = line.replace(/\[[^\]]*\]/g, '')
      var words = []
      var re = /<(\d+),(\d+)>/g
      var lastEnd = 0
      var m
      while ((m = re.exec(body)) !== null) {
        var pre = body.slice(lastEnd, m.index)
        if (pre && words.length) words[words.length - 1].text += pre
        words.push({
          t: base + Number(m[1]) / 1000,
          d: Number(m[2]) / 1000,
          text: ''
        })
        lastEnd = re.lastIndex
      }
      var tail = body.slice(lastEnd)
      if (tail && words.length) words[words.length - 1].text += tail
      if (words.length) out[base.toFixed(2)] = words
    })
    return out
  }

  // cur = 当前播放秒数；force = true 时即使下标没变也重算并重新滚动。
  // 打开浮层时必须 force —— 藏起来那段时间 timeupdate 早就把 state.lyricIdx 更新过了，
  // 不 force 的话这里会直接 return，浮层停在顶部、当前行落在可视区外，看着就像「没高亮」。
  //
  // ★ 性能：这里原本每次调用都要「querySelectorAll 全部行 + 给全部行写 data-on」，
  //   两个容器（浮层 + 内嵌页）各来一遍。一首 4 分钟的歌约 60~100 行，
  //   而每次真正变化的只有「上一行熄灭、当前行点亮」这两行 ——
  //   其余 98 行的 data-on 写进去的值和原来一模一样，纯属白写。
  //   本函数由 timeupdate（~4Hz）与换行路径反复调用，累积起来很可观。
  //
  //   改法：只记住「上一次点亮的是哪个**元素**」，每次只熄灭它、点亮新的那行。
  //   注意这里比对的是**元素引用**而不是下标 —— 元素引用天然覆盖了
  //   「歌词被重建（切歌/换行重排）后旧引用失效」的情况：那时 prevEl 不再
  //   是当前 DOM 里的节点，比对不上就会自然退回全量刷新，不需要额外的状态位。
  //
  // ★ 查找 idx 不再从 0 开始扫：歌词时间单调递增，从上次的 state.lyricIdx
  //   继续往后走即可，播到第 3 分钟时不必每次重扫前 75 行。
  //   但 seek / 切歌会让时间**倒退**，所以倒退时回退到全量扫描兜底
  //   —— 单调推进只是快路径，正确性仍由全量扫描保证。
  var lrcActiveEl = null      // 浮层里当前被点亮的那一行元素（null = 还没点亮过）
  var pageActiveEl = null     // 内嵌页里同理

  // 找出 cur 对应的歌词下标。hint 是上次的下标，用作单调推进的起点。
  function findLyricIdx (cur, hint) {
    var t = state.lyric
    var n = t.length
    var i
    if (hint >= 0 && hint < n && t[hint].t <= cur + 0.15) {
      // 快路径：时间只可能前进，从 hint 往后找，找到第一个「未来」的行即停
      i = hint
      while (i + 1 < n && cur + 0.15 >= t[i + 1].t) i++
      return i
    }
    // 慢路径：hint 不可用（首次 / seek 倒退 / 切歌），全量扫描
    var idx = -1
    for (i = 0; i < n; i++) {
      if (cur + 0.15 >= t[i].t) idx = i
      else break
    }
    return idx
  }

  // 把一个歌词容器的高亮从 prevEl 切到目标行。
  //   · 目标行与 prevEl 相同 ⇒ 什么都不用做（最常见的「重复调用」情况）
  //   · prevEl 仍在容器内   ⇒ 只熄灭它（热路径，O(1)）
  //   · 否则（首次 / force / 容器被重建）⇒ 全量刷一遍兜底
  // force 为真时强制走全量，保证「刚打开浮层」这种状态不确定的时刻一定正确。
  function highlightLine (container, prevEl, idx, force) {
    var lines = container.querySelectorAll('.lx-lrc-line')
    var target = lines[idx] || null
    if (!target) return prevEl

    if (target === prevEl && !force) return prevEl

    if (force || !prevEl || prevEl.parentNode !== container) {
      for (var j = 0; j < lines.length; j++) {
        var want = j === idx ? '1' : '0'
        if (lines[j].getAttribute('data-on') !== want) lines[j].setAttribute('data-on', want)
      }
    } else {
      if (prevEl.getAttribute('data-on') !== '0') prevEl.setAttribute('data-on', '0')
      if (target.getAttribute('data-on') !== '1') target.setAttribute('data-on', '1')
    }
    return target
  }

  function syncLyric (cur, force) {
    if (!state.lyric.length) return
    var idx = findLyricIdx(cur, force ? -2 : state.lyricIdx)
    if (idx === state.lyricIdx && !force) return
    state.lyricIdx = idx

    // 单行条形态只显示这一句（多行窗形态下它被 CSS 藏着，写在这里不影响）
    var curLine = state.lyric[idx]
    setLrcOne(curLine ? curLine.text : '', curLine ? curLine.trans : '', idx)

    var roll = $('.lx-lrc-roll')
    if (roll) {
      lrcActiveEl = highlightLine(roll, lrcActiveEl, idx, !!force)
      if (lrcActiveEl && lrcIsOpen()) lrcScrollTo(lrcActiveEl, !!force)
    } else {
      lrcActiveEl = null
    }

    var pageRoll = $('.lx-page-lyrics-roll')
    if (pageRoll) {
      pageActiveEl = highlightLine(pageRoll, pageActiveEl, idx, !!force)
      if (pageActiveEl && isEmbed()) {
        var box = $('.lx-page-lyrics-lines')
        var top = pageActiveEl.offsetTop - (box.clientHeight - pageActiveEl.offsetHeight) / 2
        if (force || lrcReduce) box.scrollTop = top
        else box.scrollTo({ top: top, behavior: 'smooth' })
      }
    } else {
      pageActiveEl = null
    }
  }

  /* ---- 卡拉OK 逐字染色 ----
     一行文字拆成逐字 <i class="lx-ch">，已唱到的字打 data-on="1"，CSS 给它换填充色。
     刻意不走 background-clip + 渐变裁剪：那种写法要按横排/竖排分别算渐变方向，
     逐字上色与书写方向无关，横竖两套排版共用同一份规则。
     逐字时间轴三来源（按优先级，见 rebuildLrcWords）：
       1. 接口的 lxlyric（真实逐字，loadLyric 里解析好挂到 line.words）
       2. 都没有 ⇒ buildCharTimes 按「本句时长 = 下一句起点 − 本句起点」把时间均摊到每个字
     渲染节奏：一条 rAF 循环，只在「浮层打开 && 正在播放 && 有歌词」时跑；
     每帧只翻转跨过时间点的那几个字（游标推进，O(1)），不整行重设。 */
  // ★ 先切字再 esc 的顺序不能反：esc 之后的 &amp; 是 5 个「字符」，按它拆字会把实体拆碎。
  //   Array.from 是按码点切，emoji / 生僻字不会被拆成半个。
  function buildCharTimes (idx) {
    var l = state.lyric[idx]
    if (!l || !l.text) return null
    var chars = Array.from(l.text)
    var next = state.lyric[idx + 1]
    var start = l.t
    var end = next ? next.t : start + Math.max(3, chars.length * 0.25)
    var span = Math.max(0.4, end - start)
    var per = span / chars.length
    return chars.map(function (c, i) { return start + per * i })
  }

  // 每行的逐字时间点表（与 state.lyric 同下标）。有 lxlyric 用真的，没有且开着逐字就均摊，
  // 关着逐字就是 null —— lineHtml 按 null 决定要不要拆 <i>。
  function rebuildLrcWords () {
    if (!state.lyric.length) { state.lrcWords = []; return }
    state.lrcWords = state.lyric.map(function (l, i) {
      if (l.words && l.words.length) return l.words.map(function (w) { return w.t })
      return lrcStyle.karaoke ? buildCharTimes(i) : null
    })
  }

  function lineHtml (l, i) {
    var times = state.lrcWords ? state.lrcWords[i] : null
    var inner = times
      ? Array.from(l.text).map(function (c, j) {
          return '<i class="lx-ch" data-t="' + times[j].toFixed(3) + '">' + esc(c) + '</i>'
        }).join('')
      : esc(l.text)
    return '<div class="lx-lrc-line" data-i="' + i + '" title="点一下跳到这一句">' +
      '<span class="lx-lyric-text">' + inner + '</span>' +
      (l.trans ? '<span class="lx-lyric-trans">' + esc(l.trans) + '</span>' : '') +
    '</div>'
  }

  // 歌词列表的（重）渲染。切换逐字开关时也要走这里 —— DOM 里得真的有 <i class="lx-ch">
  // 才有东西可点亮，光改 CSS 变量救不了「根本没拆字」的那些行。
  function renderLyricLines () {
    var roll = $('.lx-lrc-roll')
    if (!roll || !state.lyric.length) return
    roll.innerHTML = state.lyric.map(lineHtml).join('')
    var pageRoll = $('.lx-page-lyrics-roll')
    if (pageRoll) pageRoll.innerHTML = roll.innerHTML
    lrcKaraoke = { line: -1, n: 0, els: null }   // 游标跟着作废
    pageKaraoke = { line: -1, n: 0, els: null }
    lrcInvalidate()                               // 内容尺寸变了，滚动位移重算（会连 transform 一起清）
    syncLyric(audio.currentTime || 0, true)
    if (lrcIsOpen()) lrcPlace()
    lrcKick()
  }

  var lrcKaraoke = { line: -1, n: 0, els: null }
  var pageKaraoke = { line: -1, n: 0, els: null }
  // 单行条（.lx-lrc-one-text）的逐字游标，与上面两个多行窗的游标同构。
  // 它也必须记「上一帧写到第几个字」，否则每帧全量重写（见 tickKaraoke 的说明）。
  // ⚠️ 用 first（首字元素引用）而不是 NodeList 来识别「本行是否被重建」，
  //    原因见 tickKaraoke 里的注释：NodeList 每次都是新对象，比较它恒为真。
  var oneKaraoke = { line: -1, n: 0, first: null }
  var lrcRafId = 0

  // 把当前行已唱到的字点亮 / 未唱的字熄灭。游标只前进或回退跨过的那一段。
  function tickKaraokeRoll (roll, cursor) {
    if (!roll) return cursor
    var idx = state.lyricIdx
    if (cursor.line !== idx) {
      if (cursor.els) {
        for (var k = 0; k < cursor.els.length; k++) cursor.els[k].setAttribute('data-on', '0')
      }
      var line = roll.children[idx]
      cursor = { line: idx, n: 0, els: line ? line.querySelectorAll('.lx-ch') : null }
    }
    var els = cursor.els
    if (!els || !els.length) return cursor
    var times = state.lrcWords[idx]
    var cur = audio.currentTime || 0
    var n = 0
    while (n < els.length && cur >= times[n]) n++
    if (n === cursor.n) return cursor
    var from = Math.min(n, cursor.n)
    var to = Math.max(n, cursor.n)
    var on = n > cursor.n
    for (var i = from; i < to; i++) els[i].setAttribute('data-on', on ? '1' : '0')
    cursor.n = n
    return cursor
  }

  function tickKaraoke () {
    if (!lrcStyle.karaoke) return
    var idx = state.lyricIdx
    if (idx < 0 || !state.lrcWords || !state.lrcWords[idx]) return

    if (lrcIsOpen()) {
      lrcKaraoke = tickKaraokeRoll($('.lx-lrc-roll'), lrcKaraoke)

      /* 单行条：与上面多行窗同一套「游标推进」策略。
       *
       * ★ 这里原本是**每帧无条件全量重写**：
       *     for (var oi = 0; oi < oneChars.length; oi++)
       *       oneChars[oi].setAttribute('data-on', now >= oneTimes[oi] ? '1' : '0')
       *   没有「值没变就跳过」的判断。而本函数由 requestAnimationFrame
       *   以 ~60fps 驱动，于是一行 20 个字 → 每秒 1200 次 setAttribute，
       *   其中绝大多数是重复写入同一个值。
       *
       *   为什么这种冗余写特别贵：.lx-ch[data-on='1'] 不只改 color，
       *   还改 text-shadow（双层光晕，见 lx-music.css 第 806 行），
       *   而 text-shadow 属于绘制属性，改动要重新栅格化字形；
       *   再加上 CSS 里那两条 .12s 的 color/text-shadow 过渡，
       *   浏览器每帧都在做样式重算 + 光晕重绘。
       *   表现就是「刚播放还行、播一会儿 CPU 就爬上去」——
       *   持续的重绘把渲染线程压满载了。
       *
       *   修法与多行窗完全一致：先算出「已唱到第几个字」n，
       *   和上一帧的 n 相同就什么都不做（O(1) 提前返回）；
       *   不同才只翻转 from..to 这一段。换行时重置游标。 */
      var one = $('.lx-lrc-one-text')
      var oneChars = one ? one.querySelectorAll('.lx-ch') : []
      var oneTimes = state.lrcWords[idx]
      if (oneChars.length && oneTimes) {
        /* ⚠️ 判定「本行是不是换了一批新节点」必须用**首元素的引用**比较，
         *    不能用 oneChars 本身 —— querySelectorAll 每次调用都返回一个
         *    全新的 NodeList 对象，`oneKaraoke.els !== oneChars` 会**恒为真**，
         *    于是每帧都把游标重置成 n:0，守卫形同虚设。
         *    setLrcOne() 是用 innerHTML 重建这一行的（换行、force 同步时都会），
         *    重建后首元素是新的引用，用它比较才准。 */
        var firstChar = oneChars[0]
        if (oneKaraoke.line !== idx || oneKaraoke.first !== firstChar) {
          oneKaraoke = { line: idx, n: 0, first: firstChar }
        }
        var now = audio.currentTime || 0
        var n = 0
        while (n < oneChars.length && now >= oneTimes[n]) n++
        if (n !== oneKaraoke.n) {
          var from = Math.min(n, oneKaraoke.n)
          var to = Math.max(n, oneKaraoke.n)
          var on = n > oneKaraoke.n
          for (var oi = from; oi < to; oi++) oneChars[oi].setAttribute('data-on', on ? '1' : '0')
          oneKaraoke.n = n
        }
      }
    }

    if (isEmbed()) pageKaraoke = tickKaraokeRoll($('.lx-page-lyrics-roll'), pageKaraoke)
  }

  function lrcTick () {
    lrcRafId = 0
    if ((!lrcIsOpen() && !isEmbed()) || audio.paused) return
    tickKaraoke()
    lrcRafId = requestAnimationFrame(lrcTick)
  }

  // 循环的点火器：打开浮层 / 开始播放时调；暂停或关闭后循环下一帧自己退出。
  function lrcKick () {
    if (!lrcRafId && (lrcIsOpen() || isEmbed()) && !audio.paused) lrcRafId = requestAnimationFrame(lrcTick)
  }

  /* ==========================================================
   * 歌词浮层（独立于面板，不再占面板一寸空间）
   * ==========================================================
   * 为什么不做在面板里：面板高度有限（max-height 620px），歌词占固定 172px 就等于把歌曲列表
   * 挤掉三成；而面板内只能给 12.5px 小字居中排，观感像在面板里贴了张纸条。
   * 拎出来之后：面板回归纯列表，歌词拿到完整高度，并且可以自由拖动（不像贴边挡板那样只能贴两沿）。
   *
   * 两种形态共用一份 DOM，靠 [data-mode] 切（样式见 lx-music.css「歌词浮层」一节）：
   *   window 多行窗：只有歌词列表（当前行高亮放大）
   *   bar    单行条：当前句 + 翻译，只占一条 40px 的边，读文章时也能看词
   * 默认透明、只留文字，文字自带光晕，所以压在文章正文上也读得清（lyric_bg: card 可退回卡片底）。
   * 形态、位置、样式都记在 localStorage（受 remember 开关控制）。
   * ========================================================== */
  var lrcMode = CFG.lyric_mode === 'bar' ? 'bar' : 'window'
  var lrcPos = { window: null, bar: null }
  var lrcLocked = false
  var lrcJustDragged = false

  /* ---- 歌词样式（访客可在齿轮里改，改完存本地）----
     约定：空串 = 「跟随主题」，交给 CSS 里的兜底变量；判断与派生全部收在 applyLrcStyle()。
     写样式走 CSS 变量 + data-* 属性，和 lrcPlace() 写 --lx-lrc-x/-y 是同一个范式：
     改样式零重绘，既不用重建歌词列表，也不会丢滚动位置。 */
  var LRC_STYLE_KEYS = ['bg', 'dir', 'size', 'font', 'color', 'on', 'fill', 'karaoke']
  // 主题是当前样式的基底；后续自定义只改对应字段，不会退出主题或丢失主题底色。
  // 新访客默认使用清透主题；用户一旦在浮板里选择或自定义，仍以本地记忆为准。
  var lrcTheme = 'clear'

  function lrcHexCss (v) {
    var s = String(v == null ? '' : v).trim()
    return /^#[0-9a-fA-F]{3,8}$/.test(s) ? s : ''
  }

  function defaultLrcStyle () {
    return {
      bg: CFG.lyric_bg === 'card' ? 'card' : 'transparent',
      dir: CFG.lyric_dir === 'vertical' ? 'vertical' : 'horizontal',
      size: Math.min(30, Math.max(12, Math.round(Number(CFG.lyric_size) || 16))),
      font: LRC_FONT_KEYS.indexOf(String(CFG.lyric_font || '')) >= 0 && CFG.lyric_font ? String(CFG.lyric_font) : 'hei',
      color: lrcHexCss(CFG.lyric_color) || '#e2e8f0',
      on: lrcHexCss(CFG.lyric_on) || '#ffffff',
      fill: lrcHexCss(CFG.lyric_fill) || '#62d5ce',
      karaoke: CFG.lyric_karaoke !== false
    }
  }

  // 本地读回来的样式：逐键兜底 —— 只认白名单里的键，值不合法就退回默认。
  // 旧版本存的那份 JSON 里压根没有 style 字段，走这里等于"保持默认"，不会把老数据读坏。
  function lrcStyleFrom (raw) {
    var out = defaultLrcStyle()
    if (!raw || typeof raw !== 'object') return out
    LRC_STYLE_KEYS.forEach(function (k) {
      var v = raw[k]
      if (v === undefined || v === null) return
      if (k === 'bg') out.bg = v === 'card' ? 'card' : 'transparent'
      else if (k === 'dir') out.dir = v === 'vertical' ? 'vertical' : 'horizontal'
      else if (k === 'karaoke') out.karaoke = v !== false
      else if (k === 'size') {
        var n = Number(v)
        if (isFinite(n)) out.size = Math.min(30, Math.max(12, Math.round(n)))
      } else if (k === 'font') out.font = LRC_FONT_KEYS.indexOf(String(v)) >= 0 ? String(v) : ''
      else out[k] = lrcHexCss(v)
    })
    return out
  }

  var lrcStyle = defaultLrcStyle()

  // 读一个主题 CSS 变量的实际值。
  // ★ 必须从 #lx-music（elRoot）上读：--lx-dim / --lx-accent 都定义在那个根节点上，
  //   从 documentElement 读会读到空串（自定义属性只向下继承，不向上找）。
  function themeVar (name, fallback) {
    var el = elRoot || document.documentElement
    var v = ''
    try { v = getComputedStyle(el).getPropertyValue(name) || '' } catch (e) { v = '' }
    return v.trim() || fallback || ''
  }

  // 颜色 → [r,g,b]；只认 hex 与 rgb()/rgba()，解析不出来返回 null
  function lrcRgb (v) {
    var s = String(v || '').trim()
    var m = /^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(s)
    if (m) {
      var h = m[1]
      if (h.length <= 4) h = h.split('').map(function (c) { return c + c }).join('')
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
    }
    var r = /^rgba?\(([^)]+)\)$/i.exec(s)
    if (r) {
      var p = r[1].split(/[,\s/]+/).filter(function (x) { return x !== '' })
      var n = [parseFloat(p[0]), parseFloat(p[1]), parseFloat(p[2])]
      if (n.every(function (x) { return isFinite(x) })) return n
    }
    return null
  }

  /* 文字光晕：亮字配深色光晕、暗字配浅色光晕。
     ★ 这件事只能在这里算 —— CSS 没法对变量做「字亮就配深光晕」这种条件判断。
     解析不出颜色时给一个中性兜底，保证任何配色下文字都有边界。 */
  function lrcHalo (color, fallbackColor) {
    var rgb = lrcRgb(color) || lrcRgb(fallbackColor)
    if (!rgb) return 'rgba(0, 0, 0, .55)'
    var lum = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255
    return lum > 0.6 ? 'rgba(0, 0, 0, .75)' : 'rgba(255, 255, 255, .9)'
  }

  function lrcSetVar (el, name, val) {
    // 空值 = 跟随主题：把变量删掉，让 CSS 里的兜底值生效（写成空串反而会覆盖掉兜底）
    if (val) el.style.setProperty(name, val)
    else el.style.removeProperty(name)
  }

  /* 尺寸 / 内容变了 ⇒ 滚动位移作废。
     ★ 必须连已应用的 transform 一起清掉，只置 lrcOffset = -1 是错的：
       lrcScrollTo 的算式是「增量式」的 —— dpos 量的是「目标行相对容器的当前偏移」，
       再累加到 lrcOffset 上。只把 lrcOffset 置 -1 却留着旧 transform，
       下一次就变成「在旧位移之上再叠一次」，实测表现为歌词猛地弹回第一句。
       清掉 transform 后容器回到零位移，pos(0) + dpos 才是正确的绝对位置。
     ★ 清 transform 前先禁用过渡，否则会看到一段很明显的滑动。 */
  function lrcInvalidate () {
    var roll = $('.lx-lrc-roll')
    if (roll) {
      roll.style.transition = 'none'
      roll.style.transform = ''
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(function () { roll.style.transition = '' })
      }
    }
    lrcOffset = -1
  }

  // 只有这几档会动「几何」：字号 → 行高，字体 → 字宽与行高，方向 → 整套排布。
  //   背景 / 三档颜色 / 逐字开关都不改布局 —— 改它们时绝不能去碰滚动位移：
  //   一旦作废就必须重算，而重算那一下在播放中就是肉眼可见的「歌词跳回第一句」。
  var LRC_LAYOUT_KEYS = ['size', 'font', 'dir']

  // reflow === false：调用方明确知道这次改动不影响布局（纯换色 / 换背景）。
  //   默认（undefined）按「会动」处理 —— 兜底方向永远选安全的那一边。
  function applyLrcStyle (reflow) {
    var el = lrcEl()
    if (!el) return
    var s = lrcStyle
    el.setAttribute('data-bg', s.bg)
    el.setAttribute('data-dir', s.dir)
    el.setAttribute('data-font', s.font)
    el.setAttribute('data-karaoke', s.karaoke ? '1' : '0')
    var pageLyrics = $('.lx-page-lyrics')
    if (pageLyrics) pageLyrics.setAttribute('data-karaoke', s.karaoke ? '1' : '0')
    el.setAttribute('data-lrc-theme', lrcTheme)
    el.style.setProperty('--lx-lrc-size', s.size + 'px')
    lrcSetVar(el, '--lx-lrc-color', s.color)
    lrcSetVar(el, '--lx-lrc-on', s.on)
    lrcSetVar(el, '--lx-lrc-fill', s.fill)
    // 光晕跟着每一档「实际生效的颜色」走：留空时对应的是主题的次要文字色 / 强调色
    el.style.setProperty('--lx-lrc-halo', lrcHalo(s.color, themeVar('--lx-dim', '#858585')))
    el.style.setProperty('--lx-lrc-halo-on', lrcHalo(s.on, themeVar('--lx-accent', '#49B1F5')))
    el.style.setProperty('--lx-lrc-halo-fill', lrcHalo(s.fill, themeVar('--lx-accent', '#49B1F5')))
    // 字号 / 排版一变尺寸就变，位移必须真正作废（见 lrcInvalidate 的注释）
    if (reflow !== false) lrcInvalidate()
  }

  /* ---- 齿轮浮板（歌词样式的设置界面）----
     只在 mount 时拼一次 HTML，之后全靠改 data-on / value，从不重建 ——
     重建会让打开状态下改样式时闪一下，还会丢滚动位置。 */
  var LRC_PRESETS = ['', '#49b1f5', '#22c55e', '#f59e0b', '#ff5b77', '#ffffff', '#333333']
  var LRC_THEMES = [
    { id: 'clear', name: '清透', bg: 'transparent', font: 'hei', color: '#e2e8f0', on: '#ffffff', fill: '#62d5ce', karaoke: true },
    { id: 'ink', name: '水墨', bg: 'card', font: 'song', color: '#8b929b', on: '#26343e', fill: '#287f81', karaoke: true },
    { id: 'night', name: '夜航', bg: 'card', font: 'yuan', color: '#b7c7d5', on: '#ffffff', fill: '#82d8b0', karaoke: true },
    { id: 'rose', name: '晚霞', bg: 'transparent', font: 'kai', color: '#f1cbd2', on: '#fff1e9', fill: '#ff9eab', karaoke: true }
  ]

  function lrcThemeId () { return lrcTheme }

  function lrcPopSegs (key, label, opts) {
    var cur = key === 'mode' ? lrcMode : lrcStyle[key]
    return '<div class="lx-pop-row"><span class="lx-pop-label">' + label + '</span>' +
      '<div class="lx-pop-segs">' + opts.map(function (o) {
        return '<button class="lx-seg" type="button" data-pop="' + key + '" data-v="' + o[0] +
          '" data-on="' + (String(cur) === o[0] ? '1' : '0') + '">' + o[1] + '</button>'
      }).join('') + '</div></div>'
  }

  function lrcPopColor (key, label) {
    return '<div class="lx-pop-row"><span class="lx-pop-label">' + label + '</span>' +
      '<div class="lx-pop-swatches">' + LRC_PRESETS.map(function (c) {
        return '<button class="lx-swatch' + (c ? '' : ' lx-swatch-follow') + '" type="button" data-popc="' + key +
          '" data-v="' + c + '" title="' + (c || '跟随主题') + '" aria-label="' + (c || '跟随主题') +
          '" style="background:' + (c || 'transparent') + '"' +
          (String(lrcStyle[key] || '') === c ? ' data-on="1"' : '') + '></button>'
      }).join('') +
      '<input class="lx-pop-hex" data-popc="' + key + '" value="' + esc(lrcStyle[key] || '') +
      '" maxlength="7" spellcheck="false" autocomplete="off" placeholder="#任意色">' +
      '</div></div>'
  }

  function lrcPopHtml () {
    if (CFG.lyric === false) return ''
    return [
      '<div class="lx-lrc-pop" hidden>',
      '  <div class="lx-pop-title">歌词显示</div>',
      '  <div class="lx-pop-primary">',
      lrcPopSegs('mode', '显示', [['window', '多行窗'], ['bar', '单行条']]),
      lrcPopSegs('dir', '方向', [['horizontal', '横排'], ['vertical', '竖排']]),
      '  </div>',
      '  <div class="lx-pop-section">歌词主题（可继续自定义）</div>',
      '  <div class="lx-pop-themes">' + LRC_THEMES.map(function (t) {
        return '<button class="lx-pop-theme" type="button" data-pop-theme="' + t.id + '" title="' + t.name + '主题">' +
          '<span class="lx-pop-theme-sample" data-theme-sample="' + t.id + '">歌词 <b>正在播放</b></span>' +
          '<span>' + t.name + '</span></button>'
      }).join('') + '</div>',
      '  <div class="lx-pop-section">自定义</div>',
      lrcPopSegs('bg', '背景', [['transparent', '透明'], ['card', '卡片']]),
      lrcPopSegs('font', '字体', [['', '跟随'], ['hei', '黑'], ['song', '宋'], ['kai', '楷'], ['yuan', '圆'], ['mono', '码']]),
      lrcPopSegs('karaoke', '逐字染色', [['1', '开'], ['0', '关']]),
      '  <div class="lx-pop-row"><span class="lx-pop-label">字号</span>' +
        '<input class="lx-pop-range" type="range" min="12" max="30" step="1" value="' + lrcStyle.size + '" aria-label="歌词字号">' +
        '<span class="lx-pop-size-num">' + lrcStyle.size + '</span></div>',
      lrcPopColor('color', '歌词色'),
      lrcPopColor('on', '当前句'),
      lrcPopColor('fill', '填充色'),
      '  <div class="lx-pop-foot"><button class="lx-pop-reset" type="button" data-pop-reset="1">恢复默认</button></div>',
      '</div>'
    ].join('')
  }

  function lrcPopOpen () { var p = $('.lx-lrc-pop'); return !!p && !p.hidden }

  function placeLrcPop () {
    var pop = $('.lx-lrc-pop')
    var gear = $('.lx-lrc-gear')
    if (!pop) return
    // 面板打开后固定在首次落点，歌词形态或齿轮位置变化时只做视口限位。
    // 这样切换横/竖、单行/多行不会让设置面板跟着按钮跳来跳去。
    if (pop.getAttribute('data-positioned') === '1') {
      var pw = pop.offsetWidth
      var ph = pop.offsetHeight
      var fixedX = parseFloat(pop.style.left)
      var fixedY = parseFloat(pop.style.top)
      if (!isFinite(fixedX)) fixedX = 8
      if (!isFinite(fixedY)) fixedY = 8
      pop.style.left = Math.round(Math.min(Math.max(8, fixedX), Math.max(8, window.innerWidth - pw - 8))) + 'px'
      pop.style.top = Math.round(Math.min(Math.max(8, fixedY), Math.max(8, window.innerHeight - ph - 8))) + 'px'
      return
    }
    if (!gear) return
    var gr = gear.getBoundingClientRect()
    var w = pop.offsetWidth
    var h = pop.offsetHeight
    var x = Math.min(Math.max(8, gr.right - w), Math.max(8, window.innerWidth - w - 8))
    var y = gr.bottom + 6
    if (y + h > window.innerHeight - 8) y = Math.max(8, gr.top - h - 6)
    pop.style.left = Math.round(x) + 'px'
    pop.style.top = Math.round(y) + 'px'
    pop.setAttribute('data-positioned', '1')
  }

  function openLrcPop () {
    var pop = $('.lx-lrc-pop')
    if (!pop) return
    syncLrcPop()
    pop.removeAttribute('data-positioned')
    // 先量再露（offsetWidth 在 hidden 下是 0），量完再摘掉 visibility
    pop.style.visibility = 'hidden'
    pop.hidden = false
    pop.scrollTop = 0
    placeLrcPop()
    pop.style.visibility = ''
  }

  function closeLrcPop () {
    var pop = $('.lx-lrc-pop')
    if (pop) {
      pop.hidden = true
      pop.removeAttribute('data-positioned')
    }
  }

  function toggleLrcPop () { if (lrcPopOpen()) closeLrcPop(); else openLrcPop() }

  // 把当前生效的样式回填到浮板控件上（开浮板 / 每次改样式后都要走一遍）
  function syncLrcPop () {
    var pop = $('.lx-lrc-pop')
    if (!pop) return
    $$('.lx-pop-segs .lx-seg').forEach(function (b) {
      var k = b.getAttribute('data-pop')
      var v = b.getAttribute('data-v')
      var cur = k === 'mode' ? lrcMode : (k === 'karaoke' ? (lrcStyle.karaoke ? '1' : '0') : String(lrcStyle[k]))
      b.setAttribute('data-on', cur === v ? '1' : '0')
    })
    $$('.lx-swatch').forEach(function (b) {
      b.setAttribute('data-on', String(lrcStyle[b.getAttribute('data-popc')] || '') === b.getAttribute('data-v') ? '1' : '0')
    })
    $$('.lx-pop-hex').forEach(function (inp) {
      var v = lrcStyle[inp.getAttribute('data-popc')] || ''
      if (inp.value !== v) inp.value = v
    })
    var theme = lrcThemeId()
    pop.querySelectorAll('.lx-pop-theme').forEach(function (b) {
      b.setAttribute('data-on', b.getAttribute('data-pop-theme') === theme ? '1' : '0')
    })
    var range = $('.lx-pop-range')
    if (range && Number(range.value) !== lrcStyle.size) range.value = lrcStyle.size
    var num = $('.lx-pop-size-num')
    if (num) num.textContent = lrcStyle.size
  }

  function bindLrcPop () {
    var pop = $('.lx-lrc-pop')
    if (!pop) return
    pop.addEventListener('click', function (e) {
      var seg = e.target.closest ? e.target.closest('button') : null
      if (!seg) return
      if (seg.hasAttribute('data-pop-reset')) { setLrcStyle('reset'); return }
      var themeId = seg.getAttribute('data-pop-theme')
      if (themeId) {
        var theme = LRC_THEMES.filter(function (t) { return t.id === themeId })[0]
        if (theme) {
          lrcTheme = theme.id
          setLrcStyle(theme)
        }
        return
      }
      var k = seg.getAttribute('data-pop')
      if (k) {
        var v = seg.getAttribute('data-v')
        if (k === 'mode') {
          setLrcMode(v === 'bar' ? 'bar' : 'window')
        } else if (k === 'dir') {
          setLrcStyle({ dir: v })
        } else if (k === 'karaoke') setLrcStyle({ karaoke: v === '1' })
        else { var p = {}; p[k] = v; setLrcStyle(p) }
        return
      }
      var ck = seg.getAttribute('data-popc')
      if (ck) {
        var patch = {}
        patch[ck] = seg.getAttribute('data-v')
        setLrcStyle(patch)
        var hex = pop.querySelector('.lx-pop-hex[data-popc="' + ck + '"]')
        if (hex) hex.value = lrcStyle[ck] || ''
      }
    })
    pop.addEventListener('input', function (e) {
      var t = e.target
      if (t.classList && t.classList.contains('lx-pop-range')) {
        setLrcStyle({ size: Number(t.value) })
      } else if (t.classList && t.classList.contains('lx-pop-hex')) {
        var v = lrcHexCss(t.value)
        if (v) { var p = {}; p[t.getAttribute('data-popc')] = v; setLrcStyle(p) }
      }
    })
    // hex 输入失焦：非法值不生效，把输入框拉回当前真正生效的值
    pop.addEventListener('change', function (e) {
      var t = e.target
      if (t.classList && t.classList.contains('lx-pop-hex')) t.value = lrcStyle[t.getAttribute('data-popc')] || ''
    })
    // 点浮板与齿轮以外的地方就收起。pointerdown 而不是 click：赶在 elRoot 的委托处理前判掉，
    // 免得「点齿轮」被这里关掉一次、又被 toggle 打开一次，看起来像没反应。
    document.addEventListener('pointerdown', function (e) {
      if (!lrcPopOpen()) return
      if (e.target.closest && e.target.closest('.lx-lrc-pop, .lx-lrc-gear')) return
      closeLrcPop()
    })
  }

  // 运行时改样式（浮板与调试句柄共用这一个入口）：立即生效 + 记住
  function setLrcStyle (patch) {
    var wasKaraoke = lrcStyle.karaoke
    // 改之前先量一次卡片的位置。★ 下面一律用 lrcKeepPos（transient），绝不能走
    //   lrcPlace(p)  —— 那会写 lrcPos，等于伪造一次「用户拖过」，
    //   默认落点（跟随面板）从此被顶掉，切形态时还会把坐标串过去。
    var keep = lrcRect()
    var reflow = false            // 这次改动会不会动几何（决定滚动位移要不要作废重算）
    if (patch === 'reset') {
      lrcStyle = defaultLrcStyle()
      lrcTheme = 'clear'
      reflow = true               // 整套样式都可能被换掉，按「会动」处理
    } else if (patch && typeof patch === 'object') {
      var next = {}
      LRC_STYLE_KEYS.forEach(function (k) { next[k] = lrcStyle[k] })
      LRC_STYLE_KEYS.forEach(function (k) { if (patch[k] !== undefined) next[k] = patch[k] })
      lrcStyle = lrcStyleFrom(next)
      reflow = LRC_LAYOUT_KEYS.some(function (k) { return patch[k] !== undefined })
    } else {
      return lrcStyle   // 无参 = 只读，直接报当前值
    }
    applyLrcStyle(reflow)
    lrcSave()
    // 逐字开关变了要重建歌词列表：均摊时间轴 / <i class="lx-ch"> 拆不拆字都取决于它
    if (lrcStyle.karaoke !== wasKaraoke && state.lyric.length) {
      rebuildLrcWords()
      renderLyricLines()          // 内部自带 lrcInvalidate + 重新滚动
    } else if (lrcIsOpen() && reflow) {
      // 只有位移真的被作废过才需要重算（force）。
      // 纯换色时连这一下都不做：force 重算的结果虽然相同，但没必要动轨道。
      syncLyric(audio.currentTime || 0, true)
    }
    lrcKeepPos(keep, true)
    if (lrcPopOpen()) { syncLrcPop(); placeLrcPop() }
    return lrcStyle
  }

  function lrcEl () { return $('.lx-lrc') }
  function lrcIsOpen () { var el = lrcEl(); return !!el && !el.hidden }

  function lrcLoad () {
    if (CFG.remember === false) return
    var raw = store(LS_LYRIC)
    if (!raw) return
    try {
      var d = JSON.parse(raw)
      if (d && d.mode === 'bar') lrcMode = 'bar'
      else if (d && d.mode === 'window') lrcMode = 'window'
      if (d && d.pos) {
        if (d.pos.window) lrcPos.window = { x: Number(d.pos.window.x), y: Number(d.pos.window.y) }
        if (d.pos.bar) lrcPos.bar = { x: Number(d.pos.bar.x), y: Number(d.pos.bar.y) }
      }
      lrcLocked = d && d.locked === true
      // 样式：upgrade 兼容 —— 旧数据里没有 style，lrcStyleFrom 会原样返回默认值
      if (d && d.style) lrcStyle = lrcStyleFrom(d.style)
      lrcTheme = d && typeof d.theme === 'string' ? d.theme : (d && d.style ? '' : 'clear')
    } catch (e) { /* 数据坏了就当没存过 */ }
  }

  function lrcSave () {
    if (CFG.remember === false) return
    store(LS_LYRIC, JSON.stringify({ mode: lrcMode, pos: lrcPos, locked: lrcLocked, style: lrcStyle, theme: lrcTheme }))
  }

  function syncLrcLock () {
    var el = lrcEl()
    var btn = $('.lx-lrc-lock')
    if (!el || !btn) return
    el.setAttribute('data-locked', lrcLocked ? '1' : '0')
    btn.innerHTML = lrcLocked ? ICON.lock : ICON.unlock
    btn.setAttribute('title', lrcLocked ? '解锁歌词位置' : '锁定歌词位置')
    btn.setAttribute('aria-label', lrcLocked ? '解锁歌词位置' : '锁定歌词位置')
    btn.setAttribute('data-on', lrcLocked ? '1' : '0')
  }

  function toggleLrcLock () {
    lrcLocked = !lrcLocked
    syncLrcLock()
    lrcSave()
  }

  /* 顺一下「面板 ↔ 歌词卡片」的叠放关系：面板按歌词卡片的高度限高，两者不打架。
     keepLyric = true：只挪面板，**不许碰歌词卡片的位置**。
       卡片尺寸一变（换方向 / 改字号）时，这段逻辑会被 ResizeObserver 异步调到 ——
       而卡片的新位置已经由 setLrcStyle / setLrcMode 显式定好了，
       这里再 place() 一次就等于把它从眼前那个位置按默认落点重摆一遍。 */
  function lrcStackPanel (keepLyric) {
    var panel = $('.lx-panel')
    if (!panel || isEmbed()) return
    panel.style.removeProperty('max-height')
    if (lrcIsOpen() && !lrcPos[lrcMode] && elRoot.getAttribute('data-collapsed') !== 'true') {
      var el = lrcEl()
      var space = Math.max(100, window.innerHeight - el.offsetHeight - 34)
      var max = parseFloat(getComputedStyle(panel).maxHeight)
      panel.style.maxHeight = Math.min(isFinite(max) ? max : space, space) + 'px'
    }
    place(keepLyric ? { lyric: false } : undefined)
  }

  // 未拖动过的歌词浮层：音乐页固定在左上角，悬浮播放器则显示在面板上方。
  function lrcDefaultPos () {
    var el = lrcEl()
    var w = (el && el.offsetWidth) || (lrcMode === 'bar' ? 320 : 264)
    var h = (el && el.offsetHeight) || (lrcMode === 'bar' ? 44 : 240)
    if (isEmbed()) return { x: 8, y: 8 }
    var panel = $('.lx-panel')
    if (panel) {
      var r = panel.getBoundingClientRect()
      var panelTop = r.top - h - 10
      var panelBelow = r.bottom + 10
      var panelY = panelTop >= 8 ? panelTop : Math.min(panelBelow, Math.max(8, window.innerHeight - h - 8))
      return { x: r.left + (r.width - w) / 2, y: panelY }
    }
    return { x: (window.innerWidth - w) / 2, y: Math.max(8, window.innerHeight - h - 24) }
  }

  function lrcOpenDefaultPos () {
    var el = lrcEl()
    var w = (el && el.offsetWidth) || (lrcMode === 'bar' ? 320 : 264)
    var h = (el && el.offsetHeight) || (lrcMode === 'bar' ? 44 : 240)
    if (isEmbed()) return { x: 8, y: 8 }
    var panel = $('.lx-panel')
    if (!panel) return lrcDefaultPos()
    var r = panel.getBoundingClientRect()
    return { x: r.left + (r.width - w) / 2, y: Math.max(8, r.top - h - 10) }
  }

  function lrcClamp (p) {
    var el = lrcEl()
    var w = (el && el.offsetWidth) || 0
    var h = (el && el.offsetHeight) || 0
    return {
      x: Math.round(Math.min(Math.max(8, Number(p.x) || 0), Math.max(8, window.innerWidth - w - 8))),
      y: Math.round(Math.min(Math.max(8, Number(p.y) || 0), Math.max(8, window.innerHeight - h - 8)))
    }
  }

  // 位置写进 CSS 变量（--lx-lrc-x / -y），CSS 只用这两个变量定位；按形态分别记。
  // transient = true：只改这一次的显示位置，**不写进 lrcPos**。
  //   样式 / 方向 / 形态一变就必须走它 —— 卡片要钉在原地不动；
  //   一旦误写 lrcPos，就等于伪造了一次「用户拖过」，默认落点（跟随面板）从此被顶掉，
  //   而且切形态时会把上一个形态的坐标串给下一个形态。
  // 跨页面切换时临时钉住歌词的屏幕坐标，防止面板尺寸变化后的异步 place() 又把它居中。
  // 不写入 lrcPos：只有用户亲自拖动才改变长期记忆。
  var lrcPagePos = null
  function lrcPlace (p, transient) {
    var el = lrcEl()
    if (!el) return
    var q = lrcClamp(p || lrcPagePos || lrcPos[lrcMode] || lrcDefaultPos())
    if (p && !transient) {
      lrcPagePos = null
      lrcPos[lrcMode] = q
    }
    el.style.setProperty('--lx-lrc-x', q.x + 'px')
    el.style.setProperty('--lx-lrc-y', q.y + 'px')
  }

  // 当前卡片的矩形（没打开时返回 null）——改样式 / 换方向之前先量，改完原样放回去。
  function lrcRect () {
    var el = lrcEl()
    return el && !el.hidden ? el.getBoundingClientRect() : null
  }

  /* 把卡片放回「原来视觉上所在的地方」。三个形态的尺寸差得很远：
   *   横排多行窗 264×236 / 竖排多行窗 200×306 / 单行条 420×44
   *   （窄屏另有各自一套媒体查询，见 lx-music.css 1439 行起）
   * 策略分两层：
   *   ① 左上角优先 —— 尺寸没变时分毫不差；尺寸变了也保住「左上角」这个视觉锚点，
   *      文字块的起点不动，看起来就是「没动」。
   *   ② 只有当左上角在新尺寸下**已经越界**时才退而绕中心伸缩 ——
   *      越界必然被 lrcClamp 推回去，而绕中心被推的距离只有一半。
   *      宽高各自独立判断：横排 ↔ 竖排是又变宽又变高，两轴越界的可能性并不一样。
   * ★ transient = true ⇒ 只改这一次的显示位置，不写 lrcPos（位置记忆只属于拖动）。 */
  function lrcKeepPos (r, pageSwap) {
    if (!r) return
    var el = lrcEl()
    if (!el) return
    var w = el.offsetWidth
    var h = el.offsetHeight
    var x = r.left
    if (x < 8 || x > Math.max(8, window.innerWidth - w - 8)) x = r.left + (r.width - w) / 2
    var y = r.top
    if (y < 8 || y > Math.max(8, window.innerHeight - h - 8)) y = r.top + (r.height - h) / 2
    if (pageSwap) lrcPagePos = lrcClamp({ x: x, y: y })
    lrcPlace({ x: x, y: y }, true)
  }

  /* ---------------------------------------------------------
   * 把当前行送到滚动容器正中
   * ---------------------------------------------------------
   * 不用原生滚动（容器固定 overflow: hidden），而是平移内层轨道：
   *   vertical-rl 下 scrollLeft 从 0 起、随内容向后为负值（横向行为同 RTL），
   *   横排那套「scrollTop + 差 − 居中补偿」再 clamp 到 ≥0 的写法在竖排下会被压成 0
   *   ⇒ 切到竖排后永远停在第一列。平移量的取值范围天然非负 [0, 内容 − 容器]，
   *   于是横竖两个方向能共用同一套语义（pos = 「已经走过的距离」）。
   *
   * 算式（delta 一律取两个矩形的物理坐标差，不用 offsetTop —— 那玩意儿的参照是最近的
   * 定位祖先，面板里那版实测恒定偏 278px）：
   *   横排：容器与内容都向下生长 ⇒ pos += (行顶 − 容器顶) − 居中补偿
   *   竖排：内容从右往左流       ⇒ pos += 居中补偿 − (行左 − 容器左)
   * 两条都等价于「pos 的增量 = 把这一行的中心挪到容器中心所需的位移」。
   */
  var lrcOffset = -1        // 当前实际平移量；-1 = 需要重算（样式/尺寸一变就作废）
  var lrcReduce = false     // prefers-reduced-motion：不做平滑过渡

  function lrcScrollTo (active, force) {
    var box = $('.lx-lrc-lines')
    var roll = $('.lx-lrc-roll')
    if (!box || !roll || !active) return
    var boxRect = box.getBoundingClientRect()
    var lineRect = active.getBoundingClientRect()
    var vertical = lrcStyle.dir === 'vertical'
    var pos = lrcOffset < 0 ? 0 : lrcOffset
    var dpos

    if (vertical) {
      dpos = (boxRect.width - lineRect.width) / 2 - (lineRect.left - boxRect.left)
    } else {
      dpos = (lineRect.top - boxRect.top) - (boxRect.height - lineRect.height) / 2
    }

    var boxSize = vertical ? box.clientWidth : box.clientHeight
    var contentSize = vertical ? roll.offsetWidth : roll.offsetHeight
    var next = Math.max(0, Math.min(Math.round(pos + dpos), Math.max(0, contentSize - boxSize)))
    if (!force && next === lrcOffset) return
    lrcOffset = next

    // force（打开浮层 / 切形态 / 改样式）时不做过渡：否则会从上一处位置滑一大段过来
    if (force || lrcReduce) roll.style.transition = 'none'
    roll.style.transform = vertical ? 'translateX(' + next + 'px)' : 'translateY(-' + next + 'px)'
    if (force || lrcReduce) {
      // 下一帧就把过渡恢复，别让后续的换行滚动也变成瞬移
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(function () { roll.style.transition = '' })
      } else {
        setTimeout(function () { roll.style.transition = '' }, 0)
      }
    }
  }

  function setLrcOne (text, trans, idx) {
    var t = $('.lx-lrc-one-text')
    var s = $('.lx-lrc-one-trans')
    if (t) {
      var times = idx >= 0 && state.lrcWords ? state.lrcWords[idx] : null
      var chars = text ? Array.from(text) : []
      t.innerHTML = times && times.length === chars.length
        ? chars.map(function (c, i) { return '<i class="lx-ch" data-t="' + times[i].toFixed(3) + '" data-on="0">' + esc(c) + '</i>' }).join('')
        : esc(text || '')
    }
    if (s) s.textContent = trans || ''
  }

  // 空态 / 加载中 / 失败都走这里（顺带清掉已解析的歌词，免得留下上一首的残句）
  // 歌词空态 / 加载 / 失败都走这里。type 决定图标与是否带「重试」按钮：
  //   loading 转圈 / empty·idle 音符 / fail 刷新箭头 + 重试按钮
  function lrcStatus (text, type) {
    state.lyric = []
    state.lyricIdx = -1
    state.lrcWords = []
    lrcKaraoke = { line: -1, n: 0, els: null }
    var roll = $('.lx-lrc-roll')
    var ic = type === 'loading' ? ICON.spin : (type === 'fail' ? ICON.refresh : ICON.note)
    var retry = type === 'fail'
      ? '<button class="lx-lrc-retry" type="button" data-act="lrc-retry">重新获取</button>'
      : ''
    if (roll) {
      roll.innerHTML = '<div class="lx-lrc-empty lx-lrc-status" data-type="' + (type || 'idle') + '">' +
        '<span class="lx-lrc-empty-ic">' + ic + '</span>' +
        '<span class="lx-lrc-empty-msg">' + esc(text) + '</span>' +
        retry +
      '</div>'
    }
    var pageRoll = $('.lx-page-lyrics-roll')
    if (pageRoll) {
      pageRoll.innerHTML = roll ? roll.innerHTML : ''
      $('.lx-page-lyrics-lines').scrollTop = 0
    }
    pageKaraoke = { line: -1, n: 0, els: null }
    lrcInvalidate()       // 列表被整块换掉了，滚动位移作废
    setLrcOne(text, '', -1)   // 单行条形态也得给个说法，不然那一条会是空的
    if (lrcIsOpen()) lrcPlace()
  }

  // 头部那套封面 / 歌名 / 歌手 / 进度条已经去掉（浮层只留歌词文字），
  // 但「还没选歌」这个空态提示要留着 —— 打开浮层时如果没有歌也没有歌词，补上它。
  function syncLrcEmpty () {
    if (state.song || state.lyric.length) return
    lrcStatus('先选一首歌，歌词会显示在这里', 'idle')
  }

  /* 换形态（多行窗 ↔ 单行条）。
     位置按「形态」各记一份，所以这里不做「原地保留」，而是回到**目标形态自己的落点**：
       拖过 ⇒ lrcPos[目标形态]（用户给这个形态定的位置）
       没拖过 ⇒ lrcDefaultPos()（跟着面板居中）
     这正是 lrcPlace() 无参时的语义 —— 直接用它。
     ★ 绝不能写成 lrcPlace(p)：那会把坐标写进 lrcPos，等于伪造一次「用户拖过」，
       目标形态的记忆被顶掉，再切回来就找不到原位了。 */
  function setLrcMode (mode) {
    var el = lrcEl()
    if (!el) return
    var keep = lrcRect()
    lrcMode = mode === 'bar' ? 'bar' : 'window'
    el.setAttribute('data-mode', lrcMode)
    /* ★ 单行条没有「竖排」这个概念：CSS 里竖排规则全都带 [data-mode='window']
       （竖过来的一条带子毫无意义），而水平/垂直的位移语义也完全不同。
       所以「在单行条 ⇒ 方向必须是横排」由这里强制保证，而不是指望每个入口自己记得收敛 ——
       否则从调试句柄等入口进单行条，会留下「浮板亮着竖排、实际排版是横排」的错位，
       lrcScrollTo 还会去算一轴根本不存在的位移。
       注意必须在下面的测量/落位之前改：方向会改尺寸，先改后量才对得上。 */
    lrcInvalidate()               // 两个形态的尺寸/可滚动范围完全不同，位移必须真正作废
    lrcPagePos = null             // 用户主动切形态时，仍按目标形态各自的记忆/默认落点定位
    if (lrcIsOpen()) {
      // 换形态会改尺寸：先量尺寸再定位，期间先藏起来，免得在旧位置闪一帧。
      // 单行条要把当前句填进去，所以这里 force 一次。
      el.style.visibility = 'hidden'
      lrcStackPanel(true)
      syncLyric(audio.currentTime || 0, true)
      lrcKeepPos(keep, true)
      el.style.visibility = ''
    }
    lrcSave()
    syncLrcPop()          // 浮板开着的话，形态那组 seg 的亮位要跟着走
  }

  function openLrc () {
    var el = lrcEl()
    if (!el) return
    el.setAttribute('data-mode', lrcMode)
    // 先量尺寸、定位置，再露面 —— 否则会先在左上角（或上一个形态的位置）显一帧
    el.style.visibility = 'hidden'
    el.hidden = false
    // 样式要先落到节点上再测量：字号 / 排版会改尺寸，量错就等于定位错
    applyLrcStyle()
    lrcStackPanel()
    if (!lrcPos[lrcMode]) lrcPlace(lrcOpenDefaultPos())
    syncLrcEmpty()
    syncLyric(audio.currentTime || 0, true)
    // 歌词正文会改变浮层高度，必须在渲染完成后再做一次视口限位，否则齿轮可能落到屏幕外。
    if (!lrcPos[lrcMode]) lrcPlace()
    el.style.visibility = ''
    syncLrcBtn()
    lrcKick()             // 逐字染色的 rAF 循环跟着浮层一起跑起来
  }

  function closeLrc () {
    var el = lrcEl()
    if (!el || el.hidden) return
    // 关掉前记住眼前的视口位置：音乐页的面板是内嵌布局，重开时
    // 不能再从播放面板推导默认落点；只记本次显示坐标，不伪造拖动记忆。
    var r = lrcRect()
    if (r) lrcPagePos = lrcClamp({ x: r.left, y: r.top })
    el.hidden = true
    closeLrcPop()
    lrcStackPanel()
    syncLrcBtn()
  }

  function toggleLrc () { if (lrcIsOpen()) closeLrc(); else openLrc() }

  // 播放条上那个歌词按钮的亮灭跟着浮层走（浮层自己也能关，两处状态必须一致）
  function syncLrcBtn () {
    var b = $('.lx-lyric-toggle')
    if (b) b.setAttribute('data-on', lrcIsOpen() ? '1' : '0')
  }

  // 点歌词里某一句 = 跳到那一句；点到的空态（失败提示）时改成「重试加载」
  function lrcLineTap (el) {
    var emptyBox = el.classList.contains('lx-lrc-status') ? el : (el.closest ? el.closest('.lx-lrc-empty') : null)
    if (emptyBox) {
      // 只有「失败」态点了才重试；加载中/暂无歌词/没选歌点了没意义
      if (emptyBox.getAttribute('data-type') === 'fail' && state.song) loadLyric(state.song)
      return
    }
    if (CFG.lyric_seek === false) return
    var line = state.lyric[parseInt(el.getAttribute('data-i'), 10)]
    if (!line) return
    state.lyricIdx = -1          // 强制重算高亮：跳到同一句也要重新滚到中间
    try { audio.currentTime = line.t } catch (e) { return }
    syncLyric(line.t, true)
  }

  // 拖动：整条头部都是手柄，横竖都自由（贴边挡板是「只吸附左右两沿」，浮层不需要）。
  // 位置按形态分别记 —— 多行窗与单行条的合理落点完全不同。
  function bindLrcDrag () {
    if (CFG.drag === false) return
    var handle = $('.lx-lrc-head')
    if (!handle) return
    var start = null
    var ox = 0
    var oy = 0
    var moved = false

    handle.addEventListener('pointerdown', function (e) {
      if (e.button) return
      if (lrcLocked) return
      // 头部里还有「切形态 / 关闭」两个按钮，点它们不算拖动
      if (e.target && e.target.closest && e.target.closest('button')) return
      /* ★ 拖动起点一律取「卡片此刻真正在的位置」，绝不重算 lrcPos / 默认落点：
         改样式、换方向、换形态之后，卡片停在 lrcKeepPos 给的瞬时位置上，
         而 lrcPos 里存的还是上一次拖动的位置（从没拖过则为空）。
         照记忆值算起点 ⇒ 你刚一动鼠标卡片就猛地跳回旧处再跟着走。 */
      var el = lrcEl()
      var r = el && !el.hidden ? el.getBoundingClientRect() : null
      var cur = r ? { x: r.left, y: r.top } : (lrcPos[lrcMode] || lrcDefaultPos())
      start = { x: e.clientX, y: e.clientY }
      ox = cur.x
      oy = cur.y
      moved = false
      try { handle.setPointerCapture(e.pointerId) } catch (err) {}
      elRoot.classList.add('lx-dragging')
    })

    handle.addEventListener('pointermove', function (e) {
      if (!start) return
      var dx = e.clientX - start.x
      var dy = e.clientY - start.y
      if (!moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return
      moved = true
      lrcPlace({ x: ox + dx, y: oy + dy })
      if (e.cancelable) e.preventDefault()
    })

    var end = function (e) {
      if (!start) return
      start = null
      try { handle.releasePointerCapture(e.pointerId) } catch (err) {}
      elRoot.classList.remove('lx-dragging')
      if (moved) { lrcJustDragged = true; lrcStackPanel(); lrcSave() }
    }
    handle.addEventListener('pointerup', end)
    handle.addEventListener('pointercancel', end)
  }

  var lrcResizeTimer = null
  function onLrcResize () {
    if (!lrcIsOpen()) return   // 藏起来时量不到尺寸（offsetWidth 会是 0），别乱算
    clearTimeout(lrcResizeTimer)
    lrcResizeTimer = setTimeout(function () {
      lrcInvalidate()                                 // 视口一变可滚动范围也变，位移作废
      lrcStackPanel()
      lrcPlace()
      syncLyric(audio.currentTime || 0, true)         // 重新把当前句送回中间
    }, 120)
  }

  /* ==========================================================
   * 播放条交互
   * ========================================================== */
  function currentVolume () {
    var saved = parseFloat(store(LS_VOLUME))
    if (isFinite(saved) && saved >= 0 && saved <= 1) return saved
    var v = Number(CFG.volume)
    return isFinite(v) && v >= 0 && v <= 1 ? v : 0.8
  }

  function setPlaying (on) {
    var btn = $('.lx-play')
    // 三个图标（播放 / 暂停 / 加载）始终都在 DOM 里，由 CSS 按属性挑一个显示。
    // 不能写成 innerHTML = 单个图标 —— 那样「加载中」与「播放/暂停」会互相抹掉。
    btn.setAttribute('data-on', on ? '1' : '0')
    elRoot.classList.toggle('is-playing', !!on)
  }

  /* ==========================================================
   * 「正在加载」状态：取播放地址 + 音频起播这段空窗期必须有反馈
   * ========================================================== */
  function setSongLoading (i) {
    $$('.lx-song').forEach(function (r) {
      r.setAttribute('data-loading', parseInt(r.getAttribute('data-i'), 10) === i ? '1' : '0')
    })
    var hint = $('.lx-hint')
    if (hint) { hint.textContent = '正在加载…'; hint.hidden = false }
    var btn = $('.lx-play')
    if (btn) btn.setAttribute('data-loading', '1')
  }

  function clearSongLoading () {
    $$('.lx-song').forEach(function (r) { r.setAttribute('data-loading', '0') })
    var hint = $('.lx-hint')
    if (hint) { hint.hidden = true; hint.textContent = '' }
    var btn = $('.lx-play')
    if (btn) btn.removeAttribute('data-loading')
  }

  function togglePlay () {
    if (!state.song) {
      if (state.songs.length) playIndex(0)
      else { switchTab(state.tab === 'search' ? 'rank' : state.tab); }
      return
    }
    if (audio.paused) {
      var p = audio.play()
      if (p && p.catch) p.catch(function () {})
    } else {
      audio.pause()
    }
  }

  function step (delta) {
    if (!state.songs.length) return
    var n = state.songs.length
    var i = state.index < 0 ? 0 : (state.index + delta + n) % n
    playIndex(i)
  }

  // 进度条相关节点的引用缓存 + 「上次写入值」记录。
  // 作用域必须放在 bindAudio / bindSeek **之外**（同一个闭包里）：
  //   bindAudio 里的 timeupdate 靠它决定「要不要写 DOM」，
  //   而 bindSeek 里的拖动 seek 会直接改进度条、必须同步这个记录；
  //   两者若各持一份就会脱节，进度条会在松手后卡住不动。
  //
  // 为什么值得缓存：timeupdate 约 4Hz，原本每次都做 4 次 elRoot.querySelector
  // 再写 4 处 —— 其中 lx-tcur / lx-tdur 显示的是 mm:ss，**每秒最多变一次**，
  // 也就是每 4 次里至少有 3 次是在重复写同一个字符串。
  // ⚠️ 缓存的节点可能因为面板重建而脱离文档（isConnected 为假），
  //    所以每次取用时校验一次，失效就重新查询。
  var tuCache = { cur: null, dur: null, fill: null, knob: null }
  var tuLast = { cur: '', dur: '', pct: -1 }

  function tuEl (key, sel) {
    var el = tuCache[key]
    if (!el || !el.isConnected) {
      el = $(sel)
      tuCache[key] = el
    }
    return el
  }

  function bindAudio () {
    audio = new Audio()
    audio.preload = 'metadata'
    // 注意：这里刻意不设 crossOrigin —— 一旦设为 'anonymous'，音频请求会变成 CORS 模式，
    // 而第三方音乐 CDN 通常不回 Access-Control-Allow-Origin，会导致整首歌直接加载失败。
    // 我们不需要读取音频数据（没接 Web Audio 分析），保持默认的 no-cors 即可。

    // 进度条节点缓存与「上次写入值」记录见上方（提到 bindAudio 之外，
    // 因为 bindSeek 的拖动路径也要同步 tuLast.pct）。

    audio.addEventListener('timeupdate', function () {
      var cur = audio.currentTime || 0
      var dur = audio.duration || 0

      var s = fmt(cur)
      if (s !== tuLast.cur) {
        var elCur = tuEl('cur', '.lx-tcur')
        if (elCur) elCur.textContent = s
        tuLast.cur = s
      }

      s = fmt(dur)
      if (s !== tuLast.dur) {
        var elDur = tuEl('dur', '.lx-tdur')
        if (elDur) elDur.textContent = s
        tuLast.dur = s
      }

      var pct = dur ? (cur / dur) * 100 : 0
      // 百分比量化到 0.1%，避免浮点抖动导致的无效写入
      pct = Math.round(pct * 10) / 10
      if (pct !== tuLast.pct) {
        var elFill = tuEl('fill', '.lx-fill')
        if (elFill) elFill.style.width = pct + '%'
        var elKnob = tuEl('knob', '.lx-knob')
        if (elKnob) elKnob.style.left = pct + '%'
        tuLast.pct = pct
      }

      syncLyric(cur)
      // 逐字染色别只指望 rAF 循环：后台标签页里 rAF 会被节流到 0，
      // timeupdate（约 4Hz）是唯一还在走的节拍 —— 暂停/seek 之后的点亮也靠它。
      tickKaraoke()
    })
    audio.addEventListener('play', function () { setPlaying(true); lrcKick() })
    audio.addEventListener('pause', function () { setPlaying(false) })
    audio.addEventListener('ended', function () { step(1) })
    // 加载态的**统一出口**：音频真出声了（playing）或已缓冲够（canplay）就撤掉。
    // 不只在 loadUrl 里撤，是为了覆盖「地址已拿到、音频还在缓冲」那一小段；
    // 顺带也是兜底 —— 万一哪条路径漏了，也不会留下一个永远转圈的按钮。
    audio.addEventListener('playing', function () {
      if (!audio.getAttribute('src')) return
      clearSongLoading()
      // 真出声了才记「最近播放」：取链失败、被浏览器拦下的都不该进历史
      if (favOn() && state.song) pushRecent(state.song)
    })
    audio.addEventListener('canplay', function () {
      if (audio.getAttribute('src')) clearSongLoading()
    })
    audio.addEventListener('error', function () {
      if (!audio.getAttribute('src')) return
      clearSongLoading()
      if (audio.src) toast('音频加载失败，换个音质试试')
    })
    audio.addEventListener('loadedmetadata', function () {
      var el = $('.lx-tdur')
      var s = fmt(audio.duration)
      if (el) el.textContent = s
      // 同步缓存：否则 timeupdate 里会认为「值没变」而跳过，
      // 导致缓存与实际显示脱节（后续 seek 后的首次刷新可能被误判为无变化）。
      tuLast.dur = s
    })
  }

  function bindSeek () {
    var track = $('.lx-track')
    var dragging = false

    var seekTo = function (clientX) {
      var rect = track.getBoundingClientRect()
      var ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
      if (isFinite(audio.duration) && audio.duration > 0) {
        audio.currentTime = ratio * audio.duration
      }
      var pct = ratio * 100
      var elFill = $('.lx-fill')
      if (elFill) elFill.style.width = pct + '%'
      var elKnob = $('.lx-knob')
      if (elKnob) elKnob.style.left = pct + '%'
      // ★ 必须同步 timeupdate 的「上次写入值」缓存：
      //   拖动 seek 会直接改进度条，而 timeupdate 那边是靠比对缓存来决定
      //   要不要写的。不同步的话，松手后 pct 若与缓存值相同就会被跳过，
      //   进度条会停在拖动时的位置不动（直到 pct 真正变化）。
      //   这里按 timeupdate 的同一套量化规则（0.1%）写回。
      tuLast.pct = Math.round(pct * 10) / 10
    }

    track.addEventListener('pointerdown', function (e) {
      if (!audio.duration) return
      dragging = true
      try { track.setPointerCapture(e.pointerId) } catch (err) {}
      seekTo(e.clientX)
      e.preventDefault()
    })
    track.addEventListener('pointermove', function (e) { if (dragging) seekTo(e.clientX) })
    var up = function (e) {
      if (!dragging) return
      dragging = false
      try { track.releasePointerCapture(e.pointerId) } catch (err) {}
    }
    track.addEventListener('pointerup', up)
    track.addEventListener('pointercancel', up)

    track.addEventListener('keydown', function (e) {
      if (!audio.duration) return
      var stepS = e.key === 'ArrowRight' ? 5 : (e.key === 'ArrowLeft' ? -5 : 0)
      if (stepS) { audio.currentTime = Math.min(audio.duration, Math.max(0, audio.currentTime + stepS)); e.preventDefault() }
    })
  }

  /* ==========================================================
   * 收起 / 展开
   * ========================================================== */

  // 初始该不该收起：配置默认值 → 被 localStorage 的记忆覆盖 → 移动端强制收起。
  // mount()（决定首帧属性）与 init()（收尾对齐）都走这里，两处结果必然一致，
  // 也就不会出现「首帧一个状态、随后又改一次」的抖动。
  function initialCollapsed () {
    var on = CFG.collapsed
    if (CFG.remember) {
      var saved = store(LS_COLLAPSED)
      if (saved === '1') on = true
      if (saved === '0') on = false
    }
    if (isMobile()) on = true
    return !!on
  }

  function setCollapsed (on, remember) {
    elRoot.setAttribute('data-collapsed', on ? 'true' : 'false')
    // 内嵌版隐藏收起按钮，切到悬浮版时复用同一按钮
    var btn = $('.lx-collapse')
    if (btn) btn.setAttribute('title', on ? '展开' : '收起')
    if (remember !== false && CFG.remember && !isEmbed()) store(LS_COLLAPSED, on ? '1' : '0')
    // 收起位移和歌词相对面板的布局都依赖当前状态。
    if (lrcIsOpen()) lrcStackPanel()
    else place()
  }

  function toggleCollapsed () {
    if (isEmbed()) return
    setCollapsed(elRoot.getAttribute('data-collapsed') !== 'true')
  }

  // 初始化完毕、可以露面了：摘掉 lx-boot（见 lx-music.css 顶部）。
  // 放在 rAF 里是为了把「这一帧的布局」也算进去（ResizeObserver 的首次回调就在这里
  // 触发），等它跑完再显示，露出来的就是终态位置 —— 全程没有中间画面。
  function reveal () {
    var done = function () { if (elRoot) elRoot.classList.remove('lx-boot') }
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(done)
    else done()
  }

  /* ==========================================================
   * 位置：可拖动的贴边图标（挡板）+ 面板跟随
   * ----------------------------------------------------------
   * 坐标系是「视口坐标」，pos 指挡板左上角。拖动时横向自由跟手；
   * 松手后才按中心落在哪半屏吸附到左沿（x=0）或右沿（x=视口宽-挡板宽）。
   * 位置全部写成 CSS 变量交给样式表，这样移动只需要改两个变量，不碰 JS 里的几何计算：
   *   --lx-x / --lx-y        挡板左边缘 / 上边缘
   *   --lx-panel-x / -y      面板左边缘 / 上边缘（JS 算好，围绕挡板垂直居中）
   *   --lx-panel-off         收起时面板的水平位移（CSS 里算，含方向）
   * 松手后面板左侧或右侧直接贴屏幕边缘；拖动中按按下时的矩形连续移动，
   * 不在越过中线时突然跳到挡板另一侧。
   * ========================================================== */
  var RAIL_FALLBACK = { w: 46, h: 52 }
  var justDragged = false

  function railBox () {
    var r = $('.lx-rail')
    if (!r) return { w: RAIL_FALLBACK.w, h: RAIL_FALLBACK.h }
    return { w: r.offsetWidth || RAIL_FALLBACK.w, h: r.offsetHeight || RAIL_FALLBACK.h }
  }

  // 吸附终点：左沿 x=0，右沿 x=视口宽-挡板宽。
  function edgeX (side, b) {
    return side === 'right' ? Math.max(0, window.innerWidth - b.w) : 0
  }

  // 按「挡板中心落在哪半屏」决定归属哪一沿
  function nearestSide (x, b) {
    return (Number(x) + b.w / 2) <= window.innerWidth / 2 ? 'left' : 'right'
  }

  // 纵向夹进视口
  function clampY (y, b) {
    b = b || railBox()
    var maxY = Math.max(0, window.innerHeight - b.h)
    return Math.min(Math.max(0, Number(y) || 0), maxY)
  }

  // 普通布局只负责把坐标限制在视口内；左右吸附只在拖动结束时执行。
  // 这样 pointermove 期间能保留连续坐标，用户会看到挡板和面板真实跟手移动。
  function clampPos (p) {
    var b = railBox()
    var maxX = Math.max(0, window.innerWidth - b.w)
    return {
      x: Math.min(Math.max(0, Number(p.x) || 0), maxX),
      y: clampY(p.y, b)
    }
  }

  function snapPos (p) {
    var b = railBox()
    return {
      x: edgeX(nearestSide(p.x, b), b),
      y: clampY(p.y, b)
    }
  }

  // 默认位置：桌面端左下角贴边、底部保留配置间距；
  // 手机端改为「贴左沿 + 纵向落在配置比例处」。
  //
  // ★ 为什么手机端不能也用左下角
  //   主题的「回顶 / 设置」按钮组就在右下角，手机屏幕矮、两者在纵向
  //   几乎同一带，收起态的挡板会和它们挤在一起（实测反馈）。
  //   改到左沿的中间偏下位置后，既离开了底部按钮群，又在单手拇指
  //   够得到的范围内（0.58 ≈ 屏幕高度的 58% 处）。
  function defaultPos () {
    var b = railBox()
    if (isMobile()) {
      var ratio = Number(CFG.mobile_pos_ratio)
      if (!isFinite(ratio)) ratio = 0.58
      ratio = Math.min(1, Math.max(0, ratio))
      // 比例算的是「挡板中心」落在视口高度的哪里，再减半个高度得到上边缘，
      // 这样调比例时挡板是整体平移，不会因为挡板变高变矮而偏移。
      var centerY = window.innerHeight * ratio
      return { x: 0, y: clampY(centerY - b.h / 2, b) }
    }
    var gap = Number(CFG.bottom_gap)
    if (!isFinite(gap)) gap = 24
    return { x: 0, y: clampY(window.innerHeight - b.h - gap, b) }
  }

  function place (opts) {
    if (isEmbed()) return
    var b = railBox()
    var vw = window.innerWidth
    var vh = window.innerHeight

    elRoot.style.setProperty('--lx-x', Math.round(pos.x) + 'px')
    elRoot.style.setProperty('--lx-y', Math.round(pos.y) + 'px')

    // 靠左还是靠右：决定挡板圆角朝哪边、收起时从哪边滑进来
    var edge = nearestSide(pos.x, b)
    if (!(opts && opts.dragPanel)) elRoot.setAttribute('data-edge', edge)

    // 松手后面板按左右侧贴边；拖动中锁定按下时的方向与矩形，避免过中线时跳位。
    // opts.lockSide 供面板自身尺寸变化时保持原侧。
    var side = (opts && opts.dragPanel && elRoot.getAttribute('data-side')) ||
      (opts && opts.lockSide) || edge
    elRoot.setAttribute('data-side', side)

    var panel = $('.lx-panel')
    if (!panel) return
    var pw = panel.offsetWidth || 360
    var ph = panel.offsetHeight || 460

    var px = opts && opts.dragPanel
      ? pos.x + opts.dragPanel.dx
      : (side === 'left' ? pos.x : pos.x + b.w - pw)
    var py = opts && opts.dragPanel
      ? pos.y + opts.dragPanel.dy
      : pos.y + b.h / 2 - ph / 2
    px = Math.max(0, Math.min(px, Math.max(0, vw - pw)))
    py = Math.max(8, Math.min(py, Math.max(8, vh - ph - 8)))
    if ((!opts || opts.lyric !== false) &&
        lrcIsOpen() && !lrcPos[lrcMode] && elRoot.getAttribute('data-collapsed') !== 'true' &&
        !(opts && opts.dragPanel)) {
      var lyric = lrcEl()
      py = Math.max(py, Math.min(vh - ph - 8, lyric.offsetHeight + 18))
    }

    panel.style.setProperty('--lx-panel-x', Math.round(px) + 'px')
    panel.style.setProperty('--lx-panel-y', Math.round(py) + 'px')

    // 收起位移按「面板到屏幕边缘的真实距离」算，而不是 CSS 里写死的固定量 ——
    // 面板宽度会变（窄屏媒体查询）、两沿的 px 也不同，按真实距离算才不会在收起后
    // 留一截在屏幕里（或滑过头露出空白）。
    if (elRoot.getAttribute('data-collapsed') === 'true') {
      var off = side === 'left' ? -(px + pw + 24) : (vw - px + 24)
      panel.style.setProperty('--lx-panel-off', Math.round(off) + 'px')
    } else {
      panel.style.removeProperty('--lx-panel-off')
    }
    if ((!opts || opts.lyric !== false) && lrcIsOpen() && !lrcPos[lrcMode] && !isEmbed()) lrcPlace()
  }

  function setPos (x, y, lockSide) {
    pos = clampPos({ x: x, y: y })
    place({ lockSide: lockSide })
  }

  // 拖动中使用连续坐标，松手时再通过 snapPos() 吸附到左右两侧。
  function setFreePos (x, y, dragPanel) {
    pos = clampPos({ x: x, y: y })
    place({ dragPanel: dragPanel })
  }

  function initPos () {
    var saved = null

    // ★ 手机端**不读** localStorage 里保存的位置，每次都重新落到默认值。
    //
    //   为什么彻底不读、而不是「判断旧位置是不是贴底再作废」：
    //   位置会随浏览器地址栏收放而变（innerHeight 抖动），旧默认值是
    //   innerHeight - h - 24，每次进页面时这个值都不一样，任何基于
    //   「y 落在哪个区间」的启发式都可能失配 —— 失配一次，用户看到的就是
    //   老访客永远的旧位置，改动对他不生效（正是之前的现象）。
    //
    //   手机端屏幕小、用户基本不会去拖一个贴边胶囊（拖动的价值主要
    //   在桌面端把它摆到自己顺手的角落），所以手机端放弃记忆位置、
    //   每次固定落回中间默认值，是收益最稳、代价最小的做法。
    //   桌面端（>768px）照旧读取记忆位置，不受影响。
    if (!isMobile() && CFG.remember !== false) {
      saved = loadPos()
    }

    pos = snapPos(saved || defaultPos())
  }

  function savePos () {
    if (CFG.remember === false) return
    store(LS_POS, JSON.stringify({ x: Math.round(pos.x), y: Math.round(pos.y) }))
  }

  function loadPos () {
    var raw = store(LS_POS)
    if (!raw) return null
    try {
      var p = JSON.parse(raw)
      if (p && isFinite(p.x) && isFinite(p.y)) return { x: Number(p.x), y: Number(p.y) }
    } catch (e) { /* 数据坏了就当没存过 */ }
    return null
  }

  // 拖动：挡板（收起态）与面板标题栏均可拖；移动时横纵跟手，松手才吸边。
  function bindDrag () {
    if (CFG.drag === false) return
    var handles = [$('.lx-rail'), $('.lx-head')]

    handles.forEach(function (handle) {
      if (!handle) return
      var start = null
      var ox = 0
      var oy = 0
      var dragPanel = null
      var moved = false

      handle.addEventListener('pointerdown', function (e) {
        if (e.button || isEmbed()) return
        // 标题栏里还有按钮（收起），点按钮不算拖动。
        // 注意：挡板自己就是 <button>，所以只有「命中的按钮不是 handle 本身」才排除 ——
        // 否则点挡板永远会被当成点按钮，挡板就拖不动了。
        var hit = e.target && e.target.closest ? e.target.closest('button, input, a') : null
        if (hit && hit !== handle) return
        start = { x: e.clientX, y: e.clientY }
        ox = pos.x
        oy = pos.y
        var panel = $('.lx-panel')
        var panelRect = panel && panel.getBoundingClientRect()
        dragPanel = panelRect ? { dx: panelRect.left - ox, dy: panelRect.top - oy } : null
        moved = false
        try { handle.setPointerCapture(e.pointerId) } catch (err) {}
        elRoot.classList.add('lx-dragging')
      })

      handle.addEventListener('pointermove', function (e) {
        if (!start) return
        var dx = e.clientX - start.x
        var dy = e.clientY - start.y
        // 4px 内当点击处理，避免手一抖「想展开却把它拖走」
        if (!moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return
        moved = true

        // 拖动中保留连续坐标，挡板和面板都跟着指针走；吸附延后到 pointerup。
        setFreePos(ox + dx, oy + dy, dragPanel)
        if (e.cancelable) e.preventDefault()
      })

      var end = function (e) {
        if (!start) return
        start = null
        dragPanel = null
        try { handle.releasePointerCapture(e.pointerId) } catch (err) {}
        elRoot.classList.remove('lx-dragging')
        if (moved) {
          justDragged = true // 抑制随后的 click，否则松手就顺手展开了
          pos = snapPos(pos)
          savePos()
          place() // 仅在松手时吸附，方向和收起位移按最终一侧重算
        }
      }
      handle.addEventListener('pointerup', end)
      handle.addEventListener('pointercancel', end)
    })
  }

  // 音乐页只通过 CSS 常驻展示面板；data-collapsed 仍记录悬浮版原有状态。
  // 形态切换时面板会从内嵌版的 transform:none 变成悬浮版的屏外位移。
  // 即使收起属性没变，CSS 过渡也会把中间的「展开面板」画出来；等悬浮布局
  // 完成一帧后再恢复过渡，避免切页时闪出面板，不影响平时点击展开/收起。
  var mountSwitchId = 0
  function settlePageMount () {
    var id = ++mountSwitchId
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        if (elRoot && id === mountSwitchId) elRoot.classList.remove('lx-mount-switch')
      })
    })
  }

  // Pjax 只替换 #body-wrap；在它卸载音乐页正文前，把同一节点挪回 body。
  // Audio 不重建，歌词浮层同步保留原有屏幕位置。
  function syncPageMount () {
    if (!elRoot) return
    var host = document.querySelector('#lx-music-page')
    var embed = !!host && CFG.page_embed !== false
    if (embed === isEmbed() && elRoot.parentNode === (embed ? host : document.body)) return
    var lyricRect = lrcRect()
    elRoot.classList.add('lx-mount-switch')
    if (embed) {
      elRoot.classList.add('lx-embed')
      host.appendChild(elRoot)
      syncLyric(audio.currentTime || 0, true)
      lrcKick()
    } else {
      elRoot.classList.remove('lx-embed')
      document.body.appendChild(elRoot)
      pos = snapPos(pos)
      place({ lyric: false })
      if (lrcIsOpen()) lrcStackPanel(true)
    }
    if (lyricRect) lrcKeepPos(lyricRect, true)
    if (window.__lxMusic) window.__lxMusic.embed = embed
    settlePageMount()
  }

  function beforePageSwap () {
    if (isEmbed()) {
      var lyricRect = lrcRect()
      elRoot.classList.add('lx-mount-switch')
      elRoot.classList.remove('lx-embed')
      document.body.appendChild(elRoot)
      pos = snapPos(pos)
      place({ lyric: false })
      if (lyricRect) lrcKeepPos(lyricRect, true)
      if (window.__lxMusic) window.__lxMusic.embed = false
      settlePageMount()
    }
  }

  var resizeTimer = null
  function onResize () {
    if (isEmbed()) return
    clearTimeout(resizeTimer)
    resizeTimer = setTimeout(function () {
      pos = snapPos(pos)
      place()
    }, 120)
  }

  /* ==========================================================
   * Tab
   * ========================================================== */
  function switchTab (tab) {
    if (tab === 'search') state.nav++
    state.tab = tab
    elRoot.setAttribute('data-tab', tab)
    $$('.lx-tab').forEach(function (b) {
      b.setAttribute('data-on', b.getAttribute('data-tab') === tab ? '1' : '0')
    })
    showSearchPane(tab === 'search')

    if (tab === 'search') {
      // 各标签共用 .lx-main；返回搜索时必须清掉榜单、歌单或「我的」的旧内容。
      // state.songs 仍保留当前播放队列，切换标签不应打断上一首/下一首。
      state.view = 'list'
      state.trail = []
      state.queueFrom = null
      setCrumb('')
      empty('输入歌名或歌手开始搜索，也可以点上面的热搜词')
      return
    }
    if (tab === 'rank') { loadBoards(); return }
    if (tab === 'mine') { loadMine(); return }
    loadPlaylists()
  }

  /* ==========================================================
   * 初始化
   * ========================================================== */
  function init () {
    libLoad()      // 先把本地库读出来：首屏渲染歌曲行时要用它判断爱心状态
    lrcLoad()      // 歌词浮层：先读「形态 + 上次的位置」，mount() 建节点时就要用形态
    mount()
    bindAudio()
    bindSeek()

    // 两种形态共用一套拖动/定位监听；内嵌时回调自行跳过，切回悬浮时无需重绑。
    initPos()
    if (!isEmbed()) place()
    bindDrag()
    window.addEventListener('resize', onResize)
    document.addEventListener('pjax:send', beforePageSwap)
    document.addEventListener('pjax:complete', syncPageMount)
    document.addEventListener('pjax:error', syncPageMount)
    if (typeof ResizeObserver !== 'undefined') {
      var panelEl = $('.lx-panel')
      if (panelEl) {
        new ResizeObserver(function () {
          if (!isEmbed()) place({ lockSide: elRoot.getAttribute('data-side') || 'left' })
        }).observe(panelEl)
      }
    }

    // 歌词浮层：悬浮版与内嵌版都要（/music/ 页里也让它飘在页面上），所以不受上面那个 isEmbed 分支限制
    if (CFG.lyric !== false) {
      applyLrcStyle()     // ★ 样式必须在第一次打开浮层之前落到节点上（openLrc 里还会再调一次兜底）
      syncLrcLock()
      lrcReduce = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)
      syncLrcEmpty()
      syncLrcBtn()        // 给播放条那个按钮一个明确的 data-on="0"（不留 null，样式才有确定的初态）
      bindLrcDrag()
      bindLrcPop()
      if (typeof ResizeObserver !== 'undefined') {
        /* 卡片尺寸变了要处理三件事：
           ① 叠放 —— 面板按卡片高度限高，两者不打架。
           ② 滚动位移 —— 行高 / 内容宽度都变了，位移必须作废重算，否则当前句会偏出正中。
              这一条不是给我们自己的样式改动兜底的（那些路径自己会重算），而是给**外部原因**
              兜底：Web 字体晚于首帧加载、系统字号缩放、内容回流等。
              注意它必须放在「拖过就整个 return」的前面 —— 拖过的卡片同样需要这条。
           ③ 位置 —— **只**在「从没拖过」且卡片真的被挤出视口时才重新落位。
              本回调异步跑（在渲染更新里），晚于 setLrcStyle / setLrcMode 里那次显式落位；
              只要无条件动一下卡片，用户看到的就是「切换横排竖排 / 改样式时卡片自己偏移」。 */
        new ResizeObserver(function () {
          if (!lrcIsOpen()) return
          if (!lrcPos[lrcMode]) lrcStackPanel(true)
          if (lrcMode === 'window' && state.lyric.length) {
            lrcInvalidate()
            syncLyric(audio.currentTime || 0, true)
          }
          if (lrcPos[lrcMode]) return
          var r = lrcRect()
          if (!r) return
          if (r.left < 0 || r.top < 0 || r.right > window.innerWidth || r.bottom > window.innerHeight) lrcPlace()
        }).observe(lrcEl())
      }
      window.addEventListener('resize', onLrcResize)
      document.addEventListener('keydown', function (e) {
        // Esc 先关设置浮板、再关浮层 —— 浮板开着的时候按 Esc 不该把歌词整个关掉
        if (e.key !== 'Escape') return
        if (lrcPopOpen()) { closeLrcPop(); return }
        if (lrcIsOpen()) closeLrc()
      })
    }

    // 调试用把手：控制台里 __lxMusic.audio / .state / .base() 可查播放状态与当前实际在用的接口地址
    window.__lxMusic = {
      audio: audio,
      state: state,
      base: function () { return bases[baseIdx] },
      bases: bases,
      embed: !!elRoot.classList.contains('lx-embed'),
      pos: function () { return { x: pos.x, y: pos.y } },
      setPos: setPos,
      place: place,
      // 缓存排查：__lxMusic.cache.get('boards') 看有没有命中、keys() 看当前有哪几条
      cache: {
        get: cacheGet,
        clear: clearCache,
        keys: function () { return Object.keys(memCache) }
      },
      // 本地库排查：__lxMusic.lib.fav / .recent 看内容，__lxMusic.fav() 手动收藏当前歌
      lib: lib,
      fav: function (song) { return toggleFav(song || state.song) },
      isFav: isFav,
      clearLib: clearLib,
      mine: function (which) { state.mine = which === 'recent' ? 'recent' : 'fav'; loadMine() },
      // 播放列表排查：__lxMusic.queue() 往返切换、__lxMusic.queueOpen() 看当前在不在里面
      queue: function () { if (state.view === 'queue') closeQueue(); else openQueue() },
      queueOpen: function () { return state.view === 'queue' },
      // 歌词浮层排查：__lxMusic.lyric() 开关浮层、lyricMode('bar') 换形态、lyricPos() 看当前位置
      lyric: function () { if (lrcIsOpen()) closeLrc(); else openLrc() },
      lyricMode: setLrcMode,
      lyricPos: function () { return lrcMode + ' | ' + JSON.stringify(lrcPos[lrcMode]) },
      // 歌词样式排查：__lxMusic.lyricStyle() 看当前值、lyricStyle({ size: 22 }) 改一项、
      // lyricStyle('reset') 回默认。改完立刻生效，并且同样受 remember 开关控制地写回本地。
      lyricStyle: setLrcStyle,
      applyLrcStyle: applyLrcStyle,
      lrcOffset: function () { return lrcOffset },
      lrcPopOpen: lrcPopOpen,
      // 逐字染色排查：__lxMusic.karaoke() 看当前行的点亮进度（点亮了几个字 / 共几个）
      karaoke: function () {
        return { line: lrcKaraoke.line, n: lrcKaraoke.n,
          total: lrcKaraoke.els ? lrcKaraoke.els.length : 0,
          words: state.lrcWords ? (state.lrcWords[state.lyricIdx] || []).length : 0 }
      },
      // 把第 i 句当成「当前句」并滚到中间去（不碰播放进度，纯验证滚动数学用）。
      // 走的是 syncLyric 里同一条 lrcScrollTo —— 竖排居中那类位移问题一测就现形。
      lyricScroll: function (i) {
        var roll = $('.lx-lrc-roll')
        if (!roll) return null
        var lines = roll.querySelectorAll('.lx-lrc-line')
        for (var j = 0; j < lines.length; j++) lines[j].setAttribute('data-on', j === i ? '1' : '0')
        if (lines[i]) lrcScrollTo(lines[i], true)
        return lrcOffset
      }
    }

    // 事件委托：一次绑定，覆盖所有按钮
    elRoot.addEventListener('click', function (e) {
      // 刚拖过挡板：这一次 click 是拖动的尾巴，丢掉（否则松手就把面板展开了）
      if (justDragged) { justDragged = false; return }
      // 歌词行 / 空态文字不是 <button>，要显式列进来，否则点歌词跳转与「点一下重试」都收不到
      var t = e.target.closest ? e.target.closest('button, .lx-song, .lx-lrc-line, .lx-lrc-status') : null
      if (!t) return
      var act = t.getAttribute('data-act')
      if (t.classList.contains('lx-collapse') || t.classList.contains('lx-rail')) { toggleCollapsed(); return }
      if (act === 'play') { togglePlay(); return }
      if (act === 'fav') { applyFav(state.song, null); return }
      if (act === 'prev') { step(-1); return }
      if (act === 'next') { step(1); return }
      if (act === 'queue') { openQueue(); return }
      if (act === 'refresh-cache') { refreshCache(); return }
      // 歌词现在是一个独立浮层：这个按钮只是它的开关（亮灭由 syncLrcBtn 统一维护）
      if (act === 'lyric') { toggleLrc(); return }
      if (act === 'lrc-lock') { toggleLrcLock(); return }
      if (act === 'lrc-gear') { toggleLrcPop(); return }
      if (act === 'lrc-close') { closeLrc(); return }
      if (act === 'lrc-retry') { if (state.song) loadLyric(state.song); return }
      if (act === 'mute') {
        audio.muted = !audio.muted
        t.innerHTML = audio.muted ? ICON.mute : ICON.volume
        return
      }
      if (t.classList.contains('lx-lrc-line') || t.classList.contains('lx-lrc-status')) {
        // 刚拖过浮层：这一次 click 是拖动的尾巴，丢掉（否则松手就顺手跳了一句）
        if (lrcJustDragged) { lrcJustDragged = false; return }
        lrcLineTap(t)
        return
      }
      if (t.classList.contains('lx-tab')) { switchTab(t.getAttribute('data-tab')); return }
      if (t.classList.contains('lx-seg')) { state.mine = t.getAttribute('data-mine'); renderMine(); return }
      if (t.classList.contains('lx-seg-clear')) { clearMine(); return }
      if (t.classList.contains('lx-go')) {
        var kw = $('.lx-input').value.trim()
        if (kw) doSearch(kw)
        return
      }
      if (t.classList.contains('lx-back')) { goBack(); return }
    })

    $('.lx-input').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        var kw = e.target.value.trim()
        if (kw) doSearch(kw)
      }
    })

    var vol = $('.lx-vol')
    vol.value = currentVolume()
    vol.addEventListener('input', function () {
      audio.volume = Number(vol.value)
      audio.muted = false
      $('.lx-mute').innerHTML = Number(vol.value) === 0 ? ICON.mute : ICON.volume
      store(LS_VOLUME, vol.value)
    })

    // 初始状态
    if (CFG.lyric === false) {
      var lb = $('.lx-lyric-toggle')
      if (lb) lb.remove()
    }
    syncBarFav()   // 还没选歌：爱心置灰

    // 内嵌页视觉上常驻展开，但仍保留悬浮面板的收起属性；离开时无需恢复。
    if (isMobile() && CFG.mobile === false && !isEmbed()) elRoot.classList.add('lx-hide-mobile')
    setCollapsed(initialCollapsed(), false)

    // 首屏数据：热搜 + 默认视图
    loadHot()
    switchTab(state.tab)

    // 到这里「位置 / 收起态 / 首屏数据」都定了，可以露面（摘掉 lx-boot）
    reveal()
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }
})()
