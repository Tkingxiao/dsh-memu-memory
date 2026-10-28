import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DIR = path.join(HERE, 'webui')

export const WEBUI_PATH = '/dsh-memu-memory/ui'
export const SETTINGS_PATH = '/dsh-memu-memory/settings'
const require = createRequire(import.meta.url)

export function standaloneAsset(pathname) {
  const assets = {
    '/dsh-memu-memory/ui-assets/react.js': () => path.join(path.dirname(require.resolve('react/package.json')), 'umd', 'react.production.min.js'),
    '/dsh-memu-memory/ui-assets/react-dom.js': () => path.join(path.dirname(require.resolve('react-dom/package.json')), 'umd', 'react-dom.production.min.js'),
    '/dsh-memu-memory/ui-assets/client.js': () => path.join(HERE, 'client.js'),
    '/dsh-memu-memory/ui-assets/graph-view.js': () => path.join(DIR, 'graph-view.bundle.js'),
    '/dsh-memu-memory/ui-assets/standalone.js': () => path.join(DIR, 'standalone.js'),
    '/dsh-memu-memory/ui-assets/icon.png': () => path.join(HERE, '..', 'assets', 'icon-256.png'),
    '/dsh-memu-memory/ui-assets/icon.svg': () => path.join(HERE, '..', 'assets', 'icon.svg'),
    '/dsh-memu-memory/ui-assets/mark.svg': () => path.join(DIR, 'mark.svg'),
  }
  const resolve = assets[pathname]
  return resolve ? fs.readFileSync(resolve(), pathname.endsWith('.png') ? undefined : 'utf8') : null
}

/** The studio stylesheet lives next to this file so it can be read and edited as CSS. */
export function standaloneCss() {
  return fs.readFileSync(path.join(DIR, 'standalone.css'), 'utf8')
}

/* The host paints React and the plugin's own component; this page only supplies
   the window, the chrome and the tokens. Every colour below is a fallback for the
   `--dsw-alias-*` names the component already reads, so there is exactly one
   design language instead of a second copy of the settings UI. */
