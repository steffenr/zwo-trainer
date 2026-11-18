// Markup for css/components/dialog.css: the dialog header (title left, tools and ✕ right).
import { html, tHtml } from '../html.js';
import { IC } from './icons.js';

/** The ✕ button; dialogs close on [data-a=close]. */
export const closeBtn = () => html`<button class="icon-btn" data-a="close" aria-label="${tHtml('close')}">${IC.x}</button>`;

/** Header row. `title` is escaped text or a fragment; `tools` (optional fragment) sits left of ✕. */
export const dialogHead = (title, tools = null) => html`<div class="pv-head"><h2>${title}</h2>${tools}${closeBtn()}</div>`;
