/**
 * Opmaak.
 *
 * Het paneel leeft in een shadow root, dus die stijlen kunnen niet botsen met
 * Humble of SteamGifts — en andersom evenmin. Alleen de vinkjes die we in hún
 * pagina hangen hebben stijl in het document zelf nodig; die krijgen een eigen
 * voorvoegsel en `all: initial` waar het telt.
 */
'use strict';

(function (root) {
  const HSG = (root.HSG = root.HSG || {});

  /** Gaat in het gastdocument: het vinkje in een key-rij en de zwevende knop. */
  HSG.PAGE_CSS = `
.hsg-row-check {
  display: inline-flex !important;
  align-items: center;
  gap: 6px;
  margin-right: 10px;
  padding: 3px 8px;
  border-radius: 999px;
  background: rgba(20, 22, 28, 0.9);
  color: #f2f4f8;
  font: 600 11px/1 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  vertical-align: middle;
  cursor: pointer;
  user-select: none;
}
.hsg-row-check input {
  width: 13px;
  height: 13px;
  margin: 0;
  accent-color: #2f7de1;
  cursor: pointer;
}
.hsg-row-check.is-unavailable {
  opacity: 0.5;
  cursor: default;
}
.hsg-launcher {
  position: fixed;
  right: 18px;
  bottom: 18px;
  z-index: 2147483000;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 10px 15px;
  border: 0;
  border-radius: 999px;
  background: #2f7de1;
  color: #fff;
  font: 600 13px/1 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);
  cursor: pointer;
}
.hsg-launcher__count {
  padding: 2px 7px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.25);
}
`;

  /** Gaat in de shadow root van het paneel. */
  HSG.PANEL_CSS = `
:host { all: initial; }
* { box-sizing: border-box; }

.wrap {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  width: 380px;
  max-width: 100vw;
  z-index: 2147483001;
  display: flex;
  flex-direction: column;
  background: #16181d;
  color: #eef1f6;
  font: 400 13px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  box-shadow: -8px 0 30px rgba(0, 0, 0, 0.45);
}
.wrap[hidden] { display: none; }

header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 14px 8px;
}
h1 { flex: 1 1 auto; margin: 0; font-size: 15px; }
.summary { margin: 0 14px 8px; color: #9aa4b4; font-size: 12px; }

.tabs { display: flex; gap: 4px; padding: 0 14px; border-bottom: 1px solid #2c313a; }
.tab {
  padding: 7px 9px;
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: #9aa4b4;
  font: inherit;
  cursor: pointer;
}
.tab.is-active { border-bottom-color: #4b93ea; color: #eef1f6; font-weight: 600; }

.body { flex: 1 1 auto; overflow-y: auto; padding: 12px 14px 24px; }
.panel { display: none; }
.panel.is-active { display: block; }

.actions { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
.btn {
  padding: 6px 11px;
  border: 1px solid #2c313a;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.btn:hover:not(:disabled) { background: #1d2027; }
.btn:disabled { opacity: 0.5; cursor: default; }
.btn--primary { border-color: transparent; background: #4b93ea; color: #fff; font-weight: 600; }
.btn--danger { color: #e0675e; }
.btn--tiny { padding: 2px 7px; font-size: 12px; }
.btn--icon { padding: 4px 9px; }

.notice {
  margin: 0 0 10px;
  padding: 8px 10px;
  border-left: 3px solid #d9a33c;
  border-radius: 4px;
  background: #1d2027;
  font-size: 12px;
}
.notice[data-tone='error'] { border-left-color: #e0675e; }
.notice[data-tone='ok'] { border-left-color: #4fbb75; }
.notice[hidden] { display: none; }

.hint, .empty { margin: 8px 0; color: #9aa4b4; font-size: 12px; }
.hint--warn { color: #d9a33c; }

.filter, input[type='number'], input[type='text'], select, textarea {
  display: block;
  width: 100%;
  margin-top: 3px;
  padding: 6px 8px;
  border: 1px solid #2c313a;
  border-radius: 6px;
  background: #16181d;
  color: inherit;
  font: inherit;
}
textarea { resize: vertical; }

ul, ol { margin: 0; padding: 0; list-style: none; }

.item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 6px 0;
  border-bottom: 1px solid #2c313a;
}
.item input[type='checkbox'] { margin-top: 3px; accent-color: #4b93ea; }
.item label { flex: 1 1 auto; overflow-wrap: anywhere; cursor: pointer; }
.tag { color: #9aa4b4; font-size: 11px; }

.queue-item { padding: 9px 0; border-bottom: 1px solid #2c313a; }
.queue-item.is-current { margin: 0 -8px; padding: 9px 8px; border-radius: 6px; background: #1d2027; }
.queue-head { display: flex; align-items: baseline; gap: 6px; }
.queue-name { flex: 1 1 auto; font-weight: 600; overflow-wrap: anywhere; }
.status { font-size: 11px; text-transform: uppercase; letter-spacing: 0.03em; }
.status[data-status='done'] { color: #4fbb75; }
.status[data-status='error'], .status[data-status='needs-choice'] { color: #e0675e; }
.status[data-status='filled'] { color: #d9a33c; }
.queue-meta { color: #9aa4b4; font-size: 12px; overflow-wrap: anywhere; }
.queue-tools { display: flex; gap: 4px; margin-top: 4px; }

fieldset { margin: 0 0 14px; padding: 10px 12px; border: 1px solid #2c313a; border-radius: 8px; }
legend { padding: 0 4px; color: #9aa4b4; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; }
label.row { display: block; margin-bottom: 8px; font-size: 12px; }
label.check { display: flex; align-items: center; gap: 7px; margin-bottom: 8px; font-size: 12px; }
label.check input { width: auto; margin: 0; accent-color: #4b93ea; }

.check-row { display: flex; gap: 7px; padding: 5px 0; border-bottom: 1px solid #2c313a; font-size: 12px; }
.check-row__mark { font-weight: 700; }
.check-row.is-ok .check-row__mark { color: #4fbb75; }
.check-row.is-bad .check-row__mark { color: #e0675e; }
.check-row__body { flex: 1 1 auto; overflow-wrap: anywhere; }
.check-row__detail {
  display: block;
  color: #9aa4b4;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
}
h2 { margin: 14px 0 4px; font-size: 13px; }
`;
})(typeof globalThis !== 'undefined' ? globalThis : window);
