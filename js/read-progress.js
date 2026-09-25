/* ============================================================
 * 拾遗录 · 文章页阅读进度条
 * ------------------------------------------------------------
 * 零主题文件修改：本文件由 source/css/... 无关，属于纯前端脚本，
 * 通过 inject.bottom 引入（见 _config.butterfly.yml → inject.bottom）。
 *
 * ★ 它和站点自带的 pace 加载条是什么关系（这是本脚本最关键的设计）
 * ------------------------------------------------------------
 * 站点已经有两条「顶部横条」了，必须分工明确，否则会同时出现、
 * 互相压盖，看起来像坏了：
 *
 *   ① pace 加载条（source/css/pace.css）
 *      —— 页面「加载」进度：从点击链接到文档加载完成。
 *      固定在页面最顶部，3px 粗，z-index 3000，加载完成后加 pace-inactive 收掉。
 *
 *   ② 本脚本的阅读条
 *      —— 文章「阅读」进度：进入文章后，跟正文滚动走的百分比。
 *      **只在加载完之后出现**。
 *
 * 分工规则（两者永不同时可见）：
 *   · 文档还没加载完  → 只显示 pace（阅读条不介入）
 *   · 加载完 + 文章页  → pace 已收掉，阅读条接管同一条位置
 *   · 加载完 + 非文章页 → 两条都不显示（阅读条只在 #post 页面启用）
 *
 * ★ 两条怎么区分（避免用户「分不清加载好没好」）
 * ------------------------------------------------------------
 *   加载条 pace：蓝→青渐变 + 流动高光（一直在扫）→ 一看就知道「还在加载」
 *   阅读条     ：青绿单色 #00c4b6 + 完全静态，2px 略细 → 一看就知道「已就绪」
 * 颜色、动态、粗细三个维度都不同，不必靠记忆分辨。
 * 两条仍共用顶部位置，加载完由阅读条无缝接管。
 *
 * ★ 为什么不用 after_render:html 注入（像 scripts/post-back.js 那样）
 * ------------------------------------------------------------
 * 本站开了 pjax（无刷新切页）。after_render:html 只在构建期往静态 HTML 里
 * 写一次，pjax 从首页切到文章页时不会重新走注入，进度条就不会出现。
 * 所以这里改为「运行时自建 DOM」，并监听 pjax:complete 重新初始化，
 * 保证不管是直接打开文章、还是站内无刷新跳进文章，都能正常出现。
 * ============================================================ */
