/* 站点级点击特效过滤：不改 Butterfly 主题文件，也不阻断页面正常点击。 */
;(function () {
  'use strict'

  // 只认页面布局容器本身；卡片、文章、文字、图片和控件不算空白处。
  var blankSelector = 'html, body, #body-wrap, #web_bg, #content-inner, #page-header, #footer, .layout'

  function isBlankClick (event) {
    var target = event.target
    return event.isTrusted && event.detail > 0 && target && target.nodeType === 1 &&
      target.matches(blankSelector) && !target.closest('a, button, input, textarea, select, label, [role="button"], [contenteditable="true"], #lx-music')
  }

  // 心形脚本是 async：在它同步注册 window click 时，仅包装该脚本自己的监听器。
  var addEventListener = window.addEventListener
  window.addEventListener = function (type, listener, options) {
    var script = document.currentScript
    if (type === 'click' && script && script.id === 'click-heart' && typeof listener === 'function') {
      var original = listener
      listener = function (event) {
        if (isBlankClick(event)) return original.call(this, event)
      }
    }
    return addEventListener.call(this, type, listener, options)
  }

  // 丝带脚本是 defer：DOMContentLoaded 前已执行；此时只包装它注册的 onclick。
  document.addEventListener('DOMContentLoaded', function () {
    if (!document.getElementById('ribbon')) return
    var redraw = document.onclick
    if (typeof redraw !== 'function') return
    document.onclick = function (event) {
      if (isBlankClick(event)) return redraw.call(this, event)
    }
    // mobile:false 时不绘制丝带，同时禁用原脚本不加筛选的触摸重绘。
    if (document.ontouchstart === redraw) document.ontouchstart = null
  }, { once: true })
})()
