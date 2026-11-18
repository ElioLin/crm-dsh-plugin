# 插件分发与自动升级

这份文档回答两件事：

1. 别人在自己的 DSH 里，怎么**通过「添加插件」装上**我们的插件；
2. 我们发新版之后，用户怎么被**提醒**、确认后怎么**自动升级**。

结论先放前面：**插件必须发布成一个 pnpm 能解析的包**（本文按公司私有 npm registry 写）。
代码目录直接 `link:` 进 profile 只能本机用，而且永远无法升级。

---

## 0. 链路总览

```
我们                          用户
──────────────────────────────────────────────────────────────
publish.mjs  ──────────────▶  profile/package.json 多一条依赖
   │                              │
   │                              ├─ pnpm 装进 profile/node_modules
   │                              └─ 包名进 dsh.profile.bundles
   │
生成 index.json ───────────▶  「插件 → 发现 → 索引源」加一次 URL
                                  └─ 搜到插件 → 点安装
                                  
新版本 publish ────────────▶  打开插件面板
                                  └─ update.check 查 dist-tags
                                       └─ 有新版 → 弹窗
                                            └─ 立即升级 → 宿主 installBundle
                                                 └─ 重启 DSH 生效
```

DSH 侧真正做安装的是 `@deepseek-ai/dsh-plugin-manager`：它把「加依赖 + pnpm add + 登记 bundle」
收成一个 `installBundle(spec)`。我们所有安装/升级动作最终都走它，不自己跑 pnpm。

---

## 1. 为什么不能继续用 `link:`

开发机上 profile 里长期是这种装法（包名是改名前那个）：

```json
"dsh-crm-workspace": "link:D:/GitProject/crm-dsh-plug"
```

这有三个后果：

- 只有这台机器、这个路径能用，别人装不了；
- 市场把 `link:` 判为 `kind: "linked"`，**明确不提供升级**；
- 版本号取的是目录里的 `package.json`，改了立刻生效，看起来很方便，但那不是用户环境。

改名成 `@runner-corp/dsh-scenario-workspace` 之后，本机开发态也要重装一次
（`pnpm add link:D:/GitProject/crm-dsh-plug` 会按新包名建立链接，旧的 `dsh-crm-workspace`
依赖要删掉，否则 profile 里会同时存在两个 bundle、同一个 loader id 撞车）。

所以分发的前提是：把它变成一个带版本号的 npm 包。

---

## 2. 发布到公司私有 registry

### 2.1 发布前检查

`package.json` 里这几个字段缺一不可（本项目已经具备）：

| 字段 | 作用 |
| --- | --- |
| `name` / `version` | 包名与版本，**版本号唯一真源** |
| `main` | Host 入口，`lib/index.js` |
| `dsh.bundle.patch` | 声明自己是 bundle 插件，DSH 靠它插入 loader 条目 |
| `dsh.client` | 声明客户端脚本与注入的宿主模块 |
| `files` | 发布白名单，漏了 `lib/` 或 patch 文件就装不起来 |

先做一次干跑，确认包内容对：

```bash
npm pack --dry-run
```

必须看到 `lib/`、`locale/`、`cordis.patch.yml`、`package.json`。

### 2.2 发布

公司源部署在测试服务器上（见 [`deploy/registry/README.md`](../deploy/registry/README.md)），
地址 `http://crmmcptest.runner-corp.com.cn:9001/`。

```bash
npm pack --ignore-scripts
node scripts/publish.mjs runner-corp-dsh-scenario-workspace-<版本>.tgz \
  http://crmmcptest.runner-corp.com.cn:9001/
```

**为什么不用 `npm publish`**：npm 客户端在发之前会检查本地有没有 token，没有就直接抛
`ENEEDAUTH`——哪怕服务端配的是匿名可发（`publish: $all`）。`scripts/publish.mjs` 直接走
registry 的 PUT 接口，不需要账号，也不改任何全局 npm 配置；它会自己算 sha1/sha512、
按 npm 约定命名附件，已存在的同版本会被服务端拒绝。

服务端把 `@runner-corp/*` 配成匿名可读可发；要收紧时改 `verdaccio.yaml` 的 `publish`
并让发布者 `npm adduser`（那里关了自助注册，需要手工开 `max_users`）。

