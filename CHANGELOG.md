# 变更记录

## 1.13.0

把「场景介绍」和「开场引导语」合并成一个字段，并反转两个字段的必填性：管理员只写一次文案，
填的却是这一次真正要模型执行的内容。

### 破坏性改动

- **字段合并**：`welcomeMessage` 不再是卡片字段。它原来在四个地方各说一遍同一件事——卡片正文、
  注入块里的「场景说明（管理员填写）」、新会话输入框上方的「场景开场」卡片、`/指令` 的回显。
  现在统一由 `description`（场景介绍）承担。
- **必填性反转**：`description` 改为**选填**（留空则注入块不出「场景说明」这一节、新会话也不渲染
  「场景开场」卡片）；`inputDraft`（输入框预填内容）改为**必填**——它才是「进入场景后模型要做的
  那件事」，留空等于让业务人员对着空输入框重猜。
- **MCP 写入**：`toRemoteWritePayload` 的 `scenarioPayload` 不再写 `welcomeMessage`；场景介绍仍走
  请求体顶层 `description`。服务端只存储、不校验这两个键，所以旧数据照样读得回来。
- **`activation.state` 契约**：`draft.source` 的第二取值从 `welcomeMessage` 变成 `description`；
  `draft.welcome` 现在是「场景介绍投影」（字段名保留，客户端不用改）。

### 老数据自动迁移

`coerceStoredScenario` 在读存档时按旧版的显示契约迁移，避免升级后卡被必填校验判死、
场景列表凭空变短：

1. 场景介绍为空 → 继承旧的 `welcomeMessage`；
2. 输入框预填为空 → 继承旧的 `welcomeMessage`，再退到场景介绍（旧版预填本来就是
   `inputDraft || welcomeMessage`）；
3. 迁移后丢弃 `welcomeMessage`。

公司标准场景走同一套兜底（`fromRemoteScenario`）：远端缺 `inputDraft` 时依次退到本机已有模板、
旧的 `welcomeMessage`、场景介绍，所以安装/复制标准场景不会被必填校验拦住。

### 界面改动

- 编辑器里两个文本框合成一个，并**按顺序紧挨着放**：场景介绍（选填）→ 输入框预填内容（必填）。
  这两个字段就是「场景要让模型做什么」的全部内容，配完再往下绑 Skill 更顺。
- 场景介绍给了 placeholder（写什么、给谁用），输入框预填的 placeholder 换成可直接照抄的示例，
  不再用「留空 = 不预填输入框」这种反向说明。
- 当前场景条在场景介绍为空时显示「未填写场景介绍」；**卡片正文则整段不渲染**——一行灰字会让
  选填字段看起来像「配置坏了」，业务人员又补不了。
- 空状态引导文案改成「填写标题、输入框预填内容、快捷指令」。

### 顺手修掉的两个表单问题

这两个都是老问题，被「`inputDraft` 变必填」放大成必经路径，一起修：

- **校验红字现在会随输入消失**：`clearFieldError` 原来只在技能栈/附件里调用，标题、场景介绍、
  输入框预填改了字红字还挂着。改成下沉进 `patch`，一处覆盖全部字段。
- **保存后的提醒不再被吞掉**：原来 `setWarnings` 之后立刻 `onClose`，抽屉卸载，`warnings` banner
  永远没机会渲染——「尚未绑定任何 Skill」这类提醒等于没提示。现在有提醒时抽屉不关，顶部显示
  banner，footer 的「取消」换成「关闭」（改动已落盘，取消没意义）。
- 错误提示 toast 支持换行（`.crmw-toast` 加 `white-space:pre-wrap`），多字段错误不再压成一行。

### 验证

- `node --test`：220 个用例全绿（新增老存档迁移 3 例、注入块空场景介绍 1 例）。
- `node scripts/check.mjs`：7 组自检通过。
- 可视验证（浏览器里实际点开编辑框）未完成：当前环境无法启动浏览器。

## 1.12.1

修一个会让「更新提醒」在真实环境里彻底失效的缺陷。

### 问题：私有源上的包，永远不提示更新

1.12.0 的更新检查按这个顺序找 registry：

```
显式配置 → DSH_PLUGIN_REGISTRY → npm_config_registry → .npmrc 的 registry= → 官方源
```

它只读了 `.npmrc` 的**全局** `registry=` 那一行。而私有源的包靠的是 **scope 映射**：

```ini
registry=https://registry.npmjs.org/          ← 全局，指向公共源
@runner-corp:registry=http://192.168.156.203:9001/   ← 它决定私有包去哪找
```

结果就是：插件拿全局那行去公共源查 `@runner-corp/...` → 404 → 判定「registry 上没有这个包」
→ 不提示、不升级。**装得上、但永远收不到更新**，而且不报明显错误。

### 改动

- `readNpmrc` 解析并保留 `@scope:registry`，存进 `scopes`，不再只认全局那一行。
- `resolveRegistry` 增加 `name` 参数：包名带 scope 时，优先用它自己 scope 配的源
  （npm 的语义里 scope 比全局更具体），没有 scope 映射才回落到全局与官方源。
- 补两个用例，其中一个直接复现现场配置（全局官方源 + scope 指向内网），
  断言检查请求确实打到 `http://192.168.156.203:9001/@runner-corp%2f.../latest`。

### 验证

- `node --test`：217 个用例全绿（更新器 21 个）。

## 1.12.0

插件从「拷目录 / link 本地路径」变成**可分发、可自升级的 npm 包**。

### 问题：别人装不上，发新版也没人知道

原来的安装方式是 `link:D:/GitProject/crm-dsh-plug`。这有三个后果：只有这台机器能用；
DSH 的市场把 `link:` 判为 `kind: "linked"`，**明确不提供升级**；版本号取的是目录里的
`package.json`，改了立刻生效，但那不是用户环境。

更关键的是宿主**没有「检查更新」的能力**：`plugin-manager` 只有 `installBundle` /
`inspect` / `listBundles` / `removeBundle` / `setEnabled`，官方 `plugin-market` 也只负责
索引源与安装。所以「有新版本了」这句话只能由插件自己说。

### 改动

- **包名改为 `@runner-corp/dsh-scenario-workspace`**：用公司 scope，且不再含 CRM——
  这个插件以后要接 TAPD 等别的业务系统，包名不该锁死在一条业务线上。
  loader 条目名（`cordis.patch.yml` 的 `name`）与客户端 `__ModuleLoader__.load({ id })`
  同步改；`scripts/check.mjs` 新增断言守住「package.json / patch / 客户端 id」三处一致，
  改名不会再漏一处。**运行时标识不变**：`PLUGIN_ID` 仍是 `crm-workspace`，存档目录仍是
  `<profile>/crm-workspace`，老用户的场景卡片与激活记录不受影响。
- 新增 `lib/core/updater.js`（零依赖）：
  - `check()` 读 registry 的 `<name>/latest`，用 semver 比较，默认缓存 6 小时，同一时刻只发一个请求；
  - `apply()` 后台调宿主 `installBundle('<name>@<version>')`，立刻返回，由 `status()` 轮询终态；
  - `skip(version)` 记下「这个版本不再提醒」，落在 `<dataDir>/updater.json`；
  - registry 与凭据按「显式配置 → `DSH_PLUGIN_REGISTRY`/`npm_config_registry` → profile 与
    home 的 `.npmrc`（按 host+path 匹配 `_authToken`）→ 官方源」解析，私有源无需额外配置。
- 新增 4 个 Host 接口（挂在既有 `/crm-workspace/api` 上）：`update.check` / `update.apply` /
  `update.status` / `update.skip`。检查失败一律返回 `ok:false`，不抛错、不影响面板打开。
- 客户端：面板挂载时检查一次；有新版且未被跳过时弹窗（当前 → 最新、更新说明、弃用警告），
  按钮为「稍后 / 跳过此版本 / 立即升级」。升级中禁用按钮并提示不要关闭 DSH，
  完成后提示重启（Host 代码在进程内）。
- 版本号收敛成单点：`lib/core/constants.js` 的 `PLUGIN_VERSION` 与 `PLUGIN_NAME` 改为直接读
  `package.json`。此前 `package.json` 与代码里的版本曾出现 1.11.0 / 1.11.1 分裂，
  而更新器正是靠版本号判断新旧。
