# 变更记录

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
- **侧边栏入口**：「CRM 智能工作台」，`label` 以函数形式注册，语言切换后即时生效。
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