包名固定是 `@runner-corp/dsh-scenario-workspace`，写在 `package.json` 的 `name`。
代码里读包名的地方统一走 `constants.js` 的 `PLUGIN_NAME`（从 manifest 读），
`cordis.patch.yml` 的 `name` 与客户端脚本的 `__ModuleLoader__.load({ id })` 必须与它一致
（`scripts/check.mjs` 会校验，`test/client.test.js` 也会拦）。

### 2.3 用户端必须能访问同一个源

用户机器上的 `~/.npmrc`（或 profile 目录下的 `.npmrc`）要有：

```ini
@runner-corp:registry=http://crmmcptest.runner-corp.com.cn:9001/
```

**这一步不能省。** 少了它，pnpm 会去公共源找一个不存在的 scope，报 `404`。

我们没有单独的 token，所以自更新检查也不需要凭据；如果将来给 registry 开了认证，
插件的检查逻辑会读同一份 `.npmrc`（按 registry 的 host+path 匹配 `_authToken`）。

---

## 3. 用户怎么装

### 方式 A：插件页安装框（任何版本都能用）

DSH 侧边栏 → **插件** → 安装 → 输入：

```
@runner-corp/dsh-scenario-workspace
```

确认后 DSH 会跑 pnpm 并提示是否需要重启。

### 方式 B：命令行

```bash
dsh plugin --profile <profile> add @runner-corp/dsh-scenario-workspace
```

适合批量部署脚本，`--profile` 指向用户的 profile 名（桌面端通常是 `desktop`）。

### 方式 C：发现页 + 公司索引源（DSH ≥ 0.2.1，体验最好）

生成索引：

```bash
npm run index                     # 输出 build/index.json
# 多个插件一起收：
node scripts/build-index.mjs --out build/index.json . ../another-plugin
```

把 `build/index.json` 放到任意可访问的静态地址（内网 nginx / 对象存储 / jsDelivr），
然后让用户在 **插件 → 发现 → 索引源** 里加这个 URL。之后他们能在列表里看到插件、
搜关键词、点一下安装，不用记包名。

索引是 format 1，`scripts/build-index.mjs` 会从 `package.json` 的 `dsh.index` 读展示信息：

```json
"dsh": {
  "index": {
    "titleZh": "场景工作台",
    "titleEn": "CRM Workspace Hub",
    "category": "workflow",
    "keywords": ["crm", "scenario"],
    "dshRange": ">=0.2.0"
  }
}
```

**发版后要重新生成并覆盖这个文件**，否则发现页还显示旧版本号。

> DSH < 0.2.1 没有「发现」页，用户只能用方式 A 或 B。三种方式可以并存，不冲突。

### 方式 D：公开市场（可选）

非敏感插件可以给 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
提 PR 加一条，官网与第三方市场 `dshmarket` 会自动收录（通常一天内）。内部业务插件不建议。

---

## 4. 自动升级是怎么工作的

宿主只提供 `installBundle`，**没有「检查更新」**（`@deepseek-ai/dsh-plugin-market` 也只负责
索引与安装）。所以这条链路是插件自己实现的，实现在 `lib/core/updater.js`。

### 4.1 时序

1. 用户打开插件面板 → 客户端调 `update.check`；
2. Host 读当前版本（`package.json`），请求 `<registry><name>/latest`，拿 `dist-tags` 指向的版本；
3. semver 比较，有新版本且不是用户「跳过」的版本 → 返回 `updateAvailable: true`；
4. 客户端弹窗：当前版本 → 最新版本 + 更新说明；
5. 用户点「立即升级」→ `update.apply`，后台调 `ctx.pluginManager.installBundle('<name>@<version>')`；
6. 客户端轮询 `update.status` 直到 `done` / `failed`；
7. 成功后提示**重启 DSH**（Host 代码在进程内，不重启还是旧代码）。

### 4.2 三个接口

| 方法 | 入参 | 说明 |
| --- | --- | --- |
| `update.check` | `{ force?: boolean }` | 默认 6 小时复用上次结果；`force` 强制重查 |
| `update.apply` | 无 | 立即返回 `{ phase: 'installing' }`，安装跑在后台 |
| `update.status` | 无 | `idle / installing / done / failed` + 失败原因 |
| `update.skip` | `{ version }` | 记下「这个版本不再提醒」，存在 `<dataDir>/updater.json` |

