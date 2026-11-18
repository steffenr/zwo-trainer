// Markup for css/components/dialog.css: the dialog header (title left, tools and ✕ right).
import { html, tText } from '../html.js';
import { IC } from './icons.js';

/** The ✕ button (data-act="close", handled by the shared actions in app.js). */
export const closeBtn = () => html`<button class="icon-btn" data-act="close" aria-label="${tText('close')}">${IC.x}</button>`;

/** Header row. `title` is escaped text or a fragment; `tools` (optional fragment) sits left of ✕. */
export const dialogHead = (title, tools = null) => html`<div class="pv-head"><h2>${title}</h2>${tools}${closeBtn()}</div>`;