- 新增 `scripts/build-index.mjs`：生成 DSH 插件市场索引（format 1）。展示信息取
  `package.json` 的 `dsh.index`（标题、分类、关键词、DSH 兼容范围），发版后重新生成覆盖即可。
  配合「插件 → 发现 → 索引源」，员工加一次 URL 就能像逛市场一样安装。
- 新增 `docs/plugin-distribution.md`：发布、安装、索引源、升级、复用与排障。
- 新增 `scripts/publish.mjs`：直接调 registry 的 PUT 接口发布。
  `npm publish` 会在发之前检查本地 token，没有就抛 `ENEEDAUTH`——哪怕服务端配的是
  匿名可发；这个脚本不需要账号，自己算 sha1/sha512、按 npm 约定命名附件。
- 新增 `deploy/registry/`：测试服务器的一键部署产物（Verdaccio 配置、systemd 单元、
  nginx 独立站点、install.sh、部署说明）。**站点独立在 9001**，不挂在 MCP 的 9000 上：
  9000 的 server 块属于 MCP 服务，把 location include 进去，别人改 MCP 入口或重部署
  nginx 时会顺手冲掉，出问题也难判断是谁影响谁。
- 修复 `normalizeRegistry` 把 `ftp://x` 拼成 `https://ftp//x/` 的问题（非 http(s) 协议直接判无效）。
- 新增配置 `updateRegistry` / `autoUpdateCheck`。

### 验证

- `node --test`：212 个用例全绿（新增 `test/updater.test.js` 19 个：版本比较含预发布、
  registry/`.npmrc` 解析与优先级、缓存与并发去重、401/404/网络失败降级、跳过版本落盘、
  安装成功/`restart-required`/失败/抛错四种终态、无更新时拒绝启动安装）。
- `node scripts/check.mjs`：7 组自检通过。
- `npm run index` 生成的索引经人工核对：`format: 1`、分类中文名、`versions[0].source.type = npm`。

## 1.11.1

进入场景预置到输入框的东西，现在和用户自己动手**走同一条路**：写进去的只是一个纯文本字符串，
宿主 `setDraft(string)` → `draftEditor.setDraft(text)` → `clear()` + `$appendParagraphs`，
`/技能名` 由 lexicon 扫成 `TextRefNode`。1.11.0 造出来的那套 chip 没有了。

### 问题：同一个输入框，两种长相

1.11.0 为了「点技能名就能看正文」，把预填改成了 `setDraft({ text, references })`。宿主于是改走
`draftEditor.restoreDraft()`，把 `/技能名` 插成 `ReferenceChipNode`。它确实可点，但用户手打
一个技能得到的是 `TextRefNode`——普通文本加引用样式。两边不是一种东西：

| | 手打 | 1.11.0 预填 |
| --- | --- | --- |
| 节点 | `TextRefNode`（可逐字编辑、退格拆开） | `ReferenceChipNode`（整体替换、整体删除） |
| 名字来源 | lexicon 扫描草稿 | 我们塞进 references 的 `ref` |
| 外观 | 宿主按文本推断 | 我们写死 `appearance: 'file'`，连图标都是文件那套 |
| 提交 | 不需要序列化（就是文本） | 必须有 `codec`，否则 `no serializer for reference source` |

### 改动

- 删除 `composeDraftPayload`，换成 `draftPayloadFor(text)`：只返回字符串。`seedComposer`（面板 /
  `/指令` 进入场景）与 `writeDraft`（场景栏重写草稿）两个写入口都只递字符串，代码里不再有
  `appearance`、不再拼 references。
- `crm-workspace-skill` 引用源降级成宿主技能源的补充，不再是任何 chip 的主人：
  `lexicon` 补一份技能名字表；`openReference` 只在宿主源认不出名字时用 `skills.check` 拿
  `SKILL.md` 路径兜底打开；`candidates` 仍是空数组（空分组宿主不渲染）；`codec` 保留，
  只为还原 1.11.0 时期写进存档的草稿，避免升级后回车被 `no serializer` 拒收。
- 预设附件与手动拖拽同一份语义：`conversation.createDrafts(sessionId, files, ordinary)`，
  `ordinary = sessions.binding(sessionId)?.session.getSnapshot().subagent === null`；普通会话
  才预上传图片，子代理续跑时图片随 prompt 内联。
- `test/client.test.js`：原来的 4 个 chip 用例换成 5 个「与手打同源」用例（载荷恒为字符串、
  预填路径上没有 references/appearance、引用源只剩名字表与兜底、codec 仅为旧存档、附件
  ordinary 语义）。

### 验证

- `node test/client.test.js`：24 个用例全绿。
- `node scripts/check.mjs`：7 组自检通过。

## 1.11.0

输入框里预填的 `/技能名` 现在**本身就是可点 chip**：点它在右侧栏打开 `SKILL.md`，跟用户
自己从 `/` 菜单里挑出来的完全一样。这是 1.10.0「场景栏 chip」被否掉之后的正确做法。

### 为什么 1.10.0 那条路不对

1.10.0 的结论是「技能没有结构化 reference codec，所以预填不了真 chip」，于是把入口挪到了
输入框上方的场景栏。但用户要的是**输入框里那个 token 自己能点**——场景栏只是绕路。

重读宿主源码后确认这个结论是错的：真正的障碍不是「造不出 chip」，而是我们写入草稿的方式。

- `conversation.input.for(session).setDraft(x)` 的入参 `DraftInput` 是
  `string | { text, references[], quotes?, command? }`。**我们一直传的是纯字符串**，
  facade 里 `resolveDraftInput` 会把它当成 `references: []`，走到
  `draftEditor.setDraft(text)` —— 那条路只做 `$getRoot().clear()` + `$appendParagraphs`，
  纯文本里不可能长出 chip。
- 传结构化对象时走的是另一个分支 `draftEditor.restoreDraft(text, references, quotes, …)`，
  它给每条 reference 直接 `paragraph.append(new ReferenceChipNode({...}))`。**chip 是插进去
  的，不靠 lexicon 扫描**，所以和「目录结算了没有」完全无关。
- 点击时 `registerReferenceActivation` 只做一件事：`$isReferenceChipNode(node)` →
  `open(node.getSource(), { ref })` → `inputTriggers.openReference(source, …)`。带 source
  时**不看 lexicon**，按 `owner.name === source` 找注册过的触发源。

唯一真正的硬约束在提交侧：`serializeReference` 里
`if (owner?.codec === undefined) return Promise.reject(...)`，chip 的 source 必须是一个
**带 codec 的、我们自己注册的源**。宿主的 `skill` 源（`trigger:'/'`、`name:'skill'`）在源码
里明写 "this source implements no reference codec"，所以借它的名字会在按下回车时被拒收
（`slash: no serializer for reference source "skill"`）。

### 新增

- **自注册的引用源 `crm-workspace-skill`**（`trigger:'/'`，`order:3`）：
  - `codec = { clipboardText: ref => ref, serialize: async ref => ref }` —— 序列化回原样的
    `/技能名`，所以提交出去的正文与用户手打一字不差，宿主的 `SKILL_GESTURE` 照常把它当成
    技能手势注入正文。
  - `openReference` 复用已有的 `openFileInSidebar`：先用 `skills.check` 取该技能在本机的
    `SKILL.md` 绝对路径（`skills.list` 不含 `path`），再在右侧栏打开。
  - `lexicon` / `subscribeLexicon` / `warm` 也从插件侧的 `skills.list` 供给，让草稿里的
    `/技能名` 在**没被结构化引用覆盖**的场景下（比如用户后来自己又打了一个）也能正常变蓝。
  - `candidates` 返回空数组：插件不抢宿主的 `/` 菜单，这个源只服务 chip 的点击与序列化。
- **`composeDraftPayload(text)`**：把预填文本开头连续若干「整行就是一个 `/kebab` token」的
  行转成 `{ text, references }`，每条 reference 带
  `{ source: 'crm-workspace-skill', ref, offset, length, label, appearance: 'file', clipboardText }`。
  没有技能 token 时原样返回字符串——行为与 1.10.0 逐字节相同。
- **两处草稿写入点都改走结构化**：`seedComposer`（面板/`/指令` 进场景）与
  `writeDraft`（场景栏重写草稿）。`clearSeededDraft` 仍传空串，因为它本来就是要清空。
- **`package.json` 的 `dsh.client.inject` 补 `@deepseek-ai/dsh-client-ui-input-trigger`**：
  保证我们的客户端 bundle 在该包之后到达（此前只依赖运行时的 `ctx.inject` 等 fiber）。

