// ==UserScript==
// @name         烧饼论坛 自动签到 (CAP 版)
// @namespace    https://sb.sb/
// @version      2.2.1
// @description  在 Safari 打开烧饼论坛时自动完成 /checkin/ 每日签到（cap 工作量证明由站点自身组件完成）。
// @match        *://sb.sb/*
// @updateURL    https://raw.githubusercontent.com/justin0406/Scripts/main/sb-auto-signin.user.js
// @downloadURL  https://raw.githubusercontent.com/justin0406/Scripts/main/sb-auto-signin.user.js
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// @license      GPL-3.0
// ==/UserScript==

/*
 * 版本说明（2.0.0）
 * 站点早已不是「/signin/ + 原生表单 + cap-token 手填」的旧结构：
 *   1. /signin/ 会 302 到 /checkin/，真实签到页是 /checkin/
 *   2. 签到表单是 .signin-form，验证码容器是 [data-signin-cap] 里的 <cap-widget>
 *   3. cap token 通过 <cap-widget> 的 "solve" 事件 detail.token 交付，
 *      站点自己的监听器会写入 input[name="cap-token"] 并 requestSubmit()
 *   4. cap 的 JS 只在登录后的签到页加载，其它页面没有这个自定义元素
 * 所以本脚本不再自己解题、不再拼表单字段，只做：
 *   判断状态 → 触发站点自己的提交流程 → 兜底戳一下 widget → 回查确认
 */