;(function () {
  'use strict'

  var ID = 'zzcReadProgress'
  /* 只在文章页启用：主题文章页有 <div id="post">，其它页面没有 */
  var POST_SEL = '#post'

  var bar = null
  var raf = 0
  var bound = false
  var paceObserver = null

  /* ---------- 构造进度条 DOM ---------- */
  function ensure () {
    var el = document.getElementById(ID)
    if (el) { bar = el; return el }

    el = document.createElement('div')
    el.id = ID
    el.setAttribute('aria-hidden', 'true')
    /* 内层单独一层，用来画「前沿亮点」，与 pace 的结构保持一致 */
    el.innerHTML = '<div class="' + ID + '-inner"></div>'
    document.body.appendChild(el)
    bar = el
    return el
  }

  /* pace 是否还在加载中：pace 1.2.4 在文档加载完成后会给 <body> 加 pace-done，
     并给 .pace 加 pace-inactive（本项目的 pace.css 里 .pace-inactive{display:none}）。
     只要 pace 元素存在且尚未 inactive，就说明「加载中」，此时阅读条让位。 */
  function loading () {
    var pace = document.querySelector('.pace')
    if (!pace) return false
    return !pace.classList.contains('pace-inactive') && !document.body.classList.contains('pace-done')
  }

  /* ---------- 计算并绘制阅读进度 ---------- */
  function update () {
    raf = 0
    if (!bar) return

    var post = document.querySelector(POST_SEL)

    /* 非文章页：不显示 */
    if (!post) { bar.classList.remove('zrp-on'); return }

    /* 加载中：让位给 pace，不显示 */
    if (loading()) { bar.classList.remove('zrp-on'); return }

    var doc = document.documentElement
    var vh = window.innerHeight || doc.clientHeight || 0

    /* 可滚动的总距离；短文章不足一屏时为 0，直接算作 100% */
    var total = doc.scrollHeight - vh
    var y = window.pageYOffset || doc.scrollTop || 0

    var pct
    if (total <= 0) {
      pct = 100
    } else {
      pct = (y / total) * 100
    }
    if (!(pct >= 0)) pct = 0
    if (pct > 100) pct = 100

    bar.style.transform = 'scaleX(' + (pct / 100).toFixed(4) + ')'
    bar.classList.add('zrp-on')
  }

  function schedule () {
    if (raf) return
    raf = window.requestAnimationFrame
      ? window.requestAnimationFrame(update)
      : window.setTimeout(update, 16)
  }

  /* ---------- 首次进入：等 pace 收掉后再接管 ----------
     pace 的结束时机由它自己控制（加载完成后还有个收尾动画），
     这里用几帧轮询确认它真的收掉了，再把阅读条亮出来，
     避免出现「pace 刚淡出、阅读条已经冒出来」的重叠瞬间。 */
  function waitForPaceThenShow (tries) {
    tries = tries || 0
    if (loading() && tries < 120) {   /* 最多等约 2s，超时就不再等 */
      window.setTimeout(function () { waitForPaceThenShow(tries + 1) }, 16)
      return
    }
    update()
  }

  function init () {
    ensure()

    /* 只在文章页挂滚动监听，其它页面省掉这份开销 */
    if (!bound) {
      bound = true
      window.addEventListener('scroll', schedule, { passive: true })
      window.addEventListener('resize', schedule)

      /* pace 结束的兜底信号：
         pace 会给 <body> 加 pace-done，同时给 .pace 元素加 pace-inactive。
         两个位置都盯一下，任一发生变化就重算一次（谁先到用谁），
         这样 pace 收掉的那一刻阅读条能立刻接管，不用干等轮询超时。 */
      if (window.MutationObserver) {
        var onClassChange = function () { schedule() }
        new MutationObserver(onClassChange)
          .observe(document.body, { attributes: true, attributeFilter: ['class'] })

        observePace(onClassChange)
      }
    }

    waitForPaceThenShow()
  }

  /* 单独抽出：pjax 切页后 .pace 会换成新元素，需要重新挂 observer */
  function observePace (cb) {
    if (!window.MutationObserver) return
    if (paceObserver) { paceObserver.disconnect(); paceObserver = null }
    var paceEl = document.querySelector('.pace')
    if (!paceEl) return
    paceObserver = new MutationObserver(cb)
    paceObserver.observe(paceEl, { attributes: true, attributeFilter: ['class'] })
  }

  /* ---------- 启动 + pjax 支持 ---------- */
  function boot () {
    if (!document.body) return
    init()
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true })
  } else {
    boot()
  }

  /* pjax 无刷新切页后，页面换成了新内容：重新校正一次。
     新页面同样要等它自己的 pace 收掉，所以仍走 waitForPaceThenShow；
     同时 .pace 可能是新元素，observer 要重新挂。 */
  document.addEventListener('pjax:complete', function () {
    /* pjax 只替换容器内容，进度条是挂在 body 上的独立节点，通常会被保留；
       但万一被换掉（不同 pjax 实现行为不一），ensure() 会重新建一个。 */
    ensure()
    bar = document.getElementById(ID)
    observePace(function () { schedule() })
    waitForPaceThenShow()
  })

  /* 返回上一页（浏览器缓存恢复）时也要重算，否则进度会停在旧值 */
  window.addEventListener('pageshow', function (e) {
    if (e.persisted) {
      bar = document.getElementById(ID)
      waitForPaceThenShow()
    }
  })
})()