### 顺带确认的事实

场景进入的新会话，输入框与普通新会话**是同一套组件**（同一个 `SessionInputShell` /
`DraftEditorRuntime` / lexicon / 点击处理），差别只在我们写入的方式：纯文本 `setDraft`
不等于结构化 `setDraft`。这也解释了 1.9.0 起「从场景进来点技能只弹菜单」的全部现象。

### 验证

- `node --test`：192 个用例全绿（新增 4 个：结构化草稿成形、无 token 时退回字符串、
  单 token 偏移、codec 与注册点源码断言）。
- `node scripts/check.mjs`：7 组自检通过。

## 1.10.0

点场景栏里的技能名，就能像点输入框里的技能 chip 一样，在右侧栏打开它的 `SKILL.md`。

### 为什么需要这条入口

DSH 输入框里的 `/技能名` 要变成可点 chip，取决于该会话的「技能目录」是否已经结算
（`dsh-client-ui-skill` 的 `skills.list` RPC），而点击 chip 又依赖同一份目录里带着
`path`。进入场景时我们**抢在目录结算之前**就把草稿写好了，于是草稿里只有纯文字：点它不会
返回任何引用，编辑器退回自己的默认行为——光标落进 token、上方弹出 `/` 指令菜单。这正是
「从场景进来点技能，只是上方出现选择指令的选项」的原因。

技能没有结构化 reference codec（`serializeReference` 会直接 reject），所以「预填一个真
chip」在 DSH 这一侧没有受支持的做法。插件因此自带一条稳定入口：场景栏渲染技能 chip，
点击用宿主认的 `dsh-resource://file/...` 地址在右侧栏打开文件。

### 新增

- **场景栏的技能 chip**：输入框上方那条「🟢 正在使用场景」里，`挂载技能：` 后面每个技能
  都是可点的 `/${name}`。点一下在右侧栏打开它的 `SKILL.md`（会话工作目录内的文件用
  `session` 形式地址，目录外的用 `absolute` 形式，盘符的 `:` 保留）。没有文件路径的
  技能（如内置技能包）会明确提示，不留一个「点了没反应」的假按钮。
- **`activation.state` 的 `draft.skills`**：每条技能带上 `{name, description, path, route}`，
  客户端据此渲染 chip 并决定点击落点。

### 变更

- `resolveStack` 的每一项补 `path`（服务层 → 定义层 → 目录扫描，依次回退），
  `stackSkillTokens` 从「只返回 token 串」改成 `{ tokens, skills }`。

### 验证

- `node --test`：188 个用例全绿（新增「场景栏地址拼装」1 个）；
  `node scripts/check.mjs`：7 组自检通过。

## 1.9.0

场景真正把技能「带进」会话：进入时技能以 `/技能名` 预填到输入框，进入前先确认这些技能在
本机装得上、路由得了，缺的能装就直接装，装不上就拦在门口。

### 新增

- **进入场景时把绑定的技能预填成 `/技能名`**：输入框里出现的是
  `/crm-core /crm-record-change` 换行接上场景模板，跟用户自己在输入框里打 `/技能名` 完全
  一回事——宿主的 `dsh-tool-skill` 只认「空白边界 + kebab-case」的 `/name` 手势，认到就
  把该技能正文作为 instructions 注入本次请求，模型不必再调一次 `skill` 工具。用户当然可以
  在发送前把它们删掉、改掉或再加几个。
- **技能预检门禁 `skills.check`**：进入场景前（建工作区之后、激活之前）先问一次宿主：
  这张卡绑的技能，哪些能真正被 `/name` 路由。结果分四类分别提示——
  `missing`（本机没装）、`not-routable`（名字不是 kebab-case，永远路由不上）、
  `command-clash`（和场景自身的 `/指令` 撞名，宿主会先按指令解析）、
  `user-disabled`（`user-invocable: false`，只能模型自己调）。
- **能装就直接装**：`missing` 里的技能按名字去「智能体中心」的技能市场找同名项，命中就调
  `/api/runner-library/install` 装上，再回头复检一次（文件监听会让下一次请求就看见它）。
  装不上（市场没有、没有登录态、被审查拒收）才弹窗拦住：`打开智能体中心安装` /
  `仍然进入` / `取消`。
- **配置项**：`skillRoutePrefill`（默认 `true`，关掉就退回 1.8.0 的纯模板预填）、
  `autoInstallSkills`（默认 `true`，关掉就只提示不自动装）。

### 变更

- `activation.activate` / `activation.state` / `skills.check` 都接受 `cwd`：技能按该目录
  的分层视图解析（项目级 `.dsh/skills` 会盖掉用户级同名技能），预检的结论才和会话里实际
  能路由的结果一致。客户端传的是场景工作区目录。
- `activation.activate` 与 `activation.state` 的返回里多了 `skillTokens`（可直接拼进输入框
  的 token 串），`skills[]` 每项多了 `route` / `userInvocable` / `commandClash`。
- 预填文本从「只有模板」变成「token 行 + 模板」。为此草稿比对不再按全文相等：
  `isKnownTemplate` 会忽略开头的技能 token 行，宿主把草稿搬到新会话时也认得出这是我们
  自己的模板；只是缺了 token 前缀的草稿不重写（重写会把光标弹到末尾）。
- 从 `/场景指令` 进场景没有弹窗余地，所以在激活后直接提示「这些技能不会被当成 `/引用`」
  （本机没装 / 名字不能写成 `/引用` / 与 `/指令` 同名 / 不可由用户调用）。
- 注入块不再和技能手势打架：`/技能名` 已经随用户消息提交时，宿主会把技能正文注入本次
  请求，块里的「用 skill 工具逐个按名称加载」改成「直接按正文执行，不要重复加载」——
  否则同一个技能会被要求加载两遍（一遍模型自己调工具、一遍宿主注入）。
  `preview.injection` 也按「token 在草稿里」这一前提预览。

### 验证

- `node --test`：186 个用例全绿（新增技能预检、token 拼装、草稿比对 8 个）；
  `node scripts/check.mjs`：7 组自检通过。

## 1.8.0

预设附件的生命周期收口，场景卡片统一视觉，业务系统随场景同步到 MCP。

### 新增

- **附件账本**：客户端新增 `seededAttachments`（会话 → 我们挂过的附件 id）与
  `scenarioSeedKey`（场景栈去重键）。输入框的 `addAttachments` 是 append、不去重，
  同一份附件此前会被面板与场景栏各挂一次；现在所有挂载都走 `attachPresetFilesToTray`，
  同键只挂一次，换场景时先把旧的那套摘掉再挂新的。
- **业务系统随场景同步到 MCP**：`toRemoteWritePayload` 现在会带上 `businessSystem` 与
  `icon`。此前只存在本地，同一张标准场景在别的机器上会退回 CRM；图标则会在「推上去再拉
  回来」之后被重置。服务端契约需要接受这两个字段，MCP 侧的改造清单见
  `docs/mcp-business-system.md`。

### 修复

- **退出场景后预设附件留在托盘里**：场景栏自己创建的草稿附件从不登记，退出时无从摘除。
  现在统一由 `dropSeededAttachments` 回收，四条退出路径（场景栏 `×` 退出、单个场景
  `×` 移除到空栈、面板「退出全部场景」、面板移除最后一个场景）都会把托盘里属于我们的
  附件摘掉，用户自己拖进来的不动。
- **进入/叠加时预设附件被挂两遍**：面板预填与场景栏预填是两条并发路径，现在由
  `withAttachmentLock` 逐会话串行化，第二条直接命中账本不再重复创建草稿。
- **叠加场景时只带入主场景的附件**：`activationState` 的 `draft.attachments` 改为整个
  场景栈的并集（按 `attachmentId` 或「文件名 + 大小」去重）。
- **卡片高低不齐**：标题固定两行、介绍固定两行（超出裁剪，鼠标悬停看全文），技能行压成
  一行，卡片 `min-height` 与栅格 `align-items:stretch` 一起保证同一屏的卡片尺寸一致；
  公司标准卡的附件从竖排列表改成脚注 `📌 n` 徽标（悬停看完整清单）。

### 变更

- **`/指令` 进入场景也会预填并挂预设附件**：指令路径此前只调 `activation.activate`，
  于是同一个场景从面板进有附件、从指令进没有。现在空白会话里指令进入后同样走
  `seedComposer`（已有消息的会话不塞任何内容，那只是「在同一段对话里换场景」）。
