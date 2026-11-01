# Scripts

个人脚本 / Userscripts 集合。

| 文件 | 说明 | 安装 |
|---|---|---|
| `sb-auto-signin.user.js` | 烧饼论坛 (sb.sb) 自动签到。打开论坛自动判断状态，未签到则跳到 `/checkin/`，触发站点自身的签到表单与 cap 组件完成验证并回查确认 | [安装](https://raw.githubusercontent.com/justin0406/Scripts/main/sb-auto-signin.user.js) |
| `cloud139.js` | 中国移动云盘（139 云盘）自动任务，已修复 JWT 登录端点 | 由订阅引用 |

> `cloud139.js` 自 `justin0406/Rules` 迁移而来。

## 烧饼论坛自动签到说明

原 `烧饼论坛 Pro` 内置的「自动签到」只 POST `_csrf`，不含 `cap-token`，必然被 cap 拦截。

站点的签到页是 `/checkin/`（`/signin/` 会 302 过去）。提交时会先拦下没有 `cap-token` 的表单，展开 `[data-signin-cap]` 里的 `<cap-widget>`，解出后由站点自己写入 `cap-token` 并重新提交。本脚本不重复实现这套逻辑，只负责触发它，然后回查 `/checkin/` 确认结果。

**安装后请关闭 Pro 脚本里的「自动签到」开关**，避免重复请求与失败提示。
