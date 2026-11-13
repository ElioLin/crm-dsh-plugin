# 变更记录

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