- **同一张卡重复叠加会被拦下**：守卫改为读宿主上的真实栈（`activation.state`），
  命中就提示「已经在当前对话里了」，不再另开一段会话把原来的预填与附件收走。
- **业务系统与图标改为随 `scenarioPayload` 同步**：服务端对请求体顶层是 `zod .strict()`，
  多一个键就 400；`scenarioPayload` 是 `passthrough()`，插件自有字段原样往返，无需服务端先改契约。
- **`docs/` 纳入发布白名单**：MCP 侧改造清单随包发布。

### 验证

- `node --test`：178 个用例全绿；`node scripts/check.mjs`：7 组自检通过。
- 隔离 DSH Web（独立 home/profile）+ 无头浏览器实测四条退出路径：面板进入→状态条「退出场景」、
  面板进入→面板「退出全部场景」、面板进入→单场景 `×` 移除、`/指令` 进入→退出，
  托盘附件在进入后为 1 个、退出后归零；重复点同一张卡的「＋ 叠加」只弹提示，
  `workspace.json` 的会话数不变。

## 1.7.0

场景从「一个全局池子」变成「按业务系统分域」：插件改名**场景工作台**，卡片必须声明自己属于
哪个业务系统，进入场景时先落到该系统对应的工作区，再在那里开新对话。技能栈不再接受手打的名字。

### 新增

- **业务系统（必填）**：场景卡片新增 `businessSystem` 与派生的 `businessSystemKey`（如
  `CRM → crm`、`TAPD → tapd`、`其他 → other`，自定义名按 slug 生成）。预设这三个只是
  输入建议（datalist），**不是枚举**——填任何系统名都能保存。业务系统名会作为工作区目录名，
  因此拒绝 `\ / : * ? " < > |` 这些字符。
- **按业务系统落在对应工作区**：新增 `lib/core/workspaces.js` 与宿主接口 `workspace.ensure`。
  进入场景时先按「标题 = 业务系统名 / 标题 = key / 目录 = `<dataDir>/workspaces/<key>`」找已有
  工作区，命中就复用；都没有就建目录 + 建工作区（标题改成业务系统名）。会话一律建在这个工作区里，
  **叠加也一样**：当前会话不在目标工作区时，先在那里开一段再叠加。工作区根目录可用配置
  `workspaceRoot` 覆盖（默认 `<dataDir>/workspaces`）。
- **跨业务系统不允许叠加**：会话是按业务系统落在各自工作区的，把 TAPD 场景叠到 CRM 会话上会让
  这段对话同时属于两个系统、注入块里出现两套系统上下文。现在叠加前会比对当前栈里已激活场景的
  业务系统，不一致就拦住并提示「请先退出当前场景」，而不是静默塞进去或悄悄换掉原有的场景。
- **场景列表按业务系统过滤**：过滤 chip 从「业务分类」换成业务系统，并总是列出 CRM / TAPD / 其他
  三个建议值（否则在做出对应场景之前根本点不到筛选）。搜索串也把业务系统算进去。

### 变更

- **插件改名「场景工作台」**：侧边栏入口、面板标题、页脚、诊断标题、注入块里的自我介绍、
  `locale/zh.json` 的 title 与 `package.json` 的 description 一起改。包名 `dsh-crm-workspace`
  保持不变，已有安装不用重装。
- **业务分类降级为选填**：只作补充说明与搜索关键词，不再参与过滤，也不再拦保存（旧存档里的
  分类原样保留）。
- **技能栈只接受本地已有的 Skill**：「追加」按钮移除，输入名称时出候选（池里没有候选会提示
  「本地没有匹配的 Skill」），**回车加第一条候选**或点候选加入；直接敲一个不存在的名字会报
  「本地没有名为「x」的 Skill」，不再把一个模型加载不到的 Skill 塞进栈里。Skill 列表改为对
  所有能打开面板的人加载（此前只有管理员有，普通用户搜索框永远是空的）。
- **新建场景默认允许附件**：`prePinnedContext.allowAttachments` 的界面默认值改为 `true`
  （存档里缺省仍是 `false`，兼容老卡片）。
- **字段改好之后旧报错立刻消失**：保存失败时宿主会把「字段: 说明」映射回表单，此前那条红字只在下一次
  保存时才清（删掉有问题的附件、改好业务系统之后还挂着，看着像没解决）。现在改动附件与技能栈会即时清掉
  对应字段的报错。
- **公司标准场景的业务系统兜底**：服务端尚未下发 `businessSystem` 时按 `CRM` 映射，
  避免「业务系统必填」把公司场景整张拒掉；1.6.x 的老卡片在存活期收敛时同样补成 `CRM`。

### 验证

- `node --test`：**175 个用例全绿**（新增 `test/workspaces.test.js` 11 个用例覆盖工作区定位的
  四条命中路径与失败路径；`test/schema.test.js` 增补业务系统必填、分类选填、自定义系统 key、
  老存档 coerce；`test/client.test.js` 增补技能绑定、默认附件、按业务系统过滤、工作区前置的契约断言）。
- `node scripts/check.mjs`：7 组自检通过。

## 1.6.0

把「进入场景」从一次性注入改成可运维的状态：激活记录有生命周期、注入按轮次分级、
一个对话可以叠加多个场景并单独移除，出问题能在界面里直接诊断。

### 新增

- **多场景叠加**：`activation.activate` 接受 `stack: true`，一个会话可以同时启用多个场景
  （上限 8 个）。注入时按栈顺序拼接多个 `[[crm-workspace:context]]` 块；面板卡片新增
  「＋ 叠加」按钮，对话页与面板的场景条都把每个场景渲染成带 `×` 的 chip，可以**只移除其中一个**。
  宿主侧新增 `activation.deactivate`（摘掉一个场景）与 `/crm-doctor`（打印版本、状态目录、
  注入模式与当前会话的激活栈）。
- **注入分级（省 token）**：`names` → 后续轮次改发 `brief`——只留一行「场景仍然生效 + 技能栈顺序」。
  开启 `injectSkillBodies` 时仍是 `full` → `reminder`。实测同一会话第 2 轮起注入从约 1.2k 字符
  降到 200 字符上下，且不再重复场景说明与预设附件清单。
- **面板诊断弹层**：页脚显示「客户端 v… · 宿主 v…」，点「诊断」直接拉 `diagnostics`：插件/宿主版本、
  状态目录、存档版本、场景与激活条数、注入开关、当前会话的激活栈、以及客户端最近的 slot 崩溃记录。
- **`lib/core/activation.js`**：激活栈与清理逻辑抽成纯函数（`normalizeActivation` / `addScenario` /
  `removeScenario` / `markInjected` / `pruneActivations` / `describeActivation`），供 api、state 与单测共用。
- **客户端纯逻辑出口 `__pure`**：`lib/client.js` 末尾导出 `prefillTextFor` / `seededDraftTextFor` /
  `shouldClearSeededDraft`，`test/client.test.js` 用 `node:vm` 加载后直接断言，不需要浏览器。

### 变更

- **预填不再带 `/场景标题` 首行**：那既不是用户的话，标题含中文或空格时宿主也收不成 chip，回车后
  反而变成模型眼里的「用户输入了一条指令」。现在只写场景的 `inputDraft`（填写模板），场景身份由注入块
  与输入框上方的状态栏表达。`activationState` 仍返回 `reference`，但客户端不再把它写进输入框。
- **注入里说明预填模板**：模板已经随用户消息提交时，注入块写「不要复述模板原文」；没提交时提示模型
  向用户补要素材（`prefillProvided` 判定）。多场景叠加时块内还会注明「本会话同时叠加了 N 个场景」。
- **激活记录上限 200 → 50**，并新增两条回收规则：闲置超过 24 小时、场景已被删除的悬空记录。
  `/crm-doctor` 与存档收敛都会打印「过期 x、闲置 y、悬空 z、超限 w」。
- **每个 slot 条目都有崩溃边界**：面板、场景标签、场景栏各自包一层 `SlotBoundary`，某个条目渲染失败
  只降级成一条黄色提示（带重试），不再整块消失，失败原因同时进诊断弹层。
- **孤儿草稿回收**：预填时 `createDrafts` 出来的附件 id 按会话登记，退出场景或叠加移除后调
  `conversation.discardDrafts` 回收，不在会话里堆没人引用的文件。
