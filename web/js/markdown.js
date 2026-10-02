// Markdown ответа Claude: разбор в дерево (чистые функции — тестируются в node) и сборка DOM.
// Только через DOM: на странице CSP и запрет innerHTML — ни строки разметки из ответа модели.
(function (root) {
  const SAFE_URL = /^(https?:\/\/|mailto:)/i;
  const INLINE = [
    { re: /`([^`\n]+)`/, make: m => ({ t: "code", text: m[1] }) },
    { re: /\[([^\]\n]+)\]\(([^)\s]+)\)/, make: m => ({ t: "link", href: m[2], kids: parseInline(m[1]) }) },
    { re: /\*\*([^*\n][^\n]*?)\*\*/, make: m => ({ t: "strong", kids: parseInline(m[1]) }) },
    { re: /__([^_\n][^\n]*?)__/, make: m => ({ t: "strong", kids: parseInline(m[1]) }) },
    { re: /~~([^~\n]+)~~/, make: m => ({ t: "del", kids: parseInline(m[1]) }) },
    // *курсив*, но не маркер списка и не умножение с пробелами вокруг
    { re: /(^|[^\w*])\*([^*\s][^*\n]*?)\*(?!\w)/,
      make: m => [{ t: "text", text: m[1] }, { t: "em", kids: parseInline(m[2]) }] },
    { re: /https?:\/\/[^\s<>()\]]+[^\s<>()\].,;:!?'"»]/,
      make: m => ({ t: "link", href: m[0], kids: [{ t: "text", text: m[0] }] }) },
  ];
  const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
  const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

  // Строка в узлы: ищем самое раннее совпадение среди правил, остальное — текст.
  function parseInline(text) {
    const out = [];
    let rest = String(text);
    while (rest) {
      let best = null;
      for (const rule of INLINE) {
        const m = rule.re.exec(rest);
        if (m && (!best || m.index < best.m.index)) best = { m, rule };
      }
      if (!best) { out.push({ t: "text", text: rest }); break; }
      if (best.m.index) out.push({ t: "text", text: rest.slice(0, best.m.index) });
      const made = best.rule.make(best.m);
      (Array.isArray(made) ? made : [made]).forEach(n => { if (n.t !== "text" || n.text) out.push(n); });
      rest = rest.slice(best.m.index + best.m[0].length);
    }
    return out;
  }

  function cells(line) {
    return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(c => c.trim());
  }

  const isTable = (lines, i) => lines[i].includes("|") && i + 1 < lines.length
    && TABLE_SEP.test(lines[i + 1]);

  function parseMarkdown(text) {
    const blocks = [];
    const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      if (/^\s*```/.test(line)) {                          // блок кода
        const body = [];
        i++;
        while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
        i++;
        blocks.push({ t: "pre", text: body.join("\n") });
        continue;
      }
      const heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        blocks.push({ t: "h", level: Math.min(6, heading[1].length + 3), kids: parseInline(heading[2]) });
        i++;
        continue;
      }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { blocks.push({ t: "hr" }); i++; continue; }
      if (isTable(lines, i)) {
        const head = cells(line).map(parseInline);
        const rows = [];
        i += 2;
        while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(cells(lines[i++]).map(parseInline));
        blocks.push({ t: "table", head, rows });
        continue;
      }
      if (/^\s*>/.test(line)) {
        const quote = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ""));
        blocks.push({ t: "quote", kids: parseMarkdown(quote.join("\n")) });
        continue;
      }
      if (LIST_RE.test(line)) {
        // Вложенность — по отступу; смена «- …» на «1. …» на том же уровне — новый список.
        const top = [];
        const stack = [];
        while (i < lines.length && (LIST_RE.test(lines[i])
               || (lines[i].trim() && /^\s{2,}/.test(lines[i]) && stack.length))) {
          const m = lines[i].match(LIST_RE);
          if (!m) {                                        // продолжение пункта с отступом
            const items = stack[stack.length - 1].list.items;
            items[items.length - 1].kids.push({ t: "text", text: " " }, ...parseInline(lines[i].trim()));
            i++;
            continue;
          }
          const depth = m[1].replace(/\t/g, "  ").length;
          const ordered = /\d/.test(m[2]);
          while (stack.length && depth < stack[stack.length - 1].depth) stack.pop();
          if (stack.length && depth === stack[stack.length - 1].depth
              && stack[stack.length - 1].list.ordered !== ordered) stack.pop();
          let cur = stack[stack.length - 1];
          if (!cur || depth > cur.depth) {
            const list = { t: "list", ordered, start: ordered ? parseInt(m[2], 10) || 1 : 1, items: [] };
            const parent = cur && cur.list.items[cur.list.items.length - 1];
            if (parent) parent.sub.push(list); else top.push(list);
            cur = { depth, list };
            stack.push(cur);
          }
          cur.list.items.push({ kids: parseInline(m[3]), sub: [] });
          i++;
        }
        blocks.push(...top);
        continue;
      }
      const para = [];                                     // абзац до пустой строки или блока
      while (i < lines.length && lines[i].trim() && !LIST_RE.test(lines[i])
             && !/^\s*(```|#{1,6}\s|>)/.test(lines[i]) && !isTable(lines, i)) {
        para.push(parseInline(lines[i++]));
      }
      blocks.push({ t: "p", lines: para });
    }
    return blocks;
  }

  // --- дерево → DOM ------------------------------------------------------------

  function node(tag, kids) {
    const n = document.createElement(tag);
    (kids || []).forEach(k => n.appendChild(k));
    return n;
  }

  function inlineDom(items) {
    return items.map(it => {
      if (it.t === "text") return document.createTextNode(it.text);
      if (it.t === "code") { const c = node("code"); c.textContent = it.text; return c; }
      if (it.t === "link") {
        if (!SAFE_URL.test(it.href)) return node("span", inlineDom(it.kids));
        const a = node("a", inlineDom(it.kids));
        a.href = it.href;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        return a;
      }
      return node(it.t, inlineDom(it.kids));               // strong, em, del
    });
  }

  function blockDom(b) {
    if (b.t === "pre") { const c = node("code"); c.textContent = b.text; return node("pre", [c]); }
    if (b.t === "h") return node("h" + b.level, inlineDom(b.kids));
    if (b.t === "hr") return node("hr");
    if (b.t === "quote") return node("blockquote", b.kids.map(blockDom));
    if (b.t === "table") {
      const head = node("tr", b.head.map(c => node("th", inlineDom(c))));
      const body = node("tbody", b.rows.map(r => node("tr", r.map(c => node("td", inlineDom(c))))));
      const box = node("div", [node("table", [node("thead", [head]), body])]);
      box.className = "tbl";
      return box;
    }
    if (b.t === "list") {
      const list = node(b.ordered ? "ol" : "ul", b.items.map(it =>
        node("li", [...inlineDom(it.kids), ...it.sub.map(blockDom)])));
      if (b.ordered) list.start = b.start;
      return list;
    }
    const p = node("p");                                   // абзац: строки через <br>
    b.lines.forEach((ln, k) => {
      if (k) p.appendChild(node("br"));
      inlineDom(ln).forEach(n => p.appendChild(n));
    });
    return p;
  }

  function renderMarkdown(text) {
    const frag = document.createDocumentFragment();
    parseMarkdown(text).forEach(b => frag.appendChild(blockDom(b)));
    return frag;
  }

  const api = { parseMarkdown, parseInline, renderMarkdown, SAFE_URL };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof window !== "undefined" ? window : globalThis);