export function standaloneHtml() {
  const css = standaloneCss()
  return `<!doctype html><html lang="zh-CN" data-standalone="1">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>MemU 记忆</title>
<meta name="theme-color" content="#f4f5f9">
<link rel="icon" href="/dsh-memu-memory/ui-assets/mark.svg" type="image/svg+xml"><link rel="alternate icon" href="/dsh-memu-memory/ui-assets/icon.png">
<script>try{var t=localStorage.getItem('dshm-theme');document.documentElement.dataset.theme=t||(window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light')}catch(e){}</script>
<style>
:root{--dsw-alias-bg-base:#f4f5f9;--dsw-alias-bg-layer-1:#ffffff;--dsw-alias-bg-layer-2:#eceef5;--dsw-alias-bg-layer-3:#e2e5ef;--dsw-alias-bg-layer-4:#d8dce9;--dsw-alias-label-primary:#1a1e2b;--dsw-alias-label-secondary:#5f6577;--dsw-alias-label-primary-inverted:#ffffff;--dsw-alias-border-l1:rgba(26,30,43,.10);--dsw-alias-border-l2:rgba(26,30,43,.18);--dsw-alias-brand-primary:#3b5bdb;--dsw-alias-brand-text:#ffffff;--dsw-alias-label-error:#b43e45;--dsw-alias-label-warning:#9a6b1f}
:root[data-theme=dark]{--dsw-alias-bg-base:#0d0f15;--dsw-alias-bg-layer-1:#171a23;--dsw-alias-bg-layer-2:#1e222d;--dsw-alias-bg-layer-3:#272c39;--dsw-alias-bg-layer-4:#313747;--dsw-alias-label-primary:#e9ebf4;--dsw-alias-label-secondary:#9ba2b5;--dsw-alias-label-primary-inverted:#0b1030;--dsw-alias-border-l1:rgba(233,235,244,.10);--dsw-alias-border-l2:rgba(233,235,244,.18);--dsw-alias-brand-primary:#8ea2ff;--dsw-alias-brand-text:#0b1030;--dsw-alias-label-error:#f08a91;--dsw-alias-label-warning:#d6a45f}
${css}
</style>
</head>
<body>
<a class="skip" href="#root" data-i18n="skip">跳到内容</a>
<div class="ambient" aria-hidden="true">
  <i></i><i></i><i></i>
  <div class="ambient-grid"></div>
  <div class="ambient-grain"></div>
  <div class="ambient-spot"></div>
</div>
<div class="app">
  <header class="topbar" role="banner">
    <a class="brand" href="#/settings/memories" aria-label="MemU 记忆" data-i18n-aria="brand">
      <span class="brand-icon"><svg viewBox="0 0 512 512" width="30" height="30" aria-hidden="true"><path fill="var(--dshm-brand)" d="M80 352V212C80 144 124 100 184 100C244 100 288 144 288 208V288C288 305.673 273.673 320 256 320C238.327 320 224 305.673 224 288V208C224 180 208 164 184 164C160 164 144 184 144 212V352C144 369.673 129.673 384 112 384C94.327 384 80 369.673 80 352Z"/><path fill="var(--dshm-brand-2)" d="M224 208C224 144 268 100 328 100C388 100 432 144 432 212V280H368V212C368 184 352 164 328 164C304 164 288 184 288 208H224Z"/><path fill="var(--dshm-coral)" d="M368 264H432V304C432 366 382 416 320 416H288C270.327 416 256 401.673 256 384C256 366.327 270.327 352 288 352H320C346.51 352 368 330.51 368 304V264Z"/></svg></span>
      <span class="brand-text">
        <span class="brand-name" data-i18n="brand">MemU 记忆</span>
        <span class="brand-sub">Memory Studio</span>
      </span>
    </a>
    <div class="crumb" id="pageLabel" aria-live="polite" data-i18n="memories">记忆总览</div>
    <div class="topbar-actions">
      <span class="sync-pill" title="数据留在本机，与 DSH 共用同一份记忆" data-i18n-title="syncHint"><i aria-hidden="true"></i><span data-i18n="sync">本地记忆</span></span>
      <button class="icon-btn" id="theme" type="button" aria-label="切换深浅色" title="切换深浅色" data-i18n-aria="theme" data-i18n-title="theme" aria-pressed="false">
        <span class="swap" aria-hidden="true">
          <svg class="i-sun" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/></svg>
          <svg class="i-moon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a6.6 6.6 0 0 0 9.8 9.8z"/></svg>
        </span>
      </button>
      <button class="icon-btn primary" id="back" type="button" aria-label="返回 DSH" title="返回 DSH" data-i18n-aria="backToDsh" data-i18n-title="backToDsh">
        <svg id="backIcon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/><path d="M9 12h11"/></svg>
        <span class="back-label" id="backLabel" data-i18n="backToDsh">返回 DSH</span>
      </button>
    </div>
  </header>
  <main class="stage" id="stage">
    <div id="root" aria-busy="true"></div>
  </main>
  <footer class="foot">
    <span data-i18n="brand">MemU 记忆</span><span class="dot" aria-hidden="true"></span><span data-i18n="footer">与 DSH 共用同一份记忆 · 本地优先</span>
    <span class="foot-right" id="hashLabel"></span>
  </footer>
</div>
<div class="boot" id="boot" role="status" aria-live="polite">
  <div class="boot-card">
    <span class="boot-icon"><svg viewBox="0 0 512 512" width="48" height="48" aria-hidden="true"><path fill="var(--dshm-brand)" d="M80 352V212C80 144 124 100 184 100C244 100 288 144 288 208V288C288 305.673 273.673 320 256 320C238.327 320 224 305.673 224 288V208C224 180 208 164 184 164C160 164 144 184 144 212V352C144 369.673 129.673 384 112 384C94.327 384 80 369.673 80 352Z"/><path fill="var(--dshm-brand-2)" d="M224 208C224 144 268 100 328 100C388 100 432 144 432 212V280H368V212C368 184 352 164 328 164C304 164 288 184 288 208H224Z"/><path fill="var(--dshm-coral)" d="M368 264H432V304C432 366 382 416 320 416H288C270.327 416 256 401.673 256 384C256 366.327 270.327 352 288 352H320C346.51 352 368 330.51 368 304V264Z"/></svg></span>
    <div class="boot-title" data-i18n="brand">MemU 记忆</div>
    <div class="boot-sub" data-i18n="opening">正在打开记忆工作室…</div>
    <div class="boot-bar" aria-hidden="true"><i></i></div>
  </div>
</div>
<noscript><p style="padding:40px;text-align:center">这个页面需要 JavaScript 才能打开记忆工作台。 / This page requires JavaScript.</p></noscript>
<script src="/dsh-memu-memory/ui-assets/react.js"></script>
<script src="/dsh-memu-memory/ui-assets/react-dom.js"></script>
<script src="/dsh-memu-memory/ui-assets/standalone.js"></script>
<script src="/dsh-memu-memory/ui-assets/client.js"></script>
</body>
</html>`
}

export function webUiHtml() {
  return standaloneHtml()
}