- **换场景时不再留着上一个场景的模板**：宿主在切换会话/工作区时会把上一段会话的草稿「搬」到新
  会话，空白会话因此可能带着上一个场景的模板；旧规则「输入框非空就不覆盖」把它当成用户输入保留
  下来。现在把「我们写过的模板」与「所有场景的填写模板」都登记为已知模板（`seedConflict` 判定），
  空白会话里出现这类文本时换成这次场景的模板；用户自己打的字仍然一律不动。

### 验证

- `node --test`：154 个用例全部通过（新增 `test/activation.test.js`、`test/client.test.js`，
  以及叠加/单独移除/超限拒绝/`brief`/`diagnostics`/`prune`/`seedConflict` 的用例）。
- `node scripts/check.mjs`：7 组自检通过。
- 隔离 Web 实例（无头 Chromium）实测：进入场景后删除键可删、不会被回填，可加文件；场景 A → 场景 B
  时输入框换成 B 的模板；「＋ 叠加」后两个 chip、单独 `×` 只移除一个；诊断弹层能出完整 JSON。

## 1.5.4

修复「进入场景后，对话页顶部没有徽标、也找不到退出入口」，并把预填改成只写一次。

### 修复

- **对话页徽标整个崩掉（根因）**：`ComposerScenarioBanner` 调宿主注入的 `useInput()` 时没传 selector。宿主的 `useInput` 是「带 selector 的 useSelector」包装，空参会在内部 `memoizedSelector` 抛 `TypeError: selector is not a function`，宿主把整个 dock 槽条目判为崩溃（控制台：`slot entry crashed in 'conversation.input.dock'`）。后果是徽标、「× 退出场景」按钮、开场引导和附件清单全部不渲染 —— 用户在对话页里就再也退不出场景。现在按宿主源码的写法传 `useInput((snapshot) => snapshot)`，并对 `props.input` 兜底。
- **预填只写一次**：会话页 banner 与面板 `seedComposer` 原来每 800ms / 200ms 判断一次「输入框是不是空的」，用户全选删除后会在下一轮被原样写回，看起来就是「删除键删不掉」。现在一旦写入成功（或输入框里本来就有用户内容）就记住，用户再删空也不回填。
- **退出场景会顺手撤掉预填标记**：退出时如果输入框里还留着我们塞进去的 `/场景名称` 那一行，会一并清掉，避免用户下一次回车又把场景激活回来。
- **预设附件不再重复建草稿**：`createDrafts` 的结果按会话缓存，重试只重试 `addAttachments`，不会在草稿区堆一串没人用的重复文件。

### 新增

- **`/crm-exit` 指令**：对话页徽标万一又渲染不出来，用户仍可以在输入框用 `/crm-exit` 解除当前会话的场景激活（命令名必须是 ASCII，中文只能出现在描述里 —— 宿主 `commands.register` 只接受 `/^[a-z][a-z0-9_-]*$/u`）。
- 面板「退出场景」保持不变，三条退出路径（徽标 ×、面板按钮、`/crm-exit`）现在都能用。

### 验证

- `node --test`：133 个用例全部通过（新增「退出场景：徽标可移除 + `/crm-exit` 兜底」契约用例）。
- `node scripts/check.mjs`：7 组自检通过。
- 在隔离的 DSH Web 实例（headless Chromium + CDP）里实测：进入场景后徽标渲染、控制台无 `selector is not a function`、点「× 退出场景」后徽标消失且预填内容被清空、全选删除后 9 秒内不回填、`/crm-exit` 回车后激活被清除。

## 1.5.3

补上「预设附件没跟着进新对话」和「`/指令` 回车没反应」两处体验缺口。

### 修复

- **预设附件一起带进新对话**：`seedComposer` 现在同时处理草稿与附件——先把 `presetAttachments` 的字节从 `/crm-workspace/asset/...` 取回包成 `File`，再 `conversation.createDrafts(sessionId, files)` → `facade.addAttachments(ids)`，并回读 `attachmentIds` 确认。托盘里已经有附件时不会重复挂（dock 侧也加了同样的去重检查，之前用的 `inputActions.attachments` 字段根本不存在）。附件失败会在面板弹独立提示。
- **`/指令` 回车真正引入场景**：宿主虽然把卡片注册成了 `/指令`，但裸回车只会在服务端跑 handler——客户端把 token 吃掉、界面上什么都不显示，用户看到的就是「输入框清空了、场景没进来」。现在用 `commandUi.decorate()` 给同名指令挂**客户端动作**：回车/菜单选中即在本会话激活场景、弹一条「已切换到「XX」场景：技能栈…」的提示，并广播 `crm-workspace:activation` 让输入框上方的徽标/开场卡片立刻刷新。宿主 handler 保留为其它入口的兜底。
- 客户端模块显式依赖 `@deepseek-ai/dsh-client-ui-commands`（`package.json` 的 `dsh.client.inject`），确保指令服务先于本插件装配。
- 预填/预设附件只在**空白会话**里生效：老会话里用 `/指令` 切场景不会再往输入框里塞内容。

### 验证

- `node --test`：132 个用例全部通过；`node scripts/check.mjs`：7 组自检通过。

## 1.5.2

按实测反馈调整「进入场景」的会话语义，并把预填从「等输入框组件」改成「面板直接写入」。

### 变更

- **进入场景 = 开一段新对话**：`ensureScenarioSession` 会先看当前/最近会话——本来就是空白会话就复用它（用户看到的仍然是一个新对话，不再多堆空会话）；会话里已有消息时走 `connectWorkspace` 拿一个空白会话（或 `startSession`）并导航过去。不会再往旧对话里塞场景。
- 激活后统一 `uiWorkspace.openSession()` + `selectPanel('conversation')`，用户点完卡片直接落到对话面板。

### 修复

- **输入框预填改为面板侧直接写入**：新增 `seedComposerDraft(ctx, sessionId, text)`，通过 `conversation.input.for(ctx.sessions.scope(sessionId))` 拿到该会话的输入框外壳并 `setDraft`，再回读 `facade.state.getSnapshot().draft` 确认；轮询等会话作用域就绪（最多 8 秒），只在输入框为空时写入，绝不覆盖用户已输入的内容。这条路径**不依赖 `conversation.input.dock` 是否挂载、也不依赖 slot 标准 props 是否带上 `inputActions`**——之前预填失效的两条可能原因（dock 没挂载 / inputActions 缺失）都被绕开。
- 写入失败时面板会弹一条明确的错误提示（「输入框预填没写进去：会话还没就绪…」），不再静默失败——用户不用开控制台也能知道结果。
- 预填文本与输入框组件用同一套规则（`prefillTextFor`）：`/场景标题` + `inputDraft`；纯 ASCII 标题与指令同名时加「场景」前缀。

### 验证

- `node --test`：132 个用例全部通过（新增「进入场景 = 开新对话」契约用例：空白复用 / 有内容新建 / 面板侧 `seedComposerDraft` 存在）。
- `node scripts/check.mjs`：7 组自检通过。

## 1.5.1

修掉「点卡片进入场景后，输入框没有被预填」的问题——根因是插件一直在跟一个用户看不见的会话打交道。

### 修复

- **当前会话解析错误**：`currentSessionId` 只读 `sessions.list` 快照的 `snapshot.current`，而 DSH 的会话列表快照只有 `ids / byId / phase`，**没有 `current` 这个字段**，于是永远返回 `undefined`。结果「进入场景」时 `ensureSession` 总是新建一个会话，激活记录、预填、徽标全写在这个后台会话上；界面切到对话面板后显示的是「没有选中会话」的空白态，输入框自然是空的。
  现在按 DSH 的真实机制解析：`uiSession.adapter.current`（主面板的 main 绑定）→ 列表中 `retainedBy.mainView > 0` 的那一行 → 兼容旧版 `snapshot.current`。