(function () {
    'use strict';

    const LOG = '[SB-CAP]';
    const CHECKIN_URL = '/checkin/';
    const HOME_URL = '/';
    const KEY_LAST = 'sbCapLastSignin';
    const KEY_NAV = 'sbCapAutoNav';
    const VERIFY_TRIES = 14;
    const VERIFY_GAP = 1500;

    let busy = false;
    let watched = false;

    /* ---------- 基础工具 ---------- */
    const log = (...a) => console.log(LOG, ...a);
    const warn = (...a) => console.warn(LOG, ...a);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    const todayKey = () => {
        const d = new Date();
        return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
    };

    /* Stay / 其它管理器不一定提供 GM_*：全部包一层，失败退回 localStorage */
    const store = {
        get(key, fallback = '') {
            try {
                if (typeof GM_getValue === 'function') {
                    const v = GM_getValue(key, fallback);
                    return v === undefined || v === null ? fallback : v;
                }
            } catch (e) { /* fallthrough */ }
            try { return localStorage.getItem(key) ?? fallback; } catch (e) { return fallback; }
        },
        set(key, value) {
            try {
                if (typeof GM_setValue === 'function') { GM_setValue(key, value); return; }
            } catch (e) { /* fallthrough */ }
            try { localStorage.setItem(key, value); } catch (e) { /* ignore */ }
        }
    };

    const session = {
        get(key) { try { return sessionStorage.getItem(key); } catch (e) { return null; } },
        set(key, value) { try { sessionStorage.setItem(key, value); } catch (e) { /* ignore */ } },
        del(key) { try { sessionStorage.removeItem(key); } catch (e) { /* ignore */ } }
    };

    function toast(msg, kind = 'info') {
        const colors = { info: '#333', success: '#1a7f37', warn: '#9a6700', error: '#b42318' };
        const el = document.createElement('div');
        el.textContent = msg;
        el.style.cssText = [
            'position:fixed', 'left:50%', 'bottom:28px', 'transform:translateX(-50%)',
            'z-index:2147483647', 'padding:10px 16px', 'border-radius:10px',
            'font-size:14px', 'line-height:1.4', 'max-width:80vw', 'text-align:center',
            'color:#fff', 'box-shadow:0 6px 24px rgba(0,0,0,.25)',
            `background:${colors[kind] || colors.info}`, 'transition:opacity .3s',
            'font-family:-apple-system,BlinkMacSystemFont,sans-serif'
        ].join(';');
        document.body.appendChild(el);
        setTimeout(() => {
            el.style.opacity = '0';
            setTimeout(() => el.remove(), 350);
        }, kind === 'error' ? 4200 : 2600);
    }

    async function waitFor(fn, timeout = 8000, step = 150) {
        const end = Date.now() + timeout;
        while (Date.now() < end) {
            try {
                const v = fn();
                if (v) return v;
            } catch (e) { /* ignore */ }
            await sleep(step);
        }
        return null;
    }

    /* ---------- 站点状态（以服务端返回为准） ---------- */
    async function fetchText(url) {
        const res = await fetch(url, { credentials: 'include', cache: 'no-store', redirect: 'follow' });
        return await res.text();
    }

    function stripHtml(html) {
        return html
            .replace(/<script[\s\S]*?<\/script>/gi, ' ')
            .replace(/<style[\s\S]*?<\/style>/gi, ' ')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ');
    }

    async function serverState() {
        const html = await fetchText(CHECKIN_URL);
        const text = stripHtml(html);
        return {
            signed: /今日已签到/.test(text),
            loggedIn: /\/logout\//.test(html),
            hasForm: /signin-form/.test(html) || /data-signin-cap/.test(html)
        };
    }

    /* fetch 在部分注入环境里会失败，所以判断一律先用当前 DOM，网络只做兜底 */
    function pageSigned() {
        try { return /今日已签到/.test(document.body.innerText || ''); } catch (e) { return false; }
    }

    function pageGuest() {
        try {
            const html = document.documentElement.innerHTML;
            return !/\/logout\//.test(html) && /href="\/login\//.test(html);
        } catch (e) { return false; }
    }

    async function safeState() {
        try { return await serverState(); } catch (e) { return null; }
    }

    function findForm() {
        const direct = document.querySelector('form.signin-form');
        if (direct) return direct;
        const capHost = document.querySelector('[data-signin-cap]');
        if (capHost && capHost.closest('form')) return capHost.closest('form');
        return [...document.querySelectorAll('form')].find((f) =>
            /checkin|signin/i.test(f.getAttribute('action') || '')
        ) || null;
    }

    /* ---------- cap widget：不自己解题，只把它推起来 ---------- */
    function press(el) {
        const opt = { bubbles: true, cancelable: true, composed: true, pointerType: 'mouse', isPrimary: true };
        [['PointerEvent', 'pointerdown', opt], ['MouseEvent', 'mousedown', {}],
         ['PointerEvent', 'pointerup', opt], ['MouseEvent', 'mouseup', {}],
         ['MouseEvent', 'click', {}]].forEach(([Ctor, type, o]) => {
            try { el.dispatchEvent(new window[Ctor](type, o)); } catch (e) { /* ignore */ }
        });
        try { el.click(); } catch (e) { /* ignore */ }
    }

    async function nudge(widget) {
        try { widget.focus(); } catch (e) { /* ignore */ }

        for (let i = 0; i < 4; i += 1) {
            if (widget.token) return widget.token;
            const sr = widget.shadowRoot;
            const trigger = sr && sr.querySelector('.captcha-trigger');
            if (trigger) press(trigger);
            await sleep(1500);
        }
        return widget.token || null;
    }

    /* ---------- 回查确认 ---------- */
    async function verifySigned() {
        for (let i = 0; i < VERIFY_TRIES; i += 1) {
            await sleep(VERIFY_GAP);
            if (pageSigned()) return true;
            const st = await safeState();
            if (st && st.signed) return true;
        }
        return false;
    }

    function markDone() {
        store.set(KEY_LAST, todayKey());
    }

    /* 签到完成后回到论坛首页；延迟一点让 toast 能被看到 */
    function goHome(delay = 1200) {
        if (location.pathname === HOME_URL) return;
        log('签到完成，返回首页');
        setTimeout(() => {
            try { location.assign(HOME_URL); } catch (e) { location.href = HOME_URL; }
        }, delay);
    }

    /* ---------- 在签到页执行 ---------- */
    async function signOnPage() {
        if (pageSigned()) { markDone(); log('今日已签到'); goHome(); return true; }
        if (pageGuest()) { log('未登录，跳过'); return false; }

        const form = findForm() || (await waitFor(findForm, 6000, 300));
        if (!form) {
            const st = await safeState();
            if (st && st.signed) { markDone(); log('今日已签到'); goHome(); return true; }
            warn('未找到签到入口（可能未登录或页面结构已变化）');
            return false;
        }
        return await signWithForm(form);
    }

    async function signWithForm(form) {
        const capHost = form.querySelector('[data-signin-cap]') || form;
        const tokenInput = () => form.querySelector('input[name="cap-token"]');

        await sleep(300);

        // 站点行为：拦截无 cap-token 的 submit → 展开面板 → focus widget
        const btn = form.querySelector('button[type="submit"], input[type="submit"], button');
        if (btn && !btn.disabled) {
            btn.click();
            log('点击签到按钮');
        } else if (typeof form.requestSubmit === 'function') {
            form.requestSubmit();
            log('触发 requestSubmit');
        } else {
            form.submit();
            log('触发 submit');
        }

        const widget = await waitFor(() => capHost.querySelector('cap-widget'), 8000, 200);
        if (widget) {
            log('cap-widget 已出现，等待解出 token');
            await nudge(widget);
        } else {
            warn('未出现 cap-widget');
        }

        // 站点自己会在 solve 后写 token 并重新提交
        await waitFor(() => {
            const i = tokenInput();
            return i && i.value;
        }, 45000, 300);

        const ok = await verifySigned();
        if (ok) {
            markDone();
            toast('自动签到成功', 'success');
            log('签到成功');
            goHome();
        } else {
            toast('自动签到未确认，请手动点击一次', 'error');
            warn('签到未确认');
        }
        return ok;
    }

    /* ---------- 主流程 ---------- */
    const isSigninPath = () => /^\/(checkin|signin)\/?$/.test(location.pathname);

    async function run(auto = false, force = false) {
        if (busy) return;
        busy = true;
        try {
            if (!force && auto && store.get(KEY_LAST, '') === todayKey()) {
                log('今日已处理，跳过');
                return;
            }

            if (isSigninPath()) {
                await signOnPage();
                return;
            }

            if (force) {
                log('手动触发，进入签到页', CHECKIN_URL);
                location.assign(CHECKIN_URL);
                return;
            }

            // 刚签到完被送回首页时不要再跳，避免来回弹
            if (document.referrer && document.referrer.includes('/checkin')) {
                log('刚从签到页返回，停止');
                return;
            }

            // 其它页面：直接去签到页，不做网络探测（fetch 被拦时会静默失败）
            log('进入签到页', CHECKIN_URL);
            location.assign(CHECKIN_URL);
        } catch (e) {
            warn('主流程异常', e);
        } finally {
            busy = false;
        }
    }

    /* SPA 客户端路由：切到签到页时再跑一次 */
    function watchRoute() {
        if (watched) return;
        watched = true;
        let last = location.pathname;
        setInterval(() => {
            if (location.pathname === last) return;
            last = location.pathname;
            if (isSigninPath()) setTimeout(() => run(false), 800);
        }, 1000);
    }

    /* ---------- 菜单 ---------- */
    if (typeof GM_registerMenuCommand === 'function') {
        GM_registerMenuCommand('立即签到（强制）', () => {
            store.set(KEY_LAST, '');
            run(false, true);
        });
        GM_registerMenuCommand('重置今日签到状态', () => {
            store.set(KEY_LAST, '');
            toast('已重置，下次载入将重新签到');
        });
    }

    /* ---------- 启动 ---------- */
    const kick = () => {
        log('v2.2.1 loaded', location.href, 'signedToday=', pageSigned());
        setTimeout(() => run(true), 1200);
        watchRoute();
    };
    if (document.readyState === 'complete') kick();
    else window.addEventListener('load', kick, { once: true });
})();
