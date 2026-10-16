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
  // One-line path: file name first, then its folder, which is cut from the left when it does not fit.
  // The full path is in the tooltip; clicking the name opens the preview.
  function fileLabel(p) {
    const i = p.lastIndexOf('/');
    const name = p.slice(i + 1);
    const dir = i > 0 ? p.slice(0, i + 1) : '';
    return `<span class="fp" title="${esc(p)}"><button type="button" class="fn" data-act="peek" data-p="${esc(p)}" aria-label="${esc(t('preview', { path: p }))}">${esc(name)}</button>${dir ? `<span class="fd"><bdi>${esc(dir)}</bdi></span>` : ''}</span>`;
  }
  // `p` must already be escaped.
  const eyeBtn = p => `<button class="eye" type="button" data-act="peek" data-p="${p}" aria-label="${esc(t('preview', { path: p }))}" title="${esc(t('previewTitle'))}"><svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M1.5 12S5.5 5 12 5s10.5 7 10.5 7-4 7-10.5 7S1.5 12 1.5 12Z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3" fill="currentColor"/></svg></button>`;

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
    budgets: {}, budget: 'small', split: false, maxFileKb: 200,
    rules: [], rel: { enabled: true, depth: 1, rules: {} }, depthByRule: {},
    presets: {}, suggestions: [], preview: null, exp: null,
    secretAck: false, relSeq: 0, prevSeq: 0, loaded: false,
  };
  const view = { mode: null, path: null, text: '', secretLines: new Set(), parts: [], part: 1, marks: [], cur: -1, capped: false };
  let storeKey = 'ctxpack';

  // ---- persistence (per project, per browser) ----
  function loadState() {
    try { return JSON.parse(localStorage.getItem(storeKey) || '{}'); } catch { return {}; }
  }
  function persist() {
    try {
      localStorage.setItem(storeKey, JSON.stringify({ sel: [...st.sel], task: $('task').value, budget: st.budget, split: st.split }));
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
        out.push(`<div class="row${on ? ' is-sel' : ''}${f.flag ? ' off' : ''}" style="--d:${d}"><span class="chev none"></span><input type="checkbox" data-act="toggle" data-p="${p}" ${on ? 'checked' : ''} ${f.flag ? 'disabled' : ''} aria-label="${p}"><span class="name" title="${p}">${esc(k.name)}</span>${f.flag === 'deny' ? '' : eyeBtn(p)}${tag}</div>`);
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
    body.innerHTML = `<ul class="sug scroll">${list.map(r => `<li>
        ${fileLabel(r.path)}
        <span class="add"><span class="tok">${fmt(r.tokens)}</span><button class="btn add-btn" type="button" data-act="addOne" data-p="${esc(r.path)}" aria-label="${esc(t('add', { path: r.path }))}" title="${esc(t('addToSel'))}">+</button></span>
        <span class="why"><span class="lvl">L${r.level}</span><em>${esc(t('rule.' + r.rule))}</em> · ${esc(r.reason)}${r.level > 1 ? ` · ${esc(t('from', { name: basename(r.from) }))}` : ''}</span>
      </li>`).join('')}</ul>
      <div class="sugfoot"><span>${esc(t('totalTokens', { n: fmt(sum) }))}</span><span class="actions">${lvl1 && lvl1 < list.length ? `<button class="btn" type="button" data-act="addLevel1">${esc(t('level1Only', { n: lvl1 }))}</button>` : ''}<button class="btn solid" type="button" data-act="addAll">${esc(t('addAll'))}</button></span></div>`;
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
    $('meter').innerHTML = `<div class="big"><strong>${fmt(pv.total)}</strong><span>${esc(sub)}</span></div>
      ${cap ? `<div class="track" role="progressbar" aria-valuenow="${Math.round(pct)}" aria-valuemin="0" aria-valuemax="100"><div class="fill ${cls === 'ok' ? '' : cls}" style="width:${pct}%"></div></div>` : ''}
      <div class="state ${cls}">${esc(msg)}</div>`;

    const warns = pv.warnings;
    const shown = warns.slice(0, 8);
    $('warns').innerHTML = shown.map(w => `<div class="warn-i${w.level === 'over' ? ' bad' : ''}">${esc(w.text)}</div>`).join('') +
      (warns.length > shown.length ? `<div class="note">${esc(t('andMore', { n: warns.length - shown.length }))}</div>` : '') +
      (!st.sel.size ? `<div class="note">${esc(t('nothingSelected'))}</div>` : '');

    const top = [...pv.files].sort((a, b2) => b2.tokens - a.tokens).slice(0, 5);
    const max = top.length ? top[0].tokens || 1 : 1;
    $('heavyWrap').hidden = !top.length;
    $('heavy').innerHTML = top.map(f => `<div class="hv"><div class="n"><i style="width:${(f.tokens / max) * 100}%"></i>${fileLabel(f.path)}</div><span class="t">${fmt(f.tokens)}</span><button type="button" data-act="drop" data-p="${esc(f.path)}" aria-label="${esc(t('remove', { path: f.path }))}">×</button></div>`).join('');

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
  const exportBody = () => ({ selected: [...st.sel], task: $('task').value, budget: st.budget, split: st.split });

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
      renderOutput();
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
    $('vTitle').textContent = title;
    $('vMeta').textContent = t('loading');
    $('vWarn').innerHTML = '';
    $('vTabs').innerHTML = '';
    $('vToggle').hidden = $('vIde').hidden = mode !== 'file';
    $('vCopy').hidden = mode !== 'result';
    $('vCode').classList.toggle('wrap', mode === 'result');
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

  async function peek(path) {
    view.path = path;
    openViewer('file', path);
    $('vToggle').disabled = !pickable(path);
    $('vIde').href = `phpstorm://open?file=${encodeURIComponent(`${st.root}/${path}`)}&line=1`;
    updatePeekToggle();
    try {
      const f = await api('/api/file', { path });
      if (view.mode !== 'file' || view.path !== path) return;
      $('vMeta').textContent = t('fileMeta', { lines: f.lines, tokens: fmt(f.tokens) }) + (f.language ? ' · ' + f.language : '');
      view.text = f.content;
      view.secretLines = new Set(f.secrets.map(s => s.line));
      const notes = [];
      if (view.secretLines.size) notes.push(`<div class="warn-i">${esc(t('secretLines', { lines: [...view.secretLines].join(', ') }))}</div>`);
      if (f.truncated) notes.push(`<div class="note">${esc(t('truncated'))}</div>`);
      if (!f.exportable) notes.push(`<div class="note">${esc(t('notExportable', { kb: st.maxFileKb }))}</div>`);
      $('vWarn').innerHTML = notes.join('');
      renderView();
    } catch (err) {
      $('vMeta').textContent = '';
      $('vWarn').innerHTML = `<div class="warn-i bad">${esc(err.message)}</div>`;
    }
  }

  async function openResult(index) {
    openViewer('result', t('resultTitle'));
    const r = await exportNow();
    if (view.mode !== 'result') return;
    view.parts = r.parts;
    showPart(Math.min(index || 1, r.parts.length));
  }

  function showPart(index) {
    view.part = index;
    const part = view.parts[index - 1];
    const multi = view.parts.length > 1;
    $('vMeta').textContent = t('partMeta', { files: part.files, tokens: fmt(part.tokens) }) + (multi ? t('partOf', { i: index, n: view.parts.length }) : '');
    $('vTabs').innerHTML = multi ? view.parts.map(p => `<button class="part${p.index === index ? ' on' : ''}" type="button" data-act="vPart" data-i="${p.index}" aria-pressed="${p.index === index}">${esc(t('partTab', { i: p.index, tokens: fmt(p.tokens) }))}</button>`).join('') : '';
    $('vCopy').dataset.i = String(index);
    $('vCopy').textContent = multi ? t('copyPartN', { i: index }) : t('copyMd');
    view.text = part.markdown;
    renderView();
  }

  // Renders line by line so a file keeps its line numbers and secret highlighting under search marks.
  function renderView() {
    const q = $('vQ').value.toLowerCase();
    const numbered = view.mode === 'file';
    let hits = 0;
    view.capped = false;
    view.renderedQ = q;
    const html = view.text.split('\n').map((line, i) => {
      let body = '';
      if (!q) {
        body = esc(line);
      } else {
        const low = line.toLowerCase();
        let from = 0;
        for (let at = low.indexOf(q); at !== -1; at = low.indexOf(q, from)) {
          if (hits === MAX_HITS) { view.capped = true; break; }
          body += esc(line.slice(from, at)) + `<mark>${esc(line.slice(at, at + q.length))}</mark>`;
          from = at + q.length;
          hits++;
        }
        body += esc(line.slice(from));
      }
      if (view.secretLines.has(i + 1)) body = `<span class="secret">${body}</span>`;
      return numbered ? `<span class="ln">${i + 1}</span>${body}` : body;
    }).join('\n');
    $('vCode').innerHTML = html;
    view.marks = [...$('vCode').querySelectorAll('mark')];
    view.cur = -1;
    if (view.marks.length) stepView(0, true);
    else updateViewCount();
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
      case 'collapse':
        st.open.clear();
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
    } else if (el.id === 'split') {
      st.split = el.checked;
      persist();
      refresh({ related: false });
    } else if (el.id === 'preset') {
      $('delPreset').hidden = !el.value;
      if (el.value) applyPreset(el.value).catch(err => toast(err.message));
    }
  });

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
      $('split').checked = st.split;
      openAncestors([...st.sel]);

      st.loaded = true;
      renderAll();
      refresh();
    } catch (err) {
      $('proj').textContent = t('error');
      $('tree').innerHTML = `<div class="empty err">${esc(t('loadFailed', { err: err.message }))}</div>`;
    }
  }

  init();
})();