都挂在既有的 `/crm-workspace/api` 上（POST + JSON，同源校验不变）。

### 4.3 失败与安全边界

- **安装失败会自动回滚**：`installBundle` 失败时把 `package.json` 与 `pnpm-lock.yaml` 恢复原样，
  插件仍是升级前的版本；面板显示失败原因，不会谎报成功。
- **检查失败不打扰用户**：网络不通、401、404 都只返回 `ok:false`，面板照常打开，不弹窗。
  原因会写进返回的 `message`，用户手动点「检查更新」时能看到。
- **不会无限重试**：检查结果缓存 6 小时，避免每次开面板都打 registry。
- **不会静默降级到公共源**：`updateRegistry` 一旦显式配置，就只查那一个源。

### 4.4 关闭自动检查

`cordis.patch.yml`（或插件配置）：

```yaml
autoUpdateCheck: false
```

关掉后不主动查、不弹窗；用户仍可在 DSH 的插件页手动升级。

---

## 5. 后续插件怎么复用

`lib/core/updater.js` 零 npm 依赖，复制到新插件（或抽成内部包）后，Host 侧三行接入：

```js
import { createUpdater } from './core/updater.js';

const updater = createUpdater({
  name: PLUGIN_NAME,        // package.json 的 name
  version: PLUGIN_VERSION,  // package.json 的 version
  install: (spec) => ctx.pluginManager.installBundle(spec, { enabled: true }),
});
```

然后把 `updater` 传给 `createApi`，并在客户端挂载时调 `update.check`。
`updater.js` 里没有任何本项目的业务逻辑，只有「查版本 / 比版本 / 装版本 / 记跳过」。

如果以后插件多了，建议：

- 一个 `plugins-index` 仓库专门放 `index.json` 的生成与发布（CI 里跑 `build-index.mjs`）；
- `updater.js` 发成一个内部包（如 `@corp/dsh-plugin-updater`），各插件依赖同一份，
  修一个 bug 全部受益。代价是该包会成为运行期依赖，需要同步进各插件的 `files` 或依赖表。

---

## 6. 排障

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 安装报 `401` | 用户 `.npmrc` 没有该源的 `_authToken` | 补 token；`npm whoami --registry=...` 验证 |
| 安装报 `404` | registry 指错，或包名/scope 不对 | 确认 `.npmrc` 的 `registry` 与 `npm view <name>` |
| 升级报 release 太新 | pnpm 的 `minimumReleaseAge` 拦了新发布的版本 | 等窗口期，或在 profile 的 `pnpm-workspace.yaml` 加 `minimumReleaseAgeExclude: ['@runner-corp/dsh-scenario-workspace@x.y.z']` |
| 报 `incompatible-version` | 插件声明的 DSH 兼容范围与宿主不符 | 放宽 `dsh.index.dshRange`，或用 `dsh plugin version-exemptions` 授权 |
| 升级成功但界面没变 | Host 代码在进程内，未重启 | 重启 DSH；客户端脚本刷新页面即可 |
| 发现页搜不到 | index.json 没更新，或索引源 URL 不可达 | 重新生成并覆盖文件；浏览器直接打开该 URL 验证 |
| 「当前版本不是标准语义化版本」 | 装的是 `link:` 或 git 快照 | 改成 registry 安装 |

---

## 7. 版本与兼容

- **版本号唯一真源是 `package.json`**：`lib/core/constants.js` 的 `PLUGIN_VERSION` 与
  `PLUGIN_NAME` 直接读 manifest，客户端 `CLIENT_VERSION` 由 `test/client.test.js` 核对一致。
  发版只改 `package.json` 一处，然后同步 `lib/client.js` 的 `CLIENT_VERSION`（测试会拦住漏改）。
- **DSH 兼容范围**写在 `dsh.index.dshRange`（默认 `>=0.2.0`），会随索引下发，并在市场里展示。
  装到范围外时 `installBundle` 会在 pnpm 之前就拒绝，不会下载半个包。
- **升级不继承版本豁免**：给某个版本开过 `acceptRisk` 豁免，升级到新版本后需要重新授权。