- **会话切换用错 API**：`switchToConversation` 调的是 `ctx.sessions.open(...)`，但 `sessions` 上没有这个方法，调用静默失败，界面根本没切到目标会话。改为 `uiWorkspace.openSession(sessionId)`（DSH 自己的导航入口），并保留 `selectPanel('conversation')`。
- **`startSession` 用法错误**：它是「新建并导航」的 void API，旧代码却 `await` 它的返回值。现在调用后轮询 `uiSession` 的当前绑定（最多 4 秒）拿到新会话 id，再激活。
- **工作台面板拆卸对话面板时丢会话**：工作台是另一个 main 面板，打开它时对话面板被卸载、`mainView` 租用释放，当前绑定变空。新增 `lastSessionId`（由对话标题徽标与输入框组件挂载时记录），`resumableSessionId` 在当前绑定为空时回退到它，避免「一进工作台再点卡片就多开一个会话」。
- **预填延迟**：面板完成激活/退出后广播 `crm-workspace:activation` 事件，输入框上方的徽标与开场卡片立即重读状态，不再等 6/8 秒轮询。
- **预填写入兜底**：除了 slot 提供的 `inputActions.setDraft`，再补一条 `conversation.input.for(sessionScope)` 路径；任一路径不可用时会重试（最多 20 次 × 800ms），不再静默放弃。

### 验证

- `node --test`：131 个用例全部通过（新增「进入场景必须落在主面板正在显示的会话上」契约用例：禁止再用 `sessions.list.current` 与 `ctx.sessions.open`，禁止 `await startSession`）。
- `node scripts/check.mjs`：7 组自检通过。

## 1.5.0

按一线反馈收窄配置面、把「创建人」换回 DSH 身份，并让开场引导语真正出现在新会话里。

### 变更

- **无权限时不再显示发布入口**：`新建/编辑场景` 抽屉里的「设为插件标准场景」整块只在 `auth.canManageStandardScenario === true` 时渲染，普通用户看不到也勾不了（之前是渲染但灰掉，容易让人以为勾了就会发布）。
- **移除三个不需要配置的字段**：目标对象 API 名、默认动作、表单入口不再出现在抽屉里。它们本来就该由模型结合用户当次的描述与可用工具判断，预先钉死一个默认值只会误导执行；注入块改成「不预设，先确认对象与入口」的明确指令。存档字段与 MCP 写请求仍保留默认值（服务端 zod 要求），但对 UI 与模型都不再有意义。
- **移除「标记为系统底座」**：连同卡片上的「系统底座」标记一起下线（`ScenarioCardConfig.isSystemBase` 不再写入存档；旧存档里的该字段读入时被丢弃）。
- **创建人只用 DSH 身份**：`resolveCurrentUser` 不再把 MCP 的 `auth.crmUsername`（Salesforce 用户名）当成当前用户，顺序改为 `defaultAuthor` → 宿主 `deepseekAccount` 资料 → 进程用户。新建时由宿主解析（前端伪造无效），编辑时保留原创建人；公司标准场景的远端创建人只留在 `createdByCrmUser` / `createdByPlatformUid` 里，在编辑抽屉作为提示展示。

### 新增

- **新会话「场景开场」卡片**：`conversation.input.dock` 在空白会话（`session.blank === true`）里额外渲染一张引导卡片——场景图标 + `/场景名称` + `welcomeMessage`。它是 UI 投影，不写会话历史、不产生消息气泡，发出第一条消息后自动消失。
- **输入框预填带场景引用**：`activationState.draft` 新增 `reference`（`/场景名称`）与 `welcome`；预填内容变成「`/场景名称` + inputDraft」两行，用户一眼能看出这条消息引用了哪个场景。纯 ASCII 且与指令同名的标题会被加「场景」前缀，避免回车时被当成斜杠指令执行。
- **卡片页脚显示预设附件数**：原来显示「新建/修改/智能判断」的位置改为 `📌 N`（有预设附件时）。

### 说明

- 新会话顶部那行「小犇，我帮你…」属于 DSH 自己的空会话标题（`HeroShell` 的 `hero.headline`），只开放了 `conversation.hero.brand.mark` 与 `conversation.hero.workspace` 两个插槽，没有替换标题的插槽。插件只能在同一个位置补「场景开场」卡片；要改那行文案本身必须改 DSH 侧的品牌/本地化配置或源码。

### 验证

- `node --test`：130 个用例全部通过（新增「创建人不用 Salesforce 用户名且不可伪造」「远端标准场景映射不再写 createdByCrmUser」「无权限时抽屉不渲染发布入口」等用例）。
- `node scripts/check.mjs`：7 组自检通过。

## 1.4.2

场景面板的界面与权限调整：标准场景只读、凭据不进 UI，本地场景人人可建可改，开关改用可读的选项卡片。

### 变更

- 页签「公司推出的场景」更名为「标准场景」，页头不再展示 MCP 地址；认证通过只显示「已认证」，不再回显 Salesforce 用户名（鼠标悬停可看身份来源）。
- 「新建场景」按钮对所有人可见：普通用户保存即本地场景，`设为插件标准场景` 仍需标准场景管理员权限，服务端会把越权发布降级为本地场景并提示原因。
- 已安装场景的「编辑」回到卡片菜单：本地场景人人可编辑，标准场景仅管理员可编辑，普通用户可「复制为本地场景」。

### 修复

- 卡片与公司场景菜单改为 `Menu` 组件：点击菜单外部或按 Esc 即关闭，选中菜单项后立刻收起，不用再点一次。
- 编辑器开关由「整块反色的开关行」改为 `.crmw-option` 选项卡片：左侧方形复选框（选中为品牌色底 + 白色对勾）、右侧标题与一句说明，选中态只做轻微品牌色描边，不再出现大面积黑色。

### 验证

- `node --test`：127 个用例全部通过；`node scripts/check.mjs`：7 组自检通过（无硬编码颜色）。

## 1.4.1

去掉「公司推出的场景」页签的手工凭据配置：插件自己从 DSH 登录身份与部署配置里取凭据，自动通过 MCP 控制平面认证。

### 新增

- **自动登录身份**：新增 `createInternalCredentialResolver`（`lib/index.js`），按「显式配置 → 环境变量 → `<DSH_HOME>/.env` → `<DSH_HOME>/identity.json`」解析 `internal_bearer` 凭据——部署级客户端 Token（`CRM_MCP_CLIENT_TOKEN` 或 `mcpClientToken`）+ 登录用户薪号（`salary_id`），结果缓存 60 秒，换人登录后一分钟内自动跟随。运行期往 `.env` 补一条 Token 即可生效，不必重启桌面端。
- **部署契约对齐**：`internal_bearer` 请求改发控制面实际校验的 `X-Platform-User-Id`（可用 `platformUserHeader` 改），并同时保留兼容别名 `X-SFOA-Platform-User`；此前只发别名，导致 `auth.authenticated` 恒为 `false`。
- **身份来源可观测**：`bootstrap` 的 `config` 新增 `identitySource`（如 `internal_bearer:env+identity`）与 `platformUserHeader`，页签文案据此显示「DSH 登录身份自动注入」。

### 变更

- `authMode` 默认值由 `buntu` 改为 `auto`：先用能自动解析到的 `internal_bearer` 凭据，取不到再回退 Buntu Token；显式 `buntu` / `internal_bearer` 仍然强制生效。
- 启动后台同步门禁改为「确实能带上身份才发第一个请求」：显式/环境 Buntu Token 或可解析的 `internal_bearer` 凭据，二者皆无时保持静默，避免无意义 401。
- 未认证提示文案改为「未取到 DSH 登录身份，也无可用的 Buntu Token」，并说明自动解析顺序。

### 验证

- `node --test`：126 个用例全部通过（新增 6 个登录身份用例：`salary_id` 解析、缺 Token / 缺身份文件回落、配置优先、`buntu` 模式不解析、字段别名、`.env` 读取与进程环境优先级）。
- `node scripts/check.mjs`：7 组自检通过。
- 端到端实测：`GET /api/dsh/scenarios/permission` 返回 `{"authenticated":true,"platformUserId":"61979","canManageStandardScenario":true}`。

## 1.4.0

对接已上线的 MCP 控制平面服务（`http://crmmcptest.runner-corp.com.cn:9000`），把「公司标准场景」从轻量 JSON 仓库升级为完整的 8 接口协同：权限联动、自动升级、只读保护与本地副本。

### 新增

