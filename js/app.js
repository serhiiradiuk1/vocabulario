/* Vocabulario — flashcards + sortable list, backed by Supabase.
 * Plain browser JS (no build step). All user-supplied text is rendered with
 * textContent via the h() helper, never as HTML.
 */
(function () {
  'use strict';

  // ------------------------------------------------------------------ config
  const TOPICS = [
    { key: 'verbs',    label: 'Everyday verbs',          emoji: '🏃' },
    { key: 'people',   label: 'Feelings & people',       emoji: '💛' },
    { key: 'phrases',  label: 'Connectors & phrases',    emoji: '💬' },
    { key: 'society',  label: 'Society, media & ideas',  emoji: '🌍' },
    { key: 'work',     label: 'Work & business',         emoji: '💼' },
    { key: 'home',     label: 'Home & objects',          emoji: '🏠' },
    { key: 'describe', label: 'Describing things',       emoji: '✨' },
    { key: 'grammar',  label: 'Grammar & numbers',       emoji: '📐' },
    { key: 'places',   label: 'Places, travel & nature', emoji: '🗺️' },
    { key: 'body',     label: 'Body & health',           emoji: '🩺' },
    { key: 'time',     label: 'Time & frequency',        emoji: '⏰' },
    { key: 'food',     label: 'Food & celebrations',     emoji: '🎂' },
    { key: 'sports',   label: 'Sports & games',          emoji: '⚽' },
    { key: 'other',    label: 'Other',                   emoji: '📌' }
  ];
  const TOPIC_KEYS = TOPICS.map(function (t) { return t.key; });
  const TOPIC_BY_KEY = {};
  TOPICS.forEach(function (t) { TOPIC_BY_KEY[t.key] = t; });

  const WORD_SELECT = 'id, es, en, ctx, topic, added_by, created_at, author:profiles!added_by(display_name)';
  const STATUS_LABEL = { new: 'New', review: 'Practicing', good: 'Mastered' };
  const LS = { topics: 'vocab-topics-v2', view: 'vocab-view-v2', theme: 'vocab-theme' };

  const cfg = window.APP_CONFIG || {};
  const configured = !!(cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY &&
    cfg.SUPABASE_URL.indexOf('YOUR-PROJECT') === -1 && cfg.SUPABASE_ANON_KEY.indexOf('YOUR-ANON') === -1);

  // ------------------------------------------------------------------- state
  const state = {
    sb: null,
    screen: 'boot',          // boot | setup | auth | recovery | loading | main | error
    recovery: false,
    user: null,
    profile: null,
    words: [],
    progress: new Map(),     // word_id -> 'review' | 'good'
    view: 'cards',           // cards | list
    filter: 'all',           // all | new | review | good
    topics: new Set(TOPIC_KEYS),
    query: '',
    sortKey: 'es',           // es | en | topic | status | added
    sortDir: 'asc',
    order: [],               // word ids in the current card deck
    cursor: 0,
    loadToken: 0
  };

  const app = document.getElementById('app');
  const toastEl = document.getElementById('toast');
  let activeModal = null;
  let toastTimer = null;

  // ----------------------------------------------------------------- helpers
  function h(tag, attrs) {
    const el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        const v = attrs[k];
        if (v === undefined || v === null || v === false) return;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'value') el.value = v;
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (v === true) el.setAttribute(k, '');
        else el.setAttribute(k, String(v));
      });
    }
    const kids = Array.prototype.slice.call(arguments, 2);
    (function add(list) {
      list.forEach(function (kid) {
        if (kid === null || kid === undefined || kid === false) return;
        if (Array.isArray(kid)) { add(kid); return; }
        el.append(kid && kid.nodeType ? kid : document.createTextNode(String(kid)));
      });
    })(kids);
    return el;
  }

  function lsGet(key) { try { return window.localStorage.getItem(key); } catch (e) { return null; } }
  function lsSet(key, val) { try { window.localStorage.setItem(key, val); } catch (e) { /* ignore */ } }

  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.add('hidden'); }, 3200);
  }

  function shuffled(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  function collator(lang) { return function (a, b) { return a.localeCompare(b, lang, { sensitivity: 'base' }); }; }
  const cmpEs = collator('es');
  const cmpEn = collator('en');

  function friendlyError(err) {
    const m = (err && err.message) ? String(err.message) : 'Something went wrong.';
    if (/invalid login credentials/i.test(m)) return 'Wrong email or password.';
    if (/email not confirmed/i.test(m)) return 'Please confirm your email first (check your inbox).';
    if (/user already registered/i.test(m)) return 'An account with this email already exists. Try signing in.';
    if (/password should be at least/i.test(m)) return m;
    if (/rate limit/i.test(m)) return 'Too many attempts. Please wait a minute and try again.';
    if (/failed to fetch|networkerror/i.test(m)) return 'Network problem. Check your connection and try again.';
    if (/row-level security|permission denied/i.test(m)) return 'You do not have permission to do that.';
    return m;
  }

  function pageUrl() { return window.location.href.split('#')[0].split('?')[0]; }
  function wordById(id) { return state.words.find(function (w) { return w.id === id; }); }
  function statusOf(id) { return state.progress.get(id) || 'new'; }
  function isTeacher() { return !!(state.profile && state.profile.role === 'teacher'); }
  function canEdit(w) { return isTeacher() || (state.user && w.added_by === state.user.id); }
  function topicInfo(key) { return TOPIC_BY_KEY[key] || TOPIC_BY_KEY.other; }
  function authorName(w) { return w.author || 'Original list'; }

  function mount() {
    app.replaceChildren.apply(app, Array.prototype.slice.call(arguments));
  }
  // append()/replaceChildren() turn null into the text "null", so filter first.
  function put(parent, nodes) { parent.append.apply(parent, nodes.filter(Boolean)); }
  function putReplace(parent, nodes) { parent.replaceChildren.apply(parent, nodes.filter(Boolean)); }

  // ------------------------------------------------------------------- theme
  function applyTheme(t) {
    if (t) document.documentElement.setAttribute('data-theme', t);
    else document.documentElement.removeAttribute('data-theme');
  }
  function toggleTheme() {
    const cur = document.documentElement.getAttribute('data-theme');
    const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    let next;
    if (!cur) next = prefersDark ? 'light' : 'dark';
    else next = cur === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    lsSet(LS.theme, next);
  }
  applyTheme(lsGet(LS.theme));

  // ------------------------------------------------------------------- modal
  function closeModal() { if (activeModal) activeModal.close(); }

  function openModal(title, buildBody) {
    closeModal();
    const overlay = h('div', { class: 'modal-overlay' });
    const api = {
      onClose: null,
      close: function () {
        overlay.remove();
        if (activeModal === api) activeModal = null;
        if (api.onClose) api.onClose();
      }
    };
    const panel = h('div', { class: 'modal-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { class: 'modal-head' },
        h('h2', { text: title }),
        h('button', { class: 'modal-close', type: 'button', 'aria-label': 'Close', text: '×', onclick: api.close })
      ),
      buildBody(api)
    );
    overlay.append(panel);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) api.close(); });
    document.body.append(overlay);
    activeModal = api;
    return api;
  }

  // -------------------------------------------------------------------- data
  async function fetchProfile(user) {
    let res = await state.sb.from('profiles').select('id, display_name, role').eq('id', user.id).maybeSingle();
    if (res.error) throw res.error;
    if (!res.data) {
      // Fallback for accounts created before the trigger existed (always a student).
      const meta = user.user_metadata || {};
      const fallbackName = (meta.display_name || (user.email || '').split('@')[0] || 'Student').slice(0, 60);
      const ins = await state.sb.from('profiles').insert({ id: user.id, display_name: fallbackName });
      if (ins.error) throw ins.error;
      res = await state.sb.from('profiles').select('id, display_name, role').eq('id', user.id).maybeSingle();
      if (res.error) throw res.error;
    }
    return res.data;
  }

  function normWord(w) {
    const a = Array.isArray(w.author) ? w.author[0] : w.author;
    return {
      id: w.id, es: w.es, en: w.en, ctx: w.ctx || '', topic: w.topic,
      added_by: w.added_by || null, created_at: w.created_at,
      author: a && a.display_name ? a.display_name : null
    };
  }

  async function fetchWords() {
    const out = [];
    const page = 1000;
    for (let from = 0; ; from += page) {
      const res = await state.sb.from('words').select(WORD_SELECT)
        .order('id', { ascending: true }).range(from, from + page - 1);
      if (res.error) throw res.error;
      res.data.forEach(function (w) { out.push(normWord(w)); });
      if (res.data.length < page) break;
    }
    return out;
  }

  async function fetchProgress(uid) {
    const res = await state.sb.from('progress').select('word_id, status').eq('user_id', uid);
    if (res.error) throw res.error;
    const map = new Map();
    res.data.forEach(function (r) { map.set(r.word_id, r.status); });
    return map;
  }

  // ------------------------------------------------------------ deck / lists
  function deckIds(opts) {
    const useSearch = !!(opts && opts.search);
    const q = state.query.trim().toLowerCase();
    return state.words.filter(function (w) {
      if (!state.topics.has(w.topic)) return false;
      if (state.filter !== 'all' && statusOf(w.id) !== state.filter) return false;
      if (useSearch && q) {
        const hay = (w.es + ' ' + w.en + ' ' + w.ctx).toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    }).map(function (w) { return w.id; });
  }

  function rebuildOrder() {
    state.order = shuffled(deckIds());
    state.cursor = 0;
  }

  // Keep the current position when words are added/edited/removed.
  function syncOrder() {
    const wanted = new Set(deckIds());
    const current = state.order.length ? state.order[state.cursor] : null;
    const kept = state.order.filter(function (id) { return wanted.has(id); });
    const keptSet = new Set(kept);
    deckIds().forEach(function (id) { if (!keptSet.has(id)) kept.push(id); });
    state.order = kept;
    const pos = current === null ? -1 : kept.indexOf(current);
    state.cursor = pos >= 0 ? pos : Math.min(state.cursor, Math.max(kept.length - 1, 0));
  }

  function counts() {
    let good = 0, review = 0, neu = 0, total = 0;
    state.words.forEach(function (w) {
      if (!state.topics.has(w.topic)) return;
      total++;
      const s = statusOf(w.id);
      if (s === 'good') good++; else if (s === 'review') review++; else neu++;
    });
    return { good: good, review: review, neu: neu, total: total };
  }

  function sortedListIds() {
    const ids = deckIds({ search: true });
    const dir = state.sortDir === 'asc' ? 1 : -1;
    const statusRank = { review: 0, new: 1, good: 2 };
    const key = state.sortKey;
    ids.sort(function (a, b) {
      const wa = wordById(a), wb = wordById(b);
      let r = 0;
      if (key === 'es') r = cmpEs(wa.es, wb.es);
      else if (key === 'en') r = cmpEn(wa.en, wb.en);
      else if (key === 'topic') {
        r = TOPIC_KEYS.indexOf(wa.topic) - TOPIC_KEYS.indexOf(wb.topic);
        if (r === 0) r = cmpEs(wa.es, wb.es);
      } else if (key === 'status') {
        r = statusRank[statusOf(a)] - statusRank[statusOf(b)];
        if (r === 0) r = cmpEs(wa.es, wb.es);
      } else if (key === 'added') r = a - b;
      return r * dir;
    });
    return ids;
  }

  // ------------------------------------------------------------ progress I/O
  async function setStatus(wordId, status) {
    const prev = state.progress.get(wordId);
    state.progress.set(wordId, status);
    try {
      const res = await state.sb.from('progress').upsert(
        { user_id: state.user.id, word_id: wordId, status: status, updated_at: new Date().toISOString() },
        { onConflict: 'user_id,word_id' }
      );
      if (res.error) throw res.error;
    } catch (err) {
      if (prev) state.progress.set(wordId, prev); else state.progress.delete(wordId);
      toast('Could not save your progress. ' + friendlyError(err));
      if (state.screen === 'main') renderFilters();
    }
  }

  async function clearStatus(wordId) {
    const prev = state.progress.get(wordId);
    state.progress.delete(wordId);
    try {
      const res = await state.sb.from('progress').delete()
        .eq('user_id', state.user.id).eq('word_id', wordId);
      if (res.error) throw res.error;
    } catch (err) {
      if (prev) state.progress.set(wordId, prev);
      toast('Could not save your progress. ' + friendlyError(err));
    }
  }

  // -------------------------------------------------------------- word CRUD
  async function insertWord(row) {
    const res = await state.sb.from('words').insert(row).select(WORD_SELECT).single();
    if (res.error) throw res.error;
    return normWord(res.data);
  }
  async function updateWord(id, row) {
    const res = await state.sb.from('words').update(row).eq('id', id).select(WORD_SELECT).single();
    if (res.error) throw res.error;
    return normWord(res.data);
  }
  async function removeWord(id) {
    const res = await state.sb.from('words').delete().eq('id', id);
    if (res.error) throw res.error;
  }

  function openWordForm(existing) {
    return openModal(existing ? 'Edit word' : 'Add a word', function (modal) {
      const esIn = h('input', { id: 'f-es', type: 'text', maxlength: '200', required: true, autocomplete: 'off',
        autocapitalize: 'none', value: existing ? existing.es : '' });
      const enIn = h('input', { id: 'f-en', type: 'text', maxlength: '200', required: true, autocomplete: 'off',
        value: existing ? existing.en : '' });
      const ctxIn = h('textarea', { id: 'f-ctx', maxlength: '600', rows: '3' });
      ctxIn.value = existing ? existing.ctx : '';
      const selected = existing ? existing.topic : 'other';
      const topicSel = h('select', { id: 'f-topic' }, TOPICS.map(function (t) {
        return h('option', { value: t.key, selected: t.key === selected, text: t.emoji + ' ' + t.label });
      }));
      const msg = h('p', { class: 'form-msg error hidden' });
      const submit = h('button', { class: 'primary-btn', type: 'submit', text: existing ? 'Save changes' : 'Add word' });

      function field(label, input, id) {
        return h('div', { class: 'field' }, h('label', { for: id, text: label }), input);
      }

      const form = h('form', { novalidate: true, onsubmit: async function (e) {
        e.preventDefault();
        msg.classList.add('hidden');
        const row = { es: esIn.value.trim(), en: enIn.value.trim(), ctx: ctxIn.value.trim(), topic: topicSel.value };
        if (!row.es || !row.en) {
          msg.textContent = 'Please fill in both the Spanish word and its English translation.';
          msg.classList.remove('hidden');
          return;
        }
        if (!existing) {
          const lower = row.es.toLowerCase();
          const dup = state.words.find(function (w) { return w.es.toLowerCase() === lower; });
          if (dup && !window.confirm('"' + dup.es + '" is already in the list (' + dup.en + '). Add it anyway?')) return;
        }
        submit.disabled = true;
        try {
          if (existing) {
            const saved = await updateWord(existing.id, row);
            const i = state.words.findIndex(function (w) { return w.id === existing.id; });
            if (i >= 0) state.words[i] = saved;
            toast('Word updated');
          } else {
            const saved = await insertWord({ es: row.es, en: row.en, ctx: row.ctx, topic: row.topic, added_by: state.user.id });
            state.words.push(saved);
            state.topics.add(saved.topic);
            lsSet(LS.topics, JSON.stringify(Array.from(state.topics)));
            if (state.filter === 'review' || state.filter === 'good') state.filter = 'all';
            toast('Word added');
          }
          modal.close();
          syncOrder();
          renderShell();
        } catch (err) {
          msg.textContent = friendlyError(err);
          msg.classList.remove('hidden');
          submit.disabled = false;
        }
      } },
        field('Spanish', esIn, 'f-es'),
        field('English', enIn, 'f-en'),
        field('Context or example (optional)', ctxIn, 'f-ctx'),
        field('Topic', topicSel, 'f-topic'),
        msg,
        submit
      );
      setTimeout(function () { esIn.focus(); }, 30);
      return form;
    });
  }

  async function confirmDelete(w) {
    if (!window.confirm('Delete "' + w.es + '"? It will be removed for everyone.')) return;
    try {
      await removeWord(w.id);
      state.words = state.words.filter(function (x) { return x.id !== w.id; });
      state.progress.delete(w.id);
      syncOrder();
      renderShell();
      toast('Word deleted');
    } catch (err) {
      toast('Could not delete. ' + friendlyError(err));
    }
  }

  // ------------------------------------------------------------- topics modal
  function openTopicsModal() {
    const draft = new Set(state.topics);
    const listHost = h('div', { class: 'topic-list' });
    const countEl = h('span', { class: 'modal-count' });

    function perTopic(key) {
      let n = 0;
      state.words.forEach(function (w) { if (w.topic === key) n++; });
      return n;
    }
    function draw() {
      listHost.replaceChildren.apply(listHost, TOPICS.map(function (t) {
        const checked = draft.has(t.key);
        return h('button', { type: 'button', class: 'topic-row' + (checked ? ' checked' : ''),
          'aria-pressed': checked ? 'true' : 'false',
          onclick: function () { if (draft.has(t.key)) draft.delete(t.key); else draft.add(t.key); draw(); } },
          h('span', { class: 'box', text: checked ? '✓' : '' }),
          h('span', { class: 'emoji', text: t.emoji }),
          h('span', { class: 'label', text: t.label }),
          h('span', { class: 'row-count', text: String(perTopic(t.key)) })
        );
      }));
      let n = 0;
      TOPICS.forEach(function (t) { if (draft.has(t.key)) n += perTopic(t.key); });
      countEl.textContent = n + ' word' + (n === 1 ? '' : 's') + ' selected';
    }

    const modal = openModal('Choose topics', function () {
      draw();
      return h('div', null,
        h('div', { class: 'modal-sub' },
          h('div', { class: 'modal-sub-links' },
            h('button', { class: 'link-btn', type: 'button', text: 'Select all',
              onclick: function () { TOPIC_KEYS.forEach(function (k) { draft.add(k); }); draw(); } }),
            h('button', { class: 'link-btn', type: 'button', text: 'Clear all',
              onclick: function () { draft.clear(); draw(); } })
          ),
          countEl
        ),
        listHost,
        h('button', { class: 'primary-btn', type: 'button', text: 'Done', onclick: function () { modal.close(); } })
      );
    });
    modal.onClose = function () {
      state.topics = new Set(draft);
      lsSet(LS.topics, JSON.stringify(Array.from(state.topics)));
      rebuildOrder();
      renderShell();
    };
  }

  // -------------------------------------------------------------- main screen
  function setView(v) {
    state.view = v;
    lsSet(LS.view, v);
    if (v === 'cards') syncOrder();
    renderShell();
  }

  function openCardAt(id) {
    state.view = 'cards';
    lsSet(LS.view, 'cards');
    state.order = sortedListIds();
    const pos = state.order.indexOf(id);
    state.cursor = pos >= 0 ? pos : 0;
    renderShell();
  }

  function renderShell() {
    if (state.screen !== 'main') return;
    const p = state.profile;

    const header = h('header', { class: 'top' },
      h('h1', { text: 'Vocabulario' }),
      h('div', { class: 'header-btns' },
        h('button', { class: 'topics-btn', type: 'button', onclick: openTopicsModal },
          'Topics ', h('span', { class: 'count', text: String(state.topics.size) })),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Refresh words', title: 'Refresh', text: '↻',
          onclick: reloadData }),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Toggle color theme', text: '☀', onclick: toggleTheme })
      )
    );

    const whoami = h('div', { class: 'whoami' },
      h('span', { text: 'Signed in as ' + (p.display_name || 'you') }),
      h('span', { class: 'badge' + (isTeacher() ? ' teacher' : ''), text: isTeacher() ? 'Teacher' : 'Student' }),
      h('button', { class: 'link-btn', type: 'button', text: 'Sign out', onclick: signOut })
    );

    const toolbar = h('div', { class: 'toolbar' },
      h('div', { class: 'view-toggle', role: 'tablist' },
        h('button', { type: 'button', role: 'tab', 'aria-selected': state.view === 'cards' ? 'true' : 'false',
          class: state.view === 'cards' ? 'active' : '', text: 'Flashcards', onclick: function () { setView('cards'); } }),
        h('button', { type: 'button', role: 'tab', 'aria-selected': state.view === 'list' ? 'true' : 'false',
          class: state.view === 'list' ? 'active' : '', text: 'List', onclick: function () { setView('list'); } })
      ),
      h('button', { class: 'add-btn', type: 'button', text: '+ Add word', onclick: function () { openWordForm(null); } })
    );

    const filters = h('div', { class: 'filters', id: 'filters' });
    const body = h('div', { id: 'body' });
    mount(header, whoami, toolbar, filters, body);
    renderFilters();
    if (state.view === 'list') renderList(body); else renderCards(body);
  }

  function renderFilters() {
    const host = document.getElementById('filters');
    if (!host) return;
    const c = counts();
    const defs = [
      { key: 'all', label: 'All', n: c.total },
      { key: 'new', label: 'New', n: c.neu },
      { key: 'review', label: 'Practicing', n: c.review },
      { key: 'good', label: 'Mastered', n: c.good }
    ];
    host.replaceChildren.apply(host, defs.map(function (d) {
      return h('button', { type: 'button', class: 'chip' + (state.filter === d.key ? ' active' : ''),
        onclick: function () {
          state.filter = d.key;
          rebuildOrder();
          renderShell();
        } },
        d.label, h('span', { class: 'n', text: String(d.n) }));
    }));
  }

  function emptyState(text) {
    return h('div', { class: 'empty' },
      h('h2', { text: 'Nothing here yet' }),
      h('p', { text: text || 'No words match the current topics and filters.' }),
      h('button', { class: 'primary-btn', type: 'button', text: 'Show all words', onclick: function () {
        state.filter = 'all';
        state.query = '';
        state.topics = new Set(TOPIC_KEYS);
        lsSet(LS.topics, JSON.stringify(TOPIC_KEYS));
        rebuildOrder();
        renderShell();
      } })
    );
  }

  // ---------------------------------------------------------- flashcard view
  function renderCards(host) {
    if (!state.words.length) {
      host.append(h('div', { class: 'empty' },
        h('h2', { text: 'No words yet' }),
        h('p', { text: 'Add the first word to get started.' }),
        h('button', { class: 'primary-btn', type: 'button', text: '+ Add word', onclick: function () { openWordForm(null); } })));
      return;
    }
    // Drop ids that no longer exist or no longer match.
    if (!state.order.length) state.order = shuffled(deckIds());
    if (!state.order.length) { host.append(emptyState()); return; }
    if (state.cursor >= state.order.length || state.cursor < 0) state.cursor = 0;

    const id = state.order[state.cursor];
    const w = wordById(id);
    if (!w) { syncOrder(); renderShell(); return; }
    const s = statusOf(id);

    const posLabel = 'Card ' + (state.cursor + 1) + ' of ' + state.order.length;
    const fill = h('div', { class: 'progress-fill' });
    fill.style.width = ((state.cursor + 1) / state.order.length * 100) + '%';

    const flipBtn = h('button', { type: 'button', class: 'card', 'aria-label': 'Flip card' },
      h('span', { class: 'face front' },
        h('span', { class: 'eyebrow', text: 'Spanish' }),
        h('span', { class: 'es-word', text: w.es }),
        h('span', { class: 'hint', text: 'Tap to reveal' })
      ),
      h('span', { class: 'face back' },
        h('span', { class: 'back-es', text: w.es }),
        h('span', { class: 'en-word', text: w.en }),
        w.ctx ? h('span', { class: 'ctx', text: w.ctx }) : null,
        h('span', { class: 'byline', text: topicInfo(w.topic).emoji + ' ' + topicInfo(w.topic).label + ' · added by ' + authorName(w) })
      )
    );
    flipBtn.addEventListener('click', function () { flipBtn.classList.toggle('flipped'); });

    const reviewBtn = h('button', { type: 'button', class: 'status-btn review' + (s === 'review' ? ' active' : ''),
      text: 'Still practicing', onclick: function () { markAndAdvance(id, 'review'); } });
    const goodBtn = h('button', { type: 'button', class: 'status-btn good' + (s === 'good' ? ' active' : ''),
      text: 'Got it ✓', onclick: function () { markAndAdvance(id, 'good'); } });

    put(host, [
      h('div', { class: 'stats' }, h('span', { text: posLabel }), h('span', { text: STATUS_LABEL[state.filter] || 'All words' })),
      h('div', { class: 'progress-track' }, fill),
      h('div', { class: 'stage' }, flipBtn),
      h('div', { class: 'controls' },
        h('button', { class: 'ctrl-btn icon', type: 'button', 'aria-label': 'Previous card', text: '←', onclick: prevCard }),
        h('button', { class: 'ctrl-btn', type: 'button', text: 'Shuffle', onclick: function () { rebuildOrder(); renderShell(); } }),
        h('button', { class: 'ctrl-btn icon', type: 'button', 'aria-label': 'Next card', text: '→', onclick: nextCard })
      ),
      h('div', { class: 'status-row' }, reviewBtn, goodBtn),
      s !== 'new' ? h('div', { class: 'clear-status' },
        h('button', { class: 'link-btn', type: 'button', text: 'Clear status', onclick: function () {
          clearStatus(id);
          renderFilters();
          reviewBtn.classList.remove('active');
          goodBtn.classList.remove('active');
        } })) : null,
      h('p', { class: 'footer-note', text: 'Tap the card to flip · ← → to move · space to flip' })
    ]);
  }

  function markAndAdvance(id, status) {
    setStatus(id, status);
    renderFilters();
    setTimeout(function () {
      if (state.screen !== 'main' || state.view !== 'cards') return;
      if (state.order[state.cursor] !== id) return; // user already moved on
      if (state.order.length > 1) nextCard(); else renderShell();
    }, 180);
  }

  function nextCard() {
    if (!state.order.length) return;
    state.cursor = (state.cursor + 1) % state.order.length;
    renderShell();
  }
  function prevCard() {
    if (!state.order.length) return;
    state.cursor = (state.cursor - 1 + state.order.length) % state.order.length;
    renderShell();
  }

  // ---------------------------------------------------------- sortable list
  function renderList(host) {
    const rowsHost = h('div', { class: 'list-view' });
    const countEl = h('div', { class: 'stats' });
    const chipsHost = h('div', { class: 'sort-chips' });

    const search = h('input', { class: 'search', type: 'search', placeholder: 'Search Spanish, English or notes…',
      'aria-label': 'Search words', autocomplete: 'off' });
    search.value = state.query;
    search.addEventListener('input', function () { state.query = search.value; drawRows(); });

    const SORTS = [
      { key: 'es', label: 'Spanish' }, { key: 'en', label: 'English' }, { key: 'topic', label: 'Topic' },
      { key: 'status', label: 'Status' }, { key: 'added', label: 'Added' }
    ];
    function drawChips() {
      chipsHost.replaceChildren.apply(chipsHost, [h('span', { class: 'label', text: 'Sort by' })].concat(SORTS.map(function (sd) {
        const active = state.sortKey === sd.key;
        const arrow = active ? (state.sortDir === 'asc' ? ' ↑' : ' ↓') : '';
        return h('button', { type: 'button', class: 'sort-chip' + (active ? ' active' : ''),
          'aria-pressed': active ? 'true' : 'false', text: sd.label + arrow,
          onclick: function () {
            if (state.sortKey === sd.key) state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
            else { state.sortKey = sd.key; state.sortDir = 'asc'; }
            drawChips();
            drawRows();
          } });
      })));
    }

    function drawRows() {
      const ids = sortedListIds();
      countEl.replaceChildren(h('span', { text: ids.length + ' word' + (ids.length === 1 ? '' : 's') }),
        h('span', { text: STATUS_LABEL[state.filter] || 'All words' }));
      if (!ids.length) {
        rowsHost.replaceChildren(state.query.trim()
          ? h('div', { class: 'empty' }, h('p', { text: 'No words match your search.' }))
          : emptyState());
        return;
      }
      rowsHost.replaceChildren.apply(rowsHost, ids.map(function (id) {
        const w = wordById(id);
        const st = statusOf(id);
        const t = topicInfo(w.topic);
        const actions = canEdit(w) ? h('div', { class: 'row-actions' },
          h('button', { class: 'link-btn', type: 'button', text: 'Edit', 'aria-label': 'Edit ' + w.es,
            onclick: function (e) { e.stopPropagation(); openWordForm(w); } }),
          h('button', { class: 'link-btn danger', type: 'button', text: 'Delete', 'aria-label': 'Delete ' + w.es,
            onclick: function (e) { e.stopPropagation(); confirmDelete(w); } })
        ) : null;
        const row = h('div', { class: 'list-row', role: 'button', tabindex: '0', 'data-id': String(id) },
          h('div', { class: 'list-row-top' },
            h('div', { class: 'list-es', text: w.es }),
            h('div', { class: 'list-en', text: w.en })
          ),
          w.ctx ? h('div', { class: 'list-ctx', text: w.ctx }) : null,
          h('div', { class: 'list-row-bottom' },
            h('div', { class: 'list-meta' },
              h('span', { class: 'list-dot ' + (st === 'new' ? '' : st), title: STATUS_LABEL[st], 'aria-label': STATUS_LABEL[st] }),
              h('span', { text: t.emoji + ' ' + t.label }),
              h('span', { text: 'by ' + authorName(w) })
            ),
            actions
          )
        );
        row.addEventListener('click', function () { openCardAt(id); });
        row.addEventListener('keydown', function (e) {
          if ((e.key === 'Enter' || e.key === ' ') && e.target === row) { e.preventDefault(); openCardAt(id); }
        });
        return row;
      }));
    }

    drawChips();
    drawRows();
    host.append(h('div', { class: 'list-tools' }, search, chipsHost), countEl, rowsHost);
  }

  // --------------------------------------------------------------- data flow
  async function reloadData() {
    try {
      const results = await Promise.all([fetchWords(), fetchProgress(state.user.id)]);
      state.words = results[0];
      state.progress = results[1];
      syncOrder();
      renderShell();
      toast('Up to date');
    } catch (err) {
      toast('Could not refresh. ' + friendlyError(err));
    }
  }

  async function bootMain() {
    const token = ++state.loadToken;
    state.screen = 'loading';
    mount(h('p', { class: 'boot', text: 'Loading your words…' }));
    try {
      const user = state.user;
      const results = await Promise.all([fetchProfile(user), fetchWords(), fetchProgress(user.id)]);
      if (token !== state.loadToken || !state.user) return; // superseded or signed out meanwhile
      state.profile = results[0];
      state.words = results[1];
      state.progress = results[2];

      const savedTopics = lsGet(LS.topics);
      state.topics = new Set(TOPIC_KEYS);
      if (savedTopics) {
        try {
          const arr = JSON.parse(savedTopics).filter(function (k) { return TOPIC_KEYS.indexOf(k) !== -1; });
          if (arr.length) state.topics = new Set(arr);
        } catch (e) { /* keep default */ }
      }
      state.view = lsGet(LS.view) === 'list' ? 'list' : 'cards';
      state.filter = 'all';
      state.query = '';
      state.screen = 'main';
      rebuildOrder();
      renderShell();
    } catch (err) {
      if (token !== state.loadToken) return;
      state.screen = 'error';
      mount(h('div', { class: 'auth-card' },
        h('h1', { text: 'Vocabulario' }),
        h('p', { class: 'form-msg error', text: 'Could not load your data. ' + friendlyError(err) }),
        h('button', { class: 'primary-btn', type: 'button', text: 'Try again', onclick: bootMain }),
        h('div', { class: 'auth-links' }, h('button', { class: 'link-btn', type: 'button', text: 'Sign out', onclick: signOut }))
      ));
    }
  }

  function resetData() {
    state.loadToken++;
    state.user = null;
    state.profile = null;
    state.words = [];
    state.progress = new Map();
    state.order = [];
    state.cursor = 0;
    closeModal();
  }

  async function signOut() {
    try { await state.sb.auth.signOut(); } catch (e) { /* fall through */ }
    resetData();
    renderAuth('signin');
  }

  function handleSession(session) {
    if (state.recovery) return;
    if (!session || !session.user) {
      if (state.screen === 'auth') return;
      resetData();
      renderAuth('signin');
      return;
    }
    if (state.user && state.user.id === session.user.id &&
        (state.screen === 'main' || state.screen === 'loading')) {
      state.user = session.user; // token refresh, nothing to reload
      return;
    }
    state.user = session.user;
    bootMain();
  }

  // ------------------------------------------------------------ auth screens
  function renderSetupNotice() {
    state.screen = 'setup';
    mount(h('div', { class: 'auth-card setup-note' },
      h('h1', { text: 'Vocabulario' }),
      h('p', { class: 'sub', text: 'Almost there — the app is not connected to Supabase yet.' }),
      h('p', null, 'Open ', h('code', { text: 'js/config.js' }), ' and set ', h('code', { text: 'SUPABASE_URL' }),
        ' and ', h('code', { text: 'SUPABASE_ANON_KEY' }), ' from your Supabase project (Project Settings → API).'),
      h('p', null, 'Setup steps are in ', h('code', { text: 'README.md' }), '.')
    ));
  }

  function renderAuth(initialTab, notice) {
    state.screen = 'auth';
    let tab = initialTab === 'signup' ? 'signup' : 'signin';

    const card = h('div', { class: 'auth-card' });
    mount(card);

    function draw(note) {
      const msg = h('p', { class: 'form-msg hidden', role: 'alert' });
      function showMsg(kind, text) {
        msg.className = 'form-msg ' + kind;
        msg.textContent = text;
      }
      const nameIn = h('input', { id: 'a-name', type: 'text', maxlength: '60', autocomplete: 'name', placeholder: 'How should we call you?' });
      const emailIn = h('input', { id: 'a-email', type: 'email', required: true, autocomplete: 'email', inputmode: 'email' });
      const passIn = h('input', { id: 'a-pass', type: 'password', required: true, minlength: '8',
        autocomplete: tab === 'signup' ? 'new-password' : 'current-password' });
      const submit = h('button', { class: 'primary-btn', type: 'submit', text: tab === 'signup' ? 'Create account' : 'Sign in' });

      function field(label, input, id) {
        return h('div', { class: 'field' }, h('label', { for: id, text: label }), input);
      }

      const form = h('form', { onsubmit: async function (e) {
        e.preventDefault();
        msg.className = 'form-msg hidden';
        const email = emailIn.value.trim();
        const password = passIn.value;
        if (!email || !password) { showMsg('error', 'Please enter your email and password.'); return; }
        if (tab === 'signup' && password.length < 8) { showMsg('error', 'Use a password with at least 8 characters.'); return; }
        submit.disabled = true;
        try {
          if (tab === 'signin') {
            const res = await state.sb.auth.signInWithPassword({ email: email, password: password });
            if (res.error) throw res.error;
            // onAuthStateChange takes it from here.
          } else {
            const res = await state.sb.auth.signUp({
              email: email, password: password,
              options: { data: { display_name: nameIn.value.trim() }, emailRedirectTo: pageUrl() }
            });
            if (res.error) throw res.error;
            if (!res.data || !res.data.session) {
              showMsg('ok', 'Account created. Check your inbox to confirm your email, then sign in.');
              submit.disabled = false;
            }
          }
        } catch (err) {
          showMsg('error', friendlyError(err));
          submit.disabled = false;
        }
      } },
        tab === 'signup' ? field('Name', nameIn, 'a-name') : null,
        field('Email', emailIn, 'a-email'),
        field('Password', passIn, 'a-pass'),
        msg,
        submit
      );

      const links = h('div', { class: 'auth-links' });
      if (tab === 'signin') {
        links.append(h('button', { class: 'link-btn', type: 'button', text: 'Forgot password?', onclick: async function () {
          const email = emailIn.value.trim();
          if (!email) { showMsg('error', 'Enter your email above first, then tap "Forgot password?".'); return; }
          try {
            const res = await state.sb.auth.resetPasswordForEmail(email, { redirectTo: pageUrl() });
            if (res.error) throw res.error;
            showMsg('ok', 'If an account exists for that email, a reset link is on its way.');
          } catch (err) { showMsg('error', friendlyError(err)); }
        } }));
      }

      putReplace(card, [
        h('h1', { text: 'Vocabulario' }),
        h('p', { class: 'sub', text: 'Spanish vocabulary, shared by your teacher and students.' }),
        h('div', { class: 'tabs', role: 'tablist' },
          h('button', { type: 'button', role: 'tab', class: tab === 'signin' ? 'active' : '', text: 'Sign in',
            'aria-selected': tab === 'signin' ? 'true' : 'false', onclick: function () { tab = 'signin'; draw(); } }),
          h('button', { type: 'button', role: 'tab', class: tab === 'signup' ? 'active' : '', text: 'Create account',
            'aria-selected': tab === 'signup' ? 'true' : 'false', onclick: function () { tab = 'signup'; draw(); } })
        ),
        note ? h('p', { class: 'form-msg ok', text: note }) : null,
        form,
        links
      ]);
    }
    draw(notice);
  }

  function renderRecovery() {
    state.screen = 'recovery';
    const msg = h('p', { class: 'form-msg hidden', role: 'alert' });
    const passIn = h('input', { id: 'r-pass', type: 'password', required: true, minlength: '8', autocomplete: 'new-password' });
    const submit = h('button', { class: 'primary-btn', type: 'submit', text: 'Save new password' });
    const form = h('form', { onsubmit: async function (e) {
      e.preventDefault();
      if (passIn.value.length < 8) {
        msg.className = 'form-msg error'; msg.textContent = 'Use a password with at least 8 characters.'; return;
      }
      submit.disabled = true;
      try {
        const res = await state.sb.auth.updateUser({ password: passIn.value });
        if (res.error) throw res.error;
        state.recovery = false;
        try { window.history.replaceState(null, '', pageUrl()); } catch (x) { /* ignore */ }
        const s = await state.sb.auth.getSession();
        handleSession(s.data && s.data.session);
        toast('Password updated');
      } catch (err) {
        msg.className = 'form-msg error'; msg.textContent = friendlyError(err);
        submit.disabled = false;
      }
    } },
      h('div', { class: 'field' }, h('label', { for: 'r-pass', text: 'New password' }), passIn),
      msg,
      submit
    );
    mount(h('div', { class: 'auth-card' },
      h('h1', { text: 'Vocabulario' }),
      h('p', { class: 'sub', text: 'Choose a new password.' }),
      form
    ));
  }

  // -------------------------------------------------------------------- keys
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && activeModal) { activeModal.close(); return; }
    if (state.screen !== 'main' || state.view !== 'cards' || activeModal) return;
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (e.key === 'ArrowRight') { nextCard(); }
    else if (e.key === 'ArrowLeft') { prevCard(); }
    else if (e.key === ' ' && tag !== 'BUTTON') {
      e.preventDefault();
      const card = document.querySelector('.card');
      if (card) card.classList.toggle('flipped');
    }
  });

  // -------------------------------------------------------------------- init
  function init() {
    if (!configured) { renderSetupNotice(); return; }
    if (!window.supabase || !window.supabase.createClient) {
      mount(h('div', { class: 'auth-card' },
        h('h1', { text: 'Vocabulario' }),
        h('p', { class: 'form-msg error', text: 'Could not load the Supabase library. Check your connection and reload.' })));
      return;
    }
    state.sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

    const hash = window.location.hash || '';
    if (/type=recovery/.test(hash)) state.recovery = true;

    // Never await Supabase calls inside this callback (it can deadlock); defer instead.
    state.sb.auth.onAuthStateChange(function (event, session) {
      if (event === 'PASSWORD_RECOVERY') {
        state.recovery = true;
        setTimeout(renderRecovery, 0);
        return;
      }
      if (state.recovery) {
        if (state.screen !== 'recovery') setTimeout(renderRecovery, 0);
        return;
      }
      setTimeout(function () { handleSession(session); }, 0);
    });

    state.sb.auth.getSession().then(function (res) {
      if (state.recovery) { if (state.screen !== 'recovery') renderRecovery(); return; }
      handleSession(res && res.data ? res.data.session : null);
    }).catch(function () {
      handleSession(null);
    });
  }

  init();
})();
