(function () {
  'use strict'

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  var locale = String(navigator.language || navigator.userLanguage || '').toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en'
  var COPY = {
    zh: {
      skip: '跳到内容', brand: 'MemU 记忆', memories: '记忆总览', sync: '本地记忆',
      syncHint: '数据留在本机，与 DSH 共用同一份记忆', theme: '切换深浅色',
      backToDsh: '返回 DSH', close: '关闭', back: '返回',
      footer: '与 DSH 共用同一份记忆 · 本地优先', opening: '正在打开记忆工作室…',
      bootFailed: '打不开记忆工作台', reload: '重新加载', unknown: '未知错误',
    },
    en: {
      skip: 'Skip to content', brand: 'MemU Memory', memories: 'Memories', sync: 'Local memory',
      syncHint: 'Stays on this machine and is shared with DSH', theme: 'Toggle light or dark',
      backToDsh: 'Back to DSH', close: 'Close', back: 'Back',
      footer: 'Shares the same memory as DSH · local-first', opening: 'Opening the memory studio…',
      bootFailed: 'The memory studio failed to open', reload: 'Reload', unknown: 'Unknown error',
    },
  }
  var PAGE_NAMES = {
    zh: {
      engine: '引擎与连接', settings: '记忆设置', folders: '文件夹', libraries: '记忆库',
      browser: '记忆浏览', global: '全局记忆', prompts: '提示词', stats: '统计', memories: '记忆总览',
    },
    en: {
      engine: 'Engine & connection', settings: 'Memory settings', folders: 'Folders', libraries: 'Libraries',
      browser: 'Memory browser', global: 'Global memory', prompts: 'Prompts', stats: 'Stats', memories: 'Memories',
    },
  }
  var copy = COPY[locale]
  document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en'
  function applyCopy() {
    var nodes = document.querySelectorAll('[data-i18n]')
    for (var i = 0; i < nodes.length; i++) {
      var key = nodes[i].getAttribute('data-i18n')
      if (copy[key]) nodes[i].textContent = copy[key]
    }
    var titled = document.querySelectorAll('[data-i18n-title]')
    for (var j = 0; j < titled.length; j++) {
      var titleKey = titled[j].getAttribute('data-i18n-title')
      if (copy[titleKey]) titled[j].setAttribute('title', copy[titleKey])
    }
    var labelled = document.querySelectorAll('[data-i18n-aria]')
    for (var k = 0; k < labelled.length; k++) {
      var ariaKey = labelled[k].getAttribute('data-i18n-aria')
      if (copy[ariaKey]) labelled[k].setAttribute('aria-label', copy[ariaKey])
    }
  }
  applyCopy()
  var root = document.getElementById('root')
  var boot = document.getElementById('boot')
  var pageLabel = document.getElementById('pageLabel')
  var hashLabel = document.getElementById('hashLabel')
  var themeBtn = document.getElementById('theme')
  var themeMeta = document.querySelector('meta[name="theme-color"]')

  /* ── theme ─────────────────────────────────────────────────────────────── */
  function currentTheme() {
    return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
  }
  function paintTheme(value) {
    document.documentElement.dataset.theme = value
    if (themeMeta) themeMeta.setAttribute('content', value === 'dark' ? '#0d0f15' : '#f4f5f9')
    if (themeBtn) themeBtn.setAttribute('aria-pressed', value === 'dark' ? 'true' : 'false')
  }
  function setTheme(value, animate) {
    var run = function () {
      paintTheme(value)
      try { localStorage.setItem('dshm-theme', value) } catch (e) {}
    }
    // A cross-fade of the whole snapshot is the cheapest transition that still
    // feels intentional; unsupported browsers simply repaint.
    if (animate && !reduceMotion && typeof document.startViewTransition === 'function') {
      document.startViewTransition(run)
      return
    }
    run()
  }
  paintTheme(currentTheme())
  themeBtn?.addEventListener('click', function () {
    setTheme(currentTheme() === 'dark' ? 'light' : 'dark', true)
  })
  // No explicit choice follows the OS; an explicit one wins and is mirrored to
  // other tabs through the storage event.
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', function (event) {
    var stored = null
    try { stored = localStorage.getItem('dshm-theme') } catch (e) {}
    if (!stored) setTheme(event.matches ? 'dark' : 'light', true)
  })
  window.addEventListener('storage', function (event) {
    if (event.key === 'dshm-theme' && event.newValue) setTheme(event.newValue, false)
  })

  /* ── chrome: page label, title, footer, return control ─────────────────── */
  function currentSlug() {
    var match = /^#\/settings\/([a-z]+)/.exec(String(window.location.hash || ''))
    return match && PAGE_NAMES[locale][match[1]] ? match[1] : 'memories'
  }
  function paintLocation() {
    var slug = currentSlug()
    var label = PAGE_NAMES[locale][slug]
    if (pageLabel) pageLabel.textContent = label
    if (hashLabel) hashLabel.textContent = '#/settings/' + slug
    document.title = label + ' · ' + copy.brand
  }
  paintLocation()
  window.addEventListener('hashchange', paintLocation)
  window.addEventListener('dsh-memu-memory:navigation', paintLocation)

  var framed = false
  try { framed = window.self !== window.top } catch (e) { framed = true }
  var canReturn = Boolean(window.opener && !window.opener.closed) || window.history.length > 1
  var back = document.getElementById('back')
  var backIcon = document.getElementById('backIcon')
  var backLabel = document.getElementById('backLabel')
  if (framed) {
    if (backIcon) backIcon.innerHTML = '<path d="M6 6l12 12M18 6L6 18"/>'
    if (backLabel) backLabel.textContent = copy.close
    back?.setAttribute('aria-label', copy.close)
    back?.setAttribute('title', copy.close)
  } else if (!canReturn) {
    if (back) back.hidden = true
  } else {
    var fromTab = Boolean(window.opener && !window.opener.closed)
    if (backLabel) backLabel.textContent = fromTab ? copy.backToDsh : copy.back
    if (backIcon) backIcon.innerHTML = '<path d="M15 18l-6-6 6-6"/><path d="M9 12h11"/>'
  }
  back?.addEventListener('click', function () {
    if (framed) {
      // The player owns the overlay; only it can remove the iframe.
      try { window.parent.postMessage({ type: 'dsh-memu-memory-webui-close' }, window.location.origin) } catch (e) {}
      return
    }
    if (window.opener && !window.opener.closed) {
      try { window.opener.focus() } catch (e) {}
      try { window.close(); return } catch (e) {}
    }
    if (window.history.length > 1) window.history.back()
  })

  /* ── ambience: pointer spotlight and a shadow once the page scrolls ────── */
  if (!reduceMotion && window.matchMedia('(pointer: fine)').matches) {
    document.body.dataset.pointer = 'fine'
    var pending = 0
    window.addEventListener('pointermove', function (event) {
      if (pending) return
      pending = window.requestAnimationFrame(function () {
        pending = 0
        var style = document.documentElement.style
        style.setProperty('--spot-x', event.clientX + 'px')
        style.setProperty('--spot-y', event.clientY + 'px')
      })
    }, { passive: true })
  }
  function paintScroll() {
    document.body.dataset.scrolled = window.scrollY > 8 ? 'true' : 'false'
  }
  paintScroll()
  window.addEventListener('scroll', paintScroll, { passive: true })

  /* ── boot ──────────────────────────────────────────────────────────────── */
  var settled = false
  function ready() {
    if (settled) return
    settled = true
    document.body.dataset.ready = 'true'
    root?.removeAttribute('aria-busy')
    // Free the overlay once the fade finished; keeping a fixed, blurred element
    // alive forever costs compositing on every scroll.
    window.setTimeout(function () { boot?.remove() }, 900)
  }
  function markReady() {
    // rAF is the smooth path; the timer is the fallback for hidden tabs and
    // throttled frames, where rAF may not fire for minutes.
    window.requestAnimationFrame(function () {
      window.requestAnimationFrame(ready)
    })
    window.setTimeout(ready, 140)
  }
  function bootFailed(error) {
    var sub = boot?.querySelector('.boot-sub')
    var title = boot?.querySelector('.boot-title')
    if (title) title.textContent = copy.bootFailed
    if (sub) sub.textContent = String((error && error.message) || error || copy.unknown)
    boot?.querySelector('.boot-bar')?.remove()
    if (boot && !boot.querySelector('.boot-retry')) {
      var button = document.createElement('button')
      button.className = 'icon-btn primary boot-retry'
      button.type = 'button'
      button.textContent = copy.reload
      button.style.marginTop = '10px'
      button.addEventListener('click', function () { window.location.reload() })
      boot.querySelector('.boot-card')?.appendChild(button)
    }
    document.body.dataset.ready = 'false'
    if (root) root.setAttribute('aria-busy', 'false')
  }

  window.__ModuleLoader__ = {
    load: function (spec) {
      var api = spec.factory(function (name) {
        if (name === 'react') return window.React
        if (name === 'react-dom/client') return window.ReactDOM
        throw new Error('Unsupported standalone dependency: ' + name)
      })
      var query = new URLSearchParams(window.location.search)
      try {
        api.mountStandalone(root, { sessionId: query.get('surface') === 'sidebar' ? query.get('sessionId') : null })
        markReady()
      } catch (error) {
        console.error('dsh-memu-memory: standalone mount failed', error)
        bootFailed(error)
      }
    },
  }
})()