- **MCP 控制平面客户端**：`lib/core/registry.js` 按 `/api/dsh/**` 契约实现 `GET /scenarios?includeDeleted=true`、`GET /scenarios/permission`、`POST/PUT/DELETE /scenarios/{id}`、`POST/DELETE /scenarios/{id}/attachments[/{attachmentId}]` 与二进制下载；统一处理 Buntu Token 双头、`internal_bearer` 身份、超时、`correlationId` 与 `sha256` 响应头。
- **严格双向映射**：`fromRemoteScenario` 展平「主字段 + `scenarioPayload`」并把相对 `downloadUrl` 用 `new URL(downloadUrl, apiBaseUrl)` 拼成完整地址；`toRemoteWritePayload` 统一生成 POST/PUT 请求体，并在顶层与 `scenarioPayload` 内强制剔除 `version`、`revision`、`createdAt`、`updatedAt`、`presetAttachments`，避免 `400 DSH_SCENARIO_INPUT_INVALID`。
- **权限联动**：抽屉打开前调用 `GET /api/dsh/scenarios/permission`，仅 `auth.canManageStandardScenario === true` 显示「☑️ 设为插件标准场景」并允许编辑/删除标准场景；普通用户只看到「进入场景 / 复制为本地场景 / 下载到本地」。
- **自动静默升级**：每次同步后扫描 `sourceType === "COMPANY_STANDARD"` 的已安装场景，按 `revision/version` 覆盖更新；附件按 `sha256` 增量下载/校验/清理；`deletedScenarioIds` 或远端消失时自动卸载并清理本地缓存。
- **复制为本地场景**：`scenario.fork` 深拷贝标准场景与预设附件，生成 `${scenarioId}-copy-${timestamp}`、标题 ` (本地副本)`、`sourceType: "LOCAL_CUSTOM"` 的可编辑副本。
- **新会话 3 项带入强化**：输入框上方显示 `🟢 正在使用场景：【标题】 (v版本)` 与绑定 Skill；自动填入 `inputDraft || welcomeMessage`；预设附件以 `SCENARIO_PRESET` 角色挂进待发送托盘。
- 新增配置：`apiBaseUrl`（默认 `http://crmmcptest.runner-corp.com.cn:9000`）、`authMode`、`buntuToken`、`mcpClientToken`、`platformUserId`。

### 变更

- `sourceType` 本地值由 `LOCAL_INSTALLED` 迁移为 `LOCAL_CUSTOM`；旧存档自动兼容。`STATE_VERSION` 升到 2，存档新增 `companyStandardScenarios`、`deletedScenarioIds`、`lastSyncedAt`。
- `bootstrap` 新增 `auth`、`installedScenarios`、`companyStandardScenarios`；「公司推出的场景」只展示远端 `PUBLISHED`，同步不会自动把新场景塞进「已安装」。
- 服务端字段限制对齐：标题 128、分类 64、介绍 4000、预设附件 20 个、单文件 10 MiB、`scenarioId` 正则 `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` 且禁止保留字 `permission`。
- 场景包导出改为 `<scenarioId>.crm-scenario.json`，附件内联 Base64 并附带 `sha256`。

### 验证

- `node --test`：115 个用例全部通过（新增默认地址/身份头/8 接口契约/请求体红线/权限/自动升级/复制副本/新会话契约等用例）。
- `node scripts/check.mjs`：7 组自检通过。

## 1.3.1

修掉 1.3.0 上线后暴露的四个问题：预设附件「传了不显示」、创建人可随意改、界面被翻成英文、进入场景没有预填输入框。

### 修复

- **预设附件上传后仍显示「尚未上传预设附件」**：`EditorDialog` 原来把整批文件放在同一个 `try` 里，只要有一个文件失败（类型不支持、超限、网络错误），`patch` 就不执行，已成功的附件也被丢弃。现在改为逐个上传：成功的立刻进列表，失败的逐条提示，互不影响；状态用函数式更新，连续两次上传不会互相覆盖。
- **附件数量与移除**：上限由 20 收到 **10**（`LIMITS.presetAttachments`），界面显示「已上传 N / 10」，达到上限后禁用上传按钮，每条附件都有移除按钮；多选时超出上限的部分会提示被忽略。
- **创建人可被改写**：抽屉里的「创建人」改成只读（`readOnly` + `disabled`），新建场景时由 `bootstrap.plugin.currentUser` 自动带出；Host 侧保存时也会补默认值，前端无法伪造。取值顺序：`defaultAuthor` 配置 → 宿主 `deepseekAccount` 资料显示名 → 进程用户名，结果缓存 5 分钟并带 1.5s 超时。
- **界面被翻成英文**：`installLocale` 会把中文原文注册成 en 词典并绑定宿主 locale，宿主语言为 en 时整屏变英文。现在插件界面固定中文：不再注册语言包、不绑定 locale，`t()` 退化为恒等函数。
- **进入场景不预填输入框、不带预设附件**：`conversation.input.dock` 的 owner props 是 `{ session, input }`，没有 `sessionId` 字段，徽标组件读到空串后直接返回 `null`，联动逻辑整段没执行。现在从 `props.session.sessionId` 兜底取值；预填与附件带入改为「最多重试 20 次、每次间隔 800ms」，会话/输入框尚未就绪时也能最终生效，且仍然不覆盖用户已经输入的草稿。

### 变更

- `bootstrap` 新增 `plugin.currentUser`；`bootstrap.scenarios[].presetAttachments[]` 补上可 GET 的 `url`（存档里不写该字段）。
- 新增配置项 `defaultAuthor`（创建人兜底值）。
- 版本号升到 `1.3.1`。

### 验证

- `node --test`：93 个用例全部通过（新增「创建人由宿主带出」「bootstrap 附件补 url 且不落盘」等用例）。
- `node scripts/check.mjs`：6 组自检通过。

## 1.3.0

把工作台从「本地场景列表」升级成「场景中心」：双页签（我的 / 公司标准）、场景预设附件、新会话输入框联动，以及轻量远端场景库同步。

### 新增

- **场景 Schema**：`inputDraft`（输入框预填草稿，留空回落 `welcomeMessage`）、`presetAttachments[]`（`attachmentId/fileName/mimeType/localPathOrUrl/fileSize/role='SCENARIO_PRESET'`）、`sourceType`（`LOCAL_INSTALLED|COMPANY_STANDARD`）、`isStandardPublished`、`version`、`author`、`originScenarioId`。附件类型限 `.docx/.xlsx/.csv/.pdf/.md/.txt`，单文件 25 MiB、单卡 20 个，越界路径直接拒绝。
- **双页签场景中心**：`我的场景`（本地存档卡片，支持进入/编辑/导出/复制/排序/启停/删除）与 `公司推出的场景`（远端标准库，支持安装到本地、下载场景包）。切到公司页签时按需拉取，未配置仓库时给可读提示而不是报错。
- **新会话三联动**：`conversation.input.dock` 常驻「🟢 正在使用场景：【标题】 | 挂载技能：…」徽标（含 [切换场景] / [× 退出场景]）；进入场景把 `inputDraft || welcomeMessage` 用 `inputActions.setDraft` 写进输入框（光标在末尾、可撤销、不覆盖已有草稿）；预设附件经资产路由取回后 `conversation.createDrafts` + `inputActions.addAttachments` 进入官方待发送托盘。
- **场景包导出/导入**：`scenario.export` 生成 `<scenarioId>.crm-scenario.json`（附件内联 base64，超 8 MiB 的附件进 `skippedAttachments`）；`scenario.import` 重新分配 `scenarioId`、还原附件、冲突指令自动改名，支持离线分发。
- **公司标准库同步**：`lib/core/registry.js` 支持 `registryEndpoint`（CRM MCP 控制面 `/api/crm-scenarios` 或 Git Raw JSON）+ `registryToken`；`registry.list` / `scenario.install` / `scenario.publish` 提供列表、幂等安装与发布。安装时把远端附件下载到本地资产目录，失败项在返回里逐条报告。
- **发布权限**：抽屉里「☑️ 发布为公司标准场景」仅在 `canPublishStandardScenario`（或配置了 `registryToken`）时出现；无权限时后端拒绝发布但本地保存成功，并明确说明原因。
- **附件边界声明**：注入块新增「## 场景预设附件（SCENARIO_PRESET）」段，并写明「调用 `upload_files_to_record` 时严禁上传预设附件，只归档用户本轮实际提供的材料」；`reminder` 形态同样保留。
- **资产路由** `GET /crm-workspace/asset/<file>`：与 API 同样的回环/同源校验，只允许单段文件名，`private, max-age=300`，缺失 404。

### 变更

