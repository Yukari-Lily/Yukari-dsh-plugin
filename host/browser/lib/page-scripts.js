/**
 * In-page JavaScript the browser tools evaluate through `Runtime.evaluate`.
 *
 * Everything here is a string so it can cross the protocol boundary; the
 * shared prelude keeps element collection, labelling, and target resolution
 * identical between the snapshot and the action tools.
 * @module @local/browser-control/page-scripts
 */

/** Selectors for the interactive elements a snapshot advertises. */
const INTERACTIVE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button',
  'input:not([type="hidden"])',
  'select',
  'textarea',
  'summary',
  'label[for]',
  '[role="button"]',
  '[role="link"]',
  '[role="tab"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="combobox"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="searchbox"]',
  '[role="textbox"]',
  '[role="spinbutton"]',
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[onclick]',
].join(',')

/** Helpers shared by every expression; `elementIndex` makes refs stable. */
const PRELUDE = `
const SELECTOR = ${JSON.stringify(INTERACTIVE_SELECTOR)};
const clean = (value) => String(value == null ? '' : value).replace(/\\s+/g, ' ').trim();
const isVisible = (el) => {
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  const style = getComputedStyle(el);
  return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
};
const textOf = (el) => clean(el.innerText || el.textContent || '');
const nameOf = (el) => {
  const tag = el.tagName.toLowerCase();
  const labelledBy = clean(el.getAttribute('aria-labelledby'))
    ? clean(el.getAttribute('aria-labelledby')).split(/\\s+/).map((id) => {
        const target = document.getElementById(id);
        return target ? textOf(target) : '';
      }).join(' ')
    : '';
  const candidates = [
    clean(el.getAttribute('aria-label')),
    labelledBy,
    clean(el.getAttribute('placeholder')),
    clean(el.getAttribute('title')),
    clean(el.getAttribute('alt')),
    tag === 'input' && /^(button|submit|reset)$/i.test(el.type || '') ? clean(el.value) : '',
    textOf(el),
    tag === 'input' || tag === 'textarea' ? clean(el.value) : '',
    clean(el.getAttribute('name')),
  ];
  for (const candidate of candidates) {
    if (candidate) return candidate.slice(0, 140);
  }
  return '';
};
const collect = () => Array.from(document.querySelectorAll(SELECTOR));
const describe = (el, index) => {
  const tag = el.tagName.toLowerCase();
  const value = typeof el.value === 'string' ? el.value : '';
  const rect = el.getBoundingClientRect();
  return {
    ref: 'e' + index,
    tag,
    role: clean(el.getAttribute('role')) || undefined,
    type: clean(el.getAttribute('type')) || undefined,
    name: nameOf(el),
    value: value ? value.slice(0, 120) : undefined,
    href: clean(el.getAttribute('href')) || undefined,
    disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
    checked: el.checked === true || el.getAttribute('aria-checked') === 'true' || undefined,
    visible: isVisible(el),
    box: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
  };
};
const resolveTarget = (target) => {
  if (!target) return null;
  const list = collect();
  if (target.ref) {
    const index = Number.parseInt(String(target.ref).replace(/^e/i, ''), 10);
    if (!Number.isInteger(index) || index < 0 || index >= list.length) return null;
    return list[index];
  }
  if (target.selector) {
    try {
      return document.querySelector(target.selector);
    } catch {
      return null;
    }
  }
  if (target.text) {
    const needle = String(target.text).toLowerCase();
    const byText = list.find((el) => textOf(el).toLowerCase().includes(needle));
    if (byText) return byText;
    return list.find((el) => nameOf(el).toLowerCase().includes(needle)) || null;
  }
  return null;
};
const centerOf = (el) => {
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const rect = el.getBoundingClientRect();
  return {
    x: Math.round(rect.x + rect.width / 2),
    y: Math.round(rect.y + rect.height / 2),
    inside: rect.top >= 0 && rect.left >= 0 && rect.bottom <= (window.innerHeight || 0) && rect.right <= (window.innerWidth || 0),
  };
};
const describeTarget = (el) => ({ tag: el.tagName.toLowerCase(), name: nameOf(el), text: textOf(el).slice(0, 80) });
`

/**
 * Build a report of the current page: address, readable text, and the
 * interactive elements with stable `e<n>` refs.
 * @param options - text and element caps.
 * @returns an evaluable expression.
 */
export function snapshotExpression(options = {}) {
  const maxText = options.maxText ?? 12000
  const maxElements = options.maxElements ?? 120
  return `(() => {
${PRELUDE}
const maxText = ${JSON.stringify(maxText)};
const maxElements = ${JSON.stringify(maxElements)};
const all = collect();
const elements = all.map(describe).filter((entry) => entry.visible && (entry.name || entry.tag !== 'a')).slice(0, maxElements);
const text = document.body ? (document.body.innerText || document.body.textContent || '') : '';
const normalized = clean(text);
const selection = window.getSelection ? clean(String(window.getSelection())) : '';
return {
  url: location.href,
  title: document.title,
  readyState: document.readyState,
  text: normalized.slice(0, maxText),
  textTruncated: normalized.length > maxText,
  textLength: normalized.length,
  selection: selection.slice(0, 400) || undefined,
  scroll: { y: Math.round(window.scrollY), height: Math.round(document.documentElement.scrollHeight), viewport: Math.round(window.innerHeight) },
  elements,
  elementCount: all.length,
  forms: Array.from(document.querySelectorAll('input,textarea,select')).length,
};
})()`
}

/**
 * Resolve a target and report where to click it.
 * @param target - `{ ref }`, `{ selector }`, or `{ text }`.
 * @returns an evaluable expression.
 */
export function resolveExpression(target) {
  return `(() => {
${PRELUDE}
const el = resolveTarget(${JSON.stringify(target)});
if (!el) return { found: false };
const center = centerOf(el);
return { found: true, ...describeTarget(el), ...center, disabled: el.disabled === true, value: typeof el.value === 'string' ? el.value.slice(0, 200) : undefined };
})()`
}

/**
 * Focus and clear a field before text is inserted by the protocol.
 * @param target - `{ ref }`, `{ selector }`, or `{ text }`.
 * @returns an evaluable expression.
 */
export function focusExpression(target) {
  return `(() => {
${PRELUDE}
const el = resolveTarget(${JSON.stringify(target)});
if (!el) return { found: false };
el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
if (typeof el.focus === 'function') el.focus();
const editable = el.isContentEditable === true || /^(input|textarea)$/i.test(el.tagName);
if (el.isContentEditable) {
  const range = document.createRange();
  range.selectNodeContents(el);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
} else if (editable) {
  const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value');
  if (setter && setter.set) setter.set.call(el, ''); else el.value = '';
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}
return { found: true, ...describeTarget(el), editable: !!editable || el.isContentEditable === true, readOnly: el.readOnly === true || el.disabled === true };
})()`
}

/**
 * Read back the value the page currently holds for a target.
 * @param target - `{ ref }`, `{ selector }`, or `{ text }`.
 * @returns an evaluable expression.
 */
export function valueExpression(target) {
  return `(() => {
${PRELUDE}
const el = resolveTarget(${JSON.stringify(target)});
if (!el) return { found: false };
return {
  found: true,
  value: typeof el.value === 'string' ? el.value : textOf(el).slice(0, 400),
  checked: el.checked === true || undefined,
};
})()`
}

/** Move the viewport by wheel deltas. */
export function scrollExpression() {
  return `(() => {
${PRELUDE}
return { y: Math.round(window.scrollY), height: Math.round(document.documentElement.scrollHeight), viewport: Math.round(window.innerHeight) };
})()`
}
