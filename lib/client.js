/**
 * 场景工作台 —— Web 客户端（原生客户端插件，无 JSX 构建步骤）。
 *
 * 载入方式由 Host 的 ModuleLoader 决定：本文件是 classic script，
 * 通过 `window.__ModuleLoader__.load` 暴露 `apply/inject`，React 由宿主提供。
 *
 * 界面结构：
 *   sidebar.panellist 入口  →  main 面板（key = crm-workspace）
 *   面板 = 头部 + 当前场景条 + 过滤栏 + 场景卡片网格 + 编辑器 / 预览对话框
 * 卡片内容 100% 来自 Host 的场景配置，代码里不内置任何业务卡片。
 */

window.__ModuleLoader__.load({
  // 这个 id 必须与 package.json 的 name 完全一致：宿主按包名（含 scope）生成
  // boot manifest 的行，并校验脚本有没有注册同名模块。
  id: '@runner-corp/dsh-scenario-workspace',
  factory: (require) => {
    const React = require('react');
    const { useCallback, useEffect, useMemo, useRef, useState } = React;
    const h = React.createElement;

    const PLUGIN_ID = 'crm-workspace';
    const API_PATH = '/crm-workspace/api';
    const PANEL_KEY = 'crm-workspace';
    /** 客户端包版本：与 package.json 的 version 保持一致（scripts/check.mjs 会核对）。 */
    const CLIENT_VERSION = '1.14.0';
    /**
     * 业务系统的「建议值」——不是枚举：用户可以在新建场景里填任何系统名。
     * 宿主 bootstrap 会下发同一份列表（lib/core/constants.js 的 BUSINESS_SYSTEMS），
     * 这里只是宿主没下发时的兜底，保证新建场景的下拉框不会空着。
     */
    const DEFAULT_BUSINESS_SYSTEMS = [
      { key: 'crm', label: 'CRM' },
      { key: 'tapd', label: 'TAPD' },
      { key: 'other', label: '其他' },
    ];
    const STYLE_ID = 'crm-workspace-styles';
    const ADMIN_KEY = 'crm-workspace:admin-mode';
    const STANDARD_SOURCE = 'COMPANY_STANDARD';
    const LOCAL_SOURCE = 'LOCAL_CUSTOM';
    /** 由 apply 装配的入口开关：为 false 时撤下侧边栏入口（配置驱动，不改代码）。 */
    let sidebarGate = null;

    /* ── i18n ───────────────────────────────────────────────────── */

    /**
     * 插件界面固定中文：不再注册英文词典，也不绑定宿主 locale。
     * （宿主语言为 en 时，locale.bind 会把中文原文整体翻成英文，导致界面英文。）
     * 保留 `t()` 这层壳，方便以后接入真正的多语言而不改调用点。
     */
    const t = (message) => message;

    /**
     * 兼容旧调用点：不再注册语言包，只做一次空操作。
     */
    function installLocale() {}

    /* ── 图标 ───────────────────────────────────────────────────── */

    const ICON_PATHS = {
      briefcase: ['M3 8h18v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z', 'M9 8V6a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2', 'M3 13h18'],
      'file-plus': ['M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z', 'M14 3v5h5', 'M12 12v6', 'M9 15h6'],
      edit: ['M12 20h9', 'M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z'],
      search: ['M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z', 'M21 21l-4.3-4.3'],
      users: ['M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2', 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z', 'M22 21v-2a4 4 0 0 0-3-3.9', 'M16 3.1a4 4 0 0 1 0 7.8'],
      chart: ['M4 20V10', 'M10 20V4', 'M16 20v-7', 'M22 20H2'],
      target: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10Z', 'M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z'],
      shield: ['M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z', 'M9 12l2 2 4-4'],
      clipboard: ['M9 4h6a1 1 0 0 1 1 1v1H8V5a1 1 0 0 1 1-1Z', 'M8 6H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-2', 'M9 12h6', 'M9 16h4'],
      building: ['M4 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16', 'M16 9h2a2 2 0 0 1 2 2v10', 'M8 7h4', 'M8 11h4', 'M8 15h4', 'M2 21h20'],
      workflow: ['M6 7a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z', 'M18 7a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z', 'M12 21a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z', 'M6 9v4a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V9'],
      sparkles: ['M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9Z', 'M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9Z', 'M5 15l.7 1.6L7.3 17l-1.6.7L5 19.3l-.7-1.6L2.7 17l1.6-.7Z'],
      x: ['M6 6l12 12', 'M18 6L6 18'],
      more: ['M12 6.5h.01', 'M12 12h.01', 'M12 17.5h.01'],
      up: ['M12 19V5', 'M6 11l6-6 6 6'],
      down: ['M12 5v14', 'M6 13l6 6 6-6'],
      plus: ['M12 5v14', 'M5 12h14'],
      refresh: ['M21 12a9 9 0 1 1-3-6.7', 'M21 3v6h-6'],
    };

    function Icon({ name, size = 20, strokeWidth = 1.7 }) {
      const paths = ICON_PATHS[name] ?? ICON_PATHS.sparkles;
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        paths.map((d, index) => h('path', { key: index, d })),
      );
    }

    /* ── 样式 ───────────────────────────────────────────────────── */

    const CSS = `
.crmw-root{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px}
.crmw-head{display:flex;align-items:center;gap:12px;padding:14px 20px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.crmw-title{display:flex;flex-direction:column;gap:2px;min-width:0}
.crmw-title h2{margin:0;font-size:15px;font-weight:600;letter-spacing:.01em}
.crmw-title span{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.crmw-grow{flex:1 1 auto;min-width:0}
.crmw-body{flex:1 1 auto;overflow:auto;padding:18px 20px 28px;display:flex;flex-direction:column;gap:14px}
.crmw-btn{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:12px;cursor:pointer;transition:border-color .15s,background .15s}
.crmw-btn:hover{border-color:var(--dsw-alias-brand-primary)}
.crmw-btn:disabled{opacity:.5;cursor:not-allowed}
.crmw-btn.primary{background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);font-weight:600}
.crmw-btn.primary:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-brand-primary)}
.crmw-btn.ghost{background:transparent;border-color:transparent;color:var(--dsw-alias-label-secondary)}
.crmw-btn.ghost:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}
.crmw-btn.danger{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,transparent)}
.crmw-btn.sm{height:24px;padding:0 8px;font-size:11px;border-radius:6px}
.crmw-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:8px;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.crmw-icon-btn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.crmw-input,.crmw-select,.crmw-textarea{width:100%;box-sizing:border-box;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:7px 10px;outline:none}
.crmw-input:focus,.crmw-select:focus,.crmw-textarea:focus{border-color:var(--dsw-alias-brand-primary)}
.crmw-textarea{min-height:92px;resize:vertical;line-height:1.55}
.crmw-input.bad,.crmw-select.bad,.crmw-textarea.bad{border-color:var(--dsw-alias-state-error-primary)}
.crmw-field{display:flex;flex-direction:column;gap:5px;min-width:0}
.crmw-field>label{font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary);letter-spacing:.02em}
.crmw-field .hint{font-size:11px;color:var(--dsw-alias-label-secondary);line-height:1.5}
.crmw-field .err{font-size:11px;color:var(--dsw-alias-state-error-primary);line-height:1.5}
.crmw-row{display:flex;gap:12px;flex-wrap:wrap}
.crmw-row>*{flex:1 1 220px;min-width:0}
.crmw-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.crmw-chip{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 9px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11px;cursor:pointer;user-select:none;white-space:nowrap}
.crmw-chip.on{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent)}
.crmw-chip.static{cursor:default}
/* stretch：同一行的卡片等高；再看下面的固定区域高度，整片网格看起来就是统一尺寸。 */
.crmw-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(268px,1fr));gap:12px;align-items:stretch}
.crmw-card{position:relative;display:flex;flex-direction:column;gap:9px;padding:14px;border-radius:12px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);transition:border-color .15s,transform .15s,box-shadow .15s;min-height:196px;min-width:0}
.crmw-card:hover{border-color:var(--dsw-alias-brand-primary);box-shadow:0 6px 18px rgba(0,0,0,.08);transform:translateY(-1px)}
.crmw-card.disabled{opacity:.62}
.crmw-card-top{display:flex;align-items:flex-start;gap:10px}
.crmw-card-icon{display:flex;align-items:center;justify-content:center;width:34px;height:34px;flex:0 0 auto;border-radius:10px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);color:var(--dsw-alias-brand-primary)}
.crmw-card-title{font-size:13px;font-weight:600;line-height:1.35;word-break:break-word;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;min-height:2.7em}
.crmw-card-cat{font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:2px}
/* 介绍固定两行高：超出部分裁剪，鼠标悬停看全文（title 属性），保持卡片尺寸一致。 */
.crmw-card-desc{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;white-space:pre-wrap;word-break:break-word;height:3.2em;cursor:help}
.crmw-card-draft{margin:0;display:flex;align-items:baseline;gap:6px;font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-secondary)}
.crmw-card-draft b{flex:none;font-weight:600;color:var(--dsw-alias-brand-primary)}
.crmw-card-draft span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.crmw-skills{display:flex;flex-wrap:nowrap;gap:4px;overflow:hidden;min-height:20px}
.crmw-skill{display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 7px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);font-size:10.5px;color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.crmw-skill.missing{border-style:dashed;color:var(--dsw-alias-state-warn-primary)}
.crmw-card-foot{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:auto;padding-top:8px;border-top:1px dashed var(--dsw-alias-border-l1)}
.crmw-cmd{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent);padding:2px 6px;border-radius:5px}
.crmw-badge{font-size:10px;padding:2px 6px;border-radius:5px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}
.crmw-menu{position:relative}
.crmw-menu-btn{cursor:pointer;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary)}
.crmw-menu-btn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.crmw-menu-btn[aria-expanded="true"]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.crmw-menu-list{position:absolute;right:0;top:26px;z-index:20;min-width:132px;padding:4px;border-radius:9px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-overlay);box-shadow:0 10px 28px rgba(0,0,0,.22);display:flex;flex-direction:column}
.crmw-menu-list button{text-align:left;padding:6px 9px;border-radius:6px;border:0;background:transparent;color:var(--dsw-alias-label-primary);font-size:12px;cursor:pointer}
.crmw-menu-list button:hover{background:var(--dsw-alias-bg-layer-2)}
.crmw-menu-list button.danger{color:var(--dsw-alias-state-error-primary)}
.crmw-active{display:flex;align-items:center;gap:12px;padding:11px 14px;border-radius:11px;border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 9%,transparent)}
.crmw-active-text{display:flex;flex-direction:column;gap:3px;min-width:0}
.crmw-active-text strong{font-size:12px}
.crmw-active-text span{font-size:11.5px;color:var(--dsw-alias-label-secondary);line-height:1.55;white-space:pre-wrap}
.crmw-banner{display:flex;gap:9px;padding:10px 12px;border-radius:9px;font-size:12px;line-height:1.6;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.crmw-banner.warn{border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 45%,transparent);color:var(--dsw-alias-state-warn-primary)}
.crmw-banner.error{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent);color:var(--dsw-alias-state-error-primary)}
/* 升级提示：正文段落之间留一点气口，最后一句「需要重启」不贴边。 */
.crmw-update{display:flex;flex-direction:column;gap:8px}
.crmw-update p{margin:0;font-size:12px;line-height:1.6}
.crmw-update p.crmw-dim{color:var(--dsw-alias-label-secondary);font-size:11.5px}
.crmw-scenechip{display:inline-flex;align-items:center;gap:6px;max-width:260px;padding:3px 9px;border-radius:999px;border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 40%,transparent);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent);color:var(--dsw-alias-brand-primary);font-size:12px;line-height:1.4;cursor:pointer}
.crmw-scenechip:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 18%,transparent)}
.crmw-scenechip span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.crmw-tabs{display:inline-flex;align-items:center;gap:2px;padding:2px;border-radius:9px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1)}
.crmw-tab{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 11px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;cursor:pointer}
.crmw-tab.on{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.12)}
.crmw-tab .n{font-size:10.5px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary)}
.crmw-tab.on .n{color:var(--dsw-alias-brand-primary)}
.crmw-pill{display:flex;flex-direction:column;gap:6px;margin:6px 0 8px;padding:8px 10px;border-radius:10px;border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,transparent);font-size:12px;line-height:1.5}
.crmw-pill-row{display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap}
.crmw-pill-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-success-primary);flex:0 0 auto}
.crmw-guide{display:flex;flex-direction:column;gap:7px;margin:6px 0 2px;padding:12px 14px;border-radius:12px;border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 30%,transparent);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 6%,var(--dsw-alias-bg-layer-1))}
.crmw-guide-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-brand-primary)}
.crmw-guide-head strong{font-size:12.5px;color:var(--dsw-alias-label-primary)}
.crmw-guide p{margin:0;font-size:12.5px;line-height:1.65;color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word}
.crmw-guide .crmw-cmd{margin-left:auto}
.crmw-pill-title{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}
.crmw-pill-meta{font-size:11px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.crmw-pill-skills{display:inline-flex;align-items:center;gap:4px;min-width:0;overflow:hidden}
/* 提示行在状态条之外（不进 role=status 的 live region）：单独给边距与左内边距对齐。 */
.crmw-pill-note{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0 0 8px;padding:0 10px;font-size:11.5px;line-height:1.5;color:var(--dsw-alias-state-warn-primary)}
/* 「已有对话，没自动预填」是常态而不是故障：用次要色，别把正常路径染成告警。 */
.crmw-pill-note.info{color:var(--dsw-alias-label-secondary)}
.crmw-gate-list{margin:8px 0;padding-left:20px;font-size:13px}
.crmw-gate-list li{margin:4px 0}
.crmw-attach-list{display:flex;flex-wrap:wrap;gap:4px}
.crmw-attach{display:inline-flex;align-items:center;gap:4px;max-width:100%;padding:2px 7px;border-radius:6px;border:1px dashed var(--dsw-alias-border-l2);font-size:10.5px;color:var(--dsw-alias-label-secondary)}
.crmw-tag{display:inline-flex;align-items:center;height:18px;padding:0 6px;border-radius:5px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);color:var(--dsw-alias-brand-primary);font-size:10px;white-space:nowrap}
.crmw-fault{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:6px 0 2px;padding:8px 12px;border-radius:10px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 8%,transparent);font-size:11.5px;color:var(--dsw-alias-label-primary)}
.crmw-stack{display:flex;flex-wrap:wrap;gap:4px}
.crmw-stack-item{display:inline-flex;align-items:center;gap:4px;padding:2px 6px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);font-size:10.5px;color:var(--dsw-alias-label-secondary)}
.crmw-stack-item button{border:0;background:transparent;cursor:pointer;color:var(--dsw-alias-label-secondary);padding:0 2px;font-size:11px;line-height:1}
.crmw-stack-item button:hover{color:var(--dsw-alias-brand-primary)}
.crmw-foot{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:6px 14px;border-top:1px solid var(--dsw-alias-border-l1);font-size:10.5px;color:var(--dsw-alias-label-secondary)}
.crmw-file{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}
.crmw-file .nm{font-size:11.5px;flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.crmw-file .sz{font-size:10.5px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;white-space:nowrap}
.crmw-empty{display:flex;flex-direction:column;align-items:center;gap:10px;padding:48px 20px;text-align:center;border:1px dashed var(--dsw-alias-border-l2);border-radius:14px;color:var(--dsw-alias-label-secondary)}
.crmw-empty h3{margin:0;font-size:14px;color:var(--dsw-alias-label-primary)}
.crmw-empty p{margin:0;font-size:12px;line-height:1.7;max-width:460px}
.crmw-mask{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;padding:24px;background:color-mix(in srgb,var(--dsw-alias-bg-base) 40%,rgba(0,0,0,.45))}
.crmw-dialog{display:flex;flex-direction:column;width:min(760px,100%);max-height:min(86vh,860px);border-radius:14px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);box-shadow:0 24px 64px rgba(0,0,0,.32);overflow:hidden}
.crmw-dialog.narrow{width:min(480px,100%)}
.crmw-dialog.wide{width:min(920px,100%)}
.crmw-dialog-head{display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.crmw-dialog-head h3{margin:0;font-size:13.5px;font-weight:600}
.crmw-dialog-body{padding:16px;overflow:auto;display:flex;flex-direction:column;gap:12px}
.crmw-dialog-foot{display:flex;align-items:center;gap:8px;padding:12px 16px;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}
.crmw-switch{display:inline-flex;align-items:center;gap:7px;font-size:11.5px;color:var(--dsw-alias-label-secondary);cursor:pointer;user-select:none}
.crmw-switch input{appearance:none;-webkit-appearance:none;width:30px;height:17px;border-radius:999px;background:var(--dsw-alias-border-l2);position:relative;cursor:pointer;transition:background .15s;margin:0;border:0}
.crmw-switch input:checked{background:var(--dsw-alias-brand-primary)}
.crmw-switch input::after{content:'';position:absolute;top:2px;left:2px;width:13px;height:13px;border-radius:50%;background:var(--dsw-alias-bg-base);box-shadow:0 1px 2px rgba(0,0,0,.28);transition:transform .15s}
.crmw-switch input:checked::after{transform:translateX(13px)}
.crmw-switch input:disabled{cursor:not-allowed}
/* 表单里的「选项」：带标题 + 说明的勾选块，未选/已选状态一眼可分（不再整块变黑）。 */
.crmw-options{display:grid;grid-template-columns:repeat(auto-fit,minmax(216px,1fr));gap:8px}
.crmw-option{display:flex;align-items:flex-start;gap:9px;padding:9px 11px;border-radius:9px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);cursor:pointer;transition:border-color .15s,background .15s}
.crmw-option:hover{border-color:var(--dsw-alias-border-l2)}
.crmw-option.on{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 55%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,var(--dsw-alias-bg-layer-1))}
.crmw-option input{appearance:none;-webkit-appearance:none;flex:0 0 auto;width:15px;height:15px;margin:1px 0 0;border-radius:4px;border:1.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);position:relative;cursor:pointer;transition:background .15s,border-color .15s}
.crmw-option input:checked{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.crmw-option input:checked::after{content:'';position:absolute;left:4.5px;top:1px;width:4px;height:8px;border:solid var(--dsw-alias-bg-base);border-width:0 2px 2px 0;transform:rotate(45deg)}
.crmw-option input:disabled{opacity:.55;cursor:not-allowed}
.crmw-option-text{display:flex;flex-direction:column;gap:2px;min-width:0}
.crmw-option-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary)}
.crmw-option.off .crmw-option-title{font-weight:500;color:var(--dsw-alias-label-secondary)}
.crmw-option-hint{font-size:10.5px;line-height:1.5;color:var(--dsw-alias-label-secondary)}
.crmw-stack{display:flex;flex-direction:column;gap:5px}
.crmw-stack-item{display:flex;align-items:center;gap:7px;padding:5px 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}
.crmw-stack-item .idx{width:17px;flex:0 0 auto;text-align:center;font-size:10.5px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.crmw-stack-item .nm{flex:1 1 auto;min-width:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.crmw-stack-item .nm.missing{color:var(--dsw-alias-state-warn-primary);text-decoration:underline dotted}
.crmw-pre{margin:0;padding:12px;border-radius:9px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:1.65;white-space:pre-wrap;word-break:break-word;max-height:52vh;overflow:auto}
.crmw-toasts{position:fixed;right:18px;bottom:18px;z-index:80;display:flex;flex-direction:column;gap:8px;pointer-events:none}
.crmw-toast{pointer-events:auto;display:flex;align-items:flex-start;gap:8px;max-width:340px;padding:9px 12px;border-radius:9px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-overlay);box-shadow:0 8px 24px rgba(0,0,0,.24);font-size:12px;line-height:1.55;white-space:pre-wrap}
.crmw-toast.ok{border-left:3px solid var(--dsw-alias-state-success-primary)}
.crmw-toast.err{border-left:3px solid var(--dsw-alias-state-error-primary)}
.crmw-spin{width:13px;height:13px;border-radius:50%;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);animation:crmw-spin .8s linear infinite}
@keyframes crmw-spin{to{transform:rotate(360deg)}}
.crmw-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.crmw-dim{color:var(--dsw-alias-label-secondary)}
.crmw-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
`;

    function installStyles() {
      if (document.getElementById(STYLE_ID) !== null) return;
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    /* ── Host 接口 ──────────────────────────────────────────────── */

    /**
     * 把 Host 的失败响应翻译成一句人话。
     * 字段级校验错误保持 `字段: 说明` 的行格式，编辑器据此把错误挂回具体输入框。
     */
    function describeFailure(payload, status) {
      if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
        return payload.errors
          .map((item) => `${item?.field ?? ''}: ${item?.message ?? ''}`.trim())
          .join('\n');
      }
      if (typeof payload?.message === 'string' && payload.message !== '') return payload.message;
      return `请求失败（HTTP ${status}）`;
    }

    async function callHost(method, params = {}, signal) {
      const response = await fetch(API_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method, params }),
        signal,
      });
      let payload;
      try {
        payload = await response.json();
      } catch {
        throw new Error(`接口返回了无法解析的内容（HTTP ${response.status}）`);
      }
      if (response.ok !== true || payload?.ok !== true) {
        const error = new Error(describeFailure(payload, response.status));
        error.details = payload;
        throw error;
      }
      return payload;
    }

    /** 触发浏览器下载一个 JSON 文件（场景包导出 / 公司场景离线分发）。 */
    function downloadJson(fileName, data) {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = fileName;
      anchor.rel = 'noopener';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 4000);
    }

    function readFileAsBase64(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = typeof reader.result === 'string' ? reader.result : '';
          const comma = result.indexOf(',');
          resolve(comma < 0 ? '' : result.slice(comma + 1));
        };
        reader.onerror = () => reject(reader.error ?? new Error('读取本地文件失败'));
        reader.readAsDataURL(file);
      });
    }

    function formatBytes(value) {
      const size = Number(value);
      if (!Number.isFinite(size) || size <= 0) return '';
      if (size < 1024) return `${size} B`;
      if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
      return `${(size / (1024 * 1024)).toFixed(1)} MB`;
    }

    /* ── 宿主上下文小工具 ───────────────────────────────────────── */

    function getService(ctx, name) {
      try {
        return ctx.reflect?.get?.(name);
      } catch {
        return undefined;
      }
    }

    /**
     * 最近一次真正显示过的会话。
     *
     * 工作台是另一个 main 面板：切到工作台后对话面板被卸载，DSH 会释放
     * `mainView` 租用，`uiSession` 的当前绑定随之变空。此时仍然要能回答
     * 「用户刚才在哪个会话里」——否则每次点卡片都会再新建一个会话。
     */
    let lastSessionId = '';

    /**
     * 解析「当前主面板正在显示的会话」。
     *
     * DSH 的 `sessions.list` 快照里**没有** `current` 字段（只有 ids / byId /
     * phase），真正的当前会话由 uiSession 的 main 绑定决定：谁的
     * `retainedBy.mainView > 0`，主面板显示的就是谁。旧实现只读
     * `snapshot.current`，永远拿到 undefined —— 于是「进入场景」会在后台
     * 新建一个用户看不见的会话，激活、预填、徽标全部落在那个会话上。
     *
     * 取值顺序：uiSession.adapter.current → 列表里 mainView 租用的那一行 →
     * 老版本的 snapshot.current（兼容）。
     */
    function currentSessionId(ctx) {
      try {
        // uiSession 没有写进 inject 清单：统一走 reflect 取，避免 ctx.uiSession 未注入。
        const source = getService(ctx, 'uiSession')?.adapter?.current;
        const binding =
          source === undefined || source === null
            ? undefined
            : typeof source.getSnapshot === 'function'
              ? source.getSnapshot()
              : source.value;
        const key = binding?.key;
        if (typeof key === 'string' && key !== '') {
          lastSessionId = key;
          return key;
        }
      } catch {
        /* 服务形态变化时继续走下面的兜底 */
      }
      try {
        const snapshot = ctx.sessions?.list?.getSnapshot?.();
        if (typeof snapshot?.current === 'string' && snapshot.current !== '') {
          lastSessionId = snapshot.current;
          return snapshot.current;
        }
        const byId = snapshot?.byId ?? {};
        for (const row of Object.values(byId)) {
          if ((row?.retainedBy?.mainView ?? 0) > 0 && typeof row?.id === 'string' && row.id !== '') {
            lastSessionId = row.id;
            return row.id;
          }
        }
      } catch {
        /* 列表不可用时返回 undefined */
      }
      return undefined;
    }

    /**
     * 「进入场景」应该落在哪个会话上：优先当前显示的会话；对话面板刚被
     * 工作台顶掉时退回最近显示过的会话（仍需在会话列表里存在）。
     */
    function resumableSessionId(ctx) {
      const live = currentSessionId(ctx);
      if (live !== undefined) return live;
      if (lastSessionId === '') return undefined;
      try {
        const snapshot = ctx.sessions?.list?.getSnapshot?.();
        const byId = snapshot?.byId;
        if (byId !== undefined && Object.keys(byId).length > 0 && byId[lastSessionId] === undefined) {
          lastSessionId = '';
          return undefined;
        }
      } catch {
        /* 列表读不到时仍然信任最近会话 */
      }
      return lastSessionId;
    }

    /** 记录一次真实渲染过的会话（对话面板与输入框组件每次挂载都会调用）。 */
    function rememberSession(sessionId) {
      if (typeof sessionId === 'string' && sessionId !== '') lastSessionId = sessionId;
    }

    function currentWorkspaceId(ctx) {
      try {
        const workspaces = ctx.workspaces?.list?.getSnapshot?.();
        const sessionId = resumableSessionId(ctx);
        if (sessionId !== undefined) {
          const selected = workspaces?.items?.find(
            (item) => Array.isArray(item.sessionIds) && item.sessionIds.includes(sessionId),
          );
          if (selected?.workspaceId !== undefined) return selected.workspaceId;
        }
        // 会话还没归属工作区（刚建的空白会话）时才用宿主记录的最近工作区；
        // 不猜「第一个工作区」，避免把会话建到用户没在用的目录里。
        return workspaces?.recentWorkspaceId;
      } catch {
        return undefined;
      }
    }

    /**
     * 会话属于哪个工作区。先问工作区快照（sessionIds 是权威归属），
     * 再退回会话快照上的 workspaceId —— 刚建出来的会话可能还没被工作区快照收录。
     */
    function sessionWorkspaceId(ctx, sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return undefined;
      try {
        const snapshot = ctx.workspaces?.list?.getSnapshot?.();
        const hit = (snapshot?.items ?? []).find(
          (item) => Array.isArray(item.sessionIds) && item.sessionIds.includes(sessionId),
        );
        if (hit?.workspaceId !== undefined) return hit.workspaceId;
      } catch {
        /* 继续问会话快照 */
      }
      try {
        const byId = ctx.sessions?.list?.getSnapshot?.()?.byId ?? {};
        return byId[sessionId]?.workspaceId;
      } catch {
        return undefined;
      }
    }

    /** 会话的工作目录（宿主有时只给 cwd，不给 workspaceId）。 */
    function sessionCwd(ctx, sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return undefined;
      try {
        const byId = ctx.sessions?.list?.getSnapshot?.()?.byId ?? {};
        const row = byId[sessionId];
        return typeof row?.cwd === 'string' ? row.cwd : undefined;
      } catch {
        return undefined;
      }
    }

    /** 两个目录是不是同一个（大小写、分隔符、尾部斜杠都不敏感）。 */
    function samePath(left, right) {
      if (typeof left !== 'string' || typeof right !== 'string') return false;
      const normalize = (value) => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
      const a = normalize(left);
      const b = normalize(right);
      return a !== '' && a === b;
    }

    /**
     * 右侧栏资源地址（1.10.0）里的一段：转义但保留盘符的冒号。
     *
     * 宿主认的写法是 `dsh-resource://file/session/<会话 id>/<相对工作区根的路径>`，
     * Windows 绝对路径则是 `dsh-resource://file/absolute/C:/x/y.txt`：每段组件编码、
     * 盘符的 `:` 例外（不编码），否则 `C:` 会变成 `C%3A` 打不开。
     */
    function encodeAddressSegment(segment) {
      return encodeURIComponent(String(segment ?? '')).replace(/%3A/gi, ':');
    }

    /**
     * 把一个文件路径拼成右侧栏能打开的地址（纯函数，单测直接调）。
     *
     * 路径在会话工作目录里时用 `session` 形式（相对路径更稳：工作区搬家也不失效），
     * 否则退回 `absolute` 形式。拼不出来（空路径）返回空串，由调用方提示。
     */
    function fileAddressFor(sessionId, cwd, path) {
      const target = typeof path === 'string' ? path.replace(/\\/g, '/') : '';
      if (target === '') return '';
      const base = typeof cwd === 'string' ? cwd.replace(/\\/g, '/').replace(/\/+$/, '') : '';
      const relative =
        base !== '' && target.toLowerCase().startsWith(`${base.toLowerCase()}/`) ? target.slice(base.length + 1) : '';
      const segments =
        relative !== '' && typeof sessionId === 'string' && sessionId !== ''
          ? ['session', sessionId, ...relative.split('/')]
          : ['absolute', ...target.replace(/^\/+/, '').split('/')];
      return `dsh-resource://file/${segments.map(encodeAddressSegment).join('/')}`;
    }

    /** 在右侧栏打开一个文件（技能正文就是它所在目录的 SKILL.md）。 */
    function openFileInSidebar(ctx, sessionId, path) {
      try {
        const address = fileAddressFor(sessionId, sessionCwd(ctx, sessionId), path);
        if (address === '') return false;
        const sidebar = getService(ctx, 'sidebarRight');
        if (typeof sidebar?.openResource !== 'function') return false;
        sidebar.openResource(address);
        return true;
      } catch {
        return false;
      }
    }

    /**
     * 点场景栏里的技能名：像用户在输入框里点技能 chip 一样，在右侧栏打开它的 SKILL.md。
     *
     * DSH 自带的 `/技能名` 文本节点要变成可点 chip，依赖该会话的技能目录（lexicon）
     * 已经结算；预填发生在会话刚建好的那一刻，这个时序我们控制不了。所以场景栏自己
     * 提供一条稳定的入口：拿着 host 下发的技能文件路径直接开右侧栏。
     *
     * 返回 `{ ok, error }`：提示交给组件（模块级没有 toast）。
     */
    function openSkillFile(ctx, sessionId, skill) {
      const name = typeof skill?.name === 'string' ? skill.name : '';
      const path = typeof skill?.path === 'string' ? skill.path : '';
      if (path === '') {
        return { ok: false, error: `「${name}」没有可打开的文件路径：它可能来自内置技能包` };
      }
      if (openFileInSidebar(ctx, sessionId, path) !== true) {
        return { ok: false, error: `打不开右侧栏预览：技能文件在 ${path}` };
      }
      return { ok: true, error: '' };
    }

    /**
     * 会话是否已经落在目标工作区里。
     * 目标为空（没指定工作区）时一律算「在」——保持老行为。
     */
    function sessionBelongsTo(ctx, sessionId, workspaceId, targetPath) {
      if (workspaceId === undefined && targetPath === undefined) return true;
      if (typeof sessionId !== 'string' || sessionId === '') return false;
      if (workspaceId !== undefined && sessionWorkspaceId(ctx, sessionId) === workspaceId) return true;
      if (targetPath !== undefined && samePath(sessionCwd(ctx, sessionId), targetPath)) return true;
      return false;
    }

    /**
     * 找/建某个业务系统对应的工作区。
     *
     * 宿主按 <dataDir>/workspaces/<业务系统 key> 建目录，并用 workspaceController 幂等解析；
     * 这里只负责把结果收成 { workspaceId, path, title }，失败就当没有（退回原来的工作区）。
     */
    async function ensureSystemWorkspaceEntry(ctx, system) {
      const wanted = String(system ?? '').trim();
      if (wanted === '') return undefined;
      try {
        const result = await callHost('workspace.ensure', { system: wanted });
        if (result?.ok !== true) {
          if (typeof result?.message === 'string' && result.message !== '') toast(result.message, 'error');
          return undefined;
        }
        const workspace = result.workspace;
        if (workspace?.workspaceId === undefined) return undefined;
        return {
          workspaceId: workspace.workspaceId,
          path: typeof workspace.path === 'string' ? workspace.path : undefined,
          title: typeof workspace.title === 'string' ? workspace.title : wanted,
        };
      } catch (failure) {
        toast(`没法准备「${wanted}」的工作区：${String(failure?.message ?? failure)}`, 'error');
        return undefined;
      }
    }

    /** 轮询等待「当前会话」变成另一个（startSession 是导航式 void API，不返回 id）。 */
    async function waitForCurrentSession(ctx, before, timeoutMs = 4000) {
      const startedAt = Date.now();
      for (;;) {
        const current = currentSessionId(ctx);
        if (current !== undefined && current !== before) return current;
        if (Date.now() - startedAt >= timeoutMs) return current;
        await new Promise((resolve) => window.setTimeout(resolve, 120));
      }
    }

    /** 该会话是不是「还没有任何消息」的空白会话（列表行上的 blank 标记）。 */
    function isBlankSession(ctx, sessionId) {
      try {
        const byId = ctx.sessions?.list?.getSnapshot?.()?.byId ?? {};
        return byId[sessionId]?.blank === true;
      } catch {
        return false;
      }
    }

    /**
     * 进入场景时应该落在哪个会话上。
     *
     * 产品约定：**进入场景 = 开一段新的对话**。
     *   - 当前/最近会话本来就是空白会话 → 直接复用它（用户看到的已经是一个新对话，
     *     不必再多堆一个空会话）；
     *   - 会话里已经有消息 → 用 `connectWorkspace` 拿一个可复用/新建的空白会话
     *     （或 `startSession`）并导航过去，绝不再往旧对话里塞场景。
     */
    async function ensureScenarioSession(ctx, options = {}) {
      const targetWorkspaceId = options.workspaceId;
      const targetPath = options.path;
      const candidate = resumableSessionId(ctx);
      // 指定了业务系统工作区时，只有「已经在该工作区里」的空白会话才能复用；
      // 否则会把会话开到别的系统的目录里去。
      if (
        candidate !== undefined &&
        isBlankSession(ctx, candidate) &&
        sessionBelongsTo(ctx, candidate, targetWorkspaceId, targetPath)
      ) {
        rememberSession(candidate);
        return candidate;
      }

      const uiWorkspace = getService(ctx, 'uiWorkspace');
      const workspaceId = targetWorkspaceId ?? currentWorkspaceId(ctx);

      // 1) 已知工作区：直接拿一个空白会话，再导航过去（返回值是确定的 id）。
      if (workspaceId !== undefined && typeof uiWorkspace?.connectWorkspace === 'function') {
        try {
          const created = await uiWorkspace.connectWorkspace(workspaceId);
          if (typeof created === 'string' && created !== '') {
            rememberSession(created);
            switchToConversation(ctx, created);
            return created;
          }
        } catch {
          /* 继续走 startSession */
        }
      }

      // 2) 不知道工作区：用 startSession（新建并导航，void API）+ 轮询当前绑定。
      if (typeof uiWorkspace?.startSession === 'function') {
        try {
          uiWorkspace.startSession(workspaceId);
          const created = await waitForCurrentSession(ctx, candidate);
          if (created !== undefined && created !== candidate) {
            rememberSession(created);
            return created;
          }
        } catch {
          /* 继续走下面的兜底 */
        }
      }

      // 3) 最后兜底：会话控制器直接建一个，然后导航过去。
      if (typeof ctx.sessions?.create === 'function') {
        const created = await ctx.sessions.create(workspaceId === undefined ? {} : { workspaceId });
        const id = typeof created === 'string' ? created : created?.sessionId ?? created?.id;
        if (typeof id === 'string' && id !== '') {
          rememberSession(id);
          switchToConversation(ctx, id);
          return id;
        }
      }

      // 4) 连新建都失败时，至少不要让用户卡住：退回原会话。
      if (candidate !== undefined) return candidate;
      throw new Error('当前没有可用会话：请先在左侧打开或新建一个会话');
    }

    /**
     * 切到对话面板并打开指定会话。
     * 会话切换只认 uiWorkspace.openSession —— `ctx.sessions` 上没有 open 方法。
     */
    function switchToConversation(ctx, sessionId) {
      const layout = getService(ctx, 'layout');
      const uiWorkspace = getService(ctx, 'uiWorkspace');
      try {
        if (sessionId !== undefined && typeof uiWorkspace?.openSession === 'function') {
          uiWorkspace.openSession(sessionId);
        } else if (sessionId !== undefined) {
          ctx.sessions?.open?.(sessionId);
        }
      } catch {
        /* 打开会话失败时至少切到会话面板，用户可手动选择 */
      }
      try {
        layout?.selectPanel?.('conversation');
      } catch {
        /* 面板服务不可用时保持现状 */
      }
    }

    /**
     * 广播「某个会话的场景激活状态变了」。
     *
     * 输入框上方的徽标与开场卡片原本只靠 6 秒轮询：刚点完卡片、会话是新挂载的
     * 时候，第一次读到的可能还是「没有场景」，于是预填要等下一轮才发生。
     * 面板就地派发这个事件，徽标立刻重读，预填不再有肉眼可见的延迟。
     */
    function notifyActivationChanged(sessionId) {
      try {
        window.dispatchEvent(new CustomEvent('crm-workspace:activation', { detail: { sessionId } }));
      } catch {
        /* 事件不可用时依赖轮询 */
      }
    }

    /**
     * 进入场景时要写进输入框的文本。
     *
     * 旧实现会在正文前面插一行 `/场景标题`：那既不是用户说的话，也不一定命中真正的
     * 指令名（标题带中文或空格时宿主收不成 chip，回车就变成模型眼里的「用户输入了
     * /CRM单据新建与修改（副本）」）。预填现在只写 inputDraft 本身：场景身份由注入块
     * 与输入框上方的状态栏表达，用户看到的就是「模板待填」。
     */
    function prefillTextFor(card) {
      return typeof card?.inputDraft === 'string' ? card.inputDraft.trim() : '';
    }

    /**
     * 宿主 `dsh-tool-skill` 认的技能名形状（与 lib/core/constants.js 的同名常量一致）。
     *
     * 手势正则是 `/(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/`：名字里带大写、下划线、
     * 中文或点号，写进草稿也永远不会被认成技能引用，只能靠模型自己调 skill 工具。
     */
    const SKILL_ROUTE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

    /** 1.9.0 起默认把绑定的技能以 `/技能名` 预填进输入框（关掉即退回 1.8.0 行为）。 */
    function skillRoutePrefillEnabled(config) {
      return config?.skillRoutePrefill !== false;
    }

    /**
     * 我们自己注册的 `/` 引用源名。
     *
     * 它现在只做两件事，且都不改变输入框的长相：
     *  1. `lexicon` —— 把会话可见的技能名并入宿主的名字表。宿主自己的 `/` 源（`skill`）
     *     并的也是同一份 `skills.list`；这里多一份是为了在它目录还没结算时，`/技能名`
     *     也能照常着色（纯文本 token 的着色只看名字表）；
     *  2. `openReference` —— 纯文本 token 被点击时宿主源先接手（按 file address 打开
     *     SKILL.md）；只有在它认不出这个名字时，才由这里按 `skills.check` 的路径兜底。
     *
     * `candidates` 故意返回空数组（空分组宿主不渲染），因此 `onPick` 不会被调用。
     * `codec` 只为「1.11.0 时期写进宿主存档的草稿」留着：那些草稿里含有 source 指向本源
     * 的 reference 节点，升级后重开会话仍会被还原，缺 codec 会在回车时被
     * `no serializer for reference source` 挡下。新预填不再产生这类节点。
     */
    const SKILL_REF_SOURCE = 'crm-workspace-skill';

    /**
     * 预填草稿交给宿主的载荷（纯函数，单测直接调）。
     *
     * 必须是**纯字符串**。宿主 `setDraft(string)` 走 `draftEditor.setDraft()`，和用户手打
     * 是同一条路：普通文本节点 + lexicon 装饰（`TextRefNode`）。一旦传
     * `{ text, references }`，宿主改走 `draftEditor.restoreDraft()`，把 `/技能名` 插成
     * `ReferenceChipNode`（appearance 由我们指定、由我们的 codec 序列化）——那是「进入
     * 场景」独有的一种长相，手打永远得不到，同一个输入框于是出现两套样子。
     *
     * 1.11.0 用 references 造 chip；1.11.1 起回到纯文本：着色、点开 SKILL.md、回车注入
     * 技能全部交给宿主自己的 `/` 源（`dsh-client-ui-skill`），与手打同源。
     */
    function draftPayloadFor(value) {
      return typeof value === 'string' ? value : '';
    }

    /**
     * 按技能名查它在磁盘上的 SKILL.md 绝对路径（20s 缓存）。
     *
     * `skills.list` 只回名字与描述，**不带路径**（宿主视角那是目录扫描的元数据）；
     * 路径只在 `skills.check` 的解析结果里。所以 chip 要打开文件就得问 check。
     */
    const skillPathCache = new Map();

    async function skillPathOf(ctx, sessionId, name) {
      const cwd = sessionCwd(ctx, sessionId);
      const key = `${typeof cwd === 'string' ? cwd : ''}|${name}`;
      const hit = skillPathCache.get(key);
      if (hit !== undefined && Date.now() - hit.at < 20_000) return hit.path;
      try {
        const result = await callHost('skills.check', { names: [name], cwd });
        const rows = Array.isArray(result?.skills) ? result.skills : [];
        const entry = rows.find((row) => row?.name === name);
        const path = typeof entry?.path === 'string' ? entry.path : '';
        skillPathCache.set(key, { at: Date.now(), path });
        return path;
      } catch {
        return '';
      }
    }

    /**
     * 构造我们自己那个 `/` 引用源。
     *
     * 它不是「chip 的主人」，只是宿主技能源的一个补充：
     *  1. `lexicon` —— 提供一份技能名字表，让纯文本 `/技能名` 在宿主目录结算前也能着色；
     *  2. `openReference` —— 宿主源认不出这个名字时的兜底：按名字查 `skills.check` 拿到
     *     SKILL.md 绝对路径，再开右侧栏。
     *
     * `candidates` 故意返回空数组：`/` 菜单里的技能列表由宿主自己的源负责，我们再列一遍
     * 只会重复；空分组宿主不渲染，所以菜单看起来和只有宿主源时完全一样。
     */
    function createSkillRefSource(ctx) {
      let catalog = { at: 0, rows: [] };
      let loading;
      const listeners = new Set();

      const notify = () => {
        for (const listener of Array.from(listeners)) {
          try {
            listener();
          } catch {
            /* 订阅方自己抛错不该影响目录刷新 */
          }
        }
      };

      const loadCatalog = () => {
        if (catalog.rows.length > 0 && Date.now() - catalog.at < 20_000) return Promise.resolve(catalog.rows);
        if (loading !== undefined) return loading;
        loading = callHost('skills.list', {})
          .then((result) => {
            const rows = Array.isArray(result?.skills)
              ? result.skills
                  .map((row) => ({
                    name: typeof row?.name === 'string' ? row.name : '',
                    description: typeof row?.description === 'string' ? row.description : '',
                  }))
                  .filter((row) => row.name !== '')
              : [];
            catalog = { at: Date.now(), rows };
            notify();
            return rows;
          })
          .catch(() => [])
          .finally(() => {
            loading = undefined;
          });
        return loading;
      };

      return {
        trigger: '/',
        name: SKILL_REF_SOURCE,
        order: 3,
        showGroupTitle: false,
        candidates: () => Promise.resolve([]),
        onPick: (pick) => {
          const name = typeof pick?.candidate?.name === 'string' ? pick.candidate.name : '';
          return { text: name === '' ? '' : `/${name} ` };
        },
        warm: () => {
          void loadCatalog();
        },
        lexicon: () => (catalog.rows.length === 0 ? undefined : catalog.rows.map((row) => row.name)),
        subscribeLexicon: (_session, listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        openReference: (session, reference) => {
          const raw = typeof reference?.ref === 'string' ? reference.ref : '';
          const name = raw.replace(/^\//, '').trim();
          const sessionId = typeof session?.sessionId === 'string' ? session.sessionId : '';
          if (name === '' || sessionId === '') return false;
          // 和宿主自己的技能源一样：先返回 true（事件已经认领），文件路径异步解析完再开。
          void skillPathOf(ctx, sessionId, name).then((path) => {
            if (path !== '') openFileInSidebar(ctx, sessionId, path);
          });
          return true;
        },
        // 只为还原 1.11.0 时期写进存档的草稿（里面带着 source 指向本源的 reference 节点）：
        // 少了 codec，那些 chip 会在回车时被 `no serializer for reference source` 挡下。
        codec: {
          clipboardText: (ref) => String(ref ?? ''),
          serialize: async (ref) => String(ref ?? ''),
        },
      };
    }

    /**
     * 把技能引用行拼在模板前面（纯函数，单测直接调）。
     *
     * 为什么要单独一行：宿主的手势要求 token 前是行首或空白、后是空白或结尾，
     * 所以 token 不能和正文粘在一起；放在最前面是因为用户先读「这次要做什么」，
     * 再往下才是要填的内容。
     */
    function composePrefillText(skillTokens, draft) {
      const head = typeof skillTokens === 'string' ? skillTokens.trim() : '';
      const body = typeof draft === 'string' ? draft.trim() : '';
      if (head === '') return body;
      if (body === '') return head;
      return `${head}\n${body}`;
    }

    /** 去掉开头那段「整行都是 /技能名」的行，剩下的就是模板正文（纯函数）。 */
    function stripSkillTokens(value) {
      const text = typeof value === 'string' ? value : '';
      if (text === '') return '';
      const lines = text.split(/\r?\n/);
      let index = 0;
      while (index < lines.length) {
        const line = lines[index].trim();
        if (line === '') {
          index += 1;
          continue;
        }
        const tokens = line.split(/\s+/);
        const looksLikeTokens = tokens.every(
          (token) => token.startsWith('/') && SKILL_ROUTE_NAME.test(token.slice(1)),
        );
        if (looksLikeTokens !== true) break;
        index += 1;
      }
      return lines.slice(index).join('\n').trim();
    }

    /**
     * 这段文本是不是我们写进去过的模板（纯函数）。
     *
     * 预填现在有两种形态：`/技能名\n模板` 与 `模板`。宿主搬草稿、场景升级换了技能绑定，
     * 都会让输入框里剩下一份「我们写的、但和这次不完全一样」的文本 —— 两种形态都得认出来。
     */
    function isKnownTemplate(value, templates) {
      if (templates === null || templates === undefined || typeof templates.has !== 'function') return false;
      const text = typeof value === 'string' ? value.trim() : '';
      if (text === '') return false;
      if (templates.has(text) === true) return true;
      const body = stripSkillTokens(text);
      return body !== '' && templates.has(body) === true;
    }

    /**
     * 从宿主返回的 draft 契约里算出要写进输入框的文本（纯函数，单测直接调）。
     *
     * 只有 `source === 'inputDraft'` 才是「用户要填的模板」；场景介绍是 UI 投影，
     * 不写输入框。这里也绝不拼 `/场景标题`。
     */
    function seededDraftTextFor(seed) {
      if (seed === null || seed === undefined) return '';
      if (seed.source !== 'inputDraft') return '';
      const text = typeof seed.text === 'string' ? seed.text : '';
      return composePrefillText(seed.skillTokens, text);
    }

    /**
     * 我们写进过输入框的模板原文（跨会话累积）。
     *
     * 宿主在切换会话/工作区时会把上一段会话的草稿「搬」到新会话（reBindDraft），
     * 于是进入场景 B 时新会话里可能已经躺着场景 A 的模板。那不是用户打的字，
     * 按「输入框非空就不覆盖」的规则会被当成用户内容保留下来 —— 用户看到的就是
     * 「进了新场景，输入框里却是上一个场景的模板」。这里记下我们写过的原文，
     * 只为把这种「自己的残留」与「用户真的打的字」区分开。
     */
    const seededTemplates = new Set();

    /**
     * 面板 refresh 时缓存的宿主配置。
     *
     * `/指令` 路径（runScenarioCommand）手上只有 ctx，拿不到面板的 `data.config`，
     * 所以把 bootstrap 里的 config 记在这里，让两条路径用同一份开关。
     */
    let hostConfig = {};

    function rememberSeededTemplate(value) {
      const text = typeof value === 'string' ? value.trim() : '';
      if (text !== '') seededTemplates.add(text);
    }

    /**
     * 把所有场景的填写模板登记成「已知模板」。
     *
     * 面板打开时就能拿到全部卡片，于是我们知道哪些文本是场景自带的模板。空白会话里
     * 留着这样的文本，只可能是上一次进场景时写进去的（宿主会把草稿跟着新会话搬，
     * 浏览器重开也会留下），不可能是用户手打的 —— 这时就该换成这次场景的模板。
     */
    function rememberScenarioTemplates(cards) {
      if (Array.isArray(cards) !== true) return;
      for (const card of cards) {
        if (typeof card?.inputDraft === 'string') rememberSeededTemplate(card.inputDraft);
      }
    }

    /**
     * 这次预填该动不动输入框（纯函数，单测直接调）。
     *
     * - `write`：输入框是空的，正常写入；
     * - `replace`：输入框里有内容，但那内容是我们自己之前写进去的模板（宿主把
     *   旧会话草稿搬过来了），换成这次场景的模板；
     * - `keep`：用户已经打了字（或内容恰好就是这一份），保持原样；
     * - `skip`：这次没有模板可写。
     */
    function seedConflict(current, draftText, templates) {
      const now = typeof current === 'string' ? current.trim() : '';
      const next = typeof draftText === 'string' ? draftText.trim() : '';
      if (next === '') return 'skip';
      if (now === '') return 'write';
      if (now === next) return 'keep';
      // 只差开头的 /技能名 行：正文一模一样，别为了补 token 重写整段（会丢光标）。
      const nowBody = stripSkillTokens(now);
      if (nowBody !== '' && nowBody === stripSkillTokens(next)) return 'keep';
      if (isKnownTemplate(now, templates) === true) return 'replace';
      return 'keep';
    }

    /**
     * 退出 / 移除场景时该不该清空输入框（纯函数）。
     * 只有「内容仍然等于我们写进去的那份」才返回 true：用户改过或删过就不动它。
     */
    function shouldClearSeededDraft(current, seededText) {
      const now = typeof current === 'string' ? current : '';
      const seeded = typeof seededText === 'string' ? seededText : '';
      if (now === '' || seeded === '') return false;
      return now.trim() === seeded.trim();
    }

    /**
     * 孤儿草稿登记：预填会把场景预设附件 createDrafts 成会话里的草稿文件。用户随后
     * 退出场景、或这次预填最终没成功时，这些草稿没有任何消息引用，会一直留在会话
     * 附件目录里。这里按会话记下我们建过的 id，退出时统一回收
     * （宿主当前的 conversation 服务没有 discardDrafts，字节要靠会话清理；这里至少
     * 保证把它们从待发送托盘里摘掉）。
     */
    const orphanDrafts = new Map();

    /**
     * 「这个会话的托盘里，哪几个附件是插件挂上去的」账本。
     *
     * 为什么需要：宿主 `addAttachments` 是 append 语义、不去重，而有两个地方会同时想
     * 挂同一批预设附件（面板进入场景时直连 session 的 `seedComposer`，以及输入框上方
     * 场景栏自己的预填 effect）。两边都挂 → 托盘里同一份文件出现两次；退出场景时又
     * 谁都不知道该摘哪几个 → 附件留在托盘里，下次进场景看起来就像「又重复预设了一遍」。
     *
     * 记录 `{ seedKey, ids }`：seedKey 是这次场景栈的身份（场景 id + 版本按顺序拼起来），
     * ids 是插件为它建出来的草稿附件 id。
     */
    const seededAttachments = new Map();

    /** 一次性拿到所有账本里的附件 id：宿主切会话时会把草稿搬过去，用来认出「这是我们的」。 */
    function knownSeededIds() {
      const seen = new Set();
      for (const ids of orphanDrafts.values()) {
        for (const id of ids) seen.add(id);
      }
      for (const entry of seededAttachments.values()) {
        for (const id of Array.isArray(entry?.ids) ? entry.ids : []) seen.add(id);
      }
      return seen;
    }

    /** 一个场景栈的去重键：同一批场景（顺序固定）只挂一次附件。 */
    function scenarioSeedKey(cards) {
      const list = Array.isArray(cards) ? cards : [];
      return list
        .filter((card) => card !== null && card !== undefined)
        .map((card) => `${card.scenarioId ?? ''}@${card.version ?? ''}`)
        .join('+');
    }

    /** 逐会话串行化附件挂载：两个调用方同时进来时，第二个排队而不是各建一份草稿。 */
    const attachmentLocks = new Map();

    function withAttachmentLock(sessionId, task) {
      const previous = attachmentLocks.get(sessionId) ?? Promise.resolve();
      const next = previous.then(task, task);
      // 只用来排队，失败不外抛（真正的结果交给调用方自己的 Promise）。
      attachmentLocks.set(
        sessionId,
        next.then(
          () => undefined,
          () => undefined,
        ),
      );
      return next;
    }

    /* ── 技能预检与安装（1.9.0） ─────────────────────────────────── */

    /** 智能体中心的面板 id（ui-library 的 `PANEL_ID = 'library'`）。 */
    const LIBRARY_PANEL_ID = 'library';
    /** 市场列表一页 30 条（与服务端 LIBRARY_PAGE_SIZE 一致）。 */
    const LIBRARY_PAGE_SIZE = 30;
    /** 最多翻 8 页（240 个技能）就放弃：宁可让用户去智能体中心，也不要把页面挂住。 */
    const LIBRARY_MAX_PAGES = 8;

    /** 打开「智能体中心 / Skills」面板。宿主没装 ui-library 时返回 false。 */
    function openLibraryPanel(ctx) {
      try {
        const layout = getService(ctx, 'layout');
        if (typeof layout?.selectPanel !== 'function') return false;
        layout.selectPanel(LIBRARY_PANEL_ID);
        return true;
      } catch {
        return false;
      }
    }

    /** 把宿主的 route 判定翻成一句人话（面板提示与 /指令 事后提示共用）。 */
    function routeLabel(route) {
      if (route === 'missing') return '本机没装';
      if (route === 'not-routable') return '名字不能写成 /引用';
      if (route === 'command-clash') return '与 /指令 同名';
      if (route === 'user-disabled') return '不可由用户调用';
      return '';
    }

    /**
     * 在公司技能市场里按名字找技能（同源路由，浏览器自带的凭据就够）。
     *
     * 读的是 `GET /api/runner-library/skills?page=n`：一行形如
     * `{ id, name, displayName, description, sourceVersion, installed, updateAvailable }`。
     * 这条路依赖登录态，失败（401/503/网络断开）时**静默返回已找到的部分**，
     * 由调用方退回「提示用户自己去装」，绝不假装装上了。
     */
    async function findMarketSkills(names) {
      const wanted = new Set((Array.isArray(names) ? names : []).filter((name) => typeof name === 'string' && name !== ''));
      const found = new Map();
      if (wanted.size === 0) return found;
      for (let page = 1; page <= LIBRARY_MAX_PAGES; page += 1) {
        let body;
        try {
          const response = await fetch(`/api/runner-library/skills?page=${page}`, {
            headers: { accept: 'application/json' },
          });
          if (response?.ok !== true) return found;
          body = await response.json();
        } catch {
          return found;
        }
        const items = Array.isArray(body?.items) ? body.items : [];
        for (const item of items) {
          const name = typeof item?.name === 'string' ? item.name : '';
          if (name === '' || wanted.has(name) !== true) continue;
          if (found.has(name) !== true) found.set(name, item);
        }
        if (found.size >= wanted.size) break;
        if (items.length < LIBRARY_PAGE_SIZE) break;
      }
      return found;
    }

    /** 让宿主把市场里的一项装到本机 skills 根（写盘 + manifest 由 ui-library 负责）。 */
    async function installMarketSkill(item) {
      try {
        const response = await fetch('/api/runner-library/install', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            id: item.id,
            name: item.name,
            description: typeof item.description === 'string' ? item.description : '',
            sourceVersion: typeof item.sourceVersion === 'number' ? item.sourceVersion : 0,
          }),
        });
        if (response?.ok === true) return { ok: true, error: '' };
        let message = '';
        try {
          const body = await response.json();
          message = typeof body?.message === 'string' ? body.message : '';
        } catch {
          message = '';
        }
        return { ok: false, error: message !== '' ? message : `HTTP ${response?.status ?? '?'}` };
      } catch (failure) {
        return { ok: false, error: String(failure?.message ?? failure) };
      }
    }

    /**
     * 进场景前的技能门禁：本机有没有、能不能写成 `/技能名`、装没装。
     *
     * 返回 `{ missing, installed, notes }`：
     * - `missing`：还是没装的（调用方据此弹窗拦住）；
     * - `installed`：这次自动装上的；
     * - `notes`：装不上、名字不可路由、与指令同名等**不拦路但要告知**的一句话。
     * 预检本身失败（Host 异常）只记一条 notes 不拦：宁可让用户进去自己发现，
     * 也不要因为一次 RPC 抖动把人挡在门外。
     */
    async function verifyScenarioSkills(ctx, card, cwd, autoInstall) {
      const names = (Array.isArray(card?.pinnedSkills) ? card.pinnedSkills : []).filter(
        (name) => typeof name === 'string' && name.trim() !== '',
      );
      const missing = [];
      const installed = [];
      const notes = [];
      if (names.length === 0) return { missing, installed, notes };
      const dir = typeof cwd === 'string' ? cwd : '';
      let report;
      try {
        report = await callHost('skills.check', { names, cwd: dir });
      } catch (failure) {
        notes.push(`没能预检技能（${String(failure?.message ?? failure)}）：进入后若技能没被识别，请到「智能体中心」确认已安装`);
        return { missing, installed, notes };
      }
      const rows = Array.isArray(report?.skills) ? report.skills : [];
      for (const row of rows) {
        const name = typeof row?.name === 'string' ? row.name : '';
        if (name === '') continue;
        const route = typeof row?.route === 'string' ? row.route : 'ok';
        if (route === 'missing') {
          missing.push(name);
          continue;
        }
        if (route === 'ok') continue;
        notes.push(`/${name} ${routeLabel(route)}`);
      }
      if (missing.length > 0 && autoInstall === true) {
        const market = await findMarketSkills(missing);
        for (const name of [...missing]) {
          const item = market.get(name);
          if (item === undefined) continue;
          const outcome = await installMarketSkill(item);
          if (outcome.ok !== true) {
            notes.push(`/${name} 安装失败：${outcome.error}`);
            continue;
          }
          installed.push(name);
          missing.splice(missing.indexOf(name), 1);
        }
        // 装完宿主会把 skills/change 扇出去，但分层视图未必立刻可见：短轮询复检几轮。
        if (installed.length > 0) {
          for (let attempt = 0; attempt < 6 && missing.length > 0; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 250));
            try {
              const retry = await callHost('skills.check', { names: [...missing], cwd: dir });
              const retryRows = Array.isArray(retry?.skills) ? retry.skills : [];
              const still = retryRows
                .filter((row) => (typeof row?.route === 'string' ? row.route : 'ok') === 'missing')
                .map((row) => row.name)
                .filter((name) => typeof name === 'string' && name !== '');
              missing.length = 0;
              for (const name of still) missing.push(name);
            } catch {
              /* 复检失败就继续等下一轮 */
            }
          }
        }
      }
      return { missing, installed, notes };
    }

    /**
     * 「这些技能本机还没装」的拦截弹窗（1.9.0）。
     *
     * 三个出口都是明路：去智能体中心装好再回来、仍然进入（模型只能把它当普通文字）、
     * 取消。默认按钮是「仍然进入」，因为拦住用户是最后手段而不是默认行为。
     */
    function SkillGateDialog({ gate, onOpenLibrary, onEnterAnyway, onCancel }) {
      if (gate === null || gate === undefined) return null;
      const missing = Array.isArray(gate.missing) ? gate.missing : [];
      const title = typeof gate.card?.title === 'string' ? gate.card.title : '';
      return h(
        Dialog,
        {
          title: t('这些技能本机还没装'),
          width: 'narrow',
          onClose: onCancel,
          footer: [
            h(Button, { key: 'lib', size: 'sm', variant: 'ghost', onClick: onOpenLibrary }, t('打开智能体中心安装')),
            h(Button, { key: 'cancel', size: 'sm', variant: 'ghost', onClick: onCancel }, t('取消')),
            h('span', { key: 'grow', className: 'crmw-grow' }),
            h(Button, { key: 'go', size: 'sm', variant: 'primary', onClick: onEnterAnyway }, t('仍然进入')),
          ],
        },
        h(
          'p',
          null,
          t(
            `「${title}」绑定了这些技能，但本机没装：装好之后输入框里的 /技能名 才会被宿主认成技能引用，否则模型只会把它当成一句普通文字。`,
          ),
        ),
        h(
          'ul',
          { className: 'crmw-gate-list' },
          missing.map((name) => h('li', { key: name }, h('code', null, `/${name}`))),
        ),
        h('p', null, t('装好之后回到这里重新点一次场景卡片即可，不用重开对话。')),
      );
    }

    /** 会话输入框外壳（面板与场景栏共用）。 */
    function inputFacadeFor(ctx, sessionId) {
      try {
        const scope = ctx.sessions?.scope?.(sessionId);
        if (scope === undefined) return undefined;
        return getService(ctx, 'conversation')?.input?.for?.(scope);
      } catch {
        return undefined;
      }
    }

    function trayIdsOf(facade) {
      try {
        const snapshot = facade?.state?.getSnapshot?.();
        return Array.isArray(snapshot?.attachmentIds) ? snapshot.attachmentIds : [];
      } catch {
        return [];
      }
    }

    function rememberDraftIds(sessionId, ids) {
      if (typeof sessionId !== 'string' || sessionId === '' || Array.isArray(ids) !== true || ids.length === 0) return;
      const known = orphanDrafts.get(sessionId) ?? [];
      for (const id of ids) {
        if (typeof id === 'string' && id !== '' && known.includes(id) !== true) known.push(id);
      }
      orphanDrafts.set(sessionId, known);
    }

    /**
     * 退出场景 / 移除最后一个场景时，把插件挂上去的预设附件从托盘里摘掉。
     *
     * 之前的实现只查孤儿草稿表，而场景栏那条路径建完草稿从不登记 → 退出场景后附件
     * 一直留在托盘里，下一次进场景（尤其是宿主把草稿搬到新会话之后）看起来就是
     * 「附件被重复预设了」。现在两个调用方都登记进 `seededAttachments`，这里一起收。
     *
     * @returns {Promise<number>} 摘掉/回收的附件数
     */
    async function dropSeededAttachments(ctx, sessionId, { exceptSeedKey } = {}) {
      if (typeof sessionId !== 'string' || sessionId === '') return 0;
      const entry = seededAttachments.get(sessionId);
      // exceptSeedKey：只清理「上一套场景」挂的附件，保留当前这套（切场景时用）。
      const keep = exceptSeedKey !== undefined && entry !== undefined && entry.seedKey === exceptSeedKey;
      if (keep !== true) seededAttachments.delete(sessionId);
      const orphans = orphanDrafts.get(sessionId) ?? [];
      orphanDrafts.delete(sessionId);
      const keptIds = keep === true && Array.isArray(entry?.ids) ? entry.ids : [];
      const ids = keep === true
        ? orphans.filter((id) => keptIds.includes(id) !== true)
        : [...new Set([...(Array.isArray(entry?.ids) ? entry.ids : []), ...orphans])];
      if (ids.length === 0) return 0;
      const facade = inputFacadeFor(ctx, sessionId);
      const inTray = trayIdsOf(facade);
      // 先从托盘摘掉：否则用户看到的是一排指向没人用的草稿的附件。
      if (typeof facade?.removeAttachment === 'function') {
        for (const id of ids) {
          if (inTray.includes(id) !== true) continue;
          try {
            facade.removeAttachment(id);
          } catch {
            /* 托盘已经刷新过：忽略 */
          }
        }
      }
      const conversation = getService(ctx, 'conversation');
      if (typeof conversation?.discardDrafts !== 'function') return ids.length;
      try {
        return Number(await conversation.discardDrafts(sessionId, ids)) || ids.length;
      } catch {
        return ids.length;
      }
    }

    /**
     * 把一批文件挂进会话的附件托盘（幂等、串行）。
     *
     * @param {object} options
     * @param {File[]} options.files 待挂的附件
     * @param {{ids?: string[]}} options.cache 草稿 id 缓存：重试时只重挂，不重复上传
     * @param {string} options.seedKey 场景栈去重键（`scenarioSeedKey`）
     * @returns {Promise<boolean>} 是否已确认全部挂上（true 也包括「用户自己已经挂过附件」）
     */
    async function attachPresetFilesToTray(ctx, sessionId, { files, cache, seedKey }) {
      if (typeof sessionId !== 'string' || sessionId === '') return false;
      if (Array.isArray(files) !== true || files.length === 0) return true;
      return withAttachmentLock(sessionId, async () => {
        const conversation = getService(ctx, 'conversation');
        if (conversation === undefined || typeof conversation.createDrafts !== 'function') return false;
        const facade = inputFacadeFor(ctx, sessionId);
        if (facade === undefined) return false;

        const entry = seededAttachments.get(sessionId);
        let current = trayIdsOf(facade);
        // 同一次场景、附件还在托盘里 → 已经挂好了，绝不重复挂。
        if (
          entry !== undefined &&
          entry.seedKey === seedKey &&
          entry.ids.length > 0 &&
          entry.ids.every((id) => current.includes(id))
        ) {
          return true;
        }
        // 托盘里属于我们的（上一次场景挂的，或宿主从上一段会话搬过来的）先摘掉：
        // 不摘就会新旧两套同时躺着，看起来就是「附件被重复预设」。
        const ours = knownSeededIds();
        const mine = current.filter((id) => ours.has(id));
        const foreign = current.filter((id) => ours.has(id) !== true);
        if (mine.length > 0 && typeof facade.removeAttachment === 'function') {
          for (const id of mine) {
            try {
              facade.removeAttachment(id);
            } catch {
              /* 忽略 */
            }
          }
          current = trayIdsOf(facade);
        }
        // 用户自己拖进来的附件：尊重它，不往上面再堆一份预设附件。
        if (current.some((id) => ours.has(id) !== true)) return true;

        let ids = Array.isArray(cache?.ids) ? cache.ids.filter((id) => typeof id === 'string' && id !== '') : [];
        if (ids.length === 0) {
          try {
            // 与手动拖拽/粘贴同一份语义：普通会话才预上传图片，子代理续跑时图片随 prompt 内联。
            const binding =
              typeof ctx.sessions?.binding === 'function' ? ctx.sessions.binding(sessionId) : undefined;
            const sessionState = binding?.session?.getSnapshot?.();
            const ordinary = sessionState === undefined ? true : sessionState.subagent === null;
            const drafts = await conversation.createDrafts(sessionId, files, ordinary);
            ids = (Array.isArray(drafts) ? drafts : []).map((item) => item?.id).filter(Boolean);
          } catch {
            return false;
          }
          if (ids.length === 0) return false;
          if (cache !== undefined && cache !== null) cache.ids = ids;
          // 记进孤儿草稿表：预填失败或最终没发出时也能回收。
          rememberDraftIds(sessionId, ids);
        }
        let attached = false;
        try {
          attached = typeof facade.addAttachments === 'function' && facade.addAttachments(ids) !== false;
        } catch {
          attached = false;
        }
        if (attached !== true) return false;
        if (trayIdsOf(facade).length < ids.length) return false;
        seededAttachments.set(sessionId, { seedKey, ids });
        return true;
      });
    }

    /**
     * 切到新会话之前，先把自己写进旧会话、还没被用掉的模板清掉。
     *
     * 宿主会把上一段会话的草稿「搬」给新会话（rebindDraftFiles）：如果旧会话里还留着
     * 上一个场景的模板，新会话就会带着它出现，而且看起来像是用户自己打的字，于是这次
     * 场景的模板不敢覆盖它。只有内容确实是我们登记过的模板时才清，用户打的字一律不动。
     *
     * @returns {Promise<boolean>} 是否真的清掉了一份残留模板
     */
    async function clearStaleSeededDraft(ctx, sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return false;
      const conversation = getService(ctx, 'conversation');
      const scopeOf = ctx?.sessions?.scope;
      if (typeof conversation?.input?.for !== 'function' || typeof scopeOf !== 'function') return false;
      let facade;
      try {
        facade = conversation.input.for(scopeOf(sessionId));
      } catch {
        return false;
      }
      let current = '';
      try {
        const snapshot = facade?.state?.getSnapshot?.();
        current = typeof snapshot?.draft === 'string' ? snapshot.draft : '';
      } catch {
        return false;
      }
      if (current.trim() === '' || isKnownTemplate(current, seededTemplates) !== true) return false;
      try {
        return facade.setDraft('') !== false;
      } catch {
        return false;
      }
    }

    /**
     * 直接把预填内容 + 预设附件写进指定会话的输入框/托盘。
     *
     * 这条路径不依赖 `conversation.input.dock` 是否已挂载，也不依赖 slot 标准
     * props 有没有带上 `inputActions`：只要会话被主面板租用，就能用
     * `conversation.input.for(sessionScope)` 拿到该会话的输入框外壳。
     * 草稿只在输入框为空时写入，绝不覆盖用户已经打字的内容。
     *
     * @returns {Promise<{draft: boolean, attachments: boolean}>} 两项是否确认就位
     */
    async function seedComposer(ctx, sessionId, { text, attachments, seedKey, cards } = {}) {
      const wantDraft = typeof text === 'string' && text !== '';
      const files = await fetchPresetFiles(attachments);
      if (typeof sessionId !== 'string' || sessionId === '') {
        return { draft: wantDraft !== true, attachments: files.length === 0 };
      }
      const conversation = getService(ctx, 'conversation');
      const deadline = Date.now() + 10_000;
      let draftOk = wantDraft !== true;
      let attachOk = files.length === 0;
      let draftDispatches = 0;
      let attachAttempts = 0;
      // 草稿 id 缓存：重试时只重挂托盘，不重复上传同一批文件。
      const attachCache = { ids: [] };

      for (;;) {
        let facade;
        try {
          const scope = ctx.sessions?.scope?.(sessionId);
          facade = scope === undefined ? undefined : conversation?.input?.for?.(scope);
        } catch {
          facade = undefined; /* 会话作用域还没建立：继续等 */
        }
        if (facade !== undefined) {
          const state = typeof facade.state?.getSnapshot === 'function' ? facade.state.getSnapshot() : {};
          // 1) 草稿
          if (draftOk !== true) {
            const draft = typeof state?.draft === 'string' ? state.draft : undefined;
            if (draft === undefined) {
              /* 输入框外壳已就绪但快照还没有草稿字段：下一轮再看 */
            } else if (seedConflict(draft, text, seededTemplates) === 'keep') {
              // 输入框里已经有用户内容：算「已就位」，绝不再写第二次 —— 旧实现要求严格
              // 等于预填文本，只要宿主归一化过一次就会每 200ms 重写一遍，用户刚删掉的
              // 字会被填回去。
              draftOk = true;
            } else if (typeof facade.setDraft === 'function' && draftDispatches < 20) {
              try {
                // 纯字符串：宿主走 draftEditor.setDraft()，与手打同一条路（TextNode + lexicon 装饰）。
                facade.setDraft(draftPayloadFor(text));
                draftDispatches += 1;
              } catch {
                /* 输入框被冻结：下一轮再试 */
              }
              if (String(facade.state?.getSnapshot?.()?.draft ?? '').trim() !== '') {
                draftOk = true;
                rememberSeededTemplate(text);
              }
              // 连续写 20 次（≈4s）都读不回来：判定失败，让面板给出提示。
              else if (draftDispatches >= 20) return { draft: false, attachments: attachOk };
            }
          }
          // 2) 预设附件进待发送托盘。
          // 交给共享的幂等挂载：场景栏那条路径也会挂同一批文件，两边各挂一次就会重复。
          if (attachOk !== true && attachAttempts < 15) {
            attachAttempts += 1;
            const key = typeof seedKey === 'string' && seedKey !== '' ? seedKey : scenarioSeedKey(cards);
            // eslint-disable-next-line no-await-in-loop
            const attached = await attachPresetFilesToTray(ctx, sessionId, {
              files,
              cache: attachCache,
              seedKey: key,
            });
            if (attached === true) attachOk = true;
            else if (attachAttempts >= 15) return { draft: draftOk, attachments: false };
          }
        }
        if (draftOk === true && attachOk === true) return { draft: true, attachments: true };
        if (Date.now() >= deadline) return { draft: draftOk, attachments: attachOk };
        await new Promise((resolve) => window.setTimeout(resolve, 200));
      }
    }

    /** 把场景预设附件的字节取回来，包成 composer 需要的 File。 */
    async function fetchPresetFiles(attachments) {
      const files = [];
      for (const item of Array.isArray(attachments) ? attachments : []) {
        if (typeof item?.url !== 'string' || item.url === '') continue;
        try {
          const response = await fetch(item.url);
          if (response.ok !== true) continue;
          const blob = await response.blob();
          files.push(
            new File([blob], item.fileName ?? 'attachment', {
              type: item.mimeType || blob.type || 'application/octet-stream',
            }),
          );
        } catch {
          /* 单个附件失败不影响其余附件 */
        }
      }
      return files;
    }

    /** 通过会话输入框外壳弹一条提示（不依赖 slot props）。 */
    async function notifySession(ctx, sessionId, level, text) {
      try {
        const scope = ctx.sessions?.scope?.(sessionId);
        const facade = scope === undefined ? undefined : getService(ctx, 'conversation')?.input?.for?.(scope);
        if (typeof facade?.notify === 'function') facade.notify(level, text);
      } catch {
        /* 提示失败不影响激活本身 */
      }
    }

    /* ── 场景斜杠指令（客户端动作） ─────────────────────────────── */

    /**
     * 宿主已经把每张卡片的 slashCommand 注册成 `/指令`，但「裸回车」默认只会
     * 在服务端跑 handler：客户端把 token 吃掉、什么都不显示，用户看到的就是
     * 「输入框清空了、场景没进来」。
     *
     * 这里用 `commandUi.decorate` 给同名指令挂一个**客户端动作**：回车即在
     * 本会话激活场景、弹提示、并广播状态变化，界面立刻有反馈。
     * 宿主 handler 保留为别的入口（非 UI 场景）的兜底。
     */
    let scenarioCommandDisposers = [];
    let scenarioCommandSignature = '';

    function clearScenarioCommands() {
      for (const dispose of scenarioCommandDisposers.splice(0)) {
        try {
          dispose?.();
        } catch {
          /* 指令已随作用域销毁 */
        }
      }
      scenarioCommandSignature = '';
    }

    /**
     * 按当前「已安装的场景」同步客户端指令装饰。
     * @param {object} commandUi 客户端指令服务（ctx.commandUi）
     * @param {Array<object>} cards 场景卡片（bootstrap.installedScenarios）
     */
    function syncScenarioCommands(ctx, commandUi, cards) {
      if (commandUi === undefined || typeof commandUi.decorate !== 'function') return;
      const entries = (Array.isArray(cards) ? cards : [])
        .filter((card) => card?.enabled === true && typeof card.slashCommand === 'string')
        .map((card) => ({
          name: card.slashCommand.replace(/^\//, '').toLowerCase(),
          scenarioId: card.scenarioId,
          title: card.title,
        }))
        .filter((entry) => entry.name !== '' && typeof entry.scenarioId === 'string');
      const signature = entries.map((entry) => `${entry.name}:${entry.scenarioId}`).join('|');
      if (signature === scenarioCommandSignature) return;
      for (const dispose of scenarioCommandDisposers.splice(0)) {
        try {
          dispose?.();
        } catch {
          /* 忽略 */
        }
      }
      scenarioCommandSignature = signature;
      for (const entry of entries) {
        try {
          const dispose = commandUi.decorate({
            name: entry.name,
            available: () => true,
            ui: {
              kind: 'action',
              run: (session) => {
                void runScenarioCommand(ctx, session?.sessionId, entry);
              },
            },
          });
          if (typeof dispose === 'function') scenarioCommandDisposers.push(dispose);
        } catch (error) {
          // 宿主目录里没有这条指令时装饰不生效（不报错），只记一笔便于排查。
          console.warn(`[crm-workspace] 场景指令 ${entry.name} 未能挂上客户端动作`, error);
        }
      }
    }

    /** `/指令` 回车后的客户端动作：激活场景 + 明确反馈。 */
    async function runScenarioCommand(ctx, sessionId, entry) {
      if (typeof sessionId !== 'string' || sessionId === '') return;
      try {
        const result = await callHost('activation.activate', {
          sessionId,
          scenarioId: entry.scenarioId,
          source: 'command',
          cwd: sessionCwd(ctx, sessionId) ?? '',
        });
        // /指令 路径没有「进场景前」的弹窗余地，只能事后把不可路由的技能说清楚：
        // 它们不会变成输入框里的技能引用，模型只会看到一段普通文字。
        const blocked = (Array.isArray(result?.skills) ? result.skills : []).filter(
          (skill) => typeof skill?.route === 'string' && skill.route !== 'ok',
        );
        if (blocked.length > 0) {
          const lines = blocked
            .map((skill) => `${skill.name}（${routeLabel(skill.route)}）`)
            .join('、');
          void notifySession(ctx, sessionId, 'error', `这些技能不会被当成 /引用：${lines}`);
        }
        // 让输入框上方的徽标/开场卡片立刻重读，不等 6 秒轮询。
        notifyActivationChanged(sessionId);
        const title = typeof result?.scenario?.title === 'string' ? result.scenario.title : entry.title;
        const skills = Array.isArray(result?.skills) ? result.skills.map((skill) => skill?.name).filter(Boolean) : [];
        void notifySession(
          ctx,
          sessionId,
          'info',
          `已切换到「${title}」场景${skills.length > 0 ? `：${skills.join(' → ')}` : ''}`,
        );
        // /指令 也是一种「进入场景」：新对话里同样要把预填与预设附件带上，
        // 否则同一个场景从面板进有附件、从指令进没有，用户会以为是丢文件。
        // 已经有消息的会话不塞东西（那是「在同一段对话里换场景」）。
        const card = result?.scenario;
        if (card !== undefined && isBlankSession(ctx, sessionId) === true) {
          const text = composePrefillText(
            skillRoutePrefillEnabled(hostConfig) === true ? result?.skillTokens : '',
            prefillTextFor(card),
          );
          const list = Array.isArray(card.presetAttachments) ? card.presetAttachments : [];
          if (text !== '' || list.length > 0) {
            void seedComposer(ctx, sessionId, {
              text,
              attachments: list,
              seedKey: scenarioSeedKey([card]),
              cards: [card],
            });
          }
        }
      } catch (error) {
        void notifySession(ctx, sessionId, 'error', String(error?.message ?? error));
      }
    }

    /* ── 基础组件 ───────────────────────────────────────────────── */

    function Button({ children, variant = 'default', size, onClick, disabled, title, type = 'button' }) {
      const className = ['crmw-btn', variant === 'default' ? '' : variant, size === 'sm' ? 'sm' : '']
        .filter(Boolean)
        .join(' ');
      return h('button', { type, className, onClick, disabled, title }, children);
    }

    function IconButton({ name, label, onClick, size = 16 }) {
      return h(
        'button',
        { type: 'button', className: 'crmw-icon-btn', onClick, title: label, 'aria-label': label },
        h(Icon, { name, size }),
      );
    }

    function Field({ label, hint, error, children }) {
      return h(
        'div',
        { className: 'crmw-field' },
        h('label', null, label),
        children,
        error !== undefined ? h('span', { className: 'err' }, error) : null,
        hint !== undefined && error === undefined ? h('span', { className: 'hint' }, hint) : null,
      );
    }

    function Switch({ checked, onChange, label, disabled }) {
      return h(
        'label',
        { className: 'crmw-switch', style: disabled === true ? { opacity: 0.65, cursor: 'not-allowed' } : undefined },
        h('input', {
          type: 'checkbox',
          checked,
          disabled: disabled === true,
          onChange: (event) => onChange(event.target.checked),
        }),
        h('span', null, label),
      );
    }

    /**
     * 表单里的勾选项：标题 + 一句说明。
     * 之前的实现是 3 个 Switch 挤在一行、选中后整条变黑，看不出到底勾了什么。
     */
    function OptionTile({ checked, onChange, label, hint, disabled }) {
      return h(
        'label',
        { className: `crmw-option ${checked === true ? 'on' : 'off'}` },
        h('input', {
          type: 'checkbox',
          checked: checked === true,
          disabled: disabled === true,
          onChange: (event) => onChange(event.target.checked),
        }),
        h(
          'span',
          { className: 'crmw-option-text' },
          h('span', { className: 'crmw-option-title' }, label),
          hint === undefined ? null : h('span', { className: 'crmw-option-hint' }, hint),
        ),
      );
    }

    /**
     * 卡片右上角的「更多操作」菜单。
     * 用 useState 而不是 <details>：点空白处、按 Esc、选中任意一项都会立即收起
     * （之前只有再点一次触发按钮才关，用户会以为菜单点不动）。
     */
    function Menu({ label, items }) {
      const [open, setOpen] = useState(false);
      const rootRef = useRef(null);

      useEffect(() => {
        if (open !== true) return undefined;
        const onPointerDown = (event) => {
          if (rootRef.current !== null && rootRef.current.contains(event.target) !== true) setOpen(false);
        };
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setOpen(false);
        };
        document.addEventListener('mousedown', onPointerDown, true);
        document.addEventListener('keydown', onKeyDown);
        return () => {
          document.removeEventListener('mousedown', onPointerDown, true);
          document.removeEventListener('keydown', onKeyDown);
        };
      }, [open]);

      const entries = (Array.isArray(items) ? items : []).filter((item) => item !== null && item !== undefined);

      return h(
        'div',
        { className: 'crmw-menu', ref: rootRef },
        h(
          'button',
          {
            type: 'button',
            className: 'crmw-menu-btn',
            title: label,
            'aria-label': label,
            'aria-expanded': open === true,
            onClick: () => setOpen((current) => current !== true),
          },
          h(Icon, { name: 'more', size: 15 }),
        ),
        open === true
          ? h(
              'div',
              { className: 'crmw-menu-list', role: 'menu' },
              entries.map((item, index) =>
                h(
                  'button',
                  {
                    key: `${index}-${item.label}`,
                    type: 'button',
                    role: 'menuitem',
                    className: item.danger === true ? 'danger' : undefined,
                    onClick: () => {
                      setOpen(false);
                      item.onClick?.();
                    },
                  },
                  item.label,
                ),
              ),
            )
          : null,
      );
    }

    function Dialog({ title, children, footer, onClose, width }) {
      useEffect(() => {
        const onKeyDown = (event) => {
          if (event.key === 'Escape') onClose?.();
        };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
      }, [onClose]);

      return h(
        'div',
        {
          className: 'crmw-mask',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': title,
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) onClose?.();
          },
        },
        h(
          'div',
          { className: `crmw-dialog ${width === 'narrow' ? 'narrow' : width === 'wide' ? 'wide' : ''}` },
          h('div', { className: 'crmw-dialog-head' }, h('h3', null, title), h('span', { className: 'crmw-grow' }), h(IconButton, { name: 'x', label: t('关闭'), onClick: onClose })),
          h('div', { className: 'crmw-dialog-body' }, children),
          footer === undefined ? null : h('div', { className: 'crmw-dialog-foot' }, footer),
        ),
      );
    }

    function Toasts({ items }) {
      return h(
        'div',
        { className: 'crmw-toasts' },
        items.map((item) =>
          h('div', { key: item.id, className: `crmw-toast ${item.kind === 'error' ? 'err' : 'ok'}` }, h('span', null, item.text)),
        ),
      );
    }

    /* ── 卡片 ───────────────────────────────────────────────────── */

    /**
     * 卡片上「预填」那一行要显示的文本：模板第一行、压成单行。
     *
     * 只取第一行：卡片高度必须一致，全文交给 `title` 悬停。
     */
    function draftFirstLine(draft) {
      const text = typeof draft === 'string' ? draft.trim() : '';
      if (text === '') return '';
      const firstLine = text.split('\n').find((line) => line.trim() !== '');
      return typeof firstLine === 'string' ? firstLine.replace(/\s+/g, ' ').trim() : '';
    }

    /**
     * 卡片上的「预填」一行：点进去之前先看见输入框里会出现什么。
     *
     * 业务人员判断「这张卡是不是我要的」靠的就是这一句，藏到点进去之后才知道太晚了。
     * 空模板不渲染（1.13.0 起「输入框预填内容」才是必填项）。
     */
    function cardDraftLine(card) {
      const draft = typeof card?.inputDraft === 'string' ? card.inputDraft.trim() : '';
      const oneLine = draftFirstLine(draft);
      if (draft === '' || oneLine === '') return null;
      // 旧版标准场景没有 inputDraft，读入时会回退成场景介绍（registry 的兜底）：
      // 这时再露一行「预填 <介绍原文>」就是在同一张卡上把同一段话说两遍。
      // 只认「整段相同」——首行巧合相同不算。
      const description = typeof card?.description === 'string' ? card.description.trim() : '';
      if (description !== '' && draft === description) return null;
      return h(
        'p',
        { className: 'crmw-card-draft', title: draft },
        h('b', null, t('预填')),
        h('span', null, oneLine),
      );
    }

    function ScenarioCard({
      card,
      canManageStandard,
      busy,
      onEnter,
      onStack,
      onEdit,
      onDuplicate,
      onMove,
      onToggle,
      onDelete,
      onPreview,
      onExport,
      onFork,
      missingSkills,
    }) {
      const skills = Array.isArray(card.pinnedSkills) ? card.pinnedSkills : [];
      const visible = skills.slice(0, 4);
      const isStandard = card.sourceType === STANDARD_SOURCE;
      // 本地场景是用户自己的：谁都能编辑/停用/删除（不必先开「管理模式」）。
      // 公司标准场景只有标准场景管理员能改；普通用户仍可「复制为本地场景」。
      const canManage = isStandard === true ? canManageStandard === true : true;
      const showMenu = canManage === true || isStandard === true;
      const readonly = isStandard === true && canManageStandard !== true;
      const meta = [
        card.businessSystem,
        card.category,
        isStandard ? `公司标准 v${card.version || '1.0.0'}` : '',
        card.enabled === true ? '' : '已停用',
        readonly ? '只读' : '',
      ]
        .filter((item) => item !== '')
        .join(' · ');

      return h(
        'article',
        { className: `crmw-card ${card.enabled === true ? '' : 'disabled'}` },
        h(
          'div',
          { className: 'crmw-card-top' },
          h('div', { className: 'crmw-card-icon' }, h(Icon, { name: card.icon, size: 18 })),
          h(
            'div',
            { className: 'crmw-grow' },
            h('div', { className: 'crmw-card-title' }, card.title),
            h('div', { className: 'crmw-card-cat' }, meta),
          ),
          showMenu === true
            ? h(Menu, {
                label: t('更多操作'),
                items: [
                  canManage === true ? { label: t('编辑'), onClick: onEdit } : null,
                  canManage === true ? { label: t('预览注入内容'), onClick: onPreview } : null,
                  canManage === true && isStandard !== true ? { label: t('复制'), onClick: onDuplicate } : null,
                  isStandard === true ? { label: t('复制为本地场景'), onClick: onFork } : null,
                  canManage === true ? { label: t('上移'), onClick: () => onMove('up') } : null,
                  canManage === true ? { label: t('下移'), onClick: () => onMove('down') } : null,
                  canManage === true ? { label: card.enabled === true ? t('停用') : t('启用'), onClick: onToggle } : null,
                  canManage === true ? { label: t('删除'), danger: true, onClick: onDelete } : null,
                ],
              })
            : null,
        ),
        // title：介绍被裁剪成两行时，鼠标悬停仍能看到全文。
        // 1.13.0 起场景介绍选填：留空时不写「未填写场景介绍」（会让选填字段像配置坏了），
        // 但仍占住那两行高度，否则同一排卡片里下面的「预填/技能」行会高低错位。
        h(
          'p',
          {
            className: 'crmw-card-desc',
            title: card.description || '',
            'aria-hidden': card.description ? undefined : 'true',
          },
          card.description || '',
        ),
        cardDraftLine(card),
        h(
          'div',
          { className: 'crmw-skills' },
          visible.length === 0
            ? h('span', { className: 'crmw-badge' }, t('未绑定技能'))
            : visible.map((name) =>
                h(
                  'span',
                  {
                    key: name,
                    className: `crmw-skill ${Array.isArray(missingSkills) && missingSkills.includes(name) ? 'missing' : ''}`,
                    title: name,
                  },
                  name,
                ),
              ),
          skills.length > visible.length ? h('span', { className: 'crmw-badge' }, `+${skills.length - visible.length}`) : null,
        ),
        h(
          'div',
          { className: 'crmw-card-foot' },
          h('code', { className: 'crmw-cmd' }, card.slashCommand),
          Array.isArray(card.presetAttachments) && card.presetAttachments.length > 0
            ? h('span', { className: 'crmw-badge' }, `📌 ${card.presetAttachments.length}`)
            : null,
          h('span', { className: 'crmw-grow' }),
          h(IconButton, { name: 'down', label: t('下载到本地'), onClick: onExport }),
          isStandard
            ? h(
                Button,
                { size: 'sm', onClick: onFork, title: '深拷贝为标准场景的本地副本，可自由编辑' },
                `⎘ ${t('复制为本地场景')}`,
              )
            : null,
          typeof onStack === 'function'
            ? h(
                Button,
                {
                  size: 'sm',
                  variant: 'ghost',
                  disabled: busy === true || card.enabled !== true,
                  title: '把这张场景叠加到当前对话（不新开会话、不动输入框）',
                  onClick: onStack,
                },
                `＋ ${t('叠加')}`,
              )
            : null,
          h(
            Button,
            {
              variant: 'primary',
              size: 'sm',
              disabled: busy === true || card.enabled !== true,
              title: card.enabled === true ? t('进入场景') : '该场景已停用',
              onClick: onEnter,
            },
            busy === true ? h('span', { className: 'crmw-spin' }) : null,
            t('进入场景'),
          ),
        ),
      );
    }

    /**
     * 公司推出的标准场景卡片（来自 MCP 控制平面，只读展示 + 安装/下载/管理动作）。
     * 与本地卡片分开写：它的字段来自服务端，不参与本地编辑流程。
     */
    function CompanyScenarioCard({ card, installed, busy, canManage, onInstall, onDownload, onEdit, onDelete, onEnter }) {
      const skills = Array.isArray(card.pinnedSkills) ? card.pinnedSkills : [];
      const visible = skills.slice(0, 4);
      const attachments = Array.isArray(card.presetAttachments) ? card.presetAttachments : [];
      return h(
        'article',
        { className: 'crmw-card' },
        h(
          'div',
          { className: 'crmw-card-top' },
          h('div', { className: 'crmw-card-icon' }, h(Icon, { name: card.icon, size: 18 })),
          h(
            'div',
            { className: 'crmw-grow' },
            h('div', { className: 'crmw-card-title' }, card.title),
            h(
              'div',
              { className: 'crmw-card-cat' },
              [
                card.businessSystem ?? card.category ?? '',
                `v${card.version || '1.0.0'}`,
                card.revision !== undefined ? `r${card.revision}` : '',
                card.author ? `${card.author}` : '',
              ]
                .filter((item) => item !== '' && item !== undefined)
                .join(' · '),
            ),
          ),
          installed === true ? h('span', { className: 'crmw-tag' }, `✅ ${t('已安装')}`) : null,
          canManage === true
            ? h(Menu, {
                label: t('更多操作'),
                items: [
                  { label: t('编辑标准场景'), onClick: onEdit },
                  { label: t('下载到本地'), onClick: onDownload },
                  { label: t('删除标准场景'), danger: true, onClick: onDelete },
                ],
              })
            : null,
        ),
        // title：介绍被裁剪成两行时，鼠标悬停仍能看到全文。
        h('p', { className: 'crmw-card-desc', title: card.description ?? '' }, card.description),
        cardDraftLine(card),
        h(
          'div',
          { className: 'crmw-skills' },
          visible.length === 0
            ? h('span', { className: 'crmw-badge' }, t('未绑定技能'))
            : visible.map((name) => h('span', { key: name, className: 'crmw-skill', title: name }, name)),
          skills.length > visible.length ? h('span', { className: 'crmw-badge' }, `+${skills.length - visible.length}`) : null,
        ),
        h(
          'div',
          { className: 'crmw-card-foot' },
          h('span', { className: 'crmw-badge' }, `v${card.version || '1.0.0'}`),
          // 附件改成脚注徽标：竖排列出文件名会把这张卡片撑得比别的卡片高，
          // 悬停仍能看到完整清单。
          attachments.length === 0
            ? null
            : h(
                'span',
                { className: 'crmw-badge', title: attachments.map((item) => item.fileName).join('\n') },
                `📌 ${attachments.length}`,
              ),
          h('span', { className: 'crmw-grow' }),
          installed === true && typeof onEnter === 'function'
            ? h(Button, { size: 'sm', onClick: onEnter }, t('进入场景'))
            : null,
          h(
            Button,
            { size: 'sm', disabled: busy === true, onClick: onDownload, title: '导出一个可离线分发的 .json 场景包' },
            '💾 ',
            t('下载到本地'),
          ),
          h(
            Button,
            { variant: 'primary', size: 'sm', disabled: busy === true || installed === true, onClick: onInstall },
            busy === true ? h('span', { className: 'crmw-spin' }) : '⬇️ ',
            installed === true ? t('已安装') : t('安装到我的场景'),
          ),
        ),
      );
    }

    /* ── 编辑器 ─────────────────────────────────────────────────── */

    function emptyDraft(taxonomy) {
      return {
        scenarioId: '',
        title: '',
        description: '',
        icon: taxonomy?.defaultIcon ?? 'sparkles',
        // 业务系统必填：进入场景时按它选工作区（CRM 的场景落在 CRM 工作区）。
        // 业务系统必填；新建时给个起点，用户要建 TAPD/其他场景再改。
        businessSystem: 'CRM',
        // 业务分类选填：只作补充说明，面板过滤已改为按业务系统。
        category: '',
        slashCommand: '',
        enabled: true,
        pinnedSkills: [],
        prePinnedContext: {
          // 新建场景默认允许附件：业务人员上传单据/表格是最常见的第一步。
          allowAttachments: true,
        },
        inputDraft: '',
        presetAttachments: [],
        sourceType: LOCAL_SOURCE,
        readonlyForNormalUser: false,
        isStandardPublished: false,
        version: '1.0.0',
        author: '',
      };
    }

    function EditorDialog({ initial, previousId, editingStandard, canManageStandard, taxonomy, limits, skillPool, currentUser, onClose, onSaved, onToast }) {
      const [draft, setDraft] = useState(() => {
        const base = { ...emptyDraft(taxonomy), ...(initial ?? {}) };
        if (editingStandard === true) {
          base.sourceType = STANDARD_SOURCE;
          base.readonlyForNormalUser = true;
          base.isStandardPublished = true;
        }
        if (typeof base.author !== 'string' || base.author.trim() === '') base.author = currentUser ?? '';
        return base;
      });
      const [errors, setErrors] = useState({});
      const [warnings, setWarnings] = useState([]);
      const [saving, setSaving] = useState(false);
      const [skillQuery, setSkillQuery] = useState('');
      const [skillError, setSkillError] = useState('');
      const [uploading, setUploading] = useState(false);

      const pinned = Array.isArray(draft.pinnedSkills) ? draft.pinnedSkills : [];
      /**
       * 从本地 Skill 视图里按名字找一条（大小写不敏感）。
       * 找不到就是「本地没有」——不能把随手打的字符串塞进技能栈，
       * 否则进入场景后模型会去加载一个并不存在的 Skill。
       */
      const findSkill = (name) => {
        const needle = String(name ?? '').trim().toLowerCase();
        if (needle === '') return undefined;
        const pool = Array.isArray(skillPool) ? skillPool : [];
        return pool.find((skill) => String(skill.name ?? '').trim().toLowerCase() === needle);
      };

      const addSkill = (name) => {
        const typed = String(name ?? '').trim();
        if (typed === '') return;
        const hit = findSkill(typed);
        if (hit === undefined) {
          setSkillError(
            Array.isArray(skillPool) && skillPool.length > 0
              ? `本地没有名为「${typed}」的 Skill：请从搜索结果里选一个`
              : '本地 Skill 列表还没读出来：稍等一下再输入，或点「刷新」重开场景面板',
          );
          return;
        }
        const canonical = String(hit.name).trim();
        setSkillError('');
        if (pinned.includes(canonical)) {
          setSkillQuery('');
          return;
        }
        clearFieldError('pinnedSkills');
        patch('pinnedSkills', [...pinned, canonical]);
        setSkillQuery('');
      };
      const removeSkill = (index) => {
        clearFieldError('pinnedSkills');
        patch('pinnedSkills', pinned.filter((_, i) => i !== index));
      };
      const moveSkill = (index, delta) => {
        const next = [...pinned];
        const target = index + delta;
        if (target < 0 || target >= next.length) return;
        const [moved] = next.splice(index, 1);
        next.splice(target, 0, moved);
        patch('pinnedSkills', next);
      };

      const known = useMemo(() => {
        const set = new Set((skillPool ?? []).map((skill) => skill.name));
        return set;
      }, [skillPool]);

      const suggestions = useMemo(() => {
        const needle = skillQuery.trim().toLowerCase();
        const pool = Array.isArray(skillPool) ? skillPool : [];
        const filtered =
          needle === ''
            ? pool
            : pool.filter((skill) => `${skill.name} ${skill.description ?? ''}`.toLowerCase().includes(needle));
        return filtered.filter((skill) => !pinned.includes(skill.name)).slice(0, 8);
      }, [skillPool, skillQuery, pinned]);

      /**
       * 消掉某个字段的旧报错。
       *
       * 保存失败时宿主会把「字段: 说明」映射回表单；但字段被用户改好之后，
       * 那条红字还挂在那里，看上去像「问题没解决」——改一下就清掉。
       */
      const clearFieldError = (key) => {
        setErrors((current) => {
          if (current === null || current === undefined || current[key] === undefined) return current;
          const next = { ...current };
          delete next[key];
          return next;
        });
      };

      /**
       * 改字段就顺手清掉这个字段的报错。
       * 放在 patch 里而不是每个 onChange 里调：1.13.0 起 `inputDraft` 是必填项，
       * 「补写了内容但红字还挂着」会让用户以为一直没填对，反复清空重填。
       */
      const patch = (key, value) => {
        clearFieldError(key);
        setDraft((current) => ({ ...current, [key]: value }));
      };
      const patchContext = (key, value) =>
        setDraft((current) => ({ ...current, prePinnedContext: { ...current.prePinnedContext, [key]: value } }));

      const submit = async () => {
        setSaving(true);
        setErrors({});
        setWarnings([]);
        try {
          const result = await callHost('scenario.save', { draft, previousId });
          if (result.ok !== true) {
            onToast?.('保存失败', 'error');
            return;
          }
          // 有提醒时不关抽屉：`setWarnings` 之后立刻 onClose 会让 banner 永远渲染不出来，
          // 而「尚未绑定任何 Skill」这类提醒正好决定了这张卡进场景后有没有用。
          if (Array.isArray(result.warnings) && result.warnings.length > 0) {
            setWarnings(result.warnings);
            onToast?.(`已保存「${result.card?.title ?? draft.title}」，有 ${result.warnings.length} 条提醒见顶部`, 'ok');
            onSaved?.(result.card);
            return;
          }
          onToast?.(`已保存「${result.card?.title ?? draft.title}」`, 'ok');
          onSaved?.(result.card);
          onClose?.();
        } catch (error) {
          const message = String(error?.message ?? error);
          // Host 的校验错误是 `字段: 说明` 的列表，尽量映射回表单
          const mapped = {};
          for (const line of message.split('\n')) {
            const match = /^([^:：]+)[:：]\s*(.+)$/.exec(line.trim());
            if (match !== null) mapped[match[1].trim()] = match[2].trim();
          }
          setErrors(Object.keys(mapped).length > 0 ? mapped : { '': message });
          onToast?.(message, 'error');
        } finally {
          setSaving(false);
        }
      };

      const attachments = Array.isArray(draft.presetAttachments) ? draft.presetAttachments : [];
      const maxAttachments = Number(limits?.presetAttachments ?? 10) || 10;
      const attachmentFull = attachments.length >= maxAttachments;

      /**
       * 逐个上传：单个文件失败（类型不支持 / 超限 / 网络错误）只记为失败项，
       * 不影响同批次里其他已经成功的附件 —— 之前的实现整批 try/catch，
       * 一个失败就丢掉全部，界面因此一直停在「尚未上传预设附件」。
       */
      const addAttachments = async (fileList) => {
        const files = Array.from(fileList ?? []);
        if (files.length === 0) return;
        const capacity = Math.max(0, maxAttachments - attachments.length);
        if (capacity === 0) {
          onToast?.(`最多只能上传 ${maxAttachments} 个预设附件`, 'error');
          return;
        }
        const accepted = files.slice(0, capacity);
        if (files.length > accepted.length) {
          onToast?.(`最多只能上传 ${maxAttachments} 个预设附件，已忽略多出的 ${files.length - accepted.length} 个`, 'error');
        }
        setUploading(true);
        const added = [];
        const failed = [];
        for (const file of accepted) {
          try {
            const dataBase64 = await readFileAsBase64(file);
            const result = await callHost('scenario.attachment.save', {
              fileName: file.name,
              mimeType: file.type,
              dataBase64,
            });
            if (result?.attachment !== undefined) added.push(result.attachment);
            else failed.push(`${file.name}：${result?.message ?? '上传失败'}`);
          } catch (error) {
            failed.push(`${file.name}：${String(error?.message ?? error)}`);
          }
        }
        if (added.length > 0) {
          clearFieldError('presetAttachments');
          // 函数式更新：连续几次上传不会互相覆盖。
          setDraft((current) => {
            const list = Array.isArray(current.presetAttachments) ? current.presetAttachments : [];
            return { ...current, presetAttachments: [...list, ...added] };
          });
          onToast?.(`已添加 ${added.length} 个预设附件`, 'ok');
        }
        if (failed.length > 0) onToast?.(failed.join('\n'), 'error');
        setUploading(false);
      };
      const removeAttachment = (index) => {
        clearFieldError('presetAttachments');
        setDraft((current) => {
          const list = Array.isArray(current.presetAttachments) ? current.presetAttachments : [];
          return { ...current, presetAttachments: list.filter((_, i) => i !== index) };
        });
      };

      return h(
        Dialog,
        {
          title: previousId === undefined ? t('新建场景') : t('编辑场景'),
          width: 'wide',
          onClose,
          footer: [
            h('span', { key: 'grow', className: 'crmw-grow' }),
            // 保存后还有提醒时，抽屉留着让人读：「取消」此时已经没有意义（改动已落盘），改成「关闭」。
            warnings.length > 0
              ? h(Button, { key: 'close', onClick: onClose, disabled: saving }, t('关闭'))
              : h(Button, { key: 'cancel', onClick: onClose, disabled: saving }, t('取消')),
            h(Button, { key: 'save', variant: 'primary', onClick: submit, disabled: saving }, saving ? h('span', { className: 'crmw-spin' }) : null, t('保存')),
          ],
        },
        errors[''] !== undefined ? h('div', { className: 'crmw-banner error' }, errors['']) : null,
        warnings.length > 0
          ? h('div', { className: 'crmw-banner warn' }, warnings.map((item) => item.message ?? String(item)).join('；'))
          : null,
        h(
          'div',
          { className: 'crmw-row' },
          h(
            Field,
            { label: `${t('场景标题')} *`, error: errors.title },
            h('input', {
              className: `crmw-input ${errors.title ? 'bad' : ''}`,
              value: draft.title,
              maxLength: limits?.title,
              placeholder: '例如：CRM 单据新建与修改',
              onChange: (event) => patch('title', event.target.value),
            }),
          ),
          h(
            Field,
            { label: `${t('业务系统')} *`, error: errors.businessSystem, hint: '必填：决定进入场景时落在哪个工作区（CRM / TAPD / 其他，也可自定义）' },
            h('input', {
              className: `crmw-input ${errors.businessSystem ? 'bad' : ''}`,
              value: draft.businessSystem ?? '',
              list: 'crmw-systems',
              maxLength: limits?.businessSystem,
              placeholder: 'CRM',
              onChange: (event) => patch('businessSystem', event.target.value),
            }),
            h(
              'datalist',
              { id: 'crmw-systems' },
              (taxonomy?.businessSystems ?? DEFAULT_BUSINESS_SYSTEMS).map((item) => {
                const label = typeof item === 'string' ? item : item?.label;
                return label === undefined || label === '' ? null : h('option', { key: label, value: label });
              }),
            ),
          ),
        ),
        h(
          Field,
          {
            label: `${t('场景介绍')}（选填）`,
            error: errors.description,
            hint: `一段话同时给两处用：注入给模型的「场景说明」，以及新会话输入框上方的「场景开场」卡片（${[...(draft.description ?? '')].length}/${limits?.description ?? 4000}）`,
          },
          h('textarea', {
            className: `crmw-textarea ${errors.description ? 'bad' : ''}`,
            value: draft.description,
            maxLength: limits?.description,
            placeholder: '例如：用于新建与修改 CRM 单据；按业务人员描述补齐必填字段，先核对再落库。',
            onChange: (event) => patch('description', event.target.value),
          }),
        ),
        // 1.13.0：原来的「开场引导语」并进场景介绍，这里紧接着放「输入框预填内容」。
        // 这两个字段就是「场景要模型做什么」的全部内容，放一起方便一次写完再往下配技能。
        h(
          Field,
          {
            label: `${t('输入框预填内容')} *`,
            hint: `进入场景开启新会话时原样写进输入框的草稿（不会自动加 /场景名称）。写「业务人员需要补什么」：${[...(draft.inputDraft ?? '')].length}/${limits?.inputDraft ?? 2000}`,
            error: errors.inputDraft,
          },
          h('textarea', {
            className: `crmw-textarea ${errors.inputDraft ? 'bad' : ''}`,
            value: draft.inputDraft ?? '',
            maxLength: limits?.inputDraft,
            placeholder: '例如：请新建一条拜访记录，客户名称、拜访日期、本次目的、下一步计划。',
            onChange: (event) => patch('inputDraft', event.target.value),
          }),
        ),
        h(
          'div',
          { className: 'crmw-row' },
          h(
            Field,
            { label: `${t('快捷指令')} *`, error: errors.slashCommand, hint: '在会话输入框敲 / 唤起，例如 /record' },
            h('input', {
              className: `crmw-input ${errors.slashCommand ? 'bad' : ''}`,
              value: draft.slashCommand,
              maxLength: limits?.slashCommand,
              placeholder: '/record',
              onChange: (event) => patch('slashCommand', event.target.value),
            }),
          ),
          h(
            Field,
            { label: t('业务分类（选填）'), error: errors.category, hint: '只作补充说明，面板按业务系统过滤' },
            h('input', {
              className: `crmw-input ${errors.category ? 'bad' : ''}`,
              value: draft.category ?? '',
              list: 'crmw-categories',
              maxLength: limits?.category,
              placeholder: '可留空',
              onChange: (event) => patch('category', event.target.value),
            }),
            h(
              'datalist',
              { id: 'crmw-categories' },
              (taxonomy?.categories ?? []).map((value) => h('option', { key: value, value })),
            ),
          ),
          h(
            Field,
            { label: t('图标') },
            h(
              'select',
              { className: 'crmw-select', value: draft.icon, onChange: (event) => patch('icon', event.target.value) },
              (taxonomy?.icons ?? []).map((icon) => h('option', { key: icon.id, value: icon.id }, `${icon.zh}（${icon.id}）`)),
            ),
          ),
          h(
            Field,
            { label: '场景编码', hint: '留空自动生成；创建后作为日志与注入标记的稳定标识' },
            h('input', {
              className: `crmw-input ${errors.scenarioId ? 'bad' : ''} crmw-mono`,
              value: draft.scenarioId,
              disabled: previousId !== undefined,
              placeholder: '自动生成',
              onChange: (event) => patch('scenarioId', event.target.value),
            }),
            errors.scenarioId !== undefined ? h('span', { className: 'err' }, errors.scenarioId) : null,
          ),
        ),
        h(
          Field,
          {
            label: `${t('技能栈')}（顺序即执行顺序）`,
            error: errors.pinnedSkills,
            hint: '只能绑定本地已有的 Skill：输入名称会出现候选，回车或点选即按顺序加入（进入场景后由模型按顺序加载正文）',
          },
          h(
            'div',
            { className: 'crmw-stack' },
            pinned.length === 0
              ? h('div', { className: 'crmw-dim', style: { fontSize: '11.5px' } }, '尚未绑定 Skill：进入场景后模型只拿到场景说明')
              : pinned.map((name, index) =>
                  h(
                    'div',
                    { key: `${name}-${index}`, className: 'crmw-stack-item' },
                    h('span', { className: 'idx' }, String(index + 1)),
                    h('span', { className: `nm ${known.size > 0 && !known.has(name) ? 'missing' : ''}`, title: name }, name),
                    h(IconButton, { name: 'up', label: t('上移'), size: 13, onClick: () => moveSkill(index, -1) }),
                    h(IconButton, { name: 'down', label: t('下移'), size: 13, onClick: () => moveSkill(index, 1) }),
                    h(IconButton, { name: 'x', label: '移除', size: 13, onClick: () => removeSkill(index) }),
                  ),
                ),
            h(
              'div',
              { className: 'crmw-row', style: { marginTop: '6px' } },
              h('input', {
                className: `crmw-input ${skillError === '' ? '' : 'bad'}`,
                value: skillQuery,
                placeholder: '输入 Skill 名称搜索，回车添加第一个候选',
                onChange: (event) => {
                  setSkillQuery(event.target.value);
                  setSkillError('');
                },
                onKeyDown: (event) => {
                  if (event.key !== 'Enter') return;
                  event.preventDefault();
                  // 回车 = 加第一条候选；没有候选时按名字精确匹配，匹配不到就报错，绝不硬塞。
                  if (suggestions.length > 0) addSkill(suggestions[0].name);
                  else addSkill(skillQuery);
                },
              }),
            ),
            skillError === '' ? null : h('span', { className: 'err' }, skillError),
            suggestions.length > 0
              ? h(
                  'div',
                  { className: 'crmw-skills', style: { marginTop: '4px' } },
                  suggestions.map((skill) =>
                    h(
                      'button',
                      {
                        key: skill.name,
                        type: 'button',
                        className: 'crmw-chip',
                        title: skill.description ?? '',
                        onClick: () => addSkill(skill.name),
                      },
                      `+ ${skill.name}`,
                    ),
                  ),
                )
              : skillQuery.trim() === ''
                ? null
                : h('span', { className: 'crmw-dim' }, '本地没有匹配的 Skill：换个关键词，或先在 DSH 里安装该 Skill'),
          ),
        ),
        h(
          'div',
          { className: 'crmw-options' },
          h(OptionTile, {
            checked: draft.enabled !== false,
            onChange: (value) => patch('enabled', value),
            label: '在运行态展示',
            hint: '开启后业务人员在场景页能看到并进入；关闭则只留档，卡片显示「已停用」，快捷指令也不再注册。',
          }),
          h(OptionTile, {
            checked: draft.prePinnedContext?.allowAttachments === true,
            onChange: (value) => patchContext('allowAttachments', value),
            label: '允许附件',
            hint: '在注入给模型的场景上下文里声明「允许附件」，业务人员上传的单据/表格/图片可作为执行依据。',
          }),
        ),
        h(
          Field,
          {
            label: t('场景预设附件'),
            error: errors.presetAttachments,
            hint: '支持 .docx / .csv / .xlsx / .pdf / .md / .txt；仅作为模板与业务规则带入，模型不会把它们归档到 CRM 单据。',
          },
          h(
            'div',
            { className: 'crmw-stack' },
            attachments.length === 0
              ? h('div', { className: 'crmw-dim', style: { fontSize: '11.5px' } }, `尚未上传预设附件（最多 ${maxAttachments} 个）`)
              : h(
                  'div',
                  { className: 'crmw-dim', style: { fontSize: '11.5px' } },
                  `已上传 ${attachments.length} / ${maxAttachments} 个预设附件`,
                ),
            attachments.map((item, index) =>
                  h(
                    'div',
                    { key: `${item.attachmentId ?? item.fileName}-${index}`, className: 'crmw-file' },
                    h('span', { className: 'crmw-tag' }, '📌 场景内置附件'),
                    h('span', { className: 'nm', title: item.fileName }, item.fileName),
                    h('span', { className: 'sz' }, formatBytes(item.fileSize)),
                    h(IconButton, { name: 'x', label: '移除', size: 13, onClick: () => removeAttachment(index) }),
                  ),
                ),
            h(
              'div',
              { className: 'crmw-toolbar' },
              h(
                'label',
                {
                  className: 'crmw-btn sm',
                  style: { cursor: attachmentFull ? 'not-allowed' : uploading ? 'progress' : 'pointer', opacity: attachmentFull ? 0.5 : 1 },
                },
                uploading ? h('span', { className: 'crmw-spin' }) : '📎 ',
                uploading ? '上传中…' : attachmentFull ? `已达上限（${maxAttachments}）` : t('上传预设附件'),
                h('input', {
                  type: 'file',
                  multiple: true,
                  accept: (taxonomy?.presetAttachmentExtensions ?? ['.docx', '.csv', '.xlsx', '.pdf', '.md', '.txt']).join(','),
                  style: { display: 'none' },
                  disabled: uploading || attachmentFull,
                  onChange: (event) => {
                    addAttachments(event.target.files).catch(() => undefined);
                    event.target.value = '';
                  },
                }),
              ),
            ),
          ),
        ),
        h(
          'div',
          { className: 'crmw-row' },
          h(
            Field,
            {
              label: t('版本号'),
              hint: editingStandard === true
                ? `当前 v${draft.version || '1.0.0'}（revision ${draft.revision ?? 0}）；每次保存由服务端自动升补丁位与 revision`
                : '本地场景版本号；安装的公司标准场景版本由服务端维护',
              error: errors.version,
            },
            editingStandard === true
              ? h(
                  'div',
                  { className: 'crmw-input crmw-mono', style: { opacity: 0.75 } },
                  `v${draft.version || '1.0.0'}（服务端自动升版）`,
                )
              : h('input', {
                  className: `crmw-input crmw-mono ${errors.version ? 'bad' : ''}`,
                  value: draft.version ?? '',
                  maxLength: limits?.version,
                  placeholder: '1.0.0',
                  onChange: (event) => patch('version', event.target.value),
                }),
          ),
          h(
            Field,
            {
              label: t('创建人'),
              hint:
                typeof draft.createdByCrmUser === 'string' && draft.createdByCrmUser !== ''
                  ? `由当前 DSH 登录用户自动带出，不可修改（远端记录创建人：${draft.createdByCrmUser}）`
                  : '由当前 DSH 登录用户自动带出，不可修改',
              error: errors.author,
            },
            h('input', {
              className: `crmw-input ${errors.author ? 'bad' : ''}`,
              value: draft.author ?? '',
              readOnly: true,
              disabled: true,
              style: { opacity: 0.75, cursor: 'not-allowed' },
              placeholder: '自动带出当前用户',
              title: '由当前 DSH 登录用户自动带出，不可修改',
            }),
          ),
        ),
        // 发布到公司标准库只对标准场景管理员开放：无权限时整块不渲染
        // （与其放一个灰掉的勾选框，不如让普通用户看不到这个入口）。
        canManageStandard === true
          ? h(
              Field,
              {
                label: t('共享与发布'),
                hint: editingStandard === true
                  ? '正在编辑公司标准场景：保存后服务端自动升版。'
                  : '勾选后保存会把这张场景发布到公司标准场景库（生成 v1.0.0），同事在「标准场景」页签即可安装。',
              },
              h(
                'div',
                { className: 'crmw-options' },
                h(OptionTile, {
                  checked:
                    editingStandard === true ||
                    draft.sourceType === STANDARD_SOURCE ||
                    draft.isStandardPublished === true,
                  disabled: editingStandard === true,
                  onChange: (value) => {
                    setDraft((current) => ({
                      ...current,
                      isStandardPublished: value,
                      readonlyForNormalUser: value,
                      sourceType: value || editingStandard === true ? STANDARD_SOURCE : LOCAL_SOURCE,
                    }));
                  },
                  label: t('设为插件标准场景'),
                  hint:
                    editingStandard === true
                      ? '正在编辑公司标准场景：保存后服务端自动升版。'
                      : '发布到公司标准场景库，供同事安装。',
                }),
              ),
            )
          : null,
      );
    }

    function PreviewDialog({ scenarioId, onClose, onToast }) {
      const [text, setText] = useState('');
      const [skills, setSkills] = useState([]);
      const [meta, setMeta] = useState({ mode: '', characters: 0 });
      const [loading, setLoading] = useState(true);

      useEffect(() => {
        let cancelled = false;
        setLoading(true);
        callHost('preview.injection', { scenarioId })
          .then((result) => {
            if (cancelled) return;
            setText(result.text ?? '');
            setSkills(Array.isArray(result.skills) ? result.skills : []);
            setMeta({ mode: result.mode ?? '', characters: Number(result.characters ?? 0) || 0 });
          })
          .catch((error) => {
            if (!cancelled) onToast?.(String(error?.message ?? error), 'error');
          })
          .finally(() => {
            if (!cancelled) setLoading(false);
          });
        return () => {
          cancelled = true;
        };
      }, [scenarioId, onToast]);

      return h(
        Dialog,
        { title: t('预览注入内容'), width: 'wide', onClose, footer: [h('span', { key: 'g', className: 'crmw-grow' }), h(Button, { key: 'c', onClick: onClose }, t('关闭'))] },
        h(
          'div',
          { className: 'crmw-banner' },
          meta.mode === 'names'
            ? `这是点击卡片后注入到模型请求里的完整文本：只含场景、默认上下文与 Skill 名称（约 ${meta.characters} 字符），正文由模型按顺序用 skill 工具加载。如需把正文直接写进请求，把插件配置 injectSkillBodies 设为 true。`
            : meta.mode === 'reminder'
              ? '这是后续轮次的紧凑提醒（Skill 正文已在首次进入时给过）。'
              : '这是点击卡片后注入到模型请求里的完整文本（含 Skill 正文，受注入预算截断）。',
        ),
        loading
          ? h('div', { className: 'crmw-toolbar' }, h('span', { className: 'crmw-spin' }), h('span', { className: 'crmw-dim' }, '生成中…'))
          : h('pre', { className: 'crmw-pre' }, text),
        skills.length > 0
          ? h(
              'div',
              { className: 'crmw-skills' },
              skills.map((skill) =>
                h(
                  'span',
                  { key: skill.name, className: `crmw-skill ${skill.missing ? 'missing' : ''}` },
                  `${skill.name}${skill.missing ? '（缺失）' : ` · ${skill.characters} 字符`}`,
                ),
              ),
            )
          : null,
      );
    }

    /* ── 面板 ───────────────────────────────────────────────────── */

    /**
     * 列表搜索用的匹配文本。
     *
     * 预填内容也算进来：业务人员记得的往往是「那张让我建拜访记录的卡」，
     * 而不是卡片标题；「我的场景」与「标准场景」两个页签共用同一套口径。
     */
    function scenarioSearchText(card) {
      return [
        card?.title,
        card?.description,
        card?.inputDraft,
        card?.businessSystem,
        card?.category,
        card?.slashCommand,
        ...(Array.isArray(card?.pinnedSkills) ? card.pinnedSkills : []),
      ]
        .filter((part) => typeof part === 'string' && part !== '')
        .join(' ')
        .toLowerCase();
    }

    function Panel(props) {
      const ctx = props.ctx;
      const [data, setData] = useState(null);
      const [activation, setActivation] = useState(null);
      const [error, setError] = useState('');
      const [loading, setLoading] = useState(true);
      const [busyId, setBusyId] = useState('');
      const [query, setQuery] = useState('');
      const [system, setSystem] = useState('');
      // 「标准场景」页签独立保存筛选条件：两个页签的业务系统集合不同，
      // 共用一个 system 会导致「在我的场景筛 CRM，切到标准场景却筛出空」这种怪现象。
      const [companyQuery, setCompanyQuery] = useState('');
      const [companySystem, setCompanySystem] = useState('');
      const [showDisabled, setShowDisabled] = useState(false);
      const [admin, setAdmin] = useState(() => {
        try {
          return window.localStorage.getItem(ADMIN_KEY) === '1';
        } catch {
          return false;
        }
      });
      const [editor, setEditor] = useState(null);
      const [preview, setPreview] = useState(null);
      const [skillPool, setSkillPool] = useState([]);
      const [toasts, setToasts] = useState([]);
      const [confirmState, setConfirmState] = useState(null);
      const [tab, setTab] = useState('installed');
      const [auth, setAuth] = useState({
        authenticated: false,
        platformUserId: null,
        crmUsername: null,
        canManageStandardScenario: false,
      });
      const [company, setCompany] = useState({ loading: false, scenarios: null, error: '', fetchedAt: 0 });
      /** 本次同步实际使用的身份来源（internal_bearer:xxx / buntu_token），只用于提示与排障。 */
      const [identitySource, setIdentitySource] = useState('');
      const [companyBusy, setCompanyBusy] = useState('');
      /** 诊断弹层：{loading, report, error, faults}。 */
      const [diag, setDiag] = useState(null);
      /**
       * 技能门禁弹层：`{card, stack, cwd, missing}`。
       *
       * 进场景前发现绑定技能本机没装、又装不上时拦住用户：让他先去智能体中心装，
       * 或者明知不能路由也继续（模型只能把这些名字当成普通文字）。
       */
      const [skillGate, setSkillGate] = useState(null);
      /**
       * 插件自更新：打开面板时查一次，有新版本弹一次。
       *
       * 不挂在 refresh 的 5 秒轮询里 —— 那样每次轮询都会问 registry；
       * 这里只在面板挂载时问一次，Host 侧还有 6 小时缓存与「跳过此版本」兜底。
       * `{ current, latest, notes, skipped, deprecated }`，null 表示不提示。
       */
      const [updateNotice, setUpdateNotice] = useState(null);
      const [updateBusy, setUpdateBusy] = useState(false);
      const updateAskedRef = useRef(false);

      const toast = useCallback((text, kind = 'ok') => {
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        setToasts((items) => [...items, { id, text, kind }]);
        window.setTimeout(() => {
          setToasts((items) => items.filter((item) => item.id !== id));
        }, kind === 'error' ? 6000 : 3200);
      }, []);

      const refresh = useCallback(
        async (options = {}) => {
          // 工作台作为独立 main 面板时对话面板是卸载状态，这里用「最近会话」兜底，
          // 否则当前场景条会在切到工作台的瞬间消失。
          const sessionId = resumableSessionId(ctx);
          try {
            const boot = await callHost('bootstrap', { sessions: sessionId === undefined ? [] : [sessionId] });
            rememberScenarioTemplates([
              ...(boot?.scenarios ?? []),
              ...(boot?.installedScenarios ?? []),
              ...(boot?.companyStandardScenarios ?? []),
            ]);
            setData(boot);
            // `/指令` 路径（runScenarioCommand）拿不到 data.config，缓存一份供它读开关。
            hostConfig = boot?.config ?? {};
            // 场景指令随卡片列表同步：新增/停用卡片后，输入框里的 /指令 也跟着变。
            syncScenarioCommands(ctx, getService(ctx, 'commandUi'), boot?.installedScenarios);
            const bootAuth = boot?.auth ?? boot?.permission;
            if (bootAuth !== undefined && bootAuth !== null) {
              setAuth((current) => ({ ...current, ...bootAuth }));
            }
            setError('');
            sidebarGate?.(boot?.config?.showSidebarEntry !== false);
            if (sessionId !== undefined && options.withActivation !== false) {
              const state = await callHost('activation.state', { sessionId, cwd: sessionCwd(ctx, sessionId) ?? '' });
              setActivation(state.activation ?? null);
            } else {
              setActivation(null);
            }
          } catch (failure) {
            setError(String(failure?.message ?? failure));
          } finally {
            setLoading(false);
          }
        },
        [ctx],
      );

      useEffect(() => {
        let timer;
        const tick = () => {
          if (document.visibilityState === 'hidden') return;
          refresh().catch(() => undefined);
        };
        tick();
        timer = window.setInterval(tick, 5000);
        window.addEventListener('focus', tick);
        return () => {
          window.clearInterval(timer);
          window.removeEventListener('focus', tick);
        };
      }, [refresh]);

      /**
       * 打开面板时问一次「有没有新版本」。
       *
       * 失败、被关掉、已跳过都不提示 —— 升级提醒不能变成打开插件的门槛。
       * `updateAskedRef` 防的是 StrictMode 下的重复挂载，不是防轮询。
       */
      useEffect(() => {
        if (updateAskedRef.current) return;
        updateAskedRef.current = true;
        callHost('update.check', {})
          .then((result) => {
            if (result?.updateAvailable === true && result.skipped !== true) setUpdateNotice(result);
          })
          .catch(() => undefined);
      }, []);

      /**
       * 立即升级：宿主在后台跑 pnpm（可能几十秒），这里轮询到终态。
       * 不做乐观更新 —— 只有 status 说 done 才算装上了。
       */
      const applyUpdate = useCallback(async () => {
        if (updateBusy) return;
        setUpdateBusy(true);
        try {
          const started = await callHost('update.apply', {});
          if (started?.ok !== true) {
            toast(started?.message ?? '升级没能开始', 'error');
            return;
          }
          const deadline = Date.now() + 5 * 60 * 1000;
          while (Date.now() < deadline) {
            await new Promise((resolve) => window.setTimeout(resolve, 1500));
            const status = await callHost('update.status', {});
            if (status?.phase === 'done' || status?.phase === 'failed') {
              setUpdateNotice(null);
              toast(
                status.message ?? (status.phase === 'done' ? '已升级' : '升级失败'),
                status.phase === 'done' ? 'ok' : 'error',
              );
              return;
            }
          }
          toast('升级耗时超出预期，请到插件页确认安装结果', 'error');
        } catch (failure) {
          toast(String(failure?.message ?? failure), 'error');
        } finally {
          setUpdateBusy(false);
        }
      }, [toast, updateBusy]);

      /** 关掉提醒；remember 为真时记下「这个版本不再提醒」。 */
      const dismissUpdate = useCallback(
        (remember) => {
          const version = updateNotice?.latest ?? '';
          if (updateBusy) return;
          setUpdateNotice(null);
          if (remember === true && version !== '') {
            void callHost('update.skip', { version }).catch(() => undefined);
          }
        },
        [updateBusy, updateNotice],
      );

      useEffect(() => {
        // 技能栈只允许绑定本地已有的 Skill，所以**谁打开面板都要有这份列表**：
        // 早先只给管理员加载，普通用户搜索框永远没有候选，只能瞎猜名字。
        if (skillPool.length > 0) return;
        callHost('skills.list', {})
          .then((result) => setSkillPool(Array.isArray(result.skills) ? result.skills : []))
          .catch(() => undefined);
      }, [skillPool.length]);

      /** 打开抽屉前强制刷新权限：标准场景管理权限只认 auth.canManageStandardScenario。 */
      const refreshPermission = useCallback(async (force = false) => {
        try {
          const result = await callHost('scenario.permission', { refresh: force === true });
          if (result?.auth !== undefined) {
            setAuth((current) => ({ ...current, ...result.auth }));
            return result.auth;
          }
        } catch {
          /* 服务不可用时保留缓存权限；标准场景操作会被后端再次拦截 */
        }
        return undefined;
      }, []);

      useEffect(() => {
        void refreshPermission(false);
      }, [refreshPermission]);

      /**
       * 面板首次打开时做一次后台同步：拉取标准场景并触发已安装场景的静默升级。
       * 失败不影响面板使用，错误只在「公司推出的场景」页签显示。
       */
      useEffect(() => {
        let cancelled = false;
        const timer = window.setTimeout(() => {
          void callHost('registry.list', { refresh: false })
            .then((result) => {
              if (cancelled) return;
              if (result?.auth !== undefined) setAuth((current) => ({ ...current, ...result.auth }));
              if (Array.isArray(result?.scenarios)) {
                setCompany({
                  loading: false,
                  scenarios: result.scenarios,
                  error: '',
                  fetchedAt: Number(result.fetchedAt ?? 0) || 0,
                });
              }
              return refresh({ withActivation: true });
            })
            .catch(() => undefined);
        }, 900);
        return () => {
          cancelled = true;
          window.clearTimeout(timer);
        };
      }, [refresh]);

      const toggleAdmin = (value) => {
        setAdmin(value);
        try {
          window.localStorage.setItem(ADMIN_KEY, value ? '1' : '0');
        } catch {
          /* 隐私模式下写入失败无妨 */
        }
      };

      /** 「已安装的场景（我的）」：本地自建 + 主动安装的公司标准场景。 */
      const installedList = useMemo(() => {
        if (Array.isArray(data?.installedScenarios)) return data.installedScenarios;
        return Array.isArray(data?.scenarios) ? data.scenarios : [];
      }, [data]);

      /** 「标准场景」页签：同步回来的全部 PUBLISHED 标准场景。 */
      const companyRows = useMemo(() => {
        if (Array.isArray(data?.companyStandardScenarios)) return data.companyStandardScenarios;
        return [];
      }, [data]);

      /**
       * 标准场景页签真正渲染的那一份：主动「同步」拿到的完整库优先，
       * 没同步过就用 bootstrap 带回来的清单（两处都是远端数据，字段一致）。
       */
      const companySource = company.scenarios !== null ? company.scenarios : companyRows;

      const scenarios = useMemo(() => {
        const rows = installedList;
        const needle = query.trim().toLowerCase();
        return rows.filter((card) => {
          if (showDisabled !== true && card.enabled !== true) return false;
          // 列表按「业务系统」过滤（分类已经降级成选填的备注，不再当筛选维度）。
          if (system !== '' && card.businessSystem !== system) return false;
          if (needle === '') return true;
          return scenarioSearchText(card).includes(needle);
        });
      }, [installedList, query, system, showDisabled]);

      /**
       * 「标准场景」页签的筛选结果：与「我的场景」同一套口径（业务系统标签 + 关键词），
       * 但用它自己的筛选条件 —— 库里的场景集合和本机不是同一批。
       */
      const companyVisible = useMemo(() => {
        const needle = companyQuery.trim().toLowerCase();
        return companySource.filter((card) => {
          if (companySystem !== '' && card.businessSystem !== companySystem) return false;
          if (needle === '') return true;
          return scenarioSearchText(card).includes(needle);
        });
      }, [companySource, companyQuery, companySystem]);

      /**
       * 「标准场景」页签的业务系统标签：只列库里真实出现过的系统。
       * 不掺本机 taxonomy 的建议值 —— 显示一个一条都筛不出来的标签比没有更糟。
       */
      const companySystems = useMemo(() => {
        const seen = new Set();
        for (const card of companySource) {
          if (typeof card.businessSystem === 'string' && card.businessSystem !== '') seen.add(card.businessSystem);
        }
        return [...seen];
      }, [companySource]);

      /**
       * 同步后若选中的业务系统已经不在库里（该类标准场景全下架了），把它归零。
       * 否则 chips 上没有任何选中态、界面看着「没筛选」，列表却是空的。
       */
      useEffect(() => {
        if (companySystem === '') return;
        if (companySystems.includes(companySystem) === true) return;
        setCompanySystem('');
      }, [companySystems, companySystem]);

      /**
       * 过滤用的业务系统：卡片里实际出现过的 + 宿主下发的建议值。
       * 建议值也要列出来，否则新建了 CRM/TAPD 场景之前根本点不到这两个筛选项。
       */
      const systems = useMemo(() => {
        const seen = new Set();
        for (const card of installedList) {
          if (typeof card.businessSystem === 'string' && card.businessSystem !== '') seen.add(card.businessSystem);
        }
        const suggested = Array.isArray(data?.taxonomy?.businessSystems)
          ? data.taxonomy.businessSystems
          : DEFAULT_BUSINESS_SYSTEMS;
        for (const item of suggested) {
          const label = typeof item === 'string' ? item : item?.label;
          if (typeof label === 'string' && label !== '') seen.add(label);
        }
        return [...seen];
      }, [installedList, data]);

      /**
       * 当前会话激活的场景栈（顺序即技能栈叠加顺序）。
       * 旧宿主只返回 `activation.scenarioId`：这里兜底成单元素，向后兼容。
       */
      const activeCards = useMemo(() => {
        if (activation === null) return [];
        const ids =
          Array.isArray(activation.scenarios) && activation.scenarios.length > 0
            ? activation.scenarios.map((item) => item?.scenarioId).filter(Boolean)
            : [activation.scenarioId].filter(Boolean);
        return ids.map((id) => installedList.find((card) => card.scenarioId === id)).filter(Boolean);
      }, [activation, installedList]);

      const canManageStandard = auth.canManageStandardScenario === true;

      /**
       * 打开编辑器前强制调用 GET /api/dsh/scenarios/permission。
       * 标准场景编辑/删除只认服务端返回的 auth.canManageStandardScenario。
       */
      const openEditor = async ({ initial = null, previousId, standard = false } = {}) => {
        const isStandard = standard === true || initial?.sourceType === STANDARD_SOURCE;
        // 只有编辑公司标准场景才需要向服务端确认权限；本地场景人人可建可改。
        if (isStandard) {
          const permission = await refreshPermission(true);
          const allowed = (permission ?? auth).canManageStandardScenario === true;
          if (allowed !== true) {
            toast('当前账号没有管理公司标准场景的权限（auth.canManageStandardScenario=false）', 'error');
            return;
          }
        }
        setEditor({ initial, previousId, standard: isStandard });
      };

      /**
       * 进入场景。
       *
       * @param {object} card 场景卡
       * @param {{stack?: boolean}} [options] stack=true 表示「叠加到当前对话」：
       *   不新开会话、不动输入框，只把这张卡的技能栈追加到当前激活栈上。
       */
      const enterScenario = async (card, options = {}) => {
        const stack = options.stack === true;
        // 会话按业务系统落在各自的工作区里：把 TAPD 场景叠到 CRM 会话上，
        // 这段对话就同时属于两个系统，注入块里也会出现两套系统上下文。
        // 与其静默塞进去，不如在这里拦住并说清楚怎么继续。
        if (stack === true) {
          // 用宿主上的**真实**栈判断：面板里的 activation 是上一轮 refresh 的结果，
          // 刚点完「进入场景」就回来点「叠加」时它很可能还是空的，
          // 那样这两个守卫都会失效，最后表现为「点一下叠加，附件和输入框都没了」。
          let liveStack = activeCards;
          const stackSession = resumableSessionId(ctx) ?? currentSessionId(ctx);
          if (stackSession !== undefined) {
            try {
              const live = await callHost('activation.state', {
                sessionId: stackSession,
                cwd: sessionCwd(ctx, stackSession) ?? '',
              });
              const rows = Array.isArray(live?.scenarios) ? live.scenarios : [];
              if (rows.length > 0) liveStack = rows;
              else if (live?.scenario !== undefined && live?.scenario !== null) liveStack = [live.scenario];
              else liveStack = [];
            } catch {
              /* 读不到就用面板里的旧值，宁可拦错也不要静默换会话 */
            }
          }
          const conflicts = liveStack
            .filter((item) => item.scenarioId !== card.scenarioId)
            .map((item) => item.businessSystem)
            .filter((sys) => typeof sys === 'string' && sys !== '' && sys !== card.businessSystem);
          if (conflicts.length > 0) {
            toast(
              `「${card.title}」属于 ${card.businessSystem}，而当前对话用的是 ${conflicts[0]} 的场景：跨业务系统不能叠加，请先退出当前场景`,
              'error',
            );
            return;
          }
          // 同一张卡已经在栈里了：再叠加一次没有意义，而且换会话会把旧会话的
          // 预填与预设附件一并收走，用户看到的就是「点一下什么都没了」。
          if (liveStack.some((item) => item.scenarioId === card.scenarioId)) {
            toast(`「${card.title}」已经在当前对话里了：可以直接用，或先移除再重新叠加`, 'info');
            return;
          }
        }
        setBusyId(card.scenarioId);
        try {
          // 每个场景都绑一个业务系统：先把这个系统的工作区准备好（没有就建），
          // 会话一律建/落在它里面 —— 叠加也一样，绝不把 CRM 场景塞进别的工作区。
          const target = await ensureSystemWorkspaceEntry(ctx, card.businessSystem);
          const current = resumableSessionId(ctx) ?? currentSessionId(ctx);
          // 技能的分层视图是按 cwd 解析的（项目级 .dsh/skills 会盖掉用户级同名技能），
          // 所以预检与激活都必须带上这段会话真正的工作目录。
          const cwd = target?.path ?? sessionCwd(ctx, current) ?? '';
          // 进场景前先确认「这些技能本机有没有、能不能写成 /技能名」：没有就试着装，
          // 装不上就拦在这里说清楚 —— 否则用户进去后看到的是一行不起作用的纯文字。
          if (options.skipSkillGate !== true && skillRoutePrefillEnabled(data?.config) === true) {
            const gate = await verifyScenarioSkills(ctx, card, cwd, data?.config?.autoInstallSkills !== false);
            if (gate.installed.length > 0) {
              toast(`已自动安装：${gate.installed.map((name) => `/${name}`).join('、')}`, 'ok');
            }
            for (const note of gate.notes) toast(note, 'error');
            if (gate.missing.length > 0) {
              setSkillGate({ card, stack, cwd, missing: gate.missing });
              return;
            }
          }
          const alreadyThere =
            target === undefined || sessionBelongsTo(ctx, current, target.workspaceId, target.path);
          const targetOptions =
            target === undefined ? {} : { workspaceId: target.workspaceId, path: target.path };

          // 叠加：能沿用当前会话就沿用；不在目标工作区就先在目标工作区里开一段。
          // 进入：当前会话有内容时新开一个空白会话。
          if (stack !== true && alreadyThere) {
            // 新会话会继承旧会话的草稿：先把我们自己的旧模板清掉，免得它被当成用户输入带过去。
            await clearStaleSeededDraft(ctx, current);
          }
          const sessionId =
            stack === true && alreadyThere && current !== undefined
              ? current
              : await ensureScenarioSession(ctx, targetOptions);
          const result = await callHost('activation.activate', {
            sessionId,
            scenarioId: card.scenarioId,
            source: 'ui',
            stack,
            cwd,
          });
          setActivation(result.activation ?? { scenarioId: card.scenarioId });
          if (stack !== true || alreadyThere !== true) {
            // 切到对话面板：输入框上方的场景标识、开场引导与预填内容都在那里生效。
            switchToConversation(ctx, sessionId);
          }
          // 会话可能是刚建/刚挂载的：主动通知一次，别让徽标等下一轮 6 秒轮询。
          notifyActivationChanged(sessionId);
          if (stack === true) {
            toast(
              alreadyThere === true
                ? `➕ 已把「${card.title}」叠加到当前对话`
                : `➕ 已把「${card.title}」叠加到 ${target?.title ?? '目标'} 工作区的新对话`,
            );
          } else {
            toast(
              target === undefined
                ? `🟢 已进入「${card.title}」· 新对话`
                : `🟢 已进入「${card.title}」· ${target.title} 工作区新对话`,
            );
            // 预填与预设附件都不依赖输入框组件是否挂载：面板这边直接写并回读确认。
            // 绑定技能以 `/技能名` 写在模板前面：宿主 pre-step 会把它们的正文作为
            // <skill_content> 注入本次请求，等价于用户自己在输入框里引用技能。
            const text = composePrefillText(
              skillRoutePrefillEnabled(data?.config) === true ? result?.skillTokens : '',
              prefillTextFor(card),
            );
            if (text !== '') {
              void seedComposer(ctx, sessionId, {
                text,
                attachments: card.presetAttachments,
                seedKey: scenarioSeedKey([card]),
                cards: [card],
              }).then((seeded) => {
                if (seeded.draft !== true) {
                  toast('输入框预填没写进去：会话还没就绪，请点「进入对话」后再点一次场景卡片', 'error');
                } else if (seeded.attachments !== true) {
                  toast('预设附件没能挂到输入框：请确认附件文件还在插件数据目录里', 'error');
                }
              });
            } else if (Array.isArray(card.presetAttachments) && card.presetAttachments.length > 0) {
              // 没有填写模板时也要把预设附件带上（只是不写草稿）。
              void seedComposer(ctx, sessionId, {
                text: '',
                attachments: card.presetAttachments,
                seedKey: scenarioSeedKey([card]),
                cards: [card],
              }).then((seeded) => {
                if (seeded.attachments !== true) {
                  toast('预设附件没能挂到输入框：请确认附件文件还在插件数据目录里', 'error');
                }
              });
            }
          }
        } catch (failure) {
          toast(String(failure?.message ?? failure), 'error');
        } finally {
          setBusyId('');
        }
      };

      /** 从当前会话的激活栈里移除一个场景（其余场景保留）。 */
      const removeScenarioById = async (scenarioId) => {
        const sessionId = resumableSessionId(ctx);
        if (sessionId === undefined) return;
        setBusyId(scenarioId);
        try {
          const result = await callHost('activation.deactivate', { sessionId, scenarioId });
          if (result?.ok !== true) throw new Error('activation.deactivate failed');
          setActivation(result.activation ?? null);
          // 整栈被清空时托盘里的预设附件也该跟着走。
          if (result.activation === undefined || result.activation === null) void dropSeededAttachments(ctx, sessionId);
          notifyActivationChanged(sessionId);
          toast('已从当前对话移除该场景');
          await refresh({ withActivation: true });
        } catch (failure) {
          toast(String(failure?.message ?? failure), 'error');
        } finally {
          setBusyId('');
        }
      };

      const clearActivation = async () => {
        const sessionId = resumableSessionId(ctx);
        if (sessionId === undefined) {
          setActivation(null);
          return;
        }
        try {
          await callHost('activation.clear', { sessionId });
          setActivation(null);
          // 预设附件是插件挂上去的：整栈退出后它们没人引用，从托盘摘掉并回收。
          void dropSeededAttachments(ctx, sessionId);
          notifyActivationChanged(sessionId);
          toast('已退出当前场景');
        } catch (failure) {
          toast(String(failure?.message ?? failure), 'error');
        }
      };

      /**
       * 打开诊断弹层：宿主侧的事实（版本 / 状态目录 / 激活记录 / 注入模式）加上
       * 客户端最近的 slot 渲染失败。用户报「栏位不见了」时先看这里，不必翻控制台。
       */
      const openDiagnostics = async () => {
        const faults = listedSlotFaults();
        setDiag({ loading: true, report: null, error: '', faults });
        try {
          const sessionId = resumableSessionId(ctx);
          const report = await callHost('diagnostics', sessionId === undefined ? {} : { sessionId });
          setDiag({ loading: false, report, error: '', faults: listedSlotFaults() });
        } catch (failure) {
          setDiag({ loading: false, report: null, error: String(failure?.message ?? failure), faults });
        }
      };

      const mutate = async (method, params, successText) => {
        try {
          await callHost(method, params);
          toast(successText);
          await refresh();
        } catch (failure) {
          toast(String(failure?.message ?? failure), 'error');
        }
      };

      /** 把标准场景复制成本地副本：可自由编辑，不再跟随远端升级。 */
      const forkScenario = async (card) => {
        setBusyId(card.scenarioId);
        try {
          const result = await callHost('scenario.fork', { scenarioId: card.scenarioId });
          toast(`已复制为本地场景「${result?.card?.title ?? card.title}」`);
          setTab('installed');
          await refresh({ withActivation: true });
        } catch (failure) {
          toast(String(failure?.message ?? failure), 'error');
        } finally {
          setBusyId('');
        }
      };

      const loadCompany = useCallback(async (force) => {
        setCompany((current) => ({ ...current, loading: true, error: '' }));
        try {
          const result = await callHost('registry.list', { refresh: force === true });
          if (result?.auth !== undefined) setAuth((current) => ({ ...current, ...result.auth }));
          if (typeof result?.identitySource === 'string') setIdentitySource(result.identitySource);
          setCompany({
            loading: false,
            scenarios: Array.isArray(result.scenarios) ? result.scenarios : [],
            error: '',
            fetchedAt: Number(result.fetchedAt ?? 0) || 0,
          });
          const upgraded = Array.isArray(result.upgraded) ? result.upgraded : [];
          const uninstalled = Array.isArray(result.uninstalled) ? result.uninstalled : [];
          if (upgraded.length > 0) {
            toast(
              `已自动升级 ${upgraded.length} 个标准场景：${upgraded
                .map((item) => `${item.title} v${item.toVersion}`)
                .join('、')}`,
            );
          }
          if (uninstalled.length > 0) {
            toast(`已卸载 ${uninstalled.length} 个下架的标准场景`, 'error');
          }
          if (upgraded.length > 0 || uninstalled.length > 0) {
            await refresh({ withActivation: true });
          }
        } catch (failure) {
          setCompany((current) => ({ ...current, loading: false, error: String(failure?.message ?? failure) }));
        }
      }, [refresh, toast]);

      useEffect(() => {
        if (tab !== 'company') return;
        if (company.scenarios !== null || company.loading === true) return;
        void loadCompany(false);
      }, [tab, company.scenarios, company.loading, loadCompany]);

      const installCompanyScenario = async (card) => {
        setCompanyBusy(card.scenarioId);
        try {
          const result = await callHost('scenario.install', { scenarioId: card.scenarioId });
          const failed = Array.isArray(result?.attachments?.failed) ? result.attachments.failed : [];
          const savedCount = result?.attachments?.saved ?? result?.attachments?.downloaded ?? 0;
          toast(
            failed.length === 0
              ? `已安装「${result?.card?.title ?? card.title}」，预设附件 ${savedCount} 个`
              : `已安装「${result?.card?.title ?? card.title}」，但 ${failed.length} 个附件下载失败：${failed
                  .map((item) => item.fileName)
                  .join('、')}`,
            failed.length === 0 ? 'ok' : 'error',
          );
          await refresh({ withActivation: true });
          await loadCompany(true);
        } catch (failure) {
          toast(String(failure?.message ?? failure), 'error');
        } finally {
          setCompanyBusy('');
        }
      };

      const exportPackage = async (scenarioId, source) => {
        try {
          const result = await callHost('scenario.export', source === 'company' ? { scenarioId, source: 'company' } : { scenarioId });
          downloadJson(result.fileName ?? `${scenarioId}.crm-scenario.json`, result.package ?? result);
          toast(`已导出 ${result.fileName ?? `${scenarioId}.crm-scenario.json`}`);
        } catch (failure) {
          toast(String(failure?.message ?? failure), 'error');
        }
      };

      const importRef = useRef(null);
      const importPackage = async (file) => {
        try {
          const parsed = JSON.parse(await file.text());
          // 既支持「直接下载的 package 文件」，也支持外层再包一层 { package } 的分发格式。
          const bundle = parsed?.package ?? parsed;
          const result = await callHost('scenario.import', { package: bundle });
          if (result?.ok === false) {
            toast(result.message ?? '导入失败', 'error');
            return;
          }
          const failed = Array.isArray(result?.attachments?.failed) ? result.attachments.failed : [];
          toast(
            failed.length === 0
              ? `已导入「${result?.card?.title ?? file.name}」`
              : `已导入「${result?.card?.title ?? file.name}」，${failed.length} 个附件未能还原`,
            failed.length === 0 ? 'ok' : 'error',
          );
          await refresh({ withActivation: true });
        } catch (failure) {
          toast(`导入失败：${String(failure?.message ?? failure)}`, 'error');
        }
      };

      const requestDelete = (card) => {
        const isStandard = card.sourceType === STANDARD_SOURCE;
        setConfirmState({
          title: isStandard ? '删除公司标准场景' : '删除场景',
          message: isStandard
            ? `将调用 DELETE /api/dsh/scenarios/${card.scenarioId} 软删除公司标准场景「${card.title}」，所有同事的已安装副本都会在下次同步时自动卸载。此操作需要标准场景管理权限，且不可撤销。`
            : `将删除「${card.title}」。已激活该场景的会话会立即失去技能栈注入，此操作不可撤销。`,
          confirmText: t('删除'),
          danger: true,
          onConfirm: async () => {
            setConfirmState(null);
            await mutate(
              'scenario.delete',
              { scenarioId: card.scenarioId },
              `已删除「${card.title}」`,
            );
            if (isStandard) await loadCompany(false);
          },
        });
      };

      const requestDeleteCompany = (card) => {
        setConfirmState({
          title: '删除公司标准场景',
          message: `将调用 DELETE /api/dsh/scenarios/${card.scenarioId} 软删除「${card.title}」。已安装该场景的同事会在下次同步时自动卸载。此操作不可撤销。`,
          confirmText: t('删除标准场景'),
          danger: true,
          onConfirm: async () => {
            setConfirmState(null);
            try {
              await callHost('scenario.delete', { scenarioId: card.scenarioId });
              toast(`已删除公司标准场景「${card.title}」`);
              await refresh({ withActivation: true });
              await loadCompany(false);
            } catch (failure) {
              toast(String(failure?.message ?? failure), 'error');
            }
          },
        });
      };

      const header = h(
        'div',
        { className: 'crmw-head' },
        h('div', { className: 'crmw-card-icon', style: { width: '30px', height: '30px' } }, h(Icon, { name: 'sparkles', size: 17 })),
        h(
          'div',
          { className: 'crmw-title' },
          h('h2', null, t('场景工作台')),
          h(
            'span',
            null,
            `已安装 ${installedList.length} 张${canManageStandard ? ' · 标准场景管理员' : ''}`,
          ),
        ),
        h(
          'div',
          { className: 'crmw-tabs', role: 'tablist' },
          h(
            'button',
            {
              type: 'button',
              role: 'tab',
              'aria-selected': tab === 'installed',
              className: `crmw-tab ${tab === 'installed' ? 'on' : ''}`,
              onClick: () => setTab('installed'),
            },
            `🖥 ${t('已安装的场景（我的）')}`,
            h('span', { className: 'n' }, String(installedList.length)),
          ),
          h(
            'button',
            {
              type: 'button',
              role: 'tab',
              'aria-selected': tab === 'company',
              className: `crmw-tab ${tab === 'company' ? 'on' : ''}`,
              onClick: () => setTab('company'),
            },
            `🌐 ${t('标准场景')}`,
            company.scenarios === null && companyRows.length === 0
              ? null
              : h('span', { className: 'n' }, String(company.scenarios === null ? companyRows.length : company.scenarios.length)),
          ),
        ),
        h('span', { className: 'crmw-grow' }),
        h(Switch, { checked: admin, onChange: toggleAdmin, label: t('管理模式') }),
        h(IconButton, { name: 'refresh', label: t('刷新'), onClick: () => refresh({ withActivation: true }) }),
        props.closePanel === undefined
          ? null
          : h(IconButton, { name: 'x', label: t('关闭面板'), onClick: () => props.closePanel?.() }),
      );

      const banner = [];
      if (error !== '') banner.push(h('div', { key: 'err', className: 'crmw-banner error' }, error));
      if (data?.plugin?.degraded !== undefined && data.plugin.degraded !== null) {
        banner.push(h('div', { key: 'deg', className: 'crmw-banner warn' }, String(data.plugin.degraded)));
      }
      if (Array.isArray(data?.plugin?.warnings)) {
        for (const [index, warning] of data.plugin.warnings.entries()) {
          banner.push(h('div', { key: `w-${index}`, className: 'crmw-banner warn' }, String(warning)));
        }
      }

      const toolbar = h(
        'div',
        { className: 'crmw-toolbar' },
        h('input', {
          className: 'crmw-input',
          style: { maxWidth: '260px' },
          value: query,
          placeholder: t('搜索场景'),
          onChange: (event) => setQuery(event.target.value),
        }),
        h(
          'button',
          { type: 'button', className: `crmw-chip ${system === '' ? 'on' : ''}`, onClick: () => setSystem('') },
          t('全部'),
        ),
        systems.map((value) =>
          h(
            'button',
            {
              key: value,
              type: 'button',
              className: `crmw-chip ${system === value ? 'on' : ''}`,
              onClick: () => setSystem(system === value ? '' : value),
            },
            value,
          ),
        ),
        h('span', { className: 'crmw-grow' }),
        h(Switch, { checked: showDisabled, onChange: setShowDisabled, label: t('显示已停用') }),
        h('input', {
          ref: importRef,
          type: 'file',
          accept: '.json,application/json',
          style: { display: 'none' },
          onChange: (event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file !== undefined) void importPackage(file);
          },
        }),
        h(
          Button,
          { size: 'sm', onClick: () => importRef.current?.click(), title: '导入 .crm-scenario.json 场景包' },
          `📥 ${t('导入场景包')}`,
        ),
        // 新建场景人人可用：保存后是「我的本地场景」；发布成标准场景才需要管理员权限。
        h(
          Button,
          { variant: 'primary', onClick: () => void openEditor({ initial: null, previousId: undefined }) },
          h(Icon, { name: 'plus', size: 13 }),
          t('新建场景'),
        ),
      );

      const activeStrip =
        activeCards.length === 0
          ? null
          : h(
              'div',
              { className: 'crmw-active' },
              h('div', { className: 'crmw-card-icon' }, h(Icon, { name: activeCards[0].icon, size: 17 })),
              h(
                'div',
                { className: 'crmw-active-text crmw-grow' },
                h(
                  'strong',
                  null,
                  activeCards.length <= 1
                    ? `🟢 ${t('当前场景')}：【${activeCards[0].title}】 (v${activeCards[0].version ?? '1.0.0'})`
                    : `🟢 ${t('当前对话叠加了')} ${activeCards.length} ${t('个场景')}`,
                ),
                h(
                  'span',
                  null,
                  activeCards.length <= 1
                    ? activeCards[0].description || t('未填写场景介绍')
                    : activeCards.map((item) => `【${item.title}】`).join(' + '),
                ),
                h(
                  'span',
                  { className: 'crmw-dim' },
                  `技能栈：${activeCards
                    .flatMap((item) => (Array.isArray(item.pinnedSkills) ? item.pinnedSkills : []))
                    .filter((name, index, list) => list.indexOf(name) === index)
                    .join(' → ') || '未绑定'}`,
                ),
                // 每个场景一个可单独移除的 chip：这是「引入之后没法移除」的修法。
                h(
                  'span',
                  { className: 'crmw-stack' },
                  activeCards.map((item) =>
                    h(
                      'span',
                      { key: item.scenarioId, className: 'crmw-stack-item', title: item.title },
                      `${item.title}`,
                      h(
                        'button',
                        {
                          type: 'button',
                          title: `移除「${item.title}」`,
                          'aria-label': `移除「${item.title}」`,
                          disabled: busyId === item.scenarioId,
                          onClick: () => void removeScenarioById(item.scenarioId),
                        },
                        '×',
                      ),
                    ),
                  ),
                ),
              ),
              h(Button, { size: 'sm', onClick: () => switchToConversation(ctx, resumableSessionId(ctx)) }, t('进入对话')),
              h(Button, { size: 'sm', variant: 'ghost', onClick: clearActivation }, t('退出全部场景')),
            );

      // 有卡片但被筛掉了：这不是「还没有场景」，说成那个会让用户以为配置丢了、甚至重复新建。
      const filteredOut = loading !== true && scenarios.length === 0 && installedList.length > 0;
      const grid =
        scenarios.length === 0
          ? filteredOut
            ? h(
                'div',
                { className: 'crmw-empty' },
                h(Icon, { name: 'search', size: 26 }),
                h('h3', null, '没有匹配的场景'),
                h(
                  'p',
                  null,
                  `当前筛选：${query.trim() === '' ? '关键词不限' : `关键词「${query.trim()}」`} · ${
                    system === '' ? '业务系统不限' : `业务系统「${system}」`
                  }。换一个关键词或点「清除筛选」看全部 ${installedList.length} 张。`,
                ),
                h(
                  Button,
                  {
                    onClick: () => {
                      setQuery('');
                      setSystem('');
                    },
                  },
                  t('清除筛选'),
                ),
              )
            : h(
                'div',
                { className: 'crmw-empty' },
                h(Icon, { name: 'sparkles', size: 26 }),
                h('h3', null, loading ? '正在读取场景配置…' : '还没有可用的场景'),
                h(
                  'p',
                  null,
                  loading
                    ? '正在从 Host 读取场景配置。'
                    : `场景由你自己创建：点击「新建场景」填写标题、输入框预填内容、快捷指令，并按顺序绑定 Skill；保存后卡片会立即出现在这里。${canManageStandard ? '标准场景管理员还可以在编辑时勾选「设为插件标准场景」发布给全公司。' : ''}`,
                ),
                loading !== true
                  ? h(
                      Button,
                      { variant: 'primary', onClick: () => void openEditor({ initial: null, previousId: undefined }) },
                      t('新建场景'),
                    )
                  : null,
              )
          : h(
              'div',
              { className: 'crmw-grid' },
              scenarios.map((card) =>
                h(ScenarioCard, {
                  key: card.scenarioId,
                  card,
                  canManageStandard,
                  busy: busyId === card.scenarioId,
                  onEnter: () => enterScenario(card),
                  onStack: () => enterScenario(card, { stack: true }),
                  onEdit: () =>
                    void openEditor({
                      initial: card,
                      previousId: card.scenarioId,
                      standard: card.sourceType === STANDARD_SOURCE,
                    }),
                  onPreview: () => setPreview(card.scenarioId),
                  onExport: () => exportPackage(card.scenarioId, 'local'),
                  onFork: () => void forkScenario(card),
                  onDuplicate: () => mutate('scenario.duplicate', { scenarioId: card.scenarioId }, `已复制「${card.title}」`),
                  onMove: (direction) => mutate('scenario.move', { scenarioId: card.scenarioId, direction }, '顺序已更新'),
                  onToggle: () =>
                    mutate(
                      'scenario.enable',
                      { scenarioId: card.scenarioId, enabled: card.enabled !== true },
                      card.enabled === true ? `已停用「${card.title}」` : `已启用「${card.title}」`,
                    ),
                  onDelete: () => requestDelete(card),
                  missingSkills: skillPool.length > 0 ? card.pinnedSkills.filter((name) => !skillPool.some((skill) => skill.name === name)) : [],
                }),
              ),
            );

      const installedOrigins = new Set(
        installedList
          .filter((card) => card.sourceType === STANDARD_SOURCE)
          .map((card) => card.scenarioId)
          .filter((value) => typeof value === 'string' && value !== ''),
      );

      // 认证状态只暴露结论：不显示服务地址，也不显示 Salesforce 用户名。
      const resolvedIdentitySource =
        identitySource || (typeof data?.config?.identitySource === 'string' ? data.config.identitySource : '');
      const authLabel = auth.authenticated === true ? '已认证' : '未认证';

      const companyToolbar = h(
        'div',
        { className: 'crmw-toolbar' },
        h(
          'div',
          { className: 'crmw-active-text crmw-grow' },
          h('strong', null, '标准场景'),
          h(
            'span',
            { title: resolvedIdentitySource === '' ? '' : `身份来源：${resolvedIdentitySource}` },
            `${authLabel} · ${canManageStandard ? '管理员可发布/编辑标准场景' : '标准场景只读'}`,
          ),
        ),
        h(
          Button,
          { size: 'sm', disabled: company.loading === true, onClick: () => loadCompany(true) },
          h(Icon, { name: 'refresh', size: 13 }),
          t('同步'),
        ),
      );

      /**
       * 标准场景的筛选行：业务系统标签 + 关键词搜索，与「我的场景」一致的用法。
       *
       * 库大了以后（几十上百张）没有筛选就只能靠肉眼翻；这里把两个页签做成同一套
       * 交互，切页签不用重新学一遍。
       */
      const companyFilterRow =
        companySource.length === 0
          ? null // 库里一张卡都没有时，筛选行只会是一个「点不出结果」的空壳。
          : h(
              'div',
              { className: 'crmw-toolbar' },
              h('input', {
                className: 'crmw-input',
                style: { maxWidth: '260px' },
                value: companyQuery,
                placeholder: t('搜索标准场景'),
                'aria-label': t('搜索标准场景'),
                onChange: (event) => setCompanyQuery(event.target.value),
              }),
              h(
                'button',
                {
                  type: 'button',
                  className: `crmw-chip ${companySystem === '' ? 'on' : ''}`,
                  'aria-pressed': companySystem === '',
                  onClick: () => setCompanySystem(''),
                },
                t('全部'),
              ),
              companySystems.map((value) =>
                h(
                  'button',
                  {
                    key: value,
                    type: 'button',
                    className: `crmw-chip ${companySystem === value ? 'on' : ''}`,
                    'aria-pressed': companySystem === value,
                    onClick: () => setCompanySystem(companySystem === value ? '' : value),
                  },
                  value,
                ),
              ),
              (companyQuery !== '' || companySystem !== '') && companySource.length > 0
                ? h(
                    'span',
                    { className: 'crmw-dim' },
                    `筛出 ${companyVisible.length} / ${companySource.length}`,
                  )
                : null,
              h('span', { className: 'crmw-grow' }),
              companyQuery === '' && companySystem === ''
                ? null
                : h(
                    Button,
                    {
                      size: 'sm',
                      onClick: () => {
                        setCompanyQuery('');
                        setCompanySystem('');
                      },
                    },
                    t('清除筛选'),
                  ),
            );

      const companyGrid =
        company.loading === true && companySource.length === 0
          ? h('div', { className: 'crmw-toolbar' }, h('span', { className: 'crmw-spin' }), h('span', { className: 'crmw-dim' }, '正在同步标准场景…'))
          : companySource.length === 0
            ? h(
                'div',
                { className: 'crmw-empty' },
                h(Icon, { name: 'building', size: 26 }),
                h('h3', null, '标准场景库暂时没有内容'),
                h(
                  'p',
                  null,
                  auth.authenticated !== true
                    ? '当前请求未通过认证：插件会自动使用 DSH 登录身份；若仍未通过，请让管理员检查该机器的凭据配置。'
                    : '标准场景管理员在「新建/编辑场景」抽屉里勾选「设为插件标准场景」并保存后，这里就会出现可安装的标准场景。',
                ),
              )
            : companyVisible.length === 0
              ? h(
                  'div',
                  { className: 'crmw-empty' },
                  h(Icon, { name: 'search', size: 26 }),
                  h('h3', null, '没有匹配的标准场景'),
                  h(
                    'p',
                    null,
                    `当前筛选：${companyQuery === '' ? '关键词不限' : `关键词「${companyQuery}」`} · ${
                      companySystem === '' ? '业务系统不限' : `业务系统「${companySystem}」`
                    }。换一个关键词或点「清除筛选」看全部 ${companySource.length} 张。`,
                  ),
                )
              : h(
                  'div',
                  { className: 'crmw-grid' },
                  companyVisible.map((card) =>
                    h(CompanyScenarioCard, {
                      key: card.scenarioId,
                      card,
                      installed: installedOrigins.has(card.scenarioId),
                      busy: companyBusy === card.scenarioId,
                      canManage: canManageStandard,
                      onInstall: () => installCompanyScenario(card),
                      onDownload: () => exportPackage(card.scenarioId, 'company'),
                      onEdit: () => void openEditor({ initial: card, previousId: card.scenarioId, standard: true }),
                      onDelete: () => requestDeleteCompany(card),
                      onEnter: installedOrigins.has(card.scenarioId)
                        ? () => enterScenario(installedList.find((item) => item.scenarioId === card.scenarioId) ?? card)
                        : undefined,
                    }),
                  ),
                );

      return h(
        'div',
        { className: 'crmw-root' },
        header,
        h(
          'div',
          { className: 'crmw-body' },
          ...banner,
          tab === 'company'
            ? [
                companyToolbar,
                companyFilterRow,
                company.error !== '' ? h('div', { className: 'crmw-banner error' }, company.error) : null,
                companyGrid,
              ]
            : [activeStrip, toolbar, grid],
        ),
        editor === null
          ? null
          : h(EditorDialog, {
              initial: editor.initial,
              previousId: editor.previousId,
              editingStandard: editor.standard === true,
              canManageStandard,
              taxonomy: data?.taxonomy,
              limits: data?.limits,
              skillPool,
              currentUser: data?.plugin?.currentUser ?? '',
              onClose: () => setEditor(null),
              onSaved: async () => {
                await refresh({ withActivation: true });
                await loadCompany(false);
              },
              onToast: toast,
            }),
        preview === null ? null : h(PreviewDialog, { scenarioId: preview, onClose: () => setPreview(null), onToast: toast }),
        skillGate === null
          ? null
          : h(SkillGateDialog, {
              gate: skillGate,
              onOpenLibrary: () => {
                const pending = skillGate;
                setSkillGate(null);
                if (openLibraryPanel(ctx) !== true) {
                  toast('打不开智能体中心：请在侧边栏手动打开「智能体中心」安装技能', 'error');
                } else {
                  toast(`去「智能体中心」搜索并安装：${pending.missing.map((name) => `/${name}`).join('、')}`, 'info');
                }
              },
              onEnterAnyway: () => {
                const pending = skillGate;
                setSkillGate(null);
                if (pending !== null && pending !== undefined) {
                  void enterScenario(pending.card, { stack: pending.stack, skipSkillGate: true });
                }
              },
              onCancel: () => setSkillGate(null),
            }),
        diag === null
          ? null
          : h(
              Dialog,
              {
                title: t('插件诊断'),
                width: 'wide',
                onClose: () => setDiag(null),
                footer: h(Button, { size: 'sm', onClick: () => void openDiagnostics() }, diag.loading === true ? '读取中…' : t('重新读取')),
              },
              diag.error !== ''
                ? h('p', { className: 'crmw-banner error' }, `读取失败：${diag.error}`)
                : diag.loading === true
                  ? h('div', { className: 'crmw-toolbar' }, h('span', { className: 'crmw-spin' }), h('span', { className: 'crmw-dim' }, '读取中…'))
                  : h('pre', { className: 'crmw-pre' }, JSON.stringify(diag.report, null, 2)),
              diag.faults.length === 0
                ? null
                : h(
                    'div',
                    { className: 'crmw-fault' },
                    `⚠️ 最近有 ${diag.faults.length} 次 slot 渲染失败：${diag.faults
                      .map((item) => `${item.entry}（${item.message}）`)
                      .join('；')}`,
                  ),
            ),
        updateNotice === null
          ? null
          : h(
              Dialog,
              {
                title: `发现新版本 v${updateNotice.latest}`,
                width: 'narrow',
                onClose: () => dismissUpdate(false),
                footer: [
                  h('span', { key: 'g', className: 'crmw-grow' }),
                  h(Button, { key: 'later', size: 'sm', disabled: updateBusy, onClick: () => dismissUpdate(false) }, t('稍后')),
                  h(
                    Button,
                    { key: 'skip', size: 'sm', disabled: updateBusy, onClick: () => dismissUpdate(true) },
                    t('跳过此版本'),
                  ),
                  h(
                    Button,
                    {
                      key: 'go',
                      size: 'sm',
                      variant: 'primary',
                      disabled: updateBusy,
                      onClick: () => void applyUpdate(),
                    },
                    updateBusy ? t('升级中…') : t('立即升级'),
                  ),
                ],
              },
              h(
                'div',
                { className: 'crmw-update' },
                h('p', null, `当前 v${updateNotice.current} → 最新 v${updateNotice.latest}`),
                updateNotice.notes === '' || updateNotice.notes === undefined
                  ? null
                  : h('p', { className: 'crmw-dim' }, updateNotice.notes),
                updateNotice.deprecated === '' || updateNotice.deprecated === undefined
                  ? null
                  : h('p', { className: 'crmw-banner error' }, `该版本已被标记为弃用：${updateNotice.deprecated}`),
                updateBusy
                  ? h('p', { className: 'crmw-dim' }, t('正在安装，请不要关闭 DSH…'))
                  : h('p', { className: 'crmw-dim' }, t('升级完成后需要重启 DSH 才会生效。')),
              ),
            ),
        confirmState === null
          ? null
          : h(
              Dialog,
              {
                title: confirmState.title,
                width: 'narrow',
                onClose: () => setConfirmState(null),
                footer: [
                  h('span', { key: 'g', className: 'crmw-grow' }),
                  h(Button, { key: 'c', onClick: () => setConfirmState(null) }, t('取消')),
                  h(
                    Button,
                    {
                      key: 'k',
                      variant: confirmState.danger === true ? 'danger' : 'primary',
                      onClick: () => confirmState.onConfirm?.(),
                    },
                    confirmState.confirmText ?? '确认',
                  ),
                ],
              },
              h('div', { className: 'crmw-banner' }, confirmState.message),
            ),
        h(
          'div',
          { className: 'crmw-foot' },
          `场景工作台 · 客户端 v${CLIENT_VERSION} · 宿主 v${String(data?.plugin?.version ?? '未知')}`,
          h('span', { className: 'crmw-grow' }),
          h('button', { type: 'button', className: 'crmw-chip', onClick: () => void openDiagnostics() }, t('诊断')),
        ),
        h(Toasts, { items: toasts }),
      );
    }

    /* ── 侧边栏入口 ─────────────────────────────────────────────── */

    function SidebarIcon(props) {
      const size = typeof props?.size === 'number' ? props.size : 18;
      return h(Icon, { name: 'sparkles', size });
    }

    /* ── slot 崩溃边界 + 诊断快照 ───────────────────────────────── */

    /**
     * 最近几次 slot 渲染失败：面板的「诊断」页会带上它。
     * 用途很具体 —— 1.5.4 之前这个 hook 少传 selector，宿主把整条
     * `conversation.input.dock` 条目摘掉，用户看到的现象是「场景栏和退出按钮突然没了」，
     * 却没有任何可见线索。现在失败会降级显示，并留在这里可查。
     */
    const slotFaults = [];

    function rememberSlotFault(entry, error) {
      const fault = {
        entry,
        message: String(error?.message ?? error ?? ''),
        at: new Date().toISOString(),
      };
      const known = slotFaults.findIndex((item) => item.entry === entry);
      if (known >= 0) slotFaults[known] = fault;
      else slotFaults.push(fault);
      while (slotFaults.length > 10) slotFaults.shift();
      console.warn(`[crm-workspace] ${entry} 渲染失败，已降级显示`, fault);
    }

    function listedSlotFaults() {
      return slotFaults.map((item) => ({ ...item }));
    }

    /**
     * slot 条目的最小错误边界：一个组件抛错时，宿主会把整条 dock 条目摘掉，
     * 页面上就是「场景栏突然消失、连退出按钮都没有」。这里兜住错误、降级成一行
     * 可见提示，用户至少知道发生了什么、还能去面板里退出场景。
     */
    class SlotBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }

      static getDerivedStateFromError(error) {
        return { error };
      }

      componentDidCatch(error) {
        rememberSlotFault(String(this.props?.entry ?? 'slot'), error);
      }

      render() {
        if (this.state.error !== null) {
          return h(
            'div',
            { className: 'crmw-fault', role: 'alert' },
            `⚠️ ${this.props?.label ?? t('场景栏')}渲染失败：${String(this.state.error?.message ?? this.state.error)}`,
            h(
              'button',
              { type: 'button', className: 'crmw-chip', onClick: () => this.setState({ error: null }) },
              t('重试'),
            ),
          );
        }
        return this.props?.children ?? null;
      }
    }

    /** 把一个 slot 组件包进边界（注册时用，避免每个组件自己套一层）。 */
    function bounded(Component, entry, label) {
      return function BoundedSlot(props) {
        return h(SlotBoundary, { entry, label }, h(Component, props));
      };
    }

    /**
     * 会话标题旁的场景标签：让「当前在哪个场景」在对话里直接可见。
     *
     * 这里刻意不伪造聊天消息 —— 消息会进入会话历史、占用上下文，还会让模型把
     * 标记当成用户输入再回答一遍。标签只是投影：点击打开工作台面板。
     */
    function ScenarioBadge(props) {
      const ctx = props?.ctx;
      const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : '';
      const [scene, setScene] = React.useState(null);

      React.useEffect(() => {
        if (sessionId === '') return undefined;
        rememberSession(sessionId);
        let alive = true;
        const load = () => {
          void callHost('activation.state', { sessionId, cwd: sessionCwd(ctx, sessionId) ?? '' })
            .then((state) => {
              if (!alive) return;
              const card = state?.scenario;
              setScene(
                card !== undefined && card !== null && typeof card.title === 'string' && card.title !== ''
                  ? { title: card.title, icon: card.icon, version: card.version ?? '1.0.0' }
                  : null,
              );
            })
            .catch(() => {
              /* Host 暂不可用时保持上次显示 */
            });
        };
        load();
        const tick = () => {
          if (document.visibilityState !== 'hidden') load();
        };
        const timer = window.setInterval(tick, 8000);
        window.addEventListener('focus', tick);
        document.addEventListener('visibilitychange', tick);
        const onActivation = (event) => {
          const detail = event?.detail;
          if (detail?.sessionId !== undefined && detail.sessionId !== sessionId) return;
          load();
        };
        window.addEventListener('crm-workspace:activation', onActivation);
        return () => {
          alive = false;
          window.clearInterval(timer);
          window.removeEventListener('focus', tick);
          document.removeEventListener('visibilitychange', tick);
          window.removeEventListener('crm-workspace:activation', onActivation);
        };
      }, [sessionId]);

      if (scene === null) return null;
      return h(
        'button',
        {
          type: 'button',
          className: 'crmw-scenechip',
          title: `${t('当前场景')}：${scene.title} (v${scene.version})`,
          onClick: () => {
            try {
              getService(ctx, 'layout')?.selectPanel?.(PANEL_KEY);
            } catch {
              /* 面板服务不可用时忽略 */
            }
          },
        },
        h(Icon, { name: scene.icon, size: 13 }),
        h('span', null, `${t('场景')} · ${scene.title} (v${scene.version})`),
      );
    }

    /**
     * 输入框上方的「正在使用场景」状态栏。
     *
     * 三件事都发生在这里（都建立在 Host 的激活记录上，刷新页面后依然成立）：
     *   1. 持久展示场景徽标 / 技能栈 / 切换与退出按钮；
     *   2. 首次进入时把 inputDraft（1.13.0 起必填；老数据缺省时回退场景介绍）写进输入框草稿；
     *   3. 把场景预设附件挂到官方附件托盘，随首条消息一起发出。
     * 只改草稿与附件，不伪造聊天消息 —— 消息会污染会话历史。
     */
    function ComposerScenarioBanner(props) {
      const ctx = props?.ctx;
      // 这个 slot 的 owner props 是 { session, input }，没有 sessionId 字段：
      // 只读 props.sessionId 会永远是空串，徽标、预填与附件带入都会静默失效。
      const sessionId =
        (typeof props?.sessionId === 'string' && props.sessionId !== '' ? props.sessionId : '') ||
        (typeof props?.session?.sessionId === 'string' ? props.session.sessionId : '');
      const inputActions = props?.inputActions;
      const useInput = props?.useInput;
      const [state, setState] = useState(null);
      const [busy, setBusy] = useState(false);
      /**
       * 预填的可见状态：`{ mode: 'stuck' | 'skipped' | 'blocked', draft }`。
       *
       * 预填是这个插件的核心卖点，原来失败只写 `console.warn`，用户看到的是
       * 「场景已激活 + 空输入框」，既不知道预填没了、也没法重试。这里把它变成
       * 场景栏里一行可点的提示。
       */
      const [prefillNote, setPrefillNote] = useState(null);
      const seeded = useRef('');
      // 真正写进输入框的那份预填文本：退出场景时用它判断「这一行是我们塞进去的」。
      const seededDraft = useRef('');
      // 草稿快照在渲染期读取：hook 不能在 effect 里调用，否则会破坏 hook 顺序。
      //
      // 宿主的 `useInput` 是「带 selector 的 useSelector」（源码里写作 `useInput((s) => s)`）。
      // 不传 selector 会一路传到 memoizedSelector，抛出 `TypeError: selector is not a function`，
      // 把这个 slot 条目整个打崩（页面报 `slot entry crashed in 'conversation.input.dock'`）：
      // 徽标、退出按钮、预填与附件带入会一起消失，用户就再也找不到「退出场景」。
      const inputSnapshot =
        typeof useInput === 'function' ? useInput((snapshot) => snapshot) : (props?.input ?? null);
      const draftNow = typeof inputSnapshot?.draft === 'string' ? inputSnapshot.draft : '';
      // effect 里要读「最新的草稿」，用 ref 承接避免闭包拿到旧值。
      const draftRef = useRef(draftNow);
      draftRef.current = draftNow;
      // 托盘里已有的附件数：面板侧可能已经把预设附件带进来了，避免重复挂一遍。
      // 上一轮看到的激活场景数：用来发现「别处把场景退掉了」。
      const activeCount = useRef(0);
      const attachmentCountRef = useRef(0);
      attachmentCountRef.current = Array.isArray(inputSnapshot?.attachmentIds)
        ? inputSnapshot.attachmentIds.length
        : 0;

      useEffect(() => {
        if (sessionId === '') return undefined;
        rememberSession(sessionId);
        let alive = true;
        const load = () => {
          void callHost('activation.state', { sessionId, cwd: sessionCwd(ctx, sessionId) ?? '' })
            .then((result) => {
              if (!alive) return;
              const primary = result?.scenario;
              // 会话可以同时叠加多个场景：宿主返回 scenarios 栈（旧宿主只有 scenario）。
              const fromStack = Array.isArray(result?.scenarios) ? result.scenarios : [];
              const cards = fromStack.filter(
                (item) => item !== null && item !== undefined && typeof item?.title === 'string' && item.title !== '',
              );
              if (cards.length === 0 && primary !== undefined && primary !== null && typeof primary.title === 'string' && primary.title !== '') {
                cards.push(primary);
              }
              // 别处（面板 / 另一个页签）退出了场景：这里也把托盘里的预设附件收拾掉，
              // 否则状态栏消失、附件却还挂在输入框里，下次进场景看起来就是「重复预设」。
              if (cards.length === 0 && activeCount.current > 0) {
                clearSeededDraft();
                void dropSeededAttachments(ctx, sessionId);
              } else if (cards.length > 0) {
                // 场景栈换了（/指令 切场景、叠加、单独移除）：上一套挂的附件不再是这次场景的，
                // 只清理它、保留当前这套（`exceptSeedKey`），避免把刚挂好的又摘掉。
                void dropSeededAttachments(ctx, sessionId, { exceptSeedKey: scenarioSeedKey(cards) });
              }
              activeCount.current = cards.length;
              setState(cards.length === 0 ? null : { card: cards[0], cards, draft: result.draft ?? null });
            })
            .catch(() => {
              /* Host 不可用时保持上一次状态 */
            });
        };
        load();
        const tick = () => {
          if (document.visibilityState !== 'hidden') load();
        };
        const timer = window.setInterval(tick, 6000);
        window.addEventListener('focus', tick);
        document.addEventListener('visibilitychange', tick);
        // 面板点完卡片会立刻广播：这里直接重读，不必等下一次轮询。
        const onActivation = (event) => {
          const detail = event?.detail;
          if (detail?.sessionId !== undefined && detail.sessionId !== sessionId) return;
          load();
        };
        window.addEventListener('crm-workspace:activation', onActivation);
        return () => {
          alive = false;
          window.clearInterval(timer);
          window.removeEventListener('focus', tick);
          document.removeEventListener('visibilitychange', tick);
          window.removeEventListener('crm-workspace:activation', onActivation);
        };
      }, [sessionId]);

      const seed = state === null ? null : state.draft;
      const cards = state === null ? [] : state.cards;
      // 预填的去重键要覆盖整个场景栈：叠加/移除场景都要重新决定「要不要预填」。
      // 附件挂载用的也是它（`scenarioSeedKey`），面板与场景栏因此能认出「这批已经挂过」。
      const stackKey = scenarioSeedKey(cards);
      const seedKey = state === null ? '' : `${sessionId}:${stackKey}`;

      /**
       * 把文本写进当前会话的输入框。
       *
       * 两条路径：slot 标准 props 的 `inputActions`（正常路径），以及
       * `conversation.input.for(sessionScope)`（props 缺失或指向别的会话时兜底）。
       * 返回 true 表示至少有一条路径成功调用；false 时由调用方重试。
       */
      const writeDraft = (text) => {
        let applied = false;
        // 纯字符串：宿主 setDraft(string) 走 TextNode 路径，与手打同源。
        const payload = draftPayloadFor(text);
        if (typeof inputActions?.setDraft === 'function') {
          try {
            inputActions.setDraft(payload);
            applied = true;
          } catch {
            applied = false;
          }
        }
        if (applied !== true) {
          try {
            const actx = ctx.sessions?.scope?.(sessionId);
            const facade = actx === undefined ? undefined : getService(ctx, 'conversation')?.input?.for?.(actx);
            if (typeof facade?.setDraft === 'function') {
              facade.setDraft(payload);
              applied = true;
            }
          } catch {
            /* 会话作用域还没就绪：交给下一轮重试 */
          }
        }
        return applied;
      };

      useEffect(() => {
        if (state === null || seed === null || sessionId === '') return undefined;
        if (seeded.current === seedKey) return undefined;
        const pendingDraft = seededDraftTextFor(seed);
        // 预填与预设附件只属于「新对话」：老会话里用 /指令 切场景时不往输入框塞东西。
        if (props?.session?.blank !== true) {
          seeded.current = seedKey;
          // 但不写 ≠ 不用说：以前这里静默 return，用户以为插件坏了，其实是「已有对话不预填」。
          setPrefillNote(pendingDraft === '' ? null : { mode: 'skipped', draft: pendingDraft });
          return undefined;
        }
        setPrefillNote(null);
        // 预填只写「填写模板」（inputDraft）：场景介绍是 UI 投影，不往输入框里塞；
        // 首行也不再拼 `/场景标题` —— 那个假指令回车后会被宿主当成真实指令渲染成 chip。
        const draftText = pendingDraft;
        const list = Array.isArray(seed.attachments) ? seed.attachments : [];
        // 字节只取一次：重试时复用，避免每轮都把附件重新下载一遍。
        const filesPromise = list.length === 0 ? Promise.resolve([]) : fetchPresetFiles(list);
        let cancelled = false;
        let tries = 0;
        let draftBlocked = false;
        // 「只写一次」：预填落地（或输入框里本来就有用户内容）之后，即使输入框又变空也不再写。
        // 旧实现每 800ms 只看「输入框是不是空的」，用户全选删除后会在下一轮被原样写回，
        // 表现就是「按删除键删不掉」。
        let draftSettled = draftText === '';
        seededDraft.current = draftText;
        const attachCache = { ids: [] };

        const attempt = async () => {
          // 1) 预填草稿：仅当输入框为空、且自己还没写过时写一次。
          if (draftSettled !== true) {
            const verdict = seedConflict(draftRef.current, draftText, seededTemplates);
            if (verdict === 'keep') {
              // 用户已经打了字（或内容就是这一份）：尊重它，绝不覆盖。
              draftSettled = true;
            } else if (writeDraft(draftText) !== true) {
              draftBlocked = true;
              return false; /* 输入框还没就绪：下一轮再试 */
            } else {
              // 写成功（也可能是把上一个会话带过来的我们自己的模板换成了这次的）。
              draftBlocked = false;
              draftSettled = true;
              rememberSeededTemplate(draftText);
              setPrefillNote(null);
            }
          }
          // 2) 预设附件进托盘（幂等：面板那边已经挂过就不会再挂一次）。
          if (list.length === 0) return true;
          const files = await filesPromise;
          if (files.length === 0) return true;
          return attachPresetFilesToTray(ctx, sessionId, { files, cache: attachCache, seedKey: stackKey });
        };

        void (async () => {
          for (;;) {
            if (cancelled) return;
            tries += 1;
            // eslint-disable-next-line no-await-in-loop
            const done = await attempt();
            if (cancelled) return;
            if (done || tries >= 20) {
              seeded.current = seedKey;
              if (draftBlocked === true) {
                // 输入框一直没就绪（会话未绑定 / 编辑器被冻结），预填没能落地：
                // 除了留一条排查日志，还要让用户在场景栏里看见并能重试。
                console.warn('[crm-workspace] 输入框预填未生效', { sessionId, draftText });
                setPrefillNote({ mode: 'stuck', draft: draftText });
              }
              return;
            }
            // eslint-disable-next-line no-await-in-loop
            await new Promise((resolve) => setTimeout(resolve, 800));
          }
        })();

        return () => {
          cancelled = true;
        };
      }, [seed, seedKey, state, sessionId, inputActions, ctx]);

      /**
       * 退出场景 / 移除某个场景时收拾输入框。
       *
       * 预填现在只有用户自己的模板正文（不再有 `/场景标题` 那行假指令），所以只需要
       * 「内容还完全等于我们写进去的那份」时清空；用户改过任何一个字都不动。
       */
      const clearSeededDraft = () => {
        const current = String(draftRef.current ?? '');
        const seededText = seededDraft.current;
        seededDraft.current = '';
        if (shouldClearSeededDraft(current, seededText) === true) writeDraft('');
      };

      /**
       * 手动补写预填（场景栏那行提示的点击动作）。
       *
       * 两种来路：预填没落地（`stuck`）、已有对话所以没自动预填（`skipped`）。
       * 冲突判定复用 `seedConflict`：插件自己写过的旧模板（`seededTemplates` 命中）算
       * 「可以替换」，只有真正的用户输入才拦。绝不覆盖用户已经打进去的字。
       */
      const applyPrefill = (note) => {
        if (note === null || note === undefined) return;
        const draftText = String(note.draft ?? '');
        if (draftText === '') return;
        const current = String(draftRef.current ?? '');
        const verdict = seedConflict(current, draftText, seededTemplates);
        if (verdict === 'skip') return;
        if (verdict === 'keep') {
          // `keep` 有两种：输入框里已经就是这份模板（没必要重写，重写会把光标弹到末尾），
          // 或者里面是用户自己打的字（绝不能覆盖）。按内容再分一次。
          const now = current.trim();
          const next = draftText.trim();
          if (now === '' || now === next || stripSkillTokens(now) === stripSkillTokens(next)) {
            setPrefillNote(null);
            return;
          }
          setPrefillNote({ ...note, mode: 'blocked' });
          return;
        }
        if (writeDraft(draftText) !== true) {
          setPrefillNote({ ...note, mode: 'stuck' });
          return;
        }
        rememberSeededTemplate(draftText);
        seededDraft.current = draftText;
        seeded.current = seedKey;
        setPrefillNote(null);
      };

      /** 从当前会话的场景栈里移除一个场景（不动其余场景）。 */
      const removeOne = async (scenarioId) => {
        if (sessionId === '' || scenarioId === '') return;
        setBusy(true);
        try {
          const result = await callHost('activation.deactivate', { sessionId, scenarioId });
          if (result?.ok !== true) throw new Error('activation.deactivate failed');
          const left = Array.isArray(result?.scenarios) ? result.scenarios : [];
          if (left.length === 0) {
            // 整栈空了：和「退出场景」一样收拾输入框与托盘，否则预设附件会一直留在托盘里。
            clearSeededDraft();
            void dropSeededAttachments(ctx, sessionId);
            seeded.current = '';
            setState(null);
          } else {
            setState((current) => (current === null ? null : { ...current, cards: left, card: left[0] }));
            seeded.current = '';
          }
          notifyActivationChanged(sessionId);
        } catch {
          /* 失败时保留徽标，用户可重试 */
        } finally {
          setBusy(false);
        }
      };

      const exit = async () => {
        if (sessionId === '') return;
        setBusy(true);
        try {
          const result = await callHost('activation.clear', { sessionId });
          if (result?.ok !== true) throw new Error('activation.clear failed');
          clearSeededDraft();
          // 预设附件没人引用了：从托盘里摘掉（含面板那条路径挂的），别把文件留在会话里。
          void dropSeededAttachments(ctx, sessionId);
          seeded.current = '';
          setPrefillNote(null);
          setState(null);
          notifyActivationChanged(sessionId);
        } catch {
          /* 失败时保留徽标，用户可重试 */
        } finally {
          setBusy(false);
        }
      };

      if (state === null) return null;
      const card = state.card;
      const skills = Array.isArray(card.pinnedSkills) ? card.pinnedSkills : [];
      // 1.10.0：host 在 draft 里下发了每条技能的文件路径，场景栏据此渲染可点 chip。
      const routeSkills = (Array.isArray(seed?.skills) ? seed.skills : []).filter(
        (skill) => typeof skill?.name === 'string' && skill.name !== '',
      );
      const attachments = Array.isArray(seed?.attachments) ? seed.attachments : [];
      // 场景介绍只在新会话（还没有任何消息）里作为「场景开场」呈现：
      // 它是 UI 投影，不写会话历史，也不会被模型当成用户输入再回答一遍。
      // 1.13.0 起它与注入块里的「场景说明」是同一段文字，没填就不显示这张卡片。
      const welcome = typeof seed?.welcome === 'string' && seed.welcome !== '' ? seed.welcome : '';
      const showGuide = welcome !== '' && props?.session?.blank === true;

      const guide = showGuide
        ? h(
            'div',
            { className: 'crmw-guide' },
            h(
              'div',
              { className: 'crmw-guide-head' },
              h(Icon, { name: card.icon, size: 15 }),
              h('strong', null, t('场景开场')),
            ),
            h('p', null, welcome),
          )
        : null;

      const titleText =
        cards.length <= 1
          ? `🟢 正在使用场景：【${card.title}】 (v${card.version ?? '1.0.0'})`
          : `🟢 正在使用 ${cards.length} 个场景：【${card.title}】等`;

      // 预填状态提示：没落地 / 因为不是新对话所以没写，都要说清楚并能点一下补上。
      // 放在 pill 之外的独立一行：`role="status"` 的容器里塞按钮会让读屏反复重播整条状态。
      const prefillBlocked = (() => {
        if (prefillNote === null || prefillNote.mode === 'stuck') return false;
        const now = String(draftRef.current ?? '');
        const next = String(prefillNote.draft ?? '');
        if (now.trim() === '' || next.trim() === '') return false;
        // 冲突实时算：用户把输入框清空后，这行提示下一次渲染就自动换成可点的按钮。
        return seedConflict(now, next, seededTemplates) === 'keep' && now.trim() !== next.trim();
      })();
      const prefillHint =
        prefillNote === null
          ? null
          : h(
              'div',
              { className: `crmw-pill-note ${prefillNote.mode === 'skipped' && prefillBlocked === false ? 'info' : ''}` },
              h(
                'span',
                null,
                prefillNote.mode === 'skipped'
                  ? t('这是已有对话，模板没有自动填入')
                  : prefillBlocked
                    ? t('输入框里已有内容，没有覆盖')
                    : t('预填还没写进输入框'),
              ),
              prefillBlocked
                ? // 死按钮比没有按钮更糟：这里只说明，清空输入框后按钮会自己回来。
                  h('span', { className: 'crmw-dim' }, t('清空输入框后可直接填入'))
                : h(
                    'button',
                    { type: 'button', className: 'crmw-chip', onClick: () => applyPrefill(prefillNote) },
                    prefillNote.mode === 'stuck' ? t('点此重试') : t('填入输入框'),
                  ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'crmw-chip',
                  'aria-label': t('关掉这条提示'),
                  onClick: () => setPrefillNote(null),
                },
                '×',
              ),
            );

      // 技能名渲染成可点 chip：点一下在右侧栏打开它的 SKILL.md（与输入框里点技能 chip 同效）。
      // 没有路径信息时退回原来那行纯文字，避免出现「点了没反应」的假按钮。
      const skillChips =
        routeSkills.length === 0
          ? h('span', { className: 'crmw-pill-meta' }, `挂载技能：${skills.join(' + ') || '未绑定'}`)
          : h(
              'span',
              { className: 'crmw-pill-skills' },
              h('span', { className: 'crmw-pill-meta' }, '挂载技能：'),
              ...routeSkills.map((skill) =>
                h(
                  'button',
                  {
                    key: skill.name,
                    type: 'button',
                    className: 'crmw-chip',
                    title: skill.path === '' ? `${skill.name}：本机没有可打开的技能文件` : `打开 ${skill.path}`,
                    onClick: () => {
                      const outcome = openSkillFile(ctx, sessionId, skill);
                      if (outcome.ok !== true) void notifySession(ctx, sessionId, 'error', outcome.error);
                    },
                  },
                  `/${skill.name}`,
                ),
              ),
            );

      return h(
        React.Fragment,
        null,
        guide,
        h(
          'div',
          { className: 'crmw-pill', role: 'status', 'aria-live': 'polite' },
          h(
            'div',
            { className: 'crmw-pill-row' },
            h('span', { className: 'crmw-pill-dot', 'aria-hidden': 'true' }),
            h('span', { className: 'crmw-pill-title' }, titleText),
            skillChips,
            h('span', { className: 'crmw-grow' }),
            h(
              'button',
              {
                type: 'button',
                className: 'crmw-chip',
                onClick: () => {
                  try {
                    getService(ctx, 'layout')?.selectPanel?.(PANEL_KEY);
                  } catch {
                    /* 面板服务不可用时忽略 */
                  }
                },
              },
              t('切换场景'),
            ),
            h('button', { type: 'button', className: 'crmw-chip', disabled: busy, onClick: exit }, `× ${t('退出场景')}`),
          ),
          // 场景栈：每个场景一个可单独移除的 chip。
          // 只叠加了一个场景时也显示 —— 「引入之后没法移除」正是这个 × 缺失造成的。
          h(
            'div',
            { className: 'crmw-stack' },
            cards.map((item) =>
              h(
                'span',
                { key: item.scenarioId, className: 'crmw-stack-item', title: item.title },
                `${item.title} (v${item.version ?? '1.0.0'})`,
                h(
                  'button',
                  {
                    type: 'button',
                    title: `移除「${item.title}」`,
                    'aria-label': `移除「${item.title}」`,
                    disabled: busy,
                    onClick: () => void removeOne(item.scenarioId),
                  },
                  '×',
                ),
              ),
            ),
          ),
          attachments.length === 0
            ? null
            : h(
                'div',
                { className: 'crmw-attach-list' },
                attachments.map((item) =>
                  h(
                    'span',
                    { key: item.attachmentId ?? item.fileName, className: 'crmw-attach', title: item.fileName },
                    `📌 ${item.fileName}`,
                  ),
                ),
                h('span', { className: 'crmw-tag' }, '场景内置附件'),
              ),
        ),
        // 预填是否真的落地，必须有回音：核心卖点静默失效时用户会以为插件坏了。
        // 放在状态条之外 —— 塞进 `role="status"` 的容器里，读屏会把整条状态重播一遍。
        prefillHint,
      );
    }

    /* ── 插件装配 ───────────────────────────────────────────────── */

    const inject = ['slots', 'sessions', 'workspaces', 'conversation'];

    function apply(ctx) {
      installLocale(ctx);

      ctx.effect(() => {
        installStyles();
        return () => {
          document.getElementById(STYLE_ID)?.remove();
        };
      }, 'crm-workspace: styles');

      const layout = () => getService(ctx, 'layout');

      // 场景斜杠指令：宿主已把卡片登记成 /指令，这里给同名指令挂客户端动作，
      // 让「/指令 + 回车」在本会话立刻激活并给出提示，而不是只清空输入框。
      ctx.inject(['commandUi'], (cctx) => {
        cctx.effect(() => {
          const commandUi = getService(cctx, 'commandUi') ?? cctx.commandUi;
          void callHost('bootstrap', {})
            .then((boot) => syncScenarioCommands(cctx, commandUi, boot?.installedScenarios))
            .catch(() => undefined);
          return () => clearScenarioCommands();
        }, 'crm-workspace: scenario commands');
      });

      // 注册我们自己的 `/` 引用源：它不是 chip 的主人，只给 `/技能名` 补一份名字表
      // （宿主目录结算前也能着色），并在宿主源认不出这个名字时兜底打开 SKILL.md。
      ctx.inject(['inputTriggers'], (cctx) => {
        const inputTriggers = getService(cctx, 'inputTriggers') ?? cctx.inputTriggers;
        if (typeof inputTriggers?.registerSource !== 'function') return;
        cctx.effect(() => {
          const unregister = inputTriggers.registerSource(createSkillRefSource(cctx));
          return () => {
            try {
              unregister();
            } catch {
              /* 服务先一步销毁时注销会抛：忽略 */
            }
          };
        }, 'crm-workspace: skill reference source');
      });

      ctx.slots.inject('main', () =>
        ctx.slots.register(
          {
            name: 'main',
            key: PANEL_KEY,
            inject: () => ({
              ctx,
              presentation: 'panel',
              closePanel: () => {
                try {
                  layout()?.selectPanel?.(null);
                } catch {
                  /* 面板服务不可用时忽略 */
                }
              },
            }),
          },
          bounded(Panel, 'main', t('工作台面板')),
        ),
      );

      ctx.slots.inject('conversation.session.header.actions', () =>
        ctx.slots.register(
          {
            name: 'conversation.session.header.actions',
            id: PANEL_KEY,
            order: 30,
            label: () => t('场景'),
            inject: () => ({ ctx }),
          },
          bounded(ScenarioBadge, 'conversation.session.header.actions', t('场景标签')),
        ),
      );

      ctx.slots.inject('conversation.input.dock', () =>
        ctx.slots.register(
          {
            name: 'conversation.input.dock',
            id: PANEL_KEY,
            order: 20,
            label: () => t('当前场景'),
            inject: () => ({ ctx }),
          },
          bounded(ComposerScenarioBanner, 'conversation.input.dock', t('场景栏')),
        ),
      );

      ctx.slots.inject('sidebar.panellist', () => {
        const dispose = ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: PANEL_KEY,
            order: 45,
            label: () => t('场景工作台'),
          },
          SidebarIcon,
        );
        let disposed = false;
        const remove = () => {
          if (disposed) return;
          disposed = true;
          try {
            dispose?.();
          } catch {
            /* 槽未就绪时忽略 */
          }
        };
        // 配置 showSidebarEntry=false 时入口撤下；面板本体仍可按 key 直接寻址。
        sidebarGate = (visible) => {
          if (visible === false) remove();
        };
        void callHost('bootstrap', {})
          .then((boot) => {
            if (boot?.config?.showSidebarEntry === false) remove();
          })
          .catch(() => {
            /* 配置读不到就保留入口 */
          });
        return () => {
          remove();
          sidebarGate = null;
        };
      });
    }

    /**
     * 纯函数出口：只为 node:vm 单测服务（test/client.test.js 会加载本文件并调用）。
     * 它们不依赖 React 或宿主服务，可以脱离浏览器验证「预填什么、清空什么」。
     */
    const __pure = {
      prefillTextFor,
      seededDraftTextFor,
      shouldClearSeededDraft,
      seedConflict,
      scenarioSeedKey,
      // 1.9.0：`/技能名` 预填
      composePrefillText,
      stripSkillTokens,
      isKnownTemplate,
      skillRoutePrefillEnabled,
      // 1.10.0：点场景栏里的技能名 → 右侧栏打开 SKILL.md
      fileAddressFor,
      encodeAddressSegment,
      // 1.11.1：预填只递纯字符串，与手打同源
      draftPayloadFor,
      SKILL_REF_SOURCE,
      // 1.14.0：卡片上的「预填」首行 + 两个页签共用的搜索口径
      draftFirstLine,
      scenarioSearchText,
      rememberScenarioTemplates,
      rememberSeededTemplate,
      knownTemplates: () => Array.from(seededTemplates),
    };

    return { inject, apply, __pure };
  },
});
