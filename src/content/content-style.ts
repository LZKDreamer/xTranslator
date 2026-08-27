import { DESIGN_TOKEN } from "../shared/design-tokens";
import { XTRANSLATOR_DOM, YOUTUBE_PAGE_SELECTOR } from "../shared/youtube/youtube-page-contract";

const CONTENT_STYLE = `
  .xtranslator-player-mount { position: relative; display: flex; flex: 0 0 36px; align-items: center; min-width: 36px; height: 100%; margin-right: 4px; }
  .xtranslator-shorts-player-mount { position: absolute; top: 24px; right: 152px; z-index: 5; height: 32px; margin: 0; }
  .xtranslator-shorts-player-mount .xtranslator-status { top: calc(100% + 8px); bottom: auto; }
  /* Shorts keeps CC/fullscreen controls outside the light-DOM child list, but
     the visible toolbar is the positioned parent below. Pin our child within
     that toolbar instead of letting its flex layout push it over fullscreen. */
  #shorts-player .ytp-chrome-top-buttons > [data-xtranslator-mount="player"] { position: absolute; top: 0; right: 160px; z-index: 1; display: flex; flex: 0 0 44px; align-items: center; justify-content: center; width: 44px; min-width: 44px; height: 44px; margin: 0; background: transparent; }
  .xtranslator-control { display: grid; flex: 0 0 32px; width: 32px; height: 32px; padding: 0; color: ${DESIGN_TOKEN.color.textOnDark}; border: 1px solid transparent; border-radius: ${DESIGN_TOKEN.radius.control}; background: transparent; box-shadow: none; place-items: center; cursor: pointer; transition: background ${DESIGN_TOKEN.duration.fast}, border-color ${DESIGN_TOKEN.duration.fast}, transform ${DESIGN_TOKEN.duration.fast}; }
  .xtranslator-control svg { display: block; width: 18px; height: 18px; }
  .xtranslator-brand-mark { display: block; object-fit: contain; }
  .xtranslator-control .xtranslator-brand-mark { display: block !important; visibility: visible !important; width: 20px; height: 20px; border-radius: 6px; opacity: 1 !important; }
  .xtranslator-control:hover { border-color: rgba(255, 255, 255, 0.22); background: rgba(255, 255, 255, 0.14); transform: translateY(-1px); }
  .xtranslator-control:focus-visible { outline: 2px solid ${DESIGN_TOKEN.color.accentMix}; outline-offset: 2px; }
  .xtranslator-control:disabled { cursor: progress; opacity: .72; }
  .xtranslator-status { position: absolute; right: 0; bottom: calc(100% + 8px); box-sizing: border-box; display: flex; align-items: center; gap: 6px; max-width: 320px; padding: 8px 12px; color: ${DESIGN_TOKEN.color.textOnDark}; border: 1px solid ${DESIGN_TOKEN.color.borderGlassDark}; border-radius: ${DESIGN_TOKEN.radius.control}; background: ${DESIGN_TOKEN.color.surfaceGlassDark}; box-shadow: ${DESIGN_TOKEN.shadow.float}; backdrop-filter: blur(${DESIGN_TOKEN.blur.glass}); font: 13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .xtranslator-status svg { display: block; width: 14px; height: 14px; flex: none; }
  .xtranslator-status[data-tone="error"] { background: ${DESIGN_TOKEN.color.surfaceGlassDarkStrong}; }
  .xtranslator-spin { animation: xtranslator-rotate 0.8s linear infinite; }
  .xtranslator-translation { margin-top: 8px; color: ${DESIGN_TOKEN.color.textSecondary}; font: 14px/20px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
  .xtranslator-title-translation { min-height: 40px; }
  .xtranslator-title-translation[data-state="loading"] { opacity: .78; }
  .xtranslator-title-translation[data-state="error"] { color: ${DESIGN_TOKEN.color.danger}; }
  .xtranslator-title-translation[data-state="failed"] { display: flex; align-items: center; gap: 8px; color: ${DESIGN_TOKEN.color.danger}; }
  .xtranslator-title-retry { min-height: 32px; padding: 0 10px; color: inherit; border: 1px solid currentColor; border-radius: ${DESIGN_TOKEN.radius.control}; background: transparent; cursor: pointer; font: 600 12px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
  .xtranslator-title-retry:hover { background: rgba(214, 48, 49, .08); }
  .xtranslator-title-retry:focus-visible { outline: 2px solid ${DESIGN_TOKEN.color.accentMix}; outline-offset: 1px; }
  .xtranslator-description-translation { margin: 12px 0 4px; }
  .xtranslator-description-action { display: inline-flex; align-items: center; gap: 6px; min-height: 32px; padding: 0 12px 0 8px; color: ${DESIGN_TOKEN.color.textOnDark}; border: 1px solid ${DESIGN_TOKEN.color.borderGlassDark}; border-radius: 999px; background: ${DESIGN_TOKEN.color.surfaceGlassDark}; box-shadow: 0 3px 10px rgba(25, 35, 69, .22); cursor: pointer; font: 600 12px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; transition: background ${DESIGN_TOKEN.duration.fast}, box-shadow ${DESIGN_TOKEN.duration.fast}, transform ${DESIGN_TOKEN.duration.fast}; }
  .xtranslator-description-action .xtranslator-brand-mark { width: 16px; height: 16px; flex: none; border-radius: 5px; }
  .xtranslator-description-action:hover { box-shadow: 0 5px 14px rgba(25, 35, 69, .28); transform: translateY(-1px); }
  .xtranslator-description-action:focus-visible { outline: 2px solid ${DESIGN_TOKEN.color.accentMix}; outline-offset: 1px; }
  .xtranslator-description-action:disabled { cursor: progress; opacity: .72; }
  .xtranslator-description-result { margin-top: 8px; padding: 9px 12px; color: ${DESIGN_TOKEN.color.textPrimary}; border: 1px solid rgba(91, 108, 153, .16); border-left: 3px solid ${DESIGN_TOKEN.color.accentViolet}; border-radius: 8px; background: ${DESIGN_TOKEN.color.surfaceGlassLightStrong}; font: 13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; white-space: pre-wrap; }
  .xtranslator-description-translation[data-state="failed"] .xtranslator-description-result { color: ${DESIGN_TOKEN.color.danger}; border-left-color: ${DESIGN_TOKEN.color.danger}; }
  .xtranslator-caption { position: absolute; inset: auto; box-sizing: border-box; z-index: 10000; padding: 0 2%; pointer-events: none; text-align: center; }
  .xtranslator-caption[hidden] { display: none; }
  .xtranslator-caption-card { position: absolute; bottom: var(--xtranslator-caption-bottom, 4.25rem); left: 50%; box-sizing: border-box; display: flex; flex-direction: column; align-items: center; gap: 2px; width: fit-content; max-width: min(92%, 72rem); padding: 5px 14px 6px; border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 8px; background: rgba(0, 0, 0, 0.62); box-shadow: 0 2px 12px rgba(0, 0, 0, 0.22); pointer-events: auto; touch-action: none; user-select: none; cursor: grab; transform: translateX(-50%); }
  .xtranslator-caption-card[data-position="manual"] { bottom: auto; }
  .xtranslator-caption-card[data-dragging="true"] { cursor: grabbing; }
  .xtranslator-caption-line { box-sizing: border-box; display: block; width: 100%; max-width: 100%; padding: 0; color: #ffffff; font-family: -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; font-size: clamp(15px, 1.35vw, 18px); line-height: 1.25; text-shadow: 0 1px 2px rgba(0, 0, 0, 0.85); white-space: normal; overflow-wrap: break-word; word-break: normal; text-wrap: pretty; }
  .xtranslator-caption-original { color: var(--xtranslator-caption-original-color, #ececf0); font-size: clamp(calc(13px * var(--xtranslator-caption-original-scale, 1)), calc(1.05vw * var(--xtranslator-caption-original-scale, 1)), calc(15px * var(--xtranslator-caption-original-scale, 1))); }
  .xtranslator-caption-translation { color: var(--xtranslator-caption-translation-color, #ffd438); font-size: clamp(calc(16px * var(--xtranslator-caption-translation-scale, 1)), calc(1.4vw * var(--xtranslator-caption-translation-scale, 1)), calc(19px * var(--xtranslator-caption-translation-scale, 1))); font-weight: 700; }
  /* Shorts uses a narrow portrait player, so its subtitle size is intentionally
     fixed and independent from the regular-video preference sliders. */
  .xtranslator-caption[data-layout="shorts"] .xtranslator-caption-original { font-size: 15px; }
  .xtranslator-caption[data-layout="shorts"] .xtranslator-caption-translation { font-size: 19px; }
  body.xtranslator-captions-suppressed ${YOUTUBE_PAGE_SELECTOR.captionWindow} { visibility: hidden !important; }
  .${XTRANSLATOR_DOM.nativeCaptionSuppressedClass} { visibility: hidden !important; }
  .xtranslator-comments-control { display: flex; align-items: center; margin: 12px 0 4px; }
  .xtranslator-comment-controls { display: flex; align-items: center; gap: 6px; margin-top: 2px; }
  .xtranslator-comment-action { position: relative; z-index: 1; display: inline-flex; align-items: center; gap: 5px; min-height: 32px; padding: 0 11px; color: ${DESIGN_TOKEN.color.textPrimary}; border: 1px solid rgba(86, 102, 148, .18); border-radius: ${DESIGN_TOKEN.radius.control}; background: ${DESIGN_TOKEN.color.surfaceGlassLightStrong}; box-shadow: inset 0 1px 0 rgba(255, 255, 255, .78); cursor: pointer; font: 600 12px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; pointer-events: auto; transition: background ${DESIGN_TOKEN.duration.fast}, box-shadow ${DESIGN_TOKEN.duration.fast}, transform ${DESIGN_TOKEN.duration.fast}; }
  /* The batch action is moved beside the first visible top-level comment by the
     controller. It must stay in normal flow: sticky positioning flickers when
     YouTube reflows or virtualizes the last comment container. */
  [data-xtranslator-mount="comment-batch-control"] { position: relative; z-index: 2; }
  [data-xtranslator-mount="comment-batch-control"].xtranslator-comment-action { color: ${DESIGN_TOKEN.color.textOnDark}; border-color: rgba(255, 255, 255, .32); background: ${DESIGN_TOKEN.color.accentViolet}; box-shadow: 0 4px 12px rgba(60, 55, 142, .2); }
  .xtranslator-comment-action > * { pointer-events: none; }
  .xtranslator-comment-action svg { width: 12px; height: 12px; flex: none; }
  .xtranslator-comment-action .xtranslator-brand-mark { width: 16px; height: 16px; flex: none; border-radius: 5px; }
  .xtranslator-comment-action:hover { background: rgba(255, 255, 255, .96); box-shadow: inset 0 1px 0 rgba(255, 255, 255, .88), 0 3px 10px rgba(41, 52, 84, .12); transform: translateY(-1px); }
  [data-xtranslator-mount="comment-batch-control"].xtranslator-comment-action:hover { background: #6955ed; }
  .xtranslator-comment-action:focus-visible { outline: 2px solid ${DESIGN_TOKEN.color.accentMix}; outline-offset: 1px; }
  .xtranslator-comment-action[data-state="loading"] { cursor: progress; opacity: .72; }
  .xtranslator-comment-action[data-state="error"] { color: ${DESIGN_TOKEN.color.danger}; }
  .xtranslator-comment-translation { box-sizing: border-box; max-width: 100%; margin-top: 6px; padding: 8px 12px; color: ${DESIGN_TOKEN.color.textPrimary}; border: 1px solid rgba(86, 102, 148, .14); border-left: 3px solid ${DESIGN_TOKEN.color.accentViolet}; border-radius: 8px; background: ${DESIGN_TOKEN.color.surfaceGlassLightStrong}; font: 13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
  .xtranslator-comment-retry { padding: 0; color: inherit; border: 0; background: transparent; cursor: pointer; font: inherit; text-align: left; }
  .xtranslator-comment-retry:hover { text-decoration: underline; }
  .xtranslator-comment-retry:focus-visible { outline: 2px solid ${DESIGN_TOKEN.color.accentMix}; outline-offset: 2px; border-radius: 3px; }
  .xtranslator-comment-retry[data-state="loading"] { cursor: progress; opacity: .72; }
  .xtranslator-comment-translation[data-state="failed"] { color: ${DESIGN_TOKEN.color.danger}; border-left-color: ${DESIGN_TOKEN.color.danger}; }
  .xtranslator-selection-pill { position: fixed; z-index: 100010; display: flex; align-items: center; gap: 4px; box-sizing: border-box; padding: 4px; color: ${DESIGN_TOKEN.color.textOnDark}; border: 1px solid ${DESIGN_TOKEN.color.borderGlassDark}; border-radius: 999px; background: ${DESIGN_TOKEN.color.surfaceGlassDark}; box-shadow: ${DESIGN_TOKEN.shadow.float}; backdrop-filter: blur(${DESIGN_TOKEN.blur.glass}); }
  .xtranslator-selection-pill[hidden] { display: none; }
  .xtranslator-selection-result { position: fixed; z-index: 100011; display: grid; gap: 8px; box-sizing: border-box; width: min(360px, calc(100vw - 16px)); padding: 10px 12px; color: ${DESIGN_TOKEN.color.textOnDark}; border: 1px solid ${DESIGN_TOKEN.color.borderGlassDark}; border-radius: ${DESIGN_TOKEN.radius.panel}; background: ${DESIGN_TOKEN.color.surfaceGlassDarkStrong}; box-shadow: ${DESIGN_TOKEN.shadow.float}; backdrop-filter: blur(${DESIGN_TOKEN.blur.glass}); font: 14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
  .xtranslator-selection-result[hidden] { display: none; }
  .xtranslator-selection-result[data-state="loading"] .xtranslator-selection-result-text { color: ${DESIGN_TOKEN.color.textOnDark}; opacity: .8; }
  .xtranslator-selection-result[data-state="error"] .xtranslator-selection-result-text { color: ${DESIGN_TOKEN.color.textOnDark}; }
  .xtranslator-selection-result-actions { display: flex; align-items: center; justify-content: flex-end; gap: 4px; }
  .xtranslator-selection-action { display: grid; width: 32px; height: 32px; padding: 0; color: ${DESIGN_TOKEN.color.textOnDark}; border: 0; border-radius: ${DESIGN_TOKEN.radius.control}; background: transparent; place-items: center; cursor: pointer; }
  .xtranslator-selection-action svg { display: block; width: 15px; height: 15px; }
  .xtranslator-selection-action:hover { background: rgba(255, 255, 255, 0.12); }
  .xtranslator-selection-action:focus-visible { outline: 2px solid ${DESIGN_TOKEN.color.accentMix}; outline-offset: 1px; }
  .xtranslator-selection-primary { display: inline-flex; align-items: center; gap: 4px; width: auto; padding: 0 10px; color: ${DESIGN_TOKEN.color.textOnDark}; background: ${DESIGN_TOKEN.color.accentViolet}; font-size: 12px; font-weight: 600; }
  .xtranslator-selection-primary:hover { background: ${DESIGN_TOKEN.color.accentViolet}; filter: brightness(1.08); }
  .xtranslator-selection-primary svg { width: 13px; height: 13px; }
  .xtranslator-selection-result-text { display: flex; align-items: flex-start; gap: 6px; color: ${DESIGN_TOKEN.color.textOnDark}; overflow-wrap: anywhere; white-space: pre-wrap; }
  .xtranslator-selection-result-text svg { width: 14px; height: 14px; flex: none; margin-top: 2px; }
  @keyframes xtranslator-rotate { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .xtranslator-control, .xtranslator-description-action, .xtranslator-comment-action { transition: none; } .xtranslator-control:hover, .xtranslator-description-action:hover, .xtranslator-comment-action:hover { transform: none; } .xtranslator-spin { animation: none; } }
`;

export function ensureContentStyle(documentNode: Document): void {
  if (documentNode.getElementById(XTRANSLATOR_DOM.styleId)) {
    return;
  }

  const style = documentNode.createElement("style");
  style.id = XTRANSLATOR_DOM.styleId;
  style.textContent = CONTENT_STYLE;
  documentNode.head.append(style);
}
