/**
 * CRM 智能工作台 —— Web 客户端（原生客户端插件，无 JSX 构建步骤）。
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
  id: 'dsh-crm-workspace',
  factory: (require) => {
    const React = require('react');
    const { useCallback, useEffect, useMemo, useRef, useState } = React;
    const h = React.createElement;

    const PLUGIN_ID = 'crm-workspace';
    const API_PATH = '/crm-workspace/api';
    const PANEL_KEY = 'crm-workspace';
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
.crmw-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(268px,1fr));gap:12px;align-items:start}
.crmw-card{position:relative;display:flex;flex-direction:column;gap:9px;padding:14px;border-radius:12px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);transition:border-color .15s,transform .15s,box-shadow .15s}
.crmw-card:hover{border-color:var(--dsw-alias-brand-primary);box-shadow:0 6px 18px rgba(0,0,0,.08);transform:translateY(-1px)}
.crmw-card.disabled{opacity:.62}
.crmw-card-top{display:flex;align-items:flex-start;gap:10px}
.crmw-card-icon{display:flex;align-items:center;justify-content:center;width:34px;height:34px;flex:0 0 auto;border-radius:10px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);color:var(--dsw-alias-brand-primary)}
.crmw-card-title{font-size:13px;font-weight:600;line-height:1.35;word-break:break-word}
.crmw-card-cat{font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:2px}
.crmw-card-desc{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden;white-space:pre-wrap;word-break:break-word}
.crmw-skills{display:flex;flex-wrap:wrap;gap:4px}
.crmw-skill{display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 7px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);font-size:10.5px;color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.crmw-skill.missing{border-style:dashed;color:var(--dsw-alias-state-warn-primary)}
.crmw-card-foot{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:auto;padding-top:8px;border-top:1px dashed var(--dsw-alias-border-l1)}
.crmw-cmd{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent);padding:2px 6px;border-radius:5px}
.crmw-badge{font-size:10px;padding:2px 6px;border-radius:5px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}
.crmw-menu{position:relative}
.crmw-menu>summary{list-style:none;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:6px;color:var(--dsw-alias-label-secondary)}
.crmw-menu>summary::-webkit-details-marker{display:none}
.crmw-menu>summary:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
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
.crmw-pill-title{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}
.crmw-pill-meta{font-size:11px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.crmw-attach-list{display:flex;flex-wrap:wrap;gap:4px}
.crmw-attach{display:inline-flex;align-items:center;gap:4px;max-width:100%;padding:2px 7px;border-radius:6px;border:1px dashed var(--dsw-alias-border-l2);font-size:10.5px;color:var(--dsw-alias-label-secondary)}
.crmw-tag{display:inline-flex;align-items:center;height:18px;padding:0 6px;border-radius:5px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);color:var(--dsw-alias-brand-primary);font-size:10px;white-space:nowrap}
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
.crmw-switch input{appearance:none;width:30px;height:17px;border-radius:999px;background:var(--dsw-alias-border-l2);position:relative;cursor:pointer;transition:background .15s;margin:0}
.crmw-switch input:checked{background:var(--dsw-alias-brand-primary)}
.crmw-switch input::after{content:'';position:absolute;top:2px;left:2px;width:13px;height:13px;border-radius:50%;background:var(--dsw-alias-label-primary);transition:transform .15s}
.crmw-switch input:checked::after{transform:translateX(13px)}
.crmw-stack{display:flex;flex-direction:column;gap:5px}
.crmw-stack-item{display:flex;align-items:center;gap:7px;padding:5px 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}
.crmw-stack-item .idx{width:17px;flex:0 0 auto;text-align:center;font-size:10.5px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.crmw-stack-item .nm{flex:1 1 auto;min-width:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.crmw-stack-item .nm.missing{color:var(--dsw-alias-state-warn-primary);text-decoration:underline dotted}
.crmw-pre{margin:0;padding:12px;border-radius:9px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:1.65;white-space:pre-wrap;word-break:break-word;max-height:52vh;overflow:auto}
.crmw-toasts{position:fixed;right:18px;bottom:18px;z-index:80;display:flex;flex-direction:column;gap:8px;pointer-events:none}
.crmw-toast{pointer-events:auto;display:flex;align-items:flex-start;gap:8px;max-width:340px;padding:9px 12px;border-radius:9px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-overlay);box-shadow:0 8px 24px rgba(0,0,0,.24);font-size:12px;line-height:1.55}
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

    function currentSessionId(ctx) {
      try {
        const snapshot = ctx.sessions?.list?.getSnapshot?.();
        return typeof snapshot?.current === 'string' ? snapshot.current : undefined;
      } catch {
        return undefined;
      }
    }

    function currentWorkspaceId(ctx) {
      try {
        const workspaces = ctx.workspaces?.list?.getSnapshot?.();
        const current = currentSessionId(ctx);
        const selected =
          current === undefined
            ? undefined
            : workspaces?.items?.find((item) => Array.isArray(item.sessionIds) && item.sessionIds.includes(current));
        return selected?.workspaceId ?? workspaces?.recentWorkspaceId;
      } catch {
        return undefined;
      }
    }

    /** 确保有一个可用的会话：没有就按当前工作区建一个（不伪造用户消息）。 */
    async function ensureSession(ctx) {
      const existing = currentSessionId(ctx);
      if (existing !== undefined) return existing;

      const uiWorkspace = getService(ctx, 'uiWorkspace');
      const workspaceId = currentWorkspaceId(ctx);
      if (workspaceId !== undefined && typeof uiWorkspace?.connectWorkspace === 'function') {
        const created = await uiWorkspace.connectWorkspace(workspaceId);
        if (typeof created === 'string' && created !== '') return created;
      }
      if (typeof uiWorkspace?.startSession === 'function') {
        const created = await uiWorkspace.startSession(workspaceId);
        const id = typeof created === 'string' ? created : created?.sessionId;
        if (typeof id === 'string' && id !== '') return id;
      }
      if (typeof ctx.sessions?.create === 'function') {
        const created = await ctx.sessions.create(workspaceId === undefined ? {} : { workspaceId });
        const id = typeof created === 'string' ? created : created?.sessionId ?? created?.id;
        if (typeof id === 'string' && id !== '') return id;
      }
      throw new Error('当前没有可用会话：请先在左侧打开或新建一个会话');
    }

    function switchToConversation(ctx, sessionId) {
      const layout = getService(ctx, 'layout');
      try {
        if (sessionId !== undefined) ctx.sessions?.open?.(sessionId);
      } catch {
        /* 打开会话失败时至少切到会话面板，用户可手动选择 */
      }
      try {
        layout?.selectPanel?.('conversation');
      } catch {
        /* 面板服务不可用时保持现状 */
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

    const ANSWER_LABELS = { CREATE: '新建', UPDATE: '修改', AUTO: '智能判断' };

    function ScenarioCard({ card, admin, canManageStandard, busy, onEnter, onEdit, onDuplicate, onMove, onToggle, onDelete, onPreview, onExport, onFork, missingSkills }) {
      const skills = Array.isArray(card.pinnedSkills) ? card.pinnedSkills : [];
      const visible = skills.slice(0, 4);
      const isStandard = card.sourceType === STANDARD_SOURCE;
      // 普通用户对标准场景完全只读；管理员才出现编辑/删除菜单。
      const canManage = admin === true && (isStandard !== true || canManageStandard === true);
      const readonly = isStandard === true && canManageStandard !== true;
      const meta = [
        card.category,
        isStandard ? `公司标准 v${card.version || '1.0.0'}` : card.isSystemBase === true ? '系统底座' : '',
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
          canManage
            ? h(
                'details',
                { className: 'crmw-menu' },
                h('summary', { title: t('更多操作') }, h(Icon, { name: 'more', size: 15 })),
                h(
                  'div',
                  { className: 'crmw-menu-list' },
                  h('button', { type: 'button', onClick: onEdit }, t('编辑')),
                  h('button', { type: 'button', onClick: onPreview }, t('预览注入内容')),
                  isStandard ? null : h('button', { type: 'button', onClick: onDuplicate }, t('复制')),
                  h('button', { type: 'button', onClick: () => onMove('up') }, t('上移')),
                  h('button', { type: 'button', onClick: () => onMove('down') }, t('下移')),
                  h('button', { type: 'button', onClick: onToggle }, card.enabled === true ? t('停用') : t('启用')),
                  isStandard
                    ? h('button', { type: 'button', onClick: onFork }, t('复制为本地场景'))
                    : null,
                  h('button', { type: 'button', className: 'danger', onClick: onDelete }, t('删除')),
                ),
              )
            : null,
        ),
        h('p', { className: 'crmw-card-desc' }, card.description),
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
          h('span', { className: 'crmw-badge' }, ANSWER_LABELS[card.prePinnedContext?.defaultAction] ?? '智能判断'),
          h('span', { className: 'crmw-grow' }),
          h(IconButton, { name: 'down', label: t('下载到本地'), onClick: onExport }),
          isStandard
            ? h(
                Button,
                { size: 'sm', onClick: onFork, title: '深拷贝为标准场景的本地副本，可自由编辑' },
                `⎘ ${t('复制为本地场景')}`,
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
              `${card.category} · v${card.version || '1.0.0'}${card.revision !== undefined ? ` · r${card.revision}` : ''}${card.author ? ` · ${card.author}` : ''}`,
            ),
          ),
          installed === true ? h('span', { className: 'crmw-tag' }, `✅ ${t('已安装')}`) : null,
          canManage === true
            ? h(
                'details',
                { className: 'crmw-menu' },
                h('summary', { title: t('更多操作') }, h(Icon, { name: 'more', size: 15 })),
                h(
                  'div',
                  { className: 'crmw-menu-list' },
                  h('button', { type: 'button', onClick: onEdit }, t('编辑标准场景')),
                  h('button', { type: 'button', onClick: onDownload }, t('下载到本地')),
                  h('button', { type: 'button', className: 'danger', onClick: onDelete }, t('删除标准场景')),
                ),
              )
            : null,
        ),
        h('p', { className: 'crmw-card-desc' }, card.description),
        h(
          'div',
          { className: 'crmw-skills' },
          visible.length === 0
            ? h('span', { className: 'crmw-badge' }, t('未绑定技能'))
            : visible.map((name) => h('span', { key: name, className: 'crmw-skill', title: name }, name)),
          skills.length > visible.length ? h('span', { className: 'crmw-badge' }, `+${skills.length - visible.length}`) : null,
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
            ),
        h(
          'div',
          { className: 'crmw-card-foot' },
          h('span', { className: 'crmw-badge' }, `v${card.version || '1.0.0'}`),
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
        category: '',
        slashCommand: '',
        enabled: true,
        isSystemBase: false,
        pinnedSkills: [],
        prePinnedContext: {
          defaultObjectApiName: '',
          defaultAction: 'AUTO',
          formContextEntry: 'STANDARD',
          allowAttachments: false,
        },
        welcomeMessage: '',
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
      const [uploading, setUploading] = useState(false);

      const patch = (key, value) => setDraft((current) => ({ ...current, [key]: value }));
      const patchContext = (key, value) =>
        setDraft((current) => ({ ...current, prePinnedContext: { ...current.prePinnedContext, [key]: value } }));

      const pinned = Array.isArray(draft.pinnedSkills) ? draft.pinnedSkills : [];
      const addSkill = (name) => {
        const value = String(name ?? '').trim();
        if (value === '' || pinned.includes(value)) return;
        patch('pinnedSkills', [...pinned, value]);
        setSkillQuery('');
      };
      const removeSkill = (index) => patch('pinnedSkills', pinned.filter((_, i) => i !== index));
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
          if (Array.isArray(result.warnings) && result.warnings.length > 0) setWarnings(result.warnings);
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

      const fieldError = (name) => errors[name] ?? errors[`prePinnedContext.${name}`];

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
            h(Button, { key: 'cancel', onClick: onClose, disabled: saving }, t('取消')),
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
            { label: `${t('业务分类')} *`, error: errors.category, hint: '用于面板过滤，可自定义' },
            h('input', {
              className: `crmw-input ${errors.category ? 'bad' : ''}`,
              value: draft.category,
              list: 'crmw-categories',
              maxLength: limits?.category,
              placeholder: '核心单据管控',
              onChange: (event) => patch('category', event.target.value),
            }),
            h(
              'datalist',
              { id: 'crmw-categories' },
              (taxonomy?.categories ?? []).map((value) => h('option', { key: value, value })),
            ),
          ),
        ),
        h(
          Field,
          {
            label: `${t('场景介绍')} *`,
            error: errors.description,
            hint: `显示在卡片正文，说明场景解决什么问题、适用于哪些业务（${[...(draft.description ?? '')].length}/${limits?.description ?? 2000}）`,
          },
          h('textarea', {
            className: `crmw-textarea ${errors.description ? 'bad' : ''}`,
            value: draft.description,
            maxLength: limits?.description,
            onChange: (event) => patch('description', event.target.value),
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
            hint: '点击候选按顺序追加；候选来自当前 Host 的 Skill 视图，公司 Skill 未出现时可直接输入名称后回车追加（进入场景后由模型加载其正文）',
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
                className: 'crmw-input',
                value: skillQuery,
                placeholder: '搜索 Skill 名称或手动输入后回车',
                onChange: (event) => setSkillQuery(event.target.value),
                onKeyDown: (event) => {
                  if (event.key !== 'Enter') return;
                  event.preventDefault();
                  if (suggestions.length > 0) addSkill(suggestions[0].name);
                  else addSkill(skillQuery);
                },
              }),
              h(Button, { onClick: () => addSkill(skillQuery), disabled: skillQuery.trim() === '' }, '追加'),
            ),
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
              : null,
          ),
        ),
        h(
          'div',
          { className: 'crmw-row' },
          h(
            Field,
            { label: t('目标对象 API 名'), error: fieldError('defaultObjectApiName'), hint: '留空则由模型根据上下文发现对象' },
            h('input', {
              className: `crmw-input ${fieldError('defaultObjectApiName') ? 'bad' : ''} crmw-mono`,
              value: draft.prePinnedContext?.defaultObjectApiName ?? '',
              maxLength: limits?.objectApiName,
              placeholder: 'Case / Invoice__c',
              onChange: (event) => patchContext('defaultObjectApiName', event.target.value),
            }),
          ),
          h(
            Field,
            { label: t('默认动作') },
            h(
              'select',
              {
                className: 'crmw-select',
                value: draft.prePinnedContext?.defaultAction ?? 'AUTO',
                onChange: (event) => patchContext('defaultAction', event.target.value),
              },
              (taxonomy?.actions ?? ['CREATE', 'UPDATE', 'AUTO']).map((value) =>
                h('option', { key: value, value }, `${ANSWER_LABELS[value] ?? value}（${value}）`),
              ),
            ),
          ),
          h(
            Field,
            { label: t('表单入口') },
            h(
              'select',
              {
                className: 'crmw-select',
                value: draft.prePinnedContext?.formContextEntry ?? 'STANDARD',
                onChange: (event) => patchContext('formContextEntry', event.target.value),
              },
              (taxonomy?.formContextEntries ?? ['STANDARD', 'QUICK_ACTION']).map((value) =>
                h('option', { key: value, value }, value === 'STANDARD' ? '标准表单（STANDARD）' : '快速操作（QUICK_ACTION）'),
              ),
            ),
          ),
        ),
        h(
          'div',
          { className: 'crmw-toolbar' },
          h(Switch, {
            checked: draft.prePinnedContext?.allowAttachments === true,
            onChange: (value) => patchContext('allowAttachments', value),
            label: t('允许附件'),
          }),
          h(Switch, { checked: draft.enabled !== false, onChange: (value) => patch('enabled', value), label: '在运行态展示' }),
          h(Switch, { checked: draft.isSystemBase === true, onChange: (value) => patch('isSystemBase', value), label: '标记为系统底座' }),
        ),
        h(
          Field,
          { label: `${t('开场引导语')} *`, error: errors.welcomeMessage, hint: '激活场景后展示给业务人员的第一句话' },
          h('textarea', {
            className: `crmw-textarea ${errors.welcomeMessage ? 'bad' : ''}`,
            value: draft.welcomeMessage,
            maxLength: limits?.welcomeMessage,
            onChange: (event) => patch('welcomeMessage', event.target.value),
          }),
        ),
        h(
          Field,
          {
            label: '输入框预填内容（inputDraft）',
            hint:
              '进入场景开启新会话时自动填入聊天输入框的草稿。留空则默认带入上面的开场引导语；填写后可给出更明确的填空模板，例如「客户名称：____\\n拜访日期：____」。',
            error: errors.inputDraft,
          },
          h('textarea', {
            className: `crmw-textarea ${errors.inputDraft ? 'bad' : ''}`,
            value: draft.inputDraft ?? '',
            maxLength: limits?.inputDraft,
            placeholder: '留空 = 自动带入开场引导语',
            onChange: (event) => patch('inputDraft', event.target.value),
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
            { label: t('创建人'), hint: '由当前登录用户自动带出，不可修改', error: errors.author },
            h('input', {
              className: `crmw-input ${errors.author ? 'bad' : ''}`,
              value: draft.author ?? '',
              readOnly: true,
              disabled: true,
              style: { opacity: 0.75, cursor: 'not-allowed' },
              placeholder: '自动带出当前用户',
              title: '由当前登录用户自动带出，不可修改',
            }),
          ),
        ),
        canManageStandard === true
          ? h(
              'div',
              { className: 'crmw-toolbar' },
              h(Switch, {
                checked: editingStandard === true || draft.sourceType === STANDARD_SOURCE,
                disabled: editingStandard === true,
                onChange: (value) => {
                  setDraft((current) => ({
                    ...current,
                    isStandardPublished: value,
                    readonlyForNormalUser: value,
                    sourceType: value || editingStandard === true ? STANDARD_SOURCE : LOCAL_SOURCE,
                  }));
                },
                label: `☑️ ${t('设为插件标准场景')}（发布到 MCP 控制平面，供公司同事安装）`,
              }),
              editingStandard === true
                ? h('span', { className: 'crmw-dim', style: { fontSize: '11px' } }, '正在编辑公司标准场景：保存后服务端自动升版。')
                : null,
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

    function Panel(props) {
      const ctx = props.ctx;
      const [data, setData] = useState(null);
      const [activation, setActivation] = useState(null);
      const [error, setError] = useState('');
      const [loading, setLoading] = useState(true);
      const [busyId, setBusyId] = useState('');
      const [query, setQuery] = useState('');
      const [category, setCategory] = useState('');
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
      const [companyBusy, setCompanyBusy] = useState('');

      const toast = useCallback((text, kind = 'ok') => {
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        setToasts((items) => [...items, { id, text, kind }]);
        window.setTimeout(() => {
          setToasts((items) => items.filter((item) => item.id !== id));
        }, kind === 'error' ? 6000 : 3200);
      }, []);

      const refresh = useCallback(
        async (options = {}) => {
          const sessionId = currentSessionId(ctx);
          try {
            const boot = await callHost('bootstrap', { sessions: sessionId === undefined ? [] : [sessionId] });
            setData(boot);
            const bootAuth = boot?.auth ?? boot?.permission;
            if (bootAuth !== undefined && bootAuth !== null) {
              setAuth((current) => ({ ...current, ...bootAuth }));
            }
            setError('');
            sidebarGate?.(boot?.config?.showSidebarEntry !== false);
            if (sessionId !== undefined && options.withActivation !== false) {
              const state = await callHost('activation.state', { sessionId });
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

      useEffect(() => {
        if (admin !== true || skillPool.length > 0) return;
        callHost('skills.list', {})
          .then((result) => setSkillPool(Array.isArray(result.skills) ? result.skills : []))
          .catch(() => undefined);
      }, [admin, skillPool.length]);

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

      /** 「公司推出的场景（Runner）」：同步回来的全部 PUBLISHED 标准场景。 */
      const companyRows = useMemo(() => {
        if (Array.isArray(data?.companyStandardScenarios)) return data.companyStandardScenarios;
        return [];
      }, [data]);

      const scenarios = useMemo(() => {
        const rows = installedList;
        const needle = query.trim().toLowerCase();
        return rows.filter((card) => {
          if (showDisabled !== true && card.enabled !== true) return false;
          if (category !== '' && card.category !== category) return false;
          if (needle === '') return true;
          return `${card.title} ${card.description} ${card.category} ${card.slashCommand} ${(card.pinnedSkills ?? []).join(' ')}`
            .toLowerCase()
            .includes(needle);
        });
      }, [installedList, query, category, showDisabled]);

      const categories = useMemo(() => {
        const set = new Set();
        for (const card of installedList) {
          if (typeof card.category === 'string' && card.category !== '') set.add(card.category);
        }
        return [...set];
      }, [installedList]);

      const activeCard = useMemo(() => {
        if (activation === null) return undefined;
        return installedList.find((card) => card.scenarioId === activation.scenarioId);
      }, [activation, installedList]);

      const canManageStandard = auth.canManageStandardScenario === true;

      /**
       * 打开编辑器前强制调用 GET /api/dsh/scenarios/permission。
       * 标准场景编辑/删除只认服务端返回的 auth.canManageStandardScenario。
       */
      const openEditor = async ({ initial = null, previousId, standard = false } = {}) => {
        const isStandard = standard === true || initial?.sourceType === STANDARD_SOURCE;
        const permission = await refreshPermission(true);
        const allowed = (permission ?? auth).canManageStandardScenario === true;
        if (isStandard && allowed !== true) {
          toast('当前账号没有管理公司标准场景的权限（auth.canManageStandardScenario=false）', 'error');
          return;
        }
        setEditor({ initial, previousId, standard: isStandard });
      };

      const enterScenario = async (card) => {
        setBusyId(card.scenarioId);
        try {
          const sessionId = await ensureSession(ctx);
          const result = await callHost('activation.activate', { sessionId, scenarioId: card.scenarioId, source: 'ui' });
          setActivation(result.activation ?? { scenarioId: card.scenarioId });
          // 切到对话面板：输入框上方的场景标识、预填引导语与预设附件都在那里生效。
          switchToConversation(ctx, sessionId);
          toast(`🟢 正在使用场景：【${card.title}】 (v${card.version ?? '1.0.0'})`);
        } catch (failure) {
          toast(String(failure?.message ?? failure), 'error');
        } finally {
          setBusyId('');
        }
      };

      const clearActivation = async () => {
        const sessionId = currentSessionId(ctx);
        if (sessionId === undefined) {
          setActivation(null);
          return;
        }
        try {
          await callHost('activation.clear', { sessionId });
          setActivation(null);
          toast('已退出当前场景');
        } catch (failure) {
          toast(String(failure?.message ?? failure), 'error');
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
          h('h2', null, t('CRM 智能工作台')),
          h(
            'span',
            null,
            `已安装 ${installedList.length} 张 · ${data?.config?.apiBaseUrl ?? ''}${canManageStandard ? ' · 标准场景管理员' : ''}`,
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
            `🌐 ${t('公司推出的场景（Runner）')}`,
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
          { type: 'button', className: `crmw-chip ${category === '' ? 'on' : ''}`, onClick: () => setCategory('') },
          t('全部'),
        ),
        categories.map((value) =>
          h(
            'button',
            {
              key: value,
              type: 'button',
              className: `crmw-chip ${category === value ? 'on' : ''}`,
              onClick: () => setCategory(category === value ? '' : value),
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
        admin === true || canManageStandard === true
          ? h(
              Button,
              { variant: 'primary', onClick: () => void openEditor({ initial: null, previousId: undefined }) },
              h(Icon, { name: 'plus', size: 13 }),
              t('新建场景'),
            )
          : null,
      );

      const activeStrip =
        activeCard === undefined
          ? null
          : h(
              'div',
              { className: 'crmw-active' },
              h('div', { className: 'crmw-card-icon' }, h(Icon, { name: activeCard.icon, size: 17 })),
              h(
                'div',
                { className: 'crmw-active-text crmw-grow' },
                h('strong', null, `🟢 ${t('当前场景')}：【${activeCard.title}】 (v${activeCard.version ?? '1.0.0'})`),
                h('span', null, activeCard.welcomeMessage),
                h(
                  'span',
                  { className: 'crmw-dim' },
                  `技能栈：${(activeCard.pinnedSkills ?? []).join(' → ') || '未绑定'} · 指令 ${activeCard.slashCommand}${activeCard.sourceType === STANDARD_SOURCE ? ' · 公司标准（只读）' : ''}`,
                ),
              ),
              h(Button, { size: 'sm', onClick: () => switchToConversation(ctx, currentSessionId(ctx)) }, t('进入对话')),
              h(Button, { size: 'sm', variant: 'ghost', onClick: clearActivation }, t('退出场景')),
            );

      const grid =
        scenarios.length === 0
          ? h(
              'div',
              { className: 'crmw-empty' },
              h(Icon, { name: 'sparkles', size: 26 }),
              h('h3', null, loading ? '正在读取场景配置…' : '还没有可用的场景'),
              h(
                'p',
                null,
                loading
                  ? '正在从 Host 读取场景配置。'
                  : '场景卡片全部由管理员配置生成。请切换到「管理模式」，点击「新建场景」填写标题、场景介绍、快捷指令，并按顺序绑定 Skill；保存后卡片会立即出现在这里。',
              ),
              (admin === true || canManageStandard === true) && loading !== true
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
                  admin,
                  canManageStandard,
                  busy: busyId === card.scenarioId,
                  onEnter: () => enterScenario(card),
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

      const companySource = company.scenarios !== null ? company.scenarios : companyRows;

      const companyToolbar = h(
        'div',
        { className: 'crmw-toolbar' },
        h(
          'div',
          { className: 'crmw-active-text crmw-grow' },
          h('strong', null, '公司推出的场景（Runner）'),
          h(
            'span',
            null,
            `来源：${data?.config?.apiBaseUrl ?? companyRows[0]?.apiBaseUrl ?? ''} · ${
              auth.authenticated === true
                ? `已认证${auth.crmUsername ? `：${auth.crmUsername}` : ''}`
                : '未认证（请配置 Buntu Token 或 internal_bearer 凭据）'
            } · ${canManageStandard ? '可创建/编辑/删除标准场景' : '标准场景只读'}`,
          ),
        ),
        h(
          Button,
          { size: 'sm', disabled: company.loading === true, onClick: () => loadCompany(true) },
          h(Icon, { name: 'refresh', size: 13 }),
          t('同步'),
        ),
      );

      const companyGrid =
        company.loading === true && companySource.length === 0
          ? h('div', { className: 'crmw-toolbar' }, h('span', { className: 'crmw-spin' }), h('span', { className: 'crmw-dim' }, '正在从 MCP 控制平面同步标准场景…'))
          : companySource.length === 0
            ? h(
                'div',
                { className: 'crmw-empty' },
                h(Icon, { name: 'building', size: 26 }),
                h('h3', null, '公司场景库暂时没有内容'),
                h(
                  'p',
                  null,
                  auth.authenticated !== true
                    ? '当前请求没有通过 MCP 服务认证：请让管理员在 cordis.patch.yml 中配置 buntuToken，或使用 internal_bearer 模式配置 mcpClientToken + platformUserId。'
                    : '有权限的管理员在「新建/编辑场景」抽屉里勾选「☑️ 设为插件标准场景」后，这里就会出现可安装的标准场景。',
                ),
              )
            : h(
                'div',
                { className: 'crmw-grid' },
                companySource.map((card) =>
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
            ? [companyToolbar, company.error !== '' ? h('div', { className: 'crmw-banner error' }, company.error) : null, companyGrid]
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
        h(Toasts, { items: toasts }),
      );
    }

    /* ── 侧边栏入口 ─────────────────────────────────────────────── */

    function SidebarIcon(props) {
      const size = typeof props?.size === 'number' ? props.size : 18;
      return h(Icon, { name: 'sparkles', size });
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
        let alive = true;
        const load = () => {
          void callHost('activation.state', { sessionId })
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
        return () => {
          alive = false;
          window.clearInterval(timer);
          window.removeEventListener('focus', tick);
          document.removeEventListener('visibilitychange', tick);
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
     *   2. 首次进入时把 inputDraft（缺省回退 welcomeMessage）写进输入框草稿；
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
      const seeded = useRef('');
      // 草稿快照在渲染期读取：hook 不能在 effect 里调用，否则会破坏 hook 顺序。
      const inputSnapshot = typeof useInput === 'function' ? useInput() : props?.input;
      const draftNow = typeof inputSnapshot?.draft === 'string' ? inputSnapshot.draft : '';
      // effect 里要读「最新的草稿」，用 ref 承接避免闭包拿到旧值。
      const draftRef = useRef(draftNow);
      draftRef.current = draftNow;

      useEffect(() => {
        if (sessionId === '') return undefined;
        let alive = true;
        const load = () => {
          void callHost('activation.state', { sessionId })
            .then((result) => {
              if (!alive) return;
              const card = result?.scenario;
              setState(
                card !== undefined && card !== null && typeof card.title === 'string' && card.title !== ''
                  ? { card, draft: result.draft ?? null }
                  : null,
              );
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
        return () => {
          alive = false;
          window.clearInterval(timer);
          window.removeEventListener('focus', tick);
          document.removeEventListener('visibilitychange', tick);
        };
      }, [sessionId]);

      const seed = state === null ? null : state.draft;
      const seedKey = state === null ? '' : `${sessionId}:${state.card.scenarioId}:${state.card.version ?? ''}`;

      /**
       * 把场景预设附件搬进官方附件托盘：字节 → File → conversation.createDrafts → inputActions.addAttachments。
       * 返回 true 表示「已经全部就位」（或本来就没有附件），false 表示还需要重试
       * （例如会话刚打开时 conversation 服务、输入框还没就绪）。
       */
      const attachPresetFiles = async (list) => {
        if (list.length === 0) return true;
        const conversation = getService(ctx, 'conversation');
        if (conversation === undefined || typeof conversation.createDrafts !== 'function') return false;
        const already = Array.isArray(inputActions?.attachments) ? inputActions.attachments : null;
        if (already !== null && already.length === list.length) return true;
        const files = [];
        for (const item of list) {
          try {
            const response = await fetch(item.url);
            if (response.ok !== true) continue;
            const blob = await response.blob();
            files.push(new File([blob], item.fileName, { type: item.mimeType || blob.type || 'application/octet-stream' }));
          } catch {
            /* 单个附件失败不影响其余附件 */
          }
        }
        if (files.length === 0) return true;
        try {
          const drafts = await conversation.createDrafts(sessionId, files, false);
          const ids = (Array.isArray(drafts) ? drafts : []).map((item) => item?.id).filter(Boolean);
          if (ids.length === 0) return false;
          if (typeof inputActions?.addAttachments !== 'function') return true;
          return inputActions.addAttachments(ids) !== false;
        } catch {
          return false;
        }
      };

      useEffect(() => {
        if (state === null || seed === null || sessionId === '') return undefined;
        if (seeded.current === seedKey) return undefined;

        const text = typeof seed.text === 'string' ? seed.text : '';
        const list = Array.isArray(seed.attachments) ? seed.attachments : [];
        let cancelled = false;
        let tries = 0;

        const attempt = async () => {
          // 1) 预填草稿：仅在输入框为空时写入，避免覆盖用户已经打了一半的内容。
          if (text !== '' && typeof inputActions?.setDraft === 'function' && draftRef.current.trim() === '') {
            try {
              inputActions.setDraft(text);
            } catch {
              return false; /* 草稿被冻结（正在发送）时下一轮再试 */
            }
          }
          // 2) 预设附件进托盘。
          const attached = await attachPresetFiles(list);
          return attached;
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

      const exit = async () => {
        if (sessionId === '') return;
        setBusy(true);
        try {
          await callHost('activation.clear', { sessionId });
          seeded.current = '';
          setState(null);
        } catch {
          /* 失败时保留徽标，用户可重试 */
        } finally {
          setBusy(false);
        }
      };

      if (state === null) return null;
      const card = state.card;
      const skills = Array.isArray(card.pinnedSkills) ? card.pinnedSkills : [];
      const attachments = Array.isArray(seed?.attachments) ? seed.attachments : [];

      return h(
        'div',
        { className: 'crmw-pill', role: 'status', 'aria-live': 'polite' },
        h(
          'div',
          { className: 'crmw-pill-row' },
          h('span', { className: 'crmw-pill-dot', 'aria-hidden': 'true' }),
          h(
            'span',
            { className: 'crmw-pill-title' },
            `🟢 正在使用场景：【${card.title}】 (v${card.version ?? '1.0.0'})`,
          ),
          h('span', { className: 'crmw-pill-meta' }, `挂载技能：${skills.join(' + ') || '未绑定'}`),
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
        attachments.length === 0
          ? null
          : h(
              'div',
              { className: 'crmw-attach-list' },
              attachments.map((item) =>
                h('span', { key: item.attachmentId ?? item.fileName, className: 'crmw-attach', title: item.fileName }, `📌 ${item.fileName}`),
              ),
              h('span', { className: 'crmw-tag' }, '场景内置附件'),
            ),
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
          Panel,
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
          ScenarioBadge,
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
          ComposerScenarioBanner,
        ),
      );

      ctx.slots.inject('sidebar.panellist', () => {
        const dispose = ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: PANEL_KEY,
            order: 45,
            label: () => t('CRM 智能工作台'),
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

    return { inject, apply };
  },
});
