'use strict';

(() => {
  const TOKEN = new URLSearchParams(location.search).get('t') || '';
  const RULE_LABELS = {
    'controller-routes': 'Route контролера',
    'controller-deps': 'Залежності контролера',
    'inertia-page': 'Inertia-сторінка',
    'vue-imports': 'Імпорти Vue/JS',
    'vue-routes': 'route() у Vue',
    'php-inheritance': 'Наслідування PHP',
    'model-extras': 'Міграції та фабрики',
    'tests': 'Тести',
  };
  const PREVIEW_LIMIT = 300000;

  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const fmt = t => (t >= 1000 ? (t / 1000).toFixed(1) + 'K' : String(t));
  const basename = p => p.split('/').pop();
  // `p` must already be escaped.
  const eyeBtn = p => `<button class="eye" type="button" data-act="peek" data-p="${p}" aria-label="Переглянути ${p}" title="Переглянути вміст"><svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M1.5 12S5.5 5 12 5s10.5 7 10.5 7-4 7-10.5 7S1.5 12 1.5 12Z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3" fill="currentColor"/></svg></button>`;

  async function api(url, body, method) {
    const res = await fetch(url, {
      method: method || (body ? 'POST' : 'GET'),
      headers: { 'content-type': 'application/json', 'x-ctxpack-token': TOKEN },
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
    prevOpen: false, secretAck: false, relSeq: 0, prevSeq: 0,
  };
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
  function renderHeader() {
    $('proj').innerHTML = `<b>${esc(st.name)}</b> · ${esc(st.root)}${st.git ? '' : ' · без git'}`;
    $('changedBtn').disabled = !st.git;
    $('changedBtn').title = st.git ? 'Додати змінені, staged і нові файли' : 'Це не git-репозиторій';
    document.title = `${st.name} · ctxpack`;
  }

  function renderBudgets() {
    $('budgets').innerHTML = Object.entries(st.budgets).map(([name, b]) =>
      `<button type="button" data-act="budget" data-v="${esc(name)}" aria-pressed="${name === st.budget}">${b && b.limit ? `${fmt(b.limit)} · ${esc(name)}` : 'без ліміту'}</button>`).join('');
  }

  function renderPresets() {
    const names = Object.keys(st.presets);
    const current = $('preset').value;
    $('preset').innerHTML = `<option value="">${names.length ? 'Пресети…' : 'Пресетів ще немає'}</option>` +
      names.map(n => `<option value="${esc(n)}">${esc(n)} · ${(st.presets[n].include || []).length}</option>`).join('');
    $('preset').value = names.includes(current) ? current : '';
    $('delPreset').hidden = !$('preset').value;
  }

  function renderRules() {
    $('relOn').checked = st.rel.enabled;
    $('depth').value = String(st.rel.depth);
    $('rules').innerHTML = st.rules.map(k =>
      `<label for="r-${k}"><input type="checkbox" id="r-${k}" data-rule="${k}" ${st.rel.rules[k] !== false ? 'checked' : ''}>${esc(RULE_LABELS[k] || k)}${st.depthByRule[k] ? ` <span class="lvl" title="Глибина з .ctxpack.json">≤${st.depthByRule[k]}</span>` : ''}</label>`).join('');
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
    $('tree').innerHTML = out.join('') || `<div class="empty">${q ? 'Нічого не знайдено.' : 'У проєкті немає файлів для експорту.'}</div>`;
    $('tree').querySelectorAll('[data-indet]').forEach(i => { i.indeterminate = true; });
    $('selCount').textContent = `${st.sel.size} вибрано`;
  }

  function rows(n, d, vis, out) {
    for (const k of n.kids.values()) {
      if (vis && !vis.has(k.path)) continue;
      const p = esc(k.path);
      if (!k.kids) {
        const f = k.file;
        const on = st.sel.has(k.path);
        const tag = f.flag === 'deny' ? '<span class="tag deny">заборонено</span>'
          : f.flag === 'big' ? `<span class="tag ign">&gt; ${st.maxFileKb} КБ</span>`
          : `<span class="tok">${fmt(f.tokens)}</span>`;
        out.push(`<div class="row${on ? ' is-sel' : ''}${f.flag ? ' off' : ''}" style="--d:${d}"><span class="chev none"></span><input type="checkbox" data-act="toggle" data-p="${p}" ${on ? 'checked' : ''} ${f.flag ? 'disabled' : ''} aria-label="${p}"><span class="name" title="${p}">${esc(k.name)}</span>${f.flag === 'deny' ? '' : eyeBtn(p)}${tag}</div>`);
        continue;
      }
      const open = !!vis || st.open.has(k.path);
      let c = 0;
      for (const l of k.pick) if (st.sel.has(l.path)) c++;
      const all = k.pick.length > 0 && c === k.pick.length;
      out.push(`<div class="row" style="--d:${d}"><button class="chev" type="button" data-act="open" data-p="${p}" aria-expanded="${open}" aria-label="${open ? 'Згорнути' : 'Розгорнути'} ${esc(k.name)}"></button><input type="checkbox" data-act="toggleDir" data-p="${p}" ${all ? 'checked' : ''} ${c && !all ? 'data-indet="1"' : ''} ${k.pick.length ? '' : 'disabled'} aria-label="${p}/"><span class="name dir" data-act="open" data-p="${p}">${esc(k.name)}/</span>${k.pick.length ? `<span class="tok">${c ? c + '/' : ''}${k.pick.length} · ${fmt(k.tok)}</span>` : '<span class="tag ign">недоступно</span>'}</div>`);
      if (open) rows(k, d + 1, vis, out);
    }
  }

  function renderRelated() {
    const body = $('relBody');
    const list = st.suggestions;
    $('relCount').textContent = st.rel.enabled ? `${list.length} пропозицій` : 'вимкнено';
    if (!st.rel.enabled) {
      body.innerHTML = '<div class="empty">Підбір вимкнено. Вибір повністю ручний.</div>';
      return;
    }
    if (!st.sel.size) {
      body.innerHTML = '<div class="empty">Виберіть файл зліва, і тут з\'являться його route, залежності, Inertia-сторінки, імпорти, батьківські класи та тести.</div>';
      return;
    }
    if (!list.length) {
      body.innerHTML = '<div class="empty">Для вибраних файлів пропозицій немає.</div>';
      return;
    }
    const sum = list.reduce((s, r) => s + r.tokens, 0);
    const lvl1 = list.filter(r => r.level === 1).length;
    body.innerHTML = `<ul class="sug scroll">${list.map(r => `<li>
        <span class="p" title="${esc(r.path)}">${esc(r.path)}</span>
        <span class="add">${eyeBtn(esc(r.path))}<span class="tok">${fmt(r.tokens)}</span><button class="btn" type="button" data-act="addOne" data-p="${esc(r.path)}">Додати</button></span>
        <span class="why"><span class="lvl">L${r.level}</span><em>${esc(RULE_LABELS[r.rule] || r.rule)}</em> · ${esc(r.reason)}${r.level > 1 ? ` · від ${esc(basename(r.from))}` : ''}</span>
      </li>`).join('')}</ul>
      <div class="sugfoot"><span>Разом ${fmt(sum)} токенів</span><span class="actions">${lvl1 && lvl1 < list.length ? `<button class="btn" type="button" data-act="addLevel1">Лише рівень 1 · ${lvl1}</button>` : ''}<button class="btn solid" type="button" data-act="addAll">Додати всі</button></span></div>`;
  }

  function renderOutput() {
    const pv = st.preview;
    if (!pv) {
      $('meter').innerHTML = '<div class="note">Рахую…</div>';
      return;
    }
    const b = st.budgets[st.budget] || {};
    const cap = pv.usable;
    let cls = 'ok';
    let msg = 'Без ліміту. Бюджет не перевіряється.';
    let pct = 0;
    if (cap) {
      const worst = Math.max(...pv.parts.map(p => p.tokens));
      pct = Math.min(100, (worst / cap) * 100);
      cls = worst > cap ? 'bad' : worst > cap * 0.85 ? 'warn' : 'ok';
      if (worst > cap) msg = pv.parts.length > 1 ? 'Одна з частин більша за ліміт: є файл, що сам не вміщується.' : `Перевищено на ${fmt(pv.total - cap)}. Приберіть файли або увімкніть розбиття.`;
      else msg = pv.parts.length > 1 ? `${pv.parts.length} частин, кожна вміщується в ліміт.` : `Лишилось ${fmt(cap - pv.total)} до межі.`;
    }
    $('meter').innerHTML = `<div class="big"><strong>${fmt(pv.total)}</strong><span>${cap ? `із ${fmt(cap)} корисних · ліміт ${fmt(b.limit)} мінус резерв ${fmt(b.reserve || 0)}` : 'токенів (оцінка)'}</span></div>
      ${cap ? `<div class="track" role="progressbar" aria-valuenow="${Math.round(pct)}" aria-valuemin="0" aria-valuemax="100"><div class="fill ${cls === 'ok' ? '' : cls}" style="width:${pct}%"></div></div>` : ''}
      <div class="state ${cls}">${esc(msg)}</div>`;

    const warns = pv.warnings;
    const shown = warns.slice(0, 8);
    $('warns').innerHTML = shown.map(w => `<div class="warn-i${w.level === 'over' ? ' bad' : ''}">${esc(w.text)}</div>`).join('') +
      (warns.length > shown.length ? `<div class="note">…і ще ${warns.length - shown.length}</div>` : '') +
      (!st.sel.size ? '<div class="note">Нічого не вибрано.</div>' : '');

    const top = [...pv.files].sort((a, b2) => b2.tokens - a.tokens).slice(0, 5);
    const max = top.length ? top[0].tokens || 1 : 1;
    $('heavyWrap').hidden = !top.length;
    $('heavy').innerHTML = top.map(f => `<div class="hv"><div class="n" title="Переглянути ${esc(f.path)}" data-act="peek" data-p="${esc(f.path)}"><i style="width:${(f.tokens / max) * 100}%"></i><span>${esc(f.path)}</span></div><span class="t">${fmt(f.tokens)}</span><button type="button" data-act="drop" data-p="${esc(f.path)}" aria-label="Прибрати ${esc(f.path)}">×</button></div>`).join('');

    const multi = pv.parts.length > 1;
    $('partsWrap').hidden = !multi;
    $('copyBtn').hidden = multi;
    $('parts').innerHTML = multi ? pv.parts.map(p => `<button class="part" type="button" data-act="copyPart" data-i="${p.index}">Копіювати частину ${p.index} · ${fmt(p.tokens)} · ${p.files} файл.</button>`).join('') : '';
    $('copyBtn').textContent = st.secretAck ? 'Є можливі секрети · копіювати все одно' : 'Копіювати MD';
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
      if (st.prevOpen) showPreview();
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
  function exportNow() {
    const body = exportBody();
    const key = JSON.stringify(body);
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
      return navigator.clipboard.write([new ClipboardItem({ 'text/plain': textPromise.then(t => new Blob([t], { type: 'text/plain' })) })]);
    }
    return textPromise.then(t => navigator.clipboard.writeText(t));
  }

  async function copyPart(index) {
    const hasSecrets = st.preview && st.preview.warnings.some(w => w.level === 'secret');
    if (hasSecrets && !st.secretAck) {
      st.secretAck = true;
      renderOutput();
      toast('У вибраних файлах є можливі секрети (див. попередження). Натисніть ще раз, щоб скопіювати.');
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
      toast(`Скопійовано${r.parts.length > 1 ? ` частину ${index} з ${r.parts.length}` : ''} · ~${fmt(part.tokens)} токенів`);
    } catch (err) {
      try {
        await showPreview(index);
        const range = document.createRange();
        range.selectNodeContents($('md'));
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        toast('Автоматично скопіювати не вдалося. Текст виділено, натисніть Cmd/Ctrl+C.');
      } catch {
        toast(err.message);
      }
    }
  }

  async function saveExport() {
    try {
      const r = await api('/api/export', { ...exportBody(), save: true });
      const dir = r.saved[0].slice(0, r.saved[0].length - basename(r.saved[0]).length);
      toast(`Збережено в ${dir}: ${r.saved.map(basename).join(', ')}`);
    } catch (err) {
      toast(err.message);
    }
  }

  async function showPreview(index) {
    st.prevOpen = true;
    $('prevWrap').hidden = false;
    $('prevBtn').textContent = 'Сховати перегляд';
    const r = await exportNow();
    const parts = index ? [r.parts[index - 1]] : r.parts;
    let text = parts.map(p => (r.parts.length > 1 ? `<!-- ── частина ${p.index} з ${r.parts.length} ── -->\n\n` : '') + p.markdown).join('\n\n');
    const cut = text.length > PREVIEW_LIMIT;
    if (cut && !index) text = text.slice(0, PREVIEW_LIMIT);
    $('md').textContent = text;
    $('prevNote').textContent = cut && !index ? `Показано перші ${fmt(PREVIEW_LIMIT)} символів. Копіювання бере весь текст.` : '';
  }

  function togglePreview() {
    if (st.prevOpen) {
      st.prevOpen = false;
      $('prevWrap').hidden = true;
      $('prevBtn').textContent = 'Попередній перегляд';
      return;
    }
    showPreview().catch(err => toast(err.message));
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
    toast(r.missing.length ? `Пресет застосовано. Не знайдено: ${r.missing.join(', ')}` : `Пресет «${name}»: ${st.sel.size} файлів`);
  }

  async function savePreset() {
    const name = $('presetName').value.trim();
    if (!name) return toast('Вкажіть назву пресету');
    if (!st.sel.size) return toast('Спершу виберіть файли');
    try {
      const r = await api('/api/presets', { name, preset: { include: [...st.sel], task: $('task').value, budget: st.budget } });
      st.presets = r.presets;
      $('presetName').value = '';
      renderPresets();
      $('preset').value = name;
      $('delPreset').hidden = false;
      toast(`Пресет «${name}» збережено в .ctxpack.json`);
    } catch (err) {
      toast(err.message);
    }
  }

  async function deletePreset(btn) {
    const name = $('preset').value;
    if (!name) return;
    if (btn.dataset.armed !== '1') {
      btn.dataset.armed = '1';
      btn.textContent = 'Точно видалити?';
      setTimeout(() => { btn.dataset.armed = ''; btn.textContent = 'Видалити'; }, 3000);
      return;
    }
    try {
      const r = await api('/api/presets', { name, preset: null });
      st.presets = r.presets;
      $('preset').value = '';
      renderPresets();
      toast(`Пресет «${name}» видалено`);
    } catch (err) {
      toast(err.message);
    }
  }

  async function addChanged() {
    try {
      const r = await api('/api/changed');
      if (!r.git) return toast('Це не git-репозиторій');
      if (!r.files.length) return toast('Змінених файлів немає');
      r.files.forEach(p => st.sel.add(p));
      openAncestors(r.files);
      selectionChanged();
      toast(`Додано змінені файли: ${r.files.length}`);
    } catch (err) {
      toast(err.message);
    }
  }

  // ---- file preview ----
  function updatePeekToggle() {
    const on = st.sel.has(st.peekPath);
    $('peekToggle').textContent = on ? 'Прибрати з вибору' : 'Додати до вибору';
    $('peekToggle').classList.toggle('solid', !on);
  }

  async function peek(path) {
    const dlg = $('peek');
    st.peekPath = path;
    $('peekTitle').textContent = path;
    $('peekMeta').textContent = 'Завантаження…';
    $('peekWarn').innerHTML = '';
    $('peekCode').textContent = '';
    $('peekToggle').disabled = !pickable(path);
    $('peekIde').href = `phpstorm://open?file=${encodeURIComponent(`${st.root}/${path}`)}&line=1`;
    updatePeekToggle();
    if (!dlg.open) dlg.showModal();
    try {
      const f = await api('/api/file', { path });
      if (st.peekPath !== path) return;
      $('peekMeta').textContent = `${f.lines} рядків · ~${fmt(f.tokens)} токенів${f.language ? ' · ' + f.language : ''}`;
      const secretLines = new Set(f.secrets.map(s => s.line));
      $('peekCode').innerHTML = f.content.split('\n')
        .map((line, i) => `<span class="ln">${i + 1}</span>${secretLines.has(i + 1) ? `<mark>${esc(line)}</mark>` : esc(line)}`)
        .join('\n');
      const notes = [];
      if (secretLines.size) notes.push(`<div class="warn-i">Можливі секрети в рядках: ${[...secretLines].join(', ')}</div>`);
      if (f.truncated) notes.push('<div class="note">Файл великий: показано перші 400 КБ.</div>');
      if (!f.exportable) notes.push(`<div class="note">Файл більший за ${st.maxFileKb} КБ, тому в експорт не потрапить.</div>`);
      $('peekWarn').innerHTML = notes.join('');
    } catch (err) {
      $('peekMeta').textContent = '';
      $('peekWarn').innerHTML = `<div class="warn-i bad">${esc(err.message)}</div>`;
    }
  }

  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { t.hidden = true; }, 3200);
  }

  // ---- events ----
  document.addEventListener('click', e => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const p = el.dataset.p;
    switch (el.dataset.act) {
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
      case 'peekClose':
        $('peek').close();
        return;
      case 'peekToggle':
        if (st.sel.has(st.peekPath)) {
          st.sel.delete(st.peekPath);
        } else {
          st.sel.add(st.peekPath);
          openAncestors([st.peekPath]);
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
      case 'togglePrev':
        togglePreview();
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
    const t = e.target;
    if (t.dataset.rule) {
      st.rel.rules[t.dataset.rule] = t.checked;
      relSettingsChanged();
    } else if (t.id === 'relOn') {
      st.rel.enabled = t.checked;
      relSettingsChanged();
    } else if (t.id === 'depth') {
      st.rel.depth = Number(t.value);
      relSettingsChanged();
    } else if (t.id === 'split') {
      st.split = t.checked;
      persist();
      refresh({ related: false });
    } else if (t.id === 'preset') {
      $('delPreset').hidden = !t.value;
      if (t.value) applyPreset(t.value).catch(err => toast(err.message));
    }
  });

  // A click on the backdrop lands on the <dialog> itself (it has no padding).
  $('peek').addEventListener('click', e => {
    if (e.target === e.currentTarget) e.currentTarget.close();
  });
  $('q').addEventListener('input', e => {
    st.q = e.target.value.trim();
    renderTree();
  });
  $('task').addEventListener('input', () => {
    persist();
    refresh({ related: false });
  });

  // ---- boot ----
  async function init() {
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

      renderHeader();
      renderBudgets();
      renderPresets();
      renderRules();
      renderTree();
      renderRelated();
      renderOutput();
      refresh();
    } catch (err) {
      $('proj').textContent = 'Помилка';
      $('tree').innerHTML = `<div class="empty err">Не вдалося завантажити проєкт: ${esc(err.message)}</div>`;
    }
  }

  init();
})();
