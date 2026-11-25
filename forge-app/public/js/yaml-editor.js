import { h } from './dom.js';

const YAML_INDENT = '  ';

function replaceSelection(area, start, end, text, caretStart, caretEnd = caretStart) {
  area.focus();
  area.setSelectionRange(start, end);
  if (!document.execCommand('insertText', false, text)) {
    area.setRangeText(text, start, end, 'end');
    area.dispatchEvent(new Event('input', { bubbles: true }));
  }
  area.setSelectionRange(caretStart, caretEnd);
}

function selectedLines(area) {
  const { value, selectionStart, selectionEnd } = area;
  const start = value.lastIndexOf('\n', selectionStart - 1) + 1;
  const last = selectionEnd > selectionStart && value[selectionEnd - 1] === '\n' ? selectionEnd - 1 : selectionEnd;
  const lineEnd = value.indexOf('\n', last);
  const end = lineEnd === -1 ? value.length : lineEnd;
  return { start, end, lines: value.slice(start, end).split('\n') };
}

function shiftLines(area, outdent) {
  const { start, end, lines } = selectedLines(area);
  const shifted = lines.map((line) => {
    if (!outdent) return line ? YAML_INDENT + line : line;
    return line.slice(Math.min(YAML_INDENT.length, line.length - line.trimStart().length));
  });
  const text = shifted.join('\n');
  const delta = shifted[0].length - lines[0].length;
  if (area.selectionStart !== area.selectionEnd) {
    replaceSelection(area, start, end, text, start, start + text.length);
    return;
  }
  const caret = Math.max(start, area.selectionStart + delta);
  replaceSelection(area, start, end, text, caret);
}

function newLine(area) {
  const { value, selectionStart, selectionEnd } = area;
  const line = value.slice(value.lastIndexOf('\n', selectionStart - 1) + 1, selectionStart);
  const indent = line.match(/^ */)[0];
  const content = line.trimStart();
  const comment = content.startsWith('#');
  const opensBlock = !comment && /:\s*(\|[-+]?|>[-+]?)?\s*$/.test(line);
  const mappingItem = !comment && content.startsWith('- ') && /^- [^\s#][^:]*:(\s|$)/.test(content);
  const text = `\n${indent}${mappingItem ? '  ' : ''}${opensBlock ? YAML_INDENT : ''}`;
  replaceSelection(area, selectionStart, selectionEnd, text, selectionStart + text.length);
}

function pasteYaml(area, e) {
  const pasted = e.clipboardData?.getData('text/plain');
  if (!pasted?.includes('\t')) return;
  e.preventDefault();
  const text = pasted.replace(/^[\t ]+/gm, (lead) => lead.replace(/\t/g, YAML_INDENT));
  replaceSelection(area, area.selectionStart, area.selectionEnd, text, area.selectionStart + text.length);
}

export function yamlEditor(area) {
  area.addEventListener('keydown', (e) => {
    if (area.readOnly || e.ctrlKey || e.altKey || e.metaKey || e.isComposing) return;
    if (e.key === 'Tab') {
      e.preventDefault();
      if (e.shiftKey || area.selectionStart !== area.selectionEnd) shiftLines(area, e.shiftKey);
      else replaceSelection(area, area.selectionStart, area.selectionEnd, YAML_INDENT, area.selectionStart + YAML_INDENT.length);
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      newLine(area);
    }
  });
  area.addEventListener('paste', (e) => { if (!area.readOnly) pasteYaml(area, e); });
  return area;
}

export function lineMarker(area) {
  const band = h('div', { class: 'code-error-line', 'aria-hidden': 'true' });
  let line = 0;
  let lastLine = 0;
  const metrics = () => {
    const style = getComputedStyle(area);
    return { style, lineHeight: parseFloat(style.lineHeight), padTop: parseFloat(style.paddingTop), borderTop: parseFloat(style.borderTopWidth) };
  };
  const place = () => {
    if (!line || !area.isConnected) {
      band.remove();
      return;
    }
    if (!band.isConnected) {
      area.parentElement.classList.add('code-marked');
      area.after(band);
    }
    const { style, lineHeight, padTop, borderTop } = metrics();
    const top = padTop + (line - 1) * lineHeight - area.scrollTop;
    const visibleTop = Math.max(top, 0);
    const visibleBottom = Math.min(top + (lastLine - line + 1) * lineHeight, area.clientHeight);
    band.hidden = visibleBottom <= visibleTop;
    Object.assign(band.style, {
      top: `${area.offsetTop + borderTop + visibleTop}px`,
      left: `${area.offsetLeft + parseFloat(style.borderLeftWidth)}px`,
      width: `${area.clientWidth}px`,
      height: `${visibleBottom - visibleTop}px`,
    });
  };
  area.addEventListener('scroll', place);
  area.addEventListener('input', () => {
    line = 0;
    place();
  });
  new ResizeObserver(place).observe(area);
  return {
    show(target, last = target) {
      line = target;
      lastLine = Math.max(target, last);
      const { lineHeight, padTop } = metrics();
      const lines = area.value.split('\n');
      const caret = lines.slice(0, target - 1).reduce((n, l) => n + l.length + 1, 0);
      area.focus({ preventScroll: true });
      area.setSelectionRange(caret, caret);
      area.scrollTop = Math.max(0, padTop + (target - 1) * lineHeight - area.clientHeight / 3);
      place();
    },
    clear() {
      line = 0;
      place();
    },
  };
}
