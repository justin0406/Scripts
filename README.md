# Scripts

个人脚本 / Userscripts 集合。

| 文件 | 说明 | 安装 |
|---|---|---|
| `sb-auto-signin.user.js` | 烧饼论坛 (sb.sb) 自动签到。注入 cap-widget 自动解出 `cap-token` 后提交，含静默与回退两条路径 | [安装](https://raw.githubusercontent.com/justin0406/Scripts/main/sb-auto-signin.user.js) |
| `cloud139.js` | 中国移动云盘（139 云盘）自动任务，已修复 JWT 登录端点 | 由订阅引用 |

> `cloud139.js` 自 `justin0406/Rules` 迁移而来。

## 烧饼论坛自动签到说明

原 `烧饼论坛 Pro` 内置的「自动签到」只 POST `_csrf`，不含 `cap-token`，必然被 cap 拦截。
本脚本在页面内注入 `<cap-widget>`，程序化点击触发验证（无需真实手势），拿到 token 后再提交。

**安装后请关闭 Pro 脚本里的「自动签到」开关**，避免重复请求与失败提示。
