'use strict';

(() => {
  const TOKEN = new URLSearchParams(location.search).get('t') || '';
  const MAX_HITS = 5000;

  // ---- language ----
  const I18N = window.CTXPACK_I18N;
  const LANG_KEY = 'ctxpack:lang';
  let lang = (() => {
    try {
      const saved = localStorage.getItem(LANG_KEY);
      if (saved === 'en' || saved === 'uk') return saved;
    } catch {}
    return (navigator.language || '').toLowerCase().startsWith('uk') ? 'uk' : 'en';
  })();
  const t = (key, params = {}) => String(I18N[lang][key] ?? I18N.en[key] ?? key).replace(/\{(\w+)\}/g, (_, k) => (params[k] ?? ''));

  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const fmt = n => (n >= 1000 ? (n / 1000).toFixed(1) + 'K' : String(n));
  const basename = p => p.split('/').pop();
  // Full path on one line: folder (cut from the left when it does not fit), then the file name.
  function pathSpans(p) {
    const i = p.lastIndexOf('/');
    const dir = i > 0 ? p.slice(0, i + 1) : '';
    return `${dir ? `<span class="rd"><bdi>${esc(dir)}</bdi></span>` : ''}<span class="rn">${esc(p.slice(i + 1))}</span>`;
  }
  const pathLabel = p => `<button type="button" class="rp" data-act="peek" data-p="${esc(p)}" aria-label="${esc(t('preview', { path: p }))}">${pathSpans(p)}</button>`;

  async function api(url, body, method) {
    const res = await fetch(url, {
      method: method || (body ? 'POST' : 'GET'),
      headers: { 'content-type': 'application/json', 'x-ctxpack-token': TOKEN, 'x-ctxpack-lang': lang },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }

  const st = {
    name: '', root: '', git: false, files: [], byPath: new Map(), tree: null, dirs: new Map(),
    sel: new Set(), open: new Set(), q: '',
    budgets: {}, budget: 'small', split: false, stripDocs: true, stripComments: false, maxFileKb: 200,
    rules: [], rel: { enabled: true, depth: 1, rules: {} }, depthByRule: {},
    presets: {}, suggestions: [], relGroups: [], relClosed: new Set(), preview: null, exp: null,
    // Blocks of lines removed from selected files: { path: { hash, ranges: [[first, last], …] } } (see src/cuts.js).
    cuts: {}, fOrder: 'size',
    secretAck: false, relSeq: 0, prevSeq: 0, loaded: false,
  };
  const view = {
    mode: null, path: null, text: '', secretLines: new Set(), parts: [], part: 1, marks: [], cur: -1, capped: false,
    file: null, hash: null, rows: [], blocks: [], markerAt: new Map(), anchorRow: null, pending: [],
  };
  let storeKey = 'ctxpack';

  // ---- persistence (per project, per browser) ----
  function loadState() {
    try { return JSON.parse(localStorage.getItem(storeKey) || '{}'); } catch { return {}; }
  }
  function persist() {
    // A file taken out of the selection loses its cuts.
    for (const p of Object.keys(st.cuts)) if (!st.sel.has(p)) delete st.cuts[p];
    try {
      localStorage.setItem(storeKey, JSON.stringify({
        sel: [...st.sel], task: $('task').value, budget: st.budget,
        split: st.split, stripDocs: st.stripDocs, stripComments: st.stripComments, relClosed: [...st.relClosed],
        cuts: st.cuts, fOrder: st.fOrder,
      }));
    } catch {}
  }

  // ---- tree model ----
  function buildTree(files) {
    const root = { name: '', path: '', kids: new Map() };
    st.dirs = new Map();
    for (const f of files) {
      const parts = f.path.split('/');
      let n = root;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!n.kids.has(parts[i])) n.kids.set(parts[i], { name: parts[i], path: parts.slice(0, i + 1).join('/'), kids: new Map() });
        n = n.kids.get(parts[i]);
      }
      n.kids.set(parts[parts.length - 1], { name: parts[parts.length - 1], path: f.path, kids: null, file: f });
    }
    (function index(n) {
      if (!n.kids) return n.file.flag ? [] : [n];
      n.pick = [...n.kids.values()].flatMap(index);
      n.tok = n.pick.reduce((s, l) => s + l.file.tokens, 0);
      st.dirs.set(n.path, n);
      return n.pick;
    })(root);
    return root;
  }

  const pickable = p => { const f = st.byPath.get(p); return !!f && !f.flag; };
  function openAncestors(paths) {
    for (const p of paths) {
      const parts = p.split('/');
      for (let i = 1; i < parts.length; i++) st.open.add(parts.slice(0, i).join('/'));
    }
  }

  // ---- rendering ----
  // Static texts in index.html carry data-i18n* attributes.
  function applyStatic() {
    document.documentElement.lang = lang;
    document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
    document.querySelectorAll('[data-i18n-ph]').forEach(el => { el.placeholder = t(el.dataset.i18nPh); });
    document.querySelectorAll('[data-i18n-aria]').forEach(el => { el.setAttribute('aria-label', t(el.dataset.i18nAria)); });
    document.querySelectorAll('[data-i18n-title]').forEach(el => { el.title = t(el.dataset.i18nTitle); });
    document.querySelectorAll('[data-act="lang"]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === lang)));
  }

  function renderHeader() {
    $('proj').innerHTML = `<b>${esc(st.name)}</b> · ${esc(st.root)}${st.git ? '' : ` · ${esc(t('noGit'))}`}`;
    $('changedBtn').disabled = !st.git;
    $('changedBtn').title = st.git ? t('changedTitle') : t('notGitRepo');
    document.title = `${st.name} · ctxpack`;
  }

  function renderBudgets() {
    $('budgets').innerHTML = Object.entries(st.budgets).map(([name, b]) =>
      `<button type="button" data-act="budget" data-v="${esc(name)}" aria-pressed="${name === st.budget}">${b && b.limit ? `${fmt(b.limit)} · ${esc(name)}` : esc(t('unlimited'))}</button>`).join('');
  }

  function renderPresets() {
    const names = Object.keys(st.presets);
    const current = $('preset').value;
    $('preset').innerHTML = `<option value="">${esc(names.length ? t('presetsPh') : t('noPresets'))}</option>` +
      names.map(n => `<option value="${esc(n)}">${esc(n)} · ${(st.presets[n].include || []).length}</option>`).join('');
    $('preset').value = names.includes(current) ? current : '';
    $('delPreset').hidden = !$('preset').value;
  }

  function renderRules() {
    $('relOn').checked = st.rel.enabled;
    $('depth').value = String(st.rel.depth);
    $('rules').innerHTML = st.rules.map(k =>
      `<label for="r-${k}"><input type="checkbox" id="r-${k}" data-rule="${k}" ${st.rel.rules[k] !== false ? 'checked' : ''}>${esc(t('rule.' + k))}${st.depthByRule[k] ? ` <span class="lvl" title="${esc(t('depthFromConfig'))}">≤${st.depthByRule[k]}</span>` : ''}</label>`).join('');
  }

  function renderTree() {
    const q = st.q.toLowerCase();
    let vis = null;
    if (q) {
      vis = new Set();
      for (const f of st.files) {
        if (!f.path.toLowerCase().includes(q)) continue;
        const parts = f.path.split('/');
        for (let i = 1; i <= parts.length; i++) vis.add(parts.slice(0, i).join('/'));
      }
    }
    const out = [];
    if (st.tree) rows(st.tree, 0, vis, out);
    $('tree').innerHTML = out.join('') || `<div class="empty">${esc(q ? t('nothingFound') : t('noFiles'))}</div>`;
    $('tree').querySelectorAll('[data-indet]').forEach(i => { i.indeterminate = true; });
    $('selCount').textContent = t('selected', { n: st.sel.size });
    $('openAll').textContent = st.open.size ? t('collapse') : t('expandAll');
  }

  function rows(n, d, vis, out) {
    for (const k of n.kids.values()) {
      if (vis && !vis.has(k.path)) continue;
      const p = esc(k.path);
      if (!k.kids) {
        const f = k.file;
        const on = st.sel.has(k.path);
        const tag = f.flag === 'deny' ? `<span class="tag deny">${esc(t('blocked'))}</span>`
          : f.flag === 'big' ? `<span class="tag ign">${esc(t('tooBig', { kb: st.maxFileKb }))}</span>`
          : `<span class="tok">${fmt(f.tokens)}</span>`;
        out.push(`<div class="row${on ? ' is-sel' : ''}${f.flag ? ' off' : ''}" style="--d:${d}"><span class="chev none"></span><input type="checkbox" data-act="toggle" data-p="${p}" ${on ? 'checked' : ''} ${f.flag ? 'disabled' : ''} aria-label="${p}">${f.flag === 'deny' ? `<span class="name" title="${p}">${esc(k.name)}</span>` : `<button type="button" class="name file" data-act="peek" data-p="${p}" title="${esc(t('preview', { path: k.path }))}">${esc(k.name)}</button>`}${tag}</div>`);
        continue;
      }
      const open = !!vis || st.open.has(k.path);
      let c = 0;
      for (const l of k.pick) if (st.sel.has(l.path)) c++;
      const all = k.pick.length > 0 && c === k.pick.length;
      out.push(`<div class="row" style="--d:${d}"><button class="chev" type="button" data-act="open" data-p="${p}" aria-expanded="${open}" aria-label="${esc(t(open ? 'collapseDir' : 'expandDir', { name: k.name }))}"></button><input type="checkbox" data-act="toggleDir" data-p="${p}" ${all ? 'checked' : ''} ${c && !all ? 'data-indet="1"' : ''} ${k.pick.length ? '' : 'disabled'} aria-label="${p}/"><span class="name dir" data-act="open" data-p="${p}">${esc(k.name)}/</span>${k.pick.length ? `<span class="tok">${c ? c + '/' : ''}${k.pick.length} · ${fmt(k.tok)}</span>` : `<span class="tag ign">${esc(t('unavailable'))}</span>`}</div>`);
      if (open) rows(k, d + 1, vis, out);
    }
  }

  function renderRelated() {
    const body = $('relBody');
    const list = st.suggestions;
    hidePop();
    $('relCount').textContent = st.rel.enabled ? t('suggestions', { n: list.length }) : t('off');
    if (!st.rel.enabled) {
      body.innerHTML = `<div class="empty">${esc(t('relOffEmpty'))}</div>`;
      return;
    }
    if (!st.sel.size) {
      body.innerHTML = `<div class="empty">${esc(t('relPickEmpty'))}</div>`;
      return;
    }
    if (!list.length) {
      body.innerHTML = `<div class="empty">${esc(t('relNone'))}</div>`;
      return;
    }
    const sum = list.reduce((s, r) => s + r.tokens, 0);
    const lvl1 = list.filter(r => r.level === 1).length;
    const groups = st.relGroups.map(g => [g, list.filter(r => r.group === g)]).filter(([, items]) => items.length);
    body.innerHTML = `<div class="sug scroll">${groups.map(([g, items]) => {
      const name = t('group.' + g);
      const open = !st.relClosed.has(g);
      const tok = items.reduce((s, r) => s + r.tokens, 0);
      return `<section class="sg">
        <div class="sg-h"><button class="chev" type="button" data-act="relGroup" data-g="${g}" aria-expanded="${open}" aria-label="${esc(t(open ? 'collapseGroup' : 'expandGroup', { name }))}"></button><button class="sg-name" type="button" data-act="relGroup" data-g="${g}">${esc(name)}</button><span class="sg-n">${items.length}</span><span class="tok">${fmt(tok)}</span><button class="btn add-btn" type="button" data-act="addGroup" data-g="${g}" aria-label="${esc(t('addGroup', { name }))}" title="${esc(t('addGroup', { name }))}">+</button></div>
        ${open ? `<ul>${items.map(r => `<li data-i="${list.indexOf(r)}">${pathLabel(r.path)}${r.level > 1 ? `<span class="lvl">L${r.level}</span>` : ''}<span class="tok">${fmt(r.tokens)}</span><button class="btn add-btn" type="button" data-act="addOne" data-p="${esc(r.path)}" aria-label="${esc(t('add', { path: r.path }))}" title="${esc(t('addToSel'))}">+</button></li>`).join('')}</ul>` : ''}
      </section>`;
    }).join('')}</div>
      <div class="sugfoot"><span>${esc(t('totalTokens', { n: fmt(sum) }))}</span><span class="actions">${lvl1 && lvl1 < list.length ? `<button class="btn" type="button" data-act="addLevel1">${esc(t('level1Only', { n: lvl1 }))}</button>` : ''}<button class="btn solid" type="button" data-act="addAll">${esc(t('addAll'))}</button></span></div>`;
  }

  // ---- related: hover popup with the code a file was found from ----
  const pop = { li: null, pt: null, showTimer: 0, hideTimer: 0 };
  const POP_MIN_W = 420;
  const POP_MAX_W = 640;
  const POP_GAP = 18;

  function popHtml(r) {
    const head = `<div class="pop-h"><em>${esc(t('rule.' + r.rule))}</em> · ${esc(r.reason)}${r.level > 1 ? ` · ${esc(t('from', { name: basename(r.from) }))}` : ''}</div>`;
    if (!r.sites.length) return head + `<div class="note">${esc(t('byName'))}</div>`;
    const sites = r.sites.map(s => {
      const hits = new Set(s.lines);
      const code = window.CTXPACK_HL.highlight(s.code, s.file).split('\n')
        .map((line, i) => `<span class="${hits.has(s.start + i) ? 'hit' : ''}"><span class="ln">${s.start + i}</span>${line}</span>`).join('\n');
      return `<div class="pop-f">${esc(s.file)}<span>:${s.lines.join(', ')}</span></div><pre class="code">${code}</pre>`;
    }).join('');
    return head + sites + (r.moreSites ? `<div class="note">${esc(t('morePlaces', { n: r.moreSites }))}</div>` : '');
  }

  // To the right of the cursor (narrowed to fit), or to its left when the right side is too tight.
  // Without a cursor (keyboard focus) it is anchored to the start of the file name.
  function placePop(li, pt) {
    const el = $('relPop');
    const row = li.getBoundingClientRect();
    const { x, y } = pt || { x: li.querySelector('.rn')?.getBoundingClientRect().left ?? row.left, y: row.bottom };
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    const right = vw - x - POP_GAP - 8;
    const onRight = right >= POP_MIN_W || right >= x - POP_GAP - 8;
    el.style.width = `${Math.max(240, Math.min(POP_MAX_W, onRight ? right : x - POP_GAP - 8))}px`;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const left = onRight ? x + POP_GAP : x - POP_GAP - w;
    const top = Math.min(y + 8, vh - h - 8);
    el.style.left = `${Math.round(Math.max(8, left))}px`;
    el.style.top = `${Math.round(Math.max(8, top))}px`;
  }

  function showPop(li, pt) {
    clearTimeout(pop.hideTimer);
    const r = st.suggestions[Number(li.dataset.i)];
    if (!r) return;
    if (pop.li !== li) {
      pop.li?.classList.remove('hover');
      pop.li = li;
      li.classList.add('hover');
      const el = $('relPop');
      el.innerHTML = popHtml(r);
      el.hidden = false;
      placePop(li, pt);
    }
  }

  function hidePop() {
    clearTimeout(pop.showTimer);
    clearTimeout(pop.hideTimer);
    pop.li?.classList.remove('hover');
    pop.li = null;
    $('relPop').hidden = true;
  }

  const hidePopSoon = () => {
    clearTimeout(pop.showTimer);
    clearTimeout(pop.hideTimer);
    pop.hideTimer = setTimeout(hidePop, 160);
  };

  function bindPop() {
    const body = $('relBody');
    body.addEventListener('mouseover', e => {
      const li = e.target.closest('li[data-i]');
      if (!li) return;
      clearTimeout(pop.hideTimer);
      clearTimeout(pop.showTimer);
      if (pop.li === li) return;
      // Instant when moving between rows with the popup already open; otherwise at where the cursor rests.
      if (pop.li) showPop(li, { x: e.clientX, y: e.clientY });
      else pop.showTimer = setTimeout(() => showPop(li, pop.pt), 280);
    });
    body.addEventListener('mousemove', e => { pop.pt = { x: e.clientX, y: e.clientY }; });
    body.addEventListener('mouseout', e => {
      if (!e.relatedTarget || !e.relatedTarget.closest?.('#relPop, li[data-i]')) hidePopSoon();
    });
    body.addEventListener('focusin', e => {
      const li = e.target.closest('li[data-i]');
      if (li) showPop(li);
    });
    body.addEventListener('focusout', hidePopSoon);
    body.addEventListener('scroll', hidePop, true);
    $('relPop').addEventListener('mouseenter', () => clearTimeout(pop.hideTimer));
    $('relPop').addEventListener('mouseleave', hidePopSoon);
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && pop.li) hidePop(); });
    window.addEventListener('resize', hidePop);
  }

  function renderOutput() {
    const pv = st.preview;
    if (!pv) {
      $('meter').innerHTML = `<div class="note">${esc(t('counting'))}</div>`;
      return;
    }
    const b = st.budgets[st.budget] || {};
    const cap = pv.usable;
    let cls = 'ok';
    let msg = t('noLimitMsg');
    let pct = 0;
    if (cap) {
      const worst = Math.max(...pv.parts.map(p => p.tokens));
      pct = Math.min(100, (worst / cap) * 100);
      cls = worst > cap ? 'bad' : worst > cap * 0.85 ? 'warn' : 'ok';
      if (worst > cap) msg = pv.parts.length > 1 ? t('partTooBig') : t('overBy', { n: fmt(pv.total - cap) });
      else msg = pv.parts.length > 1 ? t('partsFit', { n: pv.parts.length }) : t('left', { n: fmt(cap - pv.total) });
    }
    const sub = cap ? t('ofUsable', { usable: fmt(cap), limit: fmt(b.limit), reserve: fmt(b.reserve || 0) }) : t('tokensEstimate');
    const s = pv.stripped;
    const saved = s && s.tokens > 0
      ? `<div class="state saved">${esc(t('savedLine', { tokens: fmt(s.tokens), pct: Math.round((s.tokens / Math.max(1, s.raw)) * 100), files: s.files }))}</div>`
      : '';
    $('meter').innerHTML = `<div class="big"><strong>${fmt(pv.total)}</strong><span>${esc(sub)}</span></div>
      ${cap ? `<div class="track" role="progressbar" aria-valuenow="${Math.round(pct)}" aria-valuemin="0" aria-valuemax="100"><div class="fill ${cls === 'ok' ? '' : cls}" style="width:${pct}%"></div></div>` : ''}
      <div class="state ${cls}">${esc(msg)}</div>${saved}`;

    const warns = pv.warnings;
    const shown = warns.slice(0, 8);
    $('warns').innerHTML = shown.map(w => `<div class="warn-i${w.level === 'over' ? ' bad' : ''}">${esc(w.text)}</div>`).join('') +
      (warns.length > shown.length ? `<div class="note">${esc(t('andMore', { n: warns.length - shown.length }))}</div>` : '') +
      (!st.sel.size ? `<div class="note">${esc(t('nothingSelected'))}</div>` : '');

    // Every exported file, by size or in project order (the export comes in project order).
    const files = st.fOrder === 'size' ? [...pv.files].sort((a, b2) => b2.tokens - a.tokens) : pv.files;
    const max = Math.max(1, ...files.map(f => f.tokens));
    $('heavyWrap').hidden = !files.length;
    $('fOrder').querySelectorAll('button').forEach(btn => btn.setAttribute('aria-pressed', String(btn.dataset.v === st.fOrder)));
    $('heavy').innerHTML = files.map(f => `<div class="hv"><div class="n"><i style="width:${(f.tokens / max) * 100}%"></i>${pathLabel(f.path)}</div>${f.cutLines ? `<button type="button" class="cut-b" data-act="restoreFile" data-p="${esc(f.path)}" title="${esc(t('cutBadgeTitle', { n: f.cutLines }))}">${esc(t('cutBadge', { n: f.cutLines }))}</button>` : '<span></span>'}<span class="t">${fmt(f.tokens)}</span><button type="button" data-act="drop" data-p="${esc(f.path)}" aria-label="${esc(t('remove', { path: f.path }))}">×</button></div>`).join('');

    const multi = pv.parts.length > 1;
    $('partsWrap').hidden = !multi;
    $('copyBtn').hidden = multi;
    $('parts').innerHTML = multi ? pv.parts.map(p => `<button class="part" type="button" data-act="copyPart" data-i="${p.index}">${esc(t('copyPartBtn', { i: p.index, tokens: fmt(p.tokens), files: p.files }))}</button>`).join('') : '';
    $('copyBtn').textContent = st.secretAck ? t('copyAnyway') : t('copyMd');
  }

  function renderAll() {
    applyStatic();
    if (!st.loaded) return;
    renderHeader();
    renderBudgets();
    renderPresets();
    renderRules();
    renderTree();
    renderRelated();
    renderOutput();
  }

  // ---- data refresh ----
  const relOverride = () => ({ enabled: st.rel.enabled, depth: st.rel.depth, rules: st.rel.rules });
  const exportBody = () => ({
    selected: [...st.sel], task: $('task').value, budget: st.budget,
    split: st.split, stripDocs: st.stripDocs, stripComments: st.stripComments,
    cuts: Object.fromEntries(Object.entries(st.cuts).filter(([p]) => st.sel.has(p))),
  });

  // Removing all comments already removes the IDE-helper tags, so that box is shown checked and locked.
  function syncToggles() {
    $('split').checked = st.split;
    $('stripComments').checked = st.stripComments;
    $('stripDocs').checked = st.stripDocs || st.stripComments;
    $('stripDocs').disabled = st.stripComments;
  }

  async function refreshRelated() {
    const seq = ++st.relSeq;
    if (!st.rel.enabled || !st.sel.size) {
      st.suggestions = [];
      renderRelated();
      return;
    }
    try {
      const r = await api('/api/related', { selected: [...st.sel], related: relOverride() });
      if (seq !== st.relSeq) return;
      st.suggestions = r.suggestions;
      st.relGroups = r.groups;
    } catch (err) {
      toast(err.message);
    }
    renderRelated();
  }

  async function refreshPreview() {
    const seq = ++st.prevSeq;
    st.exp = null;
    st.secretAck = false;
    try {
      const r = await api('/api/preview', exportBody());
      if (seq !== st.prevSeq) return;
      st.preview = r;
      // The file changed on disk: its cuts no longer match its lines.
      if (r.staleCuts?.length) {
        r.staleCuts.forEach(p => delete st.cuts[p]);
        persist();
      }
      renderOutput();
      if ($('viewer').open && view.mode === 'result') renderNav();
    } catch (err) {
      toast(err.message);
    }
  }

  let refreshTimer;
  function refresh({ related = true } = {}) {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      if (related) refreshRelated();
      refreshPreview();
    }, 180);
  }

  function selectionChanged() {
    renderTree();
    persist();
    refresh();
  }

  let saveRelTimer;
  function relSettingsChanged() {
    renderRules();
    refreshRelated();
    clearTimeout(saveRelTimer);
    saveRelTimer = setTimeout(() => api('/api/config', { related: relOverride() }, 'PUT').catch(err => toast(err.message)), 600);
  }

  // ---- export / clipboard ----
  // Keyed by the request and the language, since warnings in the export come back translated.
  function exportNow() {
    const body = exportBody();
    const key = lang + JSON.stringify(body);
    if (!st.exp || st.exp.key !== key) {
      const promise = api('/api/export', body);
      promise.catch(() => { if (st.exp && st.exp.key === key) st.exp = null; });
      st.exp = { key, promise };
    }
    return st.exp.promise;
  }

  // ClipboardItem with a promise keeps the click's user activation while the export is fetched.
  function writeClipboard(textPromise) {
    if (window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
      return navigator.clipboard.write([new ClipboardItem({ 'text/plain': textPromise.then(s => new Blob([s], { type: 'text/plain' })) })]);
    }
    return textPromise.then(s => navigator.clipboard.writeText(s));
  }

  async function copyPart(index) {
    const hasSecrets = st.preview && st.preview.warnings.some(w => w.level === 'secret');
    if (hasSecrets && !st.secretAck) {
      st.secretAck = true;
      renderOutput();
      toast(t('secretsConfirm'));
      return;
    }
    const result = exportNow();
    const text = result.then(r => r.parts[index - 1].markdown);
    try {
      try {
        await writeClipboard(text);
      } catch {
        await navigator.clipboard.writeText(await text);
      }
      const r = await result;
      const part = r.parts[index - 1];
      toast(r.parts.length > 1
        ? t('copiedPart', { i: index, n: r.parts.length, tokens: fmt(part.tokens) })
        : t('copied', { tokens: fmt(part.tokens) }));
    } catch (err) {
      try {
        $('vQ').value = '';
        await openResult(index);
        const range = document.createRange();
        range.selectNodeContents($('vCode'));
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        toast(t('copyFallback'));
      } catch {
        toast(err.message);
      }
    }
  }

  async function saveExport() {
    try {
      const r = await api('/api/export', { ...exportBody(), save: true });
      const dir = r.saved[0].slice(0, r.saved[0].length - basename(r.saved[0]).length);
      toast(t('savedTo', { dir, files: r.saved.map(basename).join(', ') }));
    } catch (err) {
      toast(err.message);
    }
  }

  // ---- presets & git ----
  async function applyPreset(name) {
    const p = st.presets[name];
    if (!p) return;
    const r = await api('/api/expand', { include: p.include || [] });
    st.sel = new Set(r.files);
    if (typeof p.task === 'string') $('task').value = p.task;
    if (p.budget && st.budgets[p.budget] !== undefined) {
      st.budget = p.budget;
      renderBudgets();
    }
    if (p.related) {
      const rel = await api('/api/related', { selected: [...st.sel], related: relOverride() });
      rel.suggestions.forEach(s => st.sel.add(s.path));
    }
    openAncestors([...st.sel]);
    selectionChanged();
    toast(r.missing.length ? t('presetMissing', { list: r.missing.join(', ') }) : t('presetApplied', { name, n: st.sel.size }));
  }

  async function savePreset() {
    const name = $('presetName').value.trim();
    if (!name) return toast(t('presetNameNeeded'));
    if (!st.sel.size) return toast(t('selectFirst'));
    try {
      const r = await api('/api/presets', { name, preset: { include: [...st.sel], task: $('task').value, budget: st.budget } });
      st.presets = r.presets;
      $('presetName').value = '';
      renderPresets();
      $('preset').value = name;
      $('delPreset').hidden = false;
      toast(t('presetSaved', { name }));
    } catch (err) {
      toast(err.message);
    }
  }

  async function deletePreset(btn) {
    const name = $('preset').value;
    if (!name) return;
    if (btn.dataset.armed !== '1') {
      btn.dataset.armed = '1';
      btn.textContent = t('deleteConfirm');
      setTimeout(() => { btn.dataset.armed = ''; btn.textContent = t('delete'); }, 3000);
      return;
    }
    try {
      const r = await api('/api/presets', { name, preset: null });
      st.presets = r.presets;
      $('preset').value = '';
      renderPresets();
      toast(t('presetDeleted', { name }));
    } catch (err) {
      toast(err.message);
    }
  }

  async function addChanged() {
    try {
      const r = await api('/api/changed');
      if (!r.git) return toast(t('notGitRepo'));
      if (!r.files.length) return toast(t('noChanged'));
      r.files.forEach(p => st.sel.add(p));
      openAncestors(r.files);
      selectionChanged();
      toast(t('changedAdded', { n: r.files.length }));
    } catch (err) {
      toast(err.message);
    }
  }

  // ---- viewer: one modal for a file preview ("file") and for the generated Markdown ("result") ----
  // Both modes share the text search: every hit is a <mark>, the current one gets .cur.
  function openViewer(mode, title) {
    view.mode = mode;
    view.text = '';
    view.secretLines = new Set();
    view.file = null;
    view.hash = null;
    view.blocks = [];
    view.markerAt = new Map();
    view.anchorRow = null;
    hideCutBtn();
    $('vTitle').textContent = title;
    $('vMeta').textContent = t('loading');
    $('vWarn').innerHTML = '';
    $('vTabs').innerHTML = '';
    $('vToggle').hidden = $('vIde').hidden = mode !== 'file';
    $('vRestore').hidden = true;
    $('vCopy').hidden = mode !== 'result';
    $('vCode').classList.toggle('wrap', mode === 'result');
    $('vCode').classList.toggle('numbered', mode === 'file');
    renderNav();
    renderView();
    if (!$('viewer').open) $('viewer').showModal();
    $('vQ').focus();
    $('vQ').select();
  }

  function updatePeekToggle() {
    const on = st.sel.has(view.path);
    $('vToggle').textContent = on ? t('removeFromSel') : t('addToSel');
    $('vToggle').classList.toggle('solid', !on);
  }

  // Cuts made against another version of the file are not shown (the server drops them too).
  const fileCuts = () => (view.hash && st.cuts[view.path]?.hash === view.hash ? st.cuts[view.path].ranges : []);
  const rangeLines = ranges => ranges.reduce((s, [a, b]) => s + b - a + 1, 0);

  function updateFileMeta() {
    const f = view.file;
    if (!f) return;
    const cut = rangeLines(fileCuts());
    $('vMeta').textContent = t('fileMeta', { lines: f.lines, tokens: fmt(f.tokens) }) + (f.language ? ' · ' + f.language : '') + (cut ? ' · ' + t('cutMeta', { n: cut }) : '');
    $('vRestore').hidden = !cut;
  }

  // A Windows root (C:\…, \\wsl.localhost\…) gets backslashes in the file part too.
  const ideFile = path => (st.ideRoot.includes('\\') ? `${st.ideRoot}\\${path.replace(/\//g, '\\')}` : `${st.ideRoot}/${path}`);

  async function peek(path) {
    view.path = path;
    openViewer('file', path);
    $('vToggle').disabled = !pickable(path);
    $('vIde').href = `phpstorm://open?file=${encodeURIComponent(ideFile(path))}&line=1`;
    updatePeekToggle();
    try {
      const f = await api('/api/file', { path });
      if (view.mode !== 'file' || view.path !== path) return;
      view.file = f;
      view.hash = f.hash;
      view.text = f.content;
      view.secretLines = new Set(f.secrets.map(s => s.line));
      updateFileMeta();
      const notes = [];
      if (view.secretLines.size) notes.push(`<div class="warn-i">${esc(t('secretLines', { lines: [...view.secretLines].join(', ') }))}</div>`);
      if (f.truncated) notes.push(`<div class="note">${esc(t('truncated'))}</div>`);
      if (!f.exportable) notes.push(`<div class="note">${esc(t('notExportable', { kb: st.maxFileKb }))}</div>`);
      else notes.push(`<div class="note">${esc(t('cutHint'))}</div>`);
      $('vWarn').innerHTML = notes.join('');
      renderView();
    } catch (err) {
      $('vMeta').textContent = '';
      $('vWarn').innerHTML = `<div class="warn-i bad">${esc(err.message)}</div>`;
    }
  }

  async function openResult(index) {
    openViewer('result', t('resultTitle'));
    $('vWarn').innerHTML = `<div class="note">${esc(t('cutHintResult'))}</div>`;
    const r = await exportNow();
    if (view.mode !== 'result') return;
    view.parts = r.parts;
    showPart(Math.min(index || 1, r.parts.length));
  }

  function showPart(index, { keepScroll = false } = {}) {
    view.part = index;
    const part = view.parts[index - 1];
    const multi = view.parts.length > 1;
    $('vMeta').textContent = t('partMeta', { files: part.files, tokens: fmt(part.tokens) }) + (multi ? t('partOf', { i: index, n: view.parts.length }) : '');
    $('vTabs').innerHTML = multi ? view.parts.map(p => `<button class="part${p.index === index ? ' on' : ''}" type="button" data-act="vPart" data-i="${p.index}" aria-pressed="${p.index === index}">${esc(t('partTab', { i: p.index, tokens: fmt(p.tokens) }))}</button>`).join('') : '';
    $('vCopy').dataset.i = String(index);
    $('vCopy').textContent = multi ? t('copyPartN', { i: index }) : t('copyMd');
    view.text = part.markdown;
    // Each file's content lines run from `start` to the closing fence; `map` gives their file lines.
    const lines = part.markdown.split('\n');
    view.markerAt = new Map();
    view.blocks = (part.blocks || []).map(b => {
      const fence = /^`+/.exec(lines[b.start - 1] || '')?.[0];
      const close = fence ? lines.indexOf(fence, b.start) : -1;
      b.markers.forEach(m => view.markerAt.set(b.start + m.line, { path: b.path, range: m.range }));
      return { ...b, end: close < 0 ? b.start + b.map.length : close };
    });
    renderNav();
    renderView({ keepScroll });
  }

  // Re-export after a cut or restore and show the same part at the same place.
  async function reloadResult() {
    try {
      const r = await exportNow();
      if (view.mode !== 'result') return;
      view.parts = r.parts;
      showPart(Math.min(view.part, r.parts.length), { keepScroll: true });
    } catch (err) {
      toast(err.message);
    }
  }

  // ---- viewer: file navigation in the result ----
  function renderNav() {
    const nav = $('vNav');
    nav.hidden = view.mode !== 'result' || !view.blocks.length;
    if (nav.hidden) {
      nav.innerHTML = '';
      return;
    }
    const tokens = new Map((st.preview?.files || []).map(f => [f.path, f]));
    nav.innerHTML = `<div class="lbl">${esc(t('navFiles'))} · ${view.blocks.length}</div>` + view.blocks.map((b, i) => {
      const f = tokens.get(b.path);
      return `<button type="button" class="nv" data-act="vGo" data-i="${i}" title="${esc(b.path)}"><span class="rp">${pathSpans(b.path)}</span>${f?.cutLines ? '<span class="nv-cut">✂</span>' : ''}${f ? `<span class="tok">${fmt(f.tokens)}</span>` : ''}</button>`;
    }).join('');
    syncNav();
  }

  const rowEl = i => $('vCode').querySelector(`[data-l="${i}"]`);

  function goToBlock(i) {
    const el = rowEl(view.blocks[i]?.heading);
    if (el) $('vScroll').scrollTop = el.offsetTop - 8;
  }

  // Marks the file whose heading is the last one above the top of the code.
  function syncNav() {
    if (view.mode !== 'result' || !view.blocks.length) return;
    const top = $('vScroll').scrollTop + 24;
    let on = 0;
    view.blocks.forEach((b, i) => {
      const el = rowEl(b.heading);
      if (el && el.offsetTop <= top) on = i;
    });
    $('vNav').querySelectorAll('.nv').forEach((btn, i) => btn.classList.toggle('on', i === on));
  }

  // Syntax tokens of one line with search marks laid over them: a <mark> may span several tokens,
  // so marks stay outside and the token spans are cut at the mark edges.
  function paintLine(segs, ranges) {
    let out = '';
    let pos = 0;
    let r = 0;
    let inMark = false;
    for (const [kind, text] of segs) {
      let i = 0;
      while (i < text.length) {
        const at = pos + i;
        if (inMark && at === ranges[r][1]) { out += '</mark>'; inMark = false; r++; continue; }
        if (!inMark && r < ranges.length && at === ranges[r][0]) { out += '<mark>'; inMark = true; continue; }
        const stop = inMark ? ranges[r][1] : r < ranges.length ? ranges[r][0] : Infinity;
        const end = Math.min(text.length, stop - pos);
        out += window.CTXPACK_HL.span([kind, text.slice(i, end)]);
        i = end;
      }
      pos += text.length;
    }
    return inMark ? out + '</mark>' : out;
  }

  // What the viewer shows, one row per line. A file shows its cut blocks folded into one row each;
  // the result shows the comment the export put in their place.
  function viewRows() {
    const rows = [];
    if (view.mode === 'file') {
      const cuts = fileCuts();
      let c = 0;
      for (let i = 0; i < view.lexed.length; i++) {
        const n = i + 1;
        if (cuts[c] && n === cuts[c][0]) {
          rows.push({ cut: cuts[c] });
          i = cuts[c][1] - 1;
          c++;
          continue;
        }
        rows.push({ n, segs: view.lexed[i] });
      }
    } else {
      view.lexed.forEach((segs, j) => rows.push({ segs, marker: view.markerAt.get(j) }));
    }
    return rows;
  }

  const cutText = ([a, b]) => (a === b ? t('cutRowOne', { a }) : t('cutRow', { n: b - a + 1, a, b }));
  const restoreBtn = (path, [a, b]) => `<button type="button" class="link-btn" data-act="uncut" data-p="${esc(path)}" data-a="${a}" data-b="${b}">${esc(t('restore'))}</button>`;

  // Renders line by line so a file keeps its line numbers, syntax colors and secret highlighting under search marks.
  // Lexing is cached per text, so typing in the search box only re-lays the marks.
  function renderView({ keepScroll = false } = {}) {
    const q = $('vQ').value.toLowerCase();
    const numbered = view.mode === 'file';
    const scroll = $('vScroll').scrollTop;
    let hits = 0;
    view.capped = false;
    view.renderedQ = q;
    hideCutBtn();
    if (view.lexedText !== view.text || view.lexedPath !== view.path || view.lexedMode !== view.mode) {
      const hl = window.CTXPACK_HL;
      view.lexed = view.mode === 'file' ? hl.lexFile(view.text, view.path || '') : hl.lexMarkdown(view.text);
      view.lexedText = view.text;
      view.lexedPath = view.path;
      view.lexedMode = view.mode;
    }
    view.rows = view.text ? viewRows() : [];
    const html = view.rows.map((r, i) => {
      if (r.cut) return `<span class="l cut-row" data-l="${i}"><span class="ln">⋯</span>✂ ${esc(cutText(r.cut))} · ${restoreBtn(view.path, r.cut)}</span>`;
      const ranges = [];
      if (q) {
        const low = r.segs.map(s => s[1]).join('').toLowerCase();
        for (let at = low.indexOf(q); at !== -1; at = low.indexOf(q, at + q.length)) {
          if (hits === MAX_HITS) { view.capped = true; break; }
          ranges.push([at, at + q.length]);
          hits++;
        }
      }
      let body = paintLine(r.segs, ranges);
      if (numbered && view.secretLines.has(r.n)) body = `<span class="secret">${body}</span>`;
      if (r.marker) body = `<span class="marker">${body}</span> ${restoreBtn(r.marker.path, r.marker.range)}`;
      return `<span class="l" data-l="${i}">${numbered ? `<span class="ln" data-act="pickLine" data-i="${i}">${r.n}</span>` : ''}${body}</span>`;
    }).join('\n');
    $('vCode').innerHTML = html;
    if (keepScroll) $('vScroll').scrollTop = scroll;
    view.marks = [...$('vCode').querySelectorAll('mark')];
    view.cur = -1;
    if (view.marks.length && !keepScroll) stepView(0, true);
    else updateViewCount();
    syncNav();
  }

  // ---- viewer: cutting blocks of lines ----
  // File lines behind viewer rows a..b, per file: [{ path, hash, a, b }].
  function cutTargets(a, b) {
    const out = new Map();
    const add = (path, hash, x, y) => {
      const cur = out.get(path);
      out.set(path, cur ? { ...cur, a: Math.min(cur.a, x), b: Math.max(cur.b, y) } : { path, hash, a: x, b: y });
    };
    for (let i = a; i <= b; i++) {
      const r = view.rows[i];
      if (!r) continue;
      if (view.mode === 'file') {
        if (!view.hash || !view.file?.exportable) return [];
        if (r.cut) add(view.path, view.hash, r.cut[0], r.cut[1]);
        else add(view.path, view.hash, r.n, r.n);
        continue;
      }
      const block = view.blocks.find(bl => i >= bl.start && i < bl.end);
      if (!block) continue;
      if (r.marker) add(block.path, block.hash, r.marker.range[0], r.marker.range[1]);
      else if (block.map[i - block.start]) add(block.path, block.hash, block.map[i - block.start], block.map[i - block.start]);
    }
    return [...out.values()];
  }

  // The viewer row a DOM point is in; a point between rows (on the "\n") counts as the row before it.
  function rowAt(node, offset) {
    const code = $('vCode');
    let el = node.nodeType === 3 ? node.parentElement : node;
    if (el === code) {
      const kid = node.nodeType === 3 ? node : code.childNodes[Math.min(offset, code.childNodes.length - 1)];
      el = kid?.nodeType === 1 ? kid : kid?.previousElementSibling || kid?.nextElementSibling;
    }
    const row = el?.closest?.('[data-l]');
    return row && code.contains(row) ? Number(row.dataset.l) : -1;
  }

  function selectedRows() {
    const sel = getSelection();
    if (!sel.rangeCount || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    if (!$('vCode').contains(range.commonAncestorContainer) && range.commonAncestorContainer !== $('vCode')) return null;
    const a = rowAt(range.startContainer, range.startOffset);
    let b = rowAt(range.endContainer, range.endOffset);
    if (a < 0 || b < 0) return null;
    // A drag that ends at the very start of a line does not take that line.
    if (b > a) {
      const head = document.createRange();
      head.setStart(rowEl(b), 0);
      head.setEnd(range.endContainer, range.endOffset);
      if (!head.toString()) b--;
    }
    return [a, b];
  }

  function showCutBtn(rows, x, y) {
    const items = rows ? cutTargets(rows[0], rows[1]) : [];
    view.pending = items;
    const btn = $('vCutBtn');
    if (!items.length) return hideCutBtn();
    const lines = items.reduce((s, it) => s + it.b - it.a + 1, 0);
    btn.textContent = items.length > 1 ? t('cutFiles', { n: lines, files: items.length })
      : items[0].a === items[0].b ? t('cutLine', { a: items[0].a }) : t('cutLines', { a: items[0].a, b: items[0].b });
    btn.hidden = false;
    btn.style.left = `${Math.round(Math.min(x + 10, innerWidth - btn.offsetWidth - 12))}px`;
    btn.style.top = `${Math.round(Math.min(y + 14, innerHeight - btn.offsetHeight - 12))}px`;
  }

  function hideCutBtn() {
    view.pending = [];
    $('vCutBtn').hidden = true;
  }

  // ---- cuts state ----
  function mergeRanges(list) {
    const out = [];
    for (const r of [...list].sort((x, y) => x[0] - y[0])) {
      const last = out[out.length - 1];
      if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
      else out.push([...r]);
    }
    return out;
  }

  function addCuts(items) {
    for (const { path, hash, a, b } of items) {
      const cur = st.cuts[path];
      const ranges = cur && cur.hash === hash ? cur.ranges : [];
      st.cuts[path] = { hash, ranges: mergeRanges([...ranges, [a, b]]) };
      // Cuts only apply to exported files, so cutting a file selects it.
      if (!st.sel.has(path)) {
        st.sel.add(path);
        openAncestors([path]);
        renderTree();
        if (view.mode === 'file') updatePeekToggle();
      }
    }
    getSelection().removeAllRanges();
    cutsChanged();
  }

  function removeCut(path, a, b) {
    const cur = st.cuts[path];
    if (!cur) return;
    cur.ranges = cur.ranges.filter(([x, y]) => y < a || x > b);
    if (!cur.ranges.length) delete st.cuts[path];
    cutsChanged();
  }

  function restoreFile(path) {
    delete st.cuts[path];
    cutsChanged();
  }

  function cutsChanged() {
    persist();
    st.exp = null;
    refresh({ related: false });
    if (!$('viewer').open) return;
    if (view.mode === 'file') {
      updateFileMeta();
      renderView({ keepScroll: true });
    } else if (view.mode === 'result') {
      reloadResult();
    }
  }

  function stepView(delta, absolute = false) {
    const total = view.marks.length;
    if (!total) return;
    if (view.cur >= 0) view.marks[view.cur].classList.remove('cur');
    view.cur = absolute ? delta : (view.cur + delta + total) % total;
    const m = view.marks[view.cur];
    m.classList.add('cur');
    m.scrollIntoView({ block: 'center', inline: 'nearest' });
    updateViewCount();
  }

  function updateViewCount() {
    const q = $('vQ').value;
    const total = view.marks.length;
    $('vCount').textContent = !q || !view.text ? '' : total ? `${view.cur + 1} / ${total}${view.capped ? '+' : ''}` : t('notFound');
    $('vCount').classList.toggle('none', !!q && !!view.text && !total);
    $('vPrev').disabled = $('vNext').disabled = total < 2;
  }

  function toast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { el.hidden = true; }, 3200);
  }

  function setLang(next) {
    if (next === lang || !I18N[next]) return;
    lang = next;
    try { localStorage.setItem(LANG_KEY, lang); } catch {}
    st.exp = null;
    renderAll();
    // Warnings in the preview come from the server, so fetch them again in the new language.
    if (st.loaded) refresh({ related: false });
  }

  // ---- events ----
  document.addEventListener('click', e => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const p = el.dataset.p;
    switch (el.dataset.act) {
      case 'lang':
        setLang(el.dataset.v);
        return;
      case 'open':
        if (st.open.has(p)) st.open.delete(p); else st.open.add(p);
        renderTree();
        return;
      case 'toggle':
        if (el.checked) st.sel.add(p); else st.sel.delete(p);
        break;
      case 'toggleDir': {
        const node = st.dirs.get(p);
        if (node) node.pick.forEach(l => (el.checked ? st.sel.add(l.path) : st.sel.delete(l.path)));
        break;
      }
      case 'addOne':
        st.sel.add(p);
        openAncestors([p]);
        break;
      case 'relGroup':
        if (st.relClosed.has(el.dataset.g)) st.relClosed.delete(el.dataset.g); else st.relClosed.add(el.dataset.g);
        renderRelated();
        persist();
        return;
      case 'addGroup': {
        const list = st.suggestions.filter(s => s.group === el.dataset.g).map(s => s.path);
        list.forEach(x => st.sel.add(x));
        openAncestors(list);
        break;
      }
      case 'addAll':
      case 'addLevel1': {
        const list = st.suggestions.filter(s => el.dataset.act === 'addAll' || s.level === 1).map(s => s.path);
        list.forEach(x => st.sel.add(x));
        openAncestors(list);
        break;
      }
      case 'drop':
        st.sel.delete(p);
        break;
      case 'peek':
        hidePop();
        peek(p);
        return;
      case 'vToggle':
        if (st.sel.has(view.path)) {
          st.sel.delete(view.path);
        } else {
          st.sel.add(view.path);
          openAncestors([view.path]);
        }
        updatePeekToggle();
        break;
      case 'clear':
        st.sel.clear();
        break;
      case 'openAll':
        // Collapses everything when something is open, otherwise opens every folder.
        if (st.open.size) st.open.clear();
        else st.dirs.forEach((_, path) => st.open.add(path));
        renderTree();
        return;
      case 'changed':
        addChanged();
        return;
      case 'budget':
        st.budget = el.dataset.v;
        renderBudgets();
        persist();
        refresh({ related: false });
        return;
      case 'copy':
        copyPart(1);
        return;
      case 'copyPart':
        copyPart(Number(el.dataset.i));
        return;
      case 'save':
        saveExport();
        return;
      case 'openResult':
        openResult().catch(err => toast(err.message));
        return;
      case 'vPart':
        showPart(Number(el.dataset.i));
        return;
      case 'vNext':
        stepView(1);
        return;
      case 'vPrev':
        stepView(-1);
        return;
      case 'vClose':
        $('viewer').close();
        return;
      case 'fOrder':
        st.fOrder = el.dataset.v;
        persist();
        renderOutput();
        return;
      case 'restoreFile':
        restoreFile(p);
        return;
      case 'vRestore':
        restoreFile(view.path);
        return;
      case 'uncut':
        removeCut(p, Number(el.dataset.a), Number(el.dataset.b));
        return;
      case 'vCut':
        if (view.pending.length) addCuts(view.pending);
        hideCutBtn();
        return;
      case 'vGo':
        goToBlock(Number(el.dataset.i));
        return;
      case 'pickLine': {
        // Click a line number to pick that line, Shift+click to stretch the pick from the last one.
        const i = Number(el.dataset.i);
        const from = e.shiftKey && view.anchorRow !== null ? view.anchorRow : i;
        if (!e.shiftKey) view.anchorRow = i;
        const [a, b] = [Math.min(from, i), Math.max(from, i)];
        const range = document.createRange();
        range.setStartBefore(rowEl(a));
        range.setEndAfter(rowEl(b));
        getSelection().removeAllRanges();
        getSelection().addRange(range);
        showCutBtn([a, b], e.clientX, e.clientY);
        return;
      }
      case 'savePreset':
        savePreset();
        return;
      case 'deletePreset':
        deletePreset(el);
        return;
      default:
        return;
    }
    selectionChanged();
  });

  document.addEventListener('change', e => {
    const el = e.target;
    if (el.dataset.rule) {
      st.rel.rules[el.dataset.rule] = el.checked;
      relSettingsChanged();
    } else if (el.id === 'relOn') {
      st.rel.enabled = el.checked;
      relSettingsChanged();
    } else if (el.id === 'depth') {
      st.rel.depth = Number(el.value);
      relSettingsChanged();
    } else if (el.id === 'split' || el.id === 'stripDocs' || el.id === 'stripComments') {
      st[el.id] = el.checked;
      syncToggles();
      persist();
      refresh({ related: false });
    } else if (el.id === 'preset') {
      $('delPreset').hidden = !el.value;
      if (el.value) applyPreset(el.value).catch(err => toast(err.message));
    }
  });

  // Selecting text in the viewer offers to cut those lines; the button keeps the selection when pressed.
  $('vCode').addEventListener('mouseup', e => {
    if (e.target.closest('[data-act]')) return;
    setTimeout(() => showCutBtn(selectedRows(), e.clientX, e.clientY));
  });
  $('vCode').addEventListener('mousedown', e => { if (!e.target.closest('.ln')) hideCutBtn(); });
  $('vCutBtn').addEventListener('mousedown', e => e.preventDefault());
  $('vScroll').addEventListener('scroll', () => {
    hideCutBtn();
    cancelAnimationFrame(syncNav.raf);
    syncNav.raf = requestAnimationFrame(syncNav);
  });
  $('viewer').addEventListener('close', hideCutBtn);

  // A click on the backdrop lands on the <dialog> itself (it has no padding).
  $('viewer').addEventListener('click', e => {
    if (e.target === e.currentTarget) e.currentTarget.close();
  });
  let viewSearchTimer;
  $('vQ').addEventListener('input', () => {
    clearTimeout(viewSearchTimer);
    viewSearchTimer = setTimeout(renderView, 150);
  });
  $('vQ').addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    clearTimeout(viewSearchTimer);
    if (view.renderedQ !== $('vQ').value.toLowerCase()) renderView();
    else stepView(e.shiftKey ? -1 : 1);
  });
  // Cmd/Ctrl+F inside the viewer jumps to its own search box instead of the browser's.
  $('viewer').addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      $('vQ').focus();
      $('vQ').select();
    }
  });
  $('q').addEventListener('input', e => {
    st.q = e.target.value.trim();
    renderTree();
  });
  $('task').addEventListener('input', () => {
    persist();
    refresh({ related: false });
  });

  // ---- resizable columns ----
  // Column widths are fractions of the space left after the two gutters, remembered per browser.
  const LAYOUT_KEY = 'ctxpack:layout';
  const DEFAULT_COLS = [0.33, 0.31, 0.36];
  const MIN_COL = 240;
  let cols = DEFAULT_COLS.slice();
  try {
    const saved = JSON.parse(localStorage.getItem(LAYOUT_KEY) || 'null');
    if (Array.isArray(saved) && saved.length === 3 && saved.every(n => typeof n === 'number' && n > 0)) cols = saved;
  } catch {}

  function applyCols() {
    document.querySelector('.grid').style.setProperty('--cols',
      `minmax(0, ${cols[0]}fr) var(--gutter) minmax(0, ${cols[1]}fr) var(--gutter) minmax(0, ${cols[2]}fr)`);
  }
  function saveCols() {
    try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(cols)); } catch {}
  }
  // Gutter i moves the border between columns i and i+1; the third column keeps its width.
  function moveBoundary(from, i, deltaPx, avail) {
    const px = from.map(f => f * avail);
    const pair = px[i] + px[i + 1];
    px[i] = Math.min(Math.max(px[i] + deltaPx, MIN_COL), pair - MIN_COL);
    px[i + 1] = pair - px[i];
    cols = px.map(v => v / avail);
    applyCols();
  }
  const availWidth = g => g.parentElement.clientWidth - 2 * g.offsetWidth;

  document.querySelectorAll('.gutter').forEach(g => {
    const i = Number(g.dataset.i);
    g.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      e.preventDefault();
      g.setPointerCapture(e.pointerId);
      const start = cols.slice();
      const x0 = e.clientX;
      const avail = availWidth(g);
      g.classList.add('active');
      document.body.classList.add('resizing');
      const move = ev => moveBoundary(start, i, ev.clientX - x0, avail);
      const up = () => {
        g.removeEventListener('pointermove', move);
        g.removeEventListener('pointerup', up);
        g.removeEventListener('pointercancel', up);
        g.classList.remove('active');
        document.body.classList.remove('resizing');
        saveCols();
      };
      g.addEventListener('pointermove', move);
      g.addEventListener('pointerup', up);
      g.addEventListener('pointercancel', up);
    });
    g.addEventListener('dblclick', () => {
      cols = DEFAULT_COLS.slice();
      applyCols();
      saveCols();
    });
    g.addEventListener('keydown', e => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      moveBoundary(cols, i, e.key === 'ArrowLeft' ? -32 : 32, availWidth(g));
      saveCols();
    });
  });
  applyCols();

  // ---- boot ----
  async function init() {
    applyStatic();
    try {
      const data = await api('/api/tree');
      st.name = data.name;
      st.root = data.root;
      st.ideRoot = data.ideRoot || data.root;
      st.git = data.git;
      st.files = data.files;
      st.byPath = new Map(data.files.map(f => [f.path, f]));
      st.tree = buildTree(data.files);
      st.rules = data.rules;
      st.budgets = data.config.budgets;
      st.maxFileKb = data.config.maxFileKb;
      st.presets = data.config.presets || {};
      st.budget = st.budgets[data.config.defaultBudget] ? data.config.defaultBudget : Object.keys(st.budgets)[0];
      const r = data.config.related;
      st.rel = { enabled: r.enabled !== false, depth: r.depth || 1, rules: { ...(r.rules || {}) } };
      st.depthByRule = r.depthByRule || {};

      storeKey = 'ctxpack:' + data.root;
      const saved = loadState();
      (saved.sel || []).forEach(p => { if (pickable(p)) st.sel.add(p); });
      if (typeof saved.task === 'string') $('task').value = saved.task;
      if (saved.budget && st.budgets[saved.budget] !== undefined) st.budget = saved.budget;
      st.split = !!saved.split;
      st.stripDocs = saved.stripDocs !== false;
      st.stripComments = !!saved.stripComments;
      if (Array.isArray(saved.relClosed)) st.relClosed = new Set(saved.relClosed);
      if (saved.cuts && typeof saved.cuts === 'object') st.cuts = saved.cuts;
      if (saved.fOrder === 'tree') st.fOrder = 'tree';
      syncToggles();
      openAncestors([...st.sel]);

      st.loaded = true;
      renderAll();
      refresh();
    } catch (err) {
      $('proj').textContent = t('error');
      $('tree').innerHTML = `<div class="empty err">${esc(t('loadFailed', { err: err.message }))}</div>`;
    }
  }

  // Panels stretch down to the bottom of the screen; the header above them can wrap to several lines.
  function trackGridTop() {
    const set = () => document.documentElement.style.setProperty('--grid-top', `${Math.round(document.querySelector('.grid').getBoundingClientRect().top + window.scrollY)}px`);
    new ResizeObserver(set).observe(document.querySelector('.bar'));
    window.addEventListener('resize', set);
    set();
  }

  bindPop();
  trackGridTop();
  init();
})();