- `bootstrap.config` 回显 `canPublishStandardScenario` / `registryEndpoint` / `registryConfigured`；`taxonomy` 增加 `sourceTypes` / `presetAttachmentExtensions` / `presetAttachmentRole`；`plugin.version` 升到 `1.3.0`。
- `activation.state` 增加 `draft`：`{ text, source, attachments[] }`，附件只带 `url`（不泄露落盘路径），供输入框与托盘复用。
- HTTP 请求体上限由 1 MiB 提到 40 MiB（附件 base64 内联上传），dispatch 从 11 项扩到 17 项。
- 删除/编辑卡片时同步清理不再被引用的附件文件（`pruneAssets`）。

### 验证

- `node --test`：88 个用例全部通过（新增预设附件 schema、存档往返、注入边界声明、输入框契约、安装幂等、导出/导入、发布权限、未配置仓库等用例）。
- `node scripts/check.mjs`：6 组自检通过（客户端无硬编码颜色、仍为经典脚本、主题变量齐全）。

## 1.2.0

按用户反馈调整「进入场景」的观感与信息量：不再把技能介绍/正文灌进上下文，并让场景名在对话里直接可见。

### 修复

- **进入场景不再刷技能介绍**：注入块默认只含场景说明、默认上下文与 Skill **名称**（`mode=names`，约 900–1500 字符）。原实现首次注入两条 Skill 全文共 21 437 字符，导致每次请求的「最后一条用户消息」投影被整段技能说明占据。
- **技能介绍默认不出现**：`skillLines` 默认只输出 `n. <name>`，描述仅在 `injectSkillDescriptions: true` 时以单行（≤120 字符）追加。

### 新增

- **会话标题栏场景标签**：在 `conversation.session.header.actions`（order 30）注册「场景 · <标题>」按钮，跟随当前会话轮询激活状态（8 秒、页面隐藏时暂停、聚焦即时刷新），点击打开工作台面板。标签是 UI 投影：不写会话历史、不产生消息气泡、不消耗模型调用。
- **配置开关** `injectSkillBodies`（默认 `false`）与 `injectSkillDescriptions`（默认 `false`）：需要正文直填的部署可显式打开，恢复「首次全文 / 之后提醒」的老行为。
- `preview.injection` 返回值新增 `mode`、`includeDescriptions`、`includeBodies`、`characters`，预览面板据此解释当前形态。

### 变更

- `mode` 从两态（`full` / `reminder`）变为三态：`names`（默认）/ `full`（仅正文开关打开时的首次）/ `reminder`（正文开关打开时的后续轮次）。
- 正文关闭时 `resolveStack` 跳过 `service.get` 与目录正文读取，`loaded/missing` 一律为 `false`，避免每轮加载几万字再丢弃。
- `bootstrap.config` 回显 `injectSkillBodies` / `injectSkillDescriptions`。

### 验证

- `node --test`：69 个用例全部通过（新增「默认只注入名称」「显式打开后首次全文」两组对照用例，预览用例覆盖三态）。
- 预览（真机 `crm_crm_2_copy` 卡片）：由 21 437 字符降到 **601** 字符，不再包含技能描述与 `## Skill 正文`，技能栈只剩两行名称。

## 1.1.0

修正在真实 Host 环境验证时暴露的两个正确性问题，并补上公司 Skill 的可用路径。

### 修复

- **不再谎称 Skill「不存在」**：DSH 的 `skills` 服务是分层注册表，插件运行在 Host 根作用域，只看得到全局层；公司 Skill（`crm-core` 等）挂在 agent preset 层，根视图里本来就看不见。原实现在这种情形下把 Skill 写成「当前 Skill 仓库中不存在」——这是错误断言。现在统一写「未预载正文」，并要求模型按技能栈顺序用 `skill` 工具自行加载，加载失败才如实告知用户。
- **模型请求阶段改用派发作用域的 skills 服务**：`agent/pre-step` 监听器改成具名 `function`（而非箭头函数），从 Cordis 的派发作用域取 `skills`，优先使用比根视图更完整的分层视图；取不到时退回根服务，任何情况都不抛错。

### 新增

- **`skillCatalogDir`（Skill 目录兜底）**：只读扫描 `<目录>/<skill>/SKILL.md`，解析 `name/description/whenToUse` 与正文，作为选择器与注入的补充来源。未配置时自动探测 `<DSH_HOME>/skills`，显式路径 / 相对 profile 路径 / `off` 均可。目录表不注册进注册表、不参与路由，失败静默降级为空。
- `test/skilldir.test.js`：frontmatter 解析（含缺失与无 frontmatter）、目录扫描去重排序、目录缺失降级、描述兜底。

### 变更

- **`showSidebarEntry` 真正生效**：之前该键只出现在 `bootstrap` 的配置回显里，客户端并未据此调整。现在入口注册后会读取配置，为 `false` 时主动撤下侧边栏入口（面板仍可按 key 直接寻址，便于排障）；配置变更后刷新页面即生效。
- `skills.list` 返回值新增 `origin`（`registry` / `directory`）与 `directory` 字段；`preview.injection` 每条技能新增 `loaded`，并把 `cwd` 作为可选参数。
- 打开「管理模式」时，选择器提示补充说明：公司 Skill 未出现在候选里可以直接输入名称回车追加。

### 验证

- `node --test`：65 个用例全部通过（新增 Skill 目录 5 例、派发作用域优先级 1 例）。
- 真机验证（`http://127.0.0.1:53312`）：`skills.list` 由 8 条内置 Skill 变成 15 条（含 `crm-core`、`crm-data-analysis`、`crm-record-change`、`sfoa-record-change`）；`preview.injection` 由 634 字符（两条都 missing）变成 21437 字符，两条技能正文均真实预载（4506 / 18019 字符）。

## 1.0.0

首个生产版本。定位是「动态场景容器 + 显式 Skill 组装器」：面板不含任何业务卡片，所有场景由管理员配置驱动，点卡片即按配置顺序装配 Skill 栈。

### 新增

- **场景配置（`ScenarioCardConfig`）**：编码、标题、必填介绍、图标、分类、快捷指令、启停、系统底座标记、`pinnedSkills`、`prePinnedContext`（默认对象 / 默认动作 / 表单入口 / 附件开关）、开场引导语。字段级校验与规范化，错误可回填到编辑器对应输入框。
- **面板（`main` slot，key `crm-workspace`）**：卡片网格、分类与关键词筛选、显示已停用、新建/编辑/复制/排序/启停/删除、注入内容预览、当前场景条（含开场引导语、进入对话、退出场景）、管理模式开关（记忆在 `localStorage`）、5 秒可见性感知轮询。
- **侧边栏入口**：「场景工作台」，`label` 以函数形式注册，语言切换后即时生效。
- **显式 Skill 组装**：按 `pinnedSkills` 顺序解析技能栈，顺序不做任何重排；Skill 服务缺失或单条不存在时在上下文里显式标注，不静默跳过。
- **上下文注入**：`agent/pre-step` waterfall 注入，按会话过滤；首次注入技能正文（单技能 16k / 总计 48k 字符预算，截断处写明原文长度），之后只注入紧凑提醒；注入消息由已有用户消息克隆，不手写 `MessageBase`。
- **Host 指令**：每张启用卡片的 `slashCommand` 注册为同名的 `/指令`，执行即激活场景并回显技能栈与开场语；另有 `/crm` 列出可用场景；指令名与内置指令冲突时让位并记日志。
- **同源 HTTP 接口** `/crm-workspace/api`：方法白名单、POST + JSON、1 MiB 上限、回环/信任 Host 校验、跨站拒绝、`no-store`、异常不回传堆栈。
- **存档**：`<profile>/crm-workspace/state.json`，临时文件 + rename 原子写，写前备份为 `state.backup.json`；损坏文件重命名隔离并进入只读模式；存档版本高于插件时拒绝写入，避免降级覆盖；激活记录按 7 天 / 200 条裁剪。
- **零 npm 依赖**：只使用宿主提供的模块与 Cordis 服务，无需打包构建。

### 已知边界

- 注入是「每次请求追加一条消息」，不写入会话历史；因此会话记录里看不到场景块，符合「不污染用户可见消息流」的取舍。
- 卡片级权限（谁能编辑场景）由 DSH 自身的面板访问控制决定，插件未额外实现角色体系。
- `preview.injection` 展示的是文本形态，不渲染模型最终请求的完整结构。

### 验证

- `node --test`：59 个用例（schema / 存档 / 上下文块 / 业务门面 / HTTP / 整装集成），全部通过。
- `node scripts/check.mjs`：清单字段、被引用文件、客户端加载方式、主题变量（禁止硬编码颜色）、locale、bundle patch，全部通过。
