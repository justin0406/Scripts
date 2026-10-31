// ==UserScript==
// @name         烧饼论坛 自动签到 (CAP 版)
// @namespace    https://sb.sb/
// @version      1.1
// @description  修复 sb.sb 自动签到：绕过 cap 验证码，注入 cap-widget 自动解出 cap-token 后提交签到。可独立使用，替代「烧饼论坛 Pro」内置的自动签到。
// @match        *://sb.sb/*
// @updateURL    https://raw.githubusercontent.com/justin0406/Scripts/main/sb-auto-signin.user.js
// @downloadURL  https://raw.githubusercontent.com/justin0406/Scripts/main/sb-auto-signin.user.js
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// @license      GPL-3.0
// ==/UserScript==

(function () {
    'use strict';

    /* ============ 配置 ============ */
    const CAP_ENDPOINT = 'https://capjs.net/415786673b/'; // 站点使用的 cap 服务端
    const SIGNIN_URL = '/signin/';
    const KEY_LAST = 'sbCapLastSignin';
    const KEY_FORCE = 'sbCapForceSignin';
    const LOG = '[SB-CAP]';

    const today = () => new Date().toLocaleDateString('zh-CN');
    const log = (...a) => console.log(LOG, ...a);
    const warn = (...a) => console.warn(LOG, ...a);

    /* ============ 小工具 ============ */
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    async function waitFor(fn, timeout = 15000, step = 100) {
        const end = Date.now() + timeout;
        while (Date.now() < end) {
            try { const v = fn(); if (v) return v; } catch (e) { /* ignore */ }
            await sleep(step);
        }
        return null;
    }

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
        setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 350); }, kind === 'error' ? 4200 : 2600);
    }

    function isLoggedIn() {
        // 未登录时页面顶部/侧栏会有指向 /login/ 的入口
        if (document.querySelector('a[href="/login/"], a[href^="/login/"]')) return false;
        // 存在用户名元素或退出登录入口则视为已登录
        if (document.querySelector('a[href="/logout/"], [data-username]')) return true;
        return true; // 保守：交给后续接口判断
    }

    /* ============ 核心：解决 cap 验证码 ============ */
    // 返回 { token } | { blocked } | null(超时)
    async function solveCap() {
        // 优先复用页面上已有的 widget（例如就在 /signin/ 页）
        let widget = document.querySelector('cap-widget');
        let injected = false;

        if (!widget) {
            widget = document.createElement('cap-widget');
            widget.id = '__sb_cap_widget';
            widget.setAttribute('data-cap-api-endpoint', CAP_ENDPOINT);
            // 放到视口内但几乎不可见，避免某些环境对不可见元素不触发
            widget.style.cssText = 'position:fixed;left:0;bottom:0;width:1px;height:1px;'
                + 'opacity:0.01;pointer-events:none;z-index:-1';
            document.body.appendChild(widget);
            injected = true;
        }

        const sr = await waitFor(() => widget.shadowRoot, 5000);
        if (!sr) { if (injected) widget.remove(); warn('widget 未渲染'); return null; }

        // 已经解过就直接用
        if (widget.token) {
            if (injected) setTimeout(() => widget.remove(), 1200);
            return { token: widget.token };
        }

        const trigger = sr.querySelector('.captcha-trigger');
        if (!trigger) { if (injected) widget.remove(); warn('找不到验证触发元素'); return null; }

        // 程序化点击（实测可直接通过，无需真实手势）
        const press = (el) => {
            const opt = { bubbles: true, cancelable: true, composed: true, pointerType: 'mouse', isPrimary: true };
            try { el.dispatchEvent(new PointerEvent('pointerdown', opt)); } catch (e) {}
            try { el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); } catch (e) {}
            try { el.dispatchEvent(new PointerEvent('pointerup', opt)); } catch (e) {}
            try { el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true })); } catch (e) {}
            try { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); } catch (e) {}
            try { el.click(); } catch (e) {}
        };
        press(trigger);

        const cap = sr.querySelector('.captcha');

        // 等待 token 出现（widget 解完会写入 .token 属性，并回填隐藏域）
        const token = await waitFor(() => {
            if (widget.token) return widget.token;
            const hidden = document.querySelector('input[name="cap-token"]');
            if (hidden && hidden.value) return hidden.value;
            return null;
        }, 30000, 200);

        if (!token) {
            const state = cap && cap.getAttribute('data-state');
            warn('未取得 token, state =', state);
            if (injected) widget.remove();
            return state === 'error' ? { blocked: true } : null;
        }

        if (injected) setTimeout(() => widget.remove(), 1200);
        return { token };
    }

    /* ============ 读取签到页状态 ============ */
    async function fetchSigninDoc() {
        const res = await fetch(SIGNIN_URL, { credentials: 'include', cache: 'no-store' });
        if (!res.ok && !res.redirected) throw new Error('HTTP ' + res.status);
        const html = await res.text();
        return {
            doc: new DOMParser().parseFromString(html, 'text/html'),
            finalUrl: res.url || SIGNIN_URL
        };
    }

    function parseSigninDoc(doc) {
        const text = doc.body ? doc.body.textContent || '' : '';
        const signedIn = /今日已签到|已经签到|已签到/.test(text);
        const csrf = (doc.querySelector('input[name="_csrf"]') || {}).value || null;
        // 找到真正的签到表单（排除搜索框）
        const forms = [...doc.querySelectorAll('form')];
        const form = forms.find((f) => (f.getAttribute('action') || '').includes('/signin/'))
            || forms.find((f) => f.querySelector('input[name="cap-token"]'))
            || null;
        let fields = {};
        if (form) {
            [...form.querySelectorAll('input')].forEach((el) => {
                if (!el.name || el.type === 'submit' || el.type === 'button') return;
                if (el.name === 'cap-token') return; // 稍后填
                fields[el.name] = el.value;
            });
        }
        const btn = doc.querySelector('.signin-hero-action button, form button[type="submit"]');
        const disabled = btn ? !!btn.disabled : false;
        return { signedIn: signedIn || disabled, csrf, form, fields };
    }

    /* ============ 静默签到（不离开当前页） ============ */
    async function silentSignin() {
        const { doc } = await fetchSigninDoc();
        const info = parseSigninDoc(doc);
        if (info.signedIn) return { ok: true, already: true };
        if (!info.csrf) throw new Error('缺少 CSRF');

        const solved = await solveCap();
        if (!solved || !solved.token) return { ok: false, reason: 'cap_failed' };

        // 组装提交体：沿用页面上的隐藏字段，补上 cap-token
        const body = new URLSearchParams(info.fields);
        if (!body.has('_csrf')) body.set('_csrf', info.csrf);
        body.set('cap-token', solved.token);

        const res = await fetch(SIGNIN_URL, {
            method: 'POST',
            credentials: 'include',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'X-Requested-With': 'XMLHttpRequest'
            },
            body: body.toString()
        });
        const html = await res.text();
        const after = parseSigninDoc(new DOMParser().parseFromString(html, 'text/html'));
        const ok = after.signedIn || res.redirected;
        log('POST', res.status, 'ok =', ok);
        return { ok, status: res.status, already: false };
    }

    /* ============ 回退方案：在 /signin/ 页面上原生提交 ============ */
    async function pageSignin() {
        const form = [...document.querySelectorAll('form')]
            .find((f) => (f.getAttribute('action') || '').includes('/signin/'))
            || [...document.querySelectorAll('form')].find((f) => f.querySelector('input[name="cap-token"]'));
        if (!form) return { ok: false, reason: 'no_form' };

        const solved = await solveCap();
        if (!solved || !solved.token) return { ok: false, reason: 'cap_failed' };

        // 确保隐藏域已填（widget 通常会自己填，这里兜底）
        let hidden = form.querySelector('input[name="cap-token"]');
        if (!hidden) {
            hidden = document.createElement('input');
            hidden.type = 'hidden';
            hidden.name = 'cap-token';
            form.appendChild(hidden);
        }
        hidden.value = solved.token;

        // 交给浏览器原生提交：Origin/Referer/_csrf 全部天然正确
        HTMLFormElement.prototype.submit.call(form);
        return { ok: true, navigated: true };
    }

    /* ============ 主流程 ============ */
    const KEY_TRIES = 'sbCapTries';

    async function run(force = false) {
        if (!force && GM_getValue(KEY_LAST, '') === today()) return;
        if (!isLoggedIn()) { log('未登录，跳过'); return; }

        const onSigninPage = /^\/signin\/?/.test(location.pathname);
        const forceFlag = sessionStorage.getItem(KEY_FORCE) === '1';
        let tries = Number(sessionStorage.getItem(KEY_TRIES) || 0);

        try {
            if (onSigninPage || forceFlag) {
                sessionStorage.removeItem(KEY_FORCE);
                const r = await pageSignin();
                if (r.ok) {
                    GM_setValue(KEY_LAST, today());
                    sessionStorage.removeItem(KEY_TRIES);
                    return; // 页面会跳转，由下次加载确认
                }
                warn('页面签到失败', r.reason);
                // 已经在签到页仍失败 -> 不再跳转，避免死循环
                if (onSigninPage) { toast('自动签到失败，请手动点击验证', 'error'); return; }
            }

            const r = await silentSignin();
            if (r.ok) {
                GM_setValue(KEY_LAST, today());
                sessionStorage.removeItem(KEY_TRIES);
                if (!r.already) toast('自动签到成功', 'success');
                log('签到完成');
                return;
            }

            log('静默签到未成功，尝试跳转签到页');
            if (tries >= 2) { toast('自动签到失败，请手动签到', 'error'); return; }
            sessionStorage.setItem(KEY_TRIES, String(tries + 1));
            sessionStorage.setItem(KEY_FORCE, '1');
            location.assign(SIGNIN_URL);
        } catch (e) {
            warn('签到异常', e);
        }
    }

    /* ============ 菜单命令 ============ */
    if (typeof GM_registerMenuCommand === 'function') {
        GM_registerMenuCommand('立即签到（强制）', () => {
            GM_setValue(KEY_LAST, '');
            run(true);
        });
        GM_registerMenuCommand('重置今日签到状态', () => {
            GM_setValue(KEY_LAST, '');
            toast('已重置，下次载入将重新签到');
        });
    }

    /* ============ 启动 ============ */
    // 页面加载完成后延迟一点，等论坛自身脚本就绪
    const kick = () => setTimeout(() => run(false), 1500);
    if (document.readyState === 'complete') kick();
    else window.addEventListener('load', kick, { once: true });
})();
