/* Vocabulario — homework: shared data layer, list screens and the student view.
 * The teacher builder and the review screens live in homework-builder.js and
 * homework-review.js and plug in through window.VocabHW.ext.
 *
 * Everything the user types is rendered with textContent (via VocabCore.h).
 * Permissions are enforced by the database (see supabase/migrations/0002_homework.sql).
 */
(function () {
  'use strict';

  function flat(list) {
    const out = [];
    (function walk(l) {
      l.forEach(function (k) {
        if (k === null || k === undefined || k === false) return;
        if (Array.isArray(k)) walk(k); else out.push(k);
      });
    })(list);
    return out;
  }
  // append()/replaceChildren() turn null into the text "null" and arrays into "[object ...]": flatten first.
  function add(parent) { parent.append.apply(parent, flat(Array.prototype.slice.call(arguments, 1))); return parent; }
  function fill(parent) { parent.replaceChildren.apply(parent, flat(Array.prototype.slice.call(arguments, 1))); return parent; }

  function C() { return window.VocabCore; }
  function h() { return C().h.apply(null, arguments); }
  function sb() { return C().state.sb; }
  function me() { return C().state.user.id; }
  function isT() { return C().isTeacher(); }

  const HW = { ext: {}, util: {} };
  window.VocabHW = HW;

  const HW_COLS = 'id, title, description, due_at, status, assign_all, points_enabled, show_answers, allow_resubmit, allow_late, created_at, updated_at';
  const SUB_COLS = 'id, homework_id, student_id, status, auto_score, max_score, score, submitted_at, reviewed_at, updated_at, student:profiles!student_id(display_name)';

  const BLOCK_INFO = {
    material: { icon: '📖', label: 'Material' },
    vocab:    { icon: '📚', label: 'Vocabulary' },
    choice:   { icon: '❓', label: 'Question' },
    gaps:     { icon: '✏️', label: 'Fill in the gaps' },
    text:     { icon: '📝', label: 'Written answer' },
    done:     { icon: '✅', label: 'Checklist' }
  };

  // ------------------------------------------------------------------- store
  const store = { loaded: false, loading: null, error: null, homeworks: [], submissions: [], assignees: [], students: [] };
  const route = { name: 'list', id: null, sub: null, draft: null };
  let sv = null;              // student view state for route.id
  let renderToken = 0;

  function reset() {
    store.loaded = false; store.loading = null; store.error = null;
    store.homeworks = []; store.submissions = []; store.assignees = []; store.students = [];
    route.name = 'list'; route.id = null; route.sub = null; route.draft = null;
    sv = null;
    renderToken++;
  }

  async function fetchPaged(make) {
    const out = [];
    const page = 1000;
    for (let from = 0; ; from += page) {
      const res = await make().range(from, from + page - 1);
      if (res.error) throw res.error;
      res.data.forEach(function (r) { out.push(r); });
      if (res.data.length < page) break;
    }
    return out;
  }

  function normSub(r) {
    const a = Array.isArray(r.student) ? r.student[0] : r.student;
    const o = Object.assign({}, r);
    o.student_name = a && a.display_name ? a.display_name : 'Unknown';
    delete o.student;
    return o;
  }

  async function loadAll() {
    const jobs = [
      fetchPaged(function () { return sb().from('homeworks').select(HW_COLS).order('created_at', { ascending: false }).order('id', { ascending: false }); }),
      fetchPaged(function () { return sb().from('homework_submissions').select(SUB_COLS).order('id', { ascending: true }); })
    ];
    if (isT()) {
      jobs.push(fetchPaged(function () { return sb().from('homework_assignees').select('homework_id, student_id').order('homework_id'); }));
      jobs.push(fetchPaged(function () { return sb().from('profiles').select('id, display_name, role').order('display_name'); }));
    }
    const r = await Promise.all(jobs);
    store.homeworks = r[0];
    store.submissions = r[1].map(normSub);
    store.assignees = r[2] || [];
    store.students = (r[3] || []).filter(function (p) { return p.role === 'student'; });
    store.loaded = true;
    store.error = null;
  }

  function ensureLoaded(force) {
    if (store.loaded && !force) return Promise.resolve();
    if (store.loading) return store.loading;
    store.loading = loadAll().catch(function (err) {
      store.error = err;
      store.loaded = false;
    }).then(function () { store.loading = null; });
    return store.loading;
  }

  HW.loadSummary = function () { return ensureLoaded(false); };
  HW.refresh = async function (force) {
    sv = null;
    await ensureLoaded(true);
    if (store.error) C().toast('Could not refresh homework. ' + C().friendlyError(store.error));
  };
  HW.reset = reset;

  function subFor(hwId, studentId) {
    for (let i = 0; i < store.submissions.length; i++) {
      const s = store.submissions[i];
      if (s.homework_id === hwId && s.student_id === studentId) return s;
    }
    return null;
  }

  // ---------------------------------------------------------------- helpers
  function num(x) { return Math.round(Number(x || 0) * 100) / 100; }
  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }
  function isPast(iso) { return !!iso && new Date(iso).getTime() < Date.now(); }

  // 'todo' | 'draft' | 'returned' | 'submitted' | 'reviewed' | 'closed'
  function studentState(hw, sub) {
    const st = sub ? sub.status : null;
    if (st === 'reviewed') return 'reviewed';
    if (st === 'submitted') return 'submitted';
    if (isPast(hw.due_at) && !hw.allow_late) return 'closed';
    if (st === 'returned') return 'returned';
    if (st === 'draft') return 'draft';
    return 'todo';
  }
  const STATE_LABEL = {
    todo: 'To do', draft: 'In progress', returned: 'Needs changes', submitted: 'Submitted',
    reviewed: 'Reviewed', closed: 'Closed'
  };

  function pill(text, kind) { return h('span', { class: 'pill' + (kind ? ' ' + kind : ''), text: text }); }

  function duePill(hw) {
    if (!hw.due_at) return pill('No deadline');
    const ms = new Date(hw.due_at).getTime() - Date.now();
    if (ms < 0) return pill((hw.allow_late ? 'Overdue · ' : 'Closed · ') + fmtDate(hw.due_at), 'late');
    if (ms < 48 * 3600 * 1000) return pill('Due soon · ' + fmtDate(hw.due_at), 'soon');
    return pill('Due ' + fmtDate(hw.due_at));
  }

  function safeUrl(u) {
    try {
      const x = new URL(String(u || ''));
      return (x.protocol === 'http:' || x.protocol === 'https:') ? x.href : null;
    } catch (e) { return null; }
  }
  function youTubeId(u) {
    try {
      const x = new URL(u);
      const host = x.hostname.replace(/^www\./, '');
      let id = null;
      if (host === 'youtu.be') id = x.pathname.slice(1);
      else if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtube-nocookie.com') {
        if (x.pathname === '/watch') id = x.searchParams.get('v');
        else {
          const m = x.pathname.match(/^\/(embed|shorts|live)\/([\w-]{11})/);
          if (m) id = m[2];
        }
      }
      return id && /^[\w-]{11}$/.test(id) ? id : null;
    } catch (e) { return null; }
  }

  // Same comparison the database uses: ignore case, spaces and edge punctuation; accents count.
  function norm(t) {
    return String(t == null ? '' : t).trim().replace(/^[\s.,;:!?¡¿]+|[\s.,;:!?¡¿]+$/g, '').replace(/\s+/g, ' ').toLowerCase();
  }

  function bodyHost() { return document.getElementById('body'); }
  function rerender() {
    const host = bodyHost();
    if (!host || C().state.screen !== 'main' || C().state.section !== 'homework') return;
    fill(host);
    HW.render(host);
  }
  function go(name, params) {
    route.name = name;
    route.id = params && params.id !== undefined ? params.id : null;
    route.sub = params && params.sub !== undefined ? params.sub : null;
    route.draft = params && params.draft ? params.draft : null;
    if (name !== 'view') sv = null;
    rerender();
    window.scrollTo(0, 0);
  }

  function loadingEl(text) { return h('p', { class: 'boot small', text: text || 'Loading…' }); }
  function errorBox(err, retry) {
    return h('div', { class: 'empty' },
      h('p', { text: 'Something went wrong. ' + C().friendlyError(err) }),
      h('button', { class: 'primary-btn', type: 'button', text: 'Try again', onclick: retry }));
  }
  function backBtn(label, onclick) {
    return h('button', { class: 'link-btn back-btn', type: 'button', text: '← ' + label, onclick: onclick });
  }

  HW.util = {
    add: add, fill: fill, h: h, sb: sb, me: me, isT: isT, store: store, route: route, go: go, rerender: rerender, ensureLoaded: ensureLoaded,
    num: num, fmtDate: fmtDate, isPast: isPast, pill: pill, duePill: duePill, safeUrl: safeUrl, youTubeId: youTubeId,
    norm: norm, loadingEl: loadingEl, errorBox: errorBox, backBtn: backBtn, subFor: subFor, BLOCK_INFO: BLOCK_INFO,
    studentState: studentState, STATE_LABEL: STATE_LABEL, HW_COLS: HW_COLS, normSub: normSub,
    audienceIds: function (hwId) {
      return store.assignees.filter(function (a) { return a.homework_id === hwId; }).map(function (a) { return a.student_id; });
    },
    // students who should hand this homework in
    audience: function (hw) {
      if (hw.assign_all) return store.students.slice();
      const ids = new Set(HW.util.audienceIds(hw.id));
      return store.students.filter(function (s) { return ids.has(s.id); });
    }
  };

  HW.badgeCount = function () {
    if (!store.loaded) return 0;
    if (isT()) {
      return store.submissions.filter(function (s) { return s.status === 'submitted'; }).length;
    }
    let n = 0;
    store.homeworks.forEach(function (hw) {
      if (hw.status !== 'published') return;
      const st = studentState(hw, subFor(hw.id, me()));
      if (st === 'todo' || st === 'draft' || st === 'returned') n++;
    });
    return n;
  };

  // ----------------------------------------------------------------- router
  HW.render = function (host) {
    renderToken++;
    if (!store.loaded) {
      if (store.error && !store.loading) {
        add(host, errorBox(store.error, function () { store.error = null; rerender(); }));
        return;
      }
      add(host, loadingEl('Loading homework…'));
      ensureLoaded(false).then(function () { rerender(); C().updateBadge(); });
      return;
    }
    if (route.name === 'view' && !isT()) return renderStudentView(host);
    if (isT()) {
      if (route.name === 'edit' && HW.ext.builder) return HW.ext.builder.render(host, route);
      if (route.name === 'review' && HW.ext.review) return HW.ext.review.renderTable(host, route.id);
      if (route.name === 'submission' && HW.ext.review) return HW.ext.review.renderSubmission(host, route.id, route.sub);
      return renderTeacherList(host);
    }
    route.name = 'list';
    return renderStudentList(host);
  };

  // ----------------------------------------------------------- student: list
  function renderStudentList(host) {
    const items = store.homeworks.filter(function (hw) { return hw.status === 'published'; }).map(function (hw) {
      const sub = subFor(hw.id, me());
      return { hw: hw, sub: sub, st: studentState(hw, sub) };
    });
    const rank = { returned: 0, todo: 1, draft: 1, submitted: 2, reviewed: 3, closed: 4 };
    items.sort(function (a, b) {
      if (rank[a.st] !== rank[b.st]) return rank[a.st] - rank[b.st];
      const da = a.hw.due_at ? new Date(a.hw.due_at).getTime() : Infinity;
      const db = b.hw.due_at ? new Date(b.hw.due_at).getTime() : Infinity;
      if (da !== db) return da - db;
      return b.hw.id - a.hw.id;
    });

    add(host, h('div', { class: 'hw-head' }, h('h2', { text: 'Your homework' })));
    if (!items.length) {
      add(host, h('div', { class: 'empty' },
        h('h2', { text: 'No homework yet' }),
        h('p', { text: 'When your teacher assigns something, it will show up here.' })));
      return;
    }
    add(host, h('div', { class: 'hw-list' }, items.map(function (it) {
      const hw = it.hw;
      let result = null;
      if (it.st === 'reviewed' && hw.points_enabled && it.sub.score !== null) {
        result = pill('Score ' + num(it.sub.score) + ' / ' + num(it.sub.max_score), 'done');
      } else if (it.st === 'submitted' && hw.points_enabled) {
        result = pill('Auto-check ' + num(it.sub.auto_score) + ' / ' + num(it.sub.max_score));
      }
      const stKind = { todo: 'accent', draft: 'accent', returned: 'late', submitted: '', reviewed: 'done', closed: 'late' }[it.st];
      const card = h('button', { type: 'button', class: 'hw-card', onclick: function () { go('view', { id: hw.id }); } },
        h('div', { class: 'hw-card-top' },
          h('span', { class: 'hw-title', text: hw.title }),
          pill(STATE_LABEL[it.st], stKind)),
        hw.description ? h('div', { class: 'hw-desc', text: hw.description }) : null,
        h('div', { class: 'hw-meta' },
          (it.st === 'todo' || it.st === 'draft' || it.st === 'returned' || it.st === 'closed') ? duePill(hw) : (hw.due_at ? pill('Due ' + fmtDate(hw.due_at)) : null),
          result));
      return card;
    })));
  }

  // --------------------------------------------------------- student: detail
  async function loadDetail(id) {
    const r = await Promise.all([
      sb().from('homeworks').select(HW_COLS).eq('id', id).maybeSingle(),
      sb().from('homework_blocks').select('id, pos, type, title, config, points').eq('homework_id', id).order('pos').order('id'),
      sb().from('homework_submissions').select('*').eq('homework_id', id).eq('student_id', me()).maybeSingle(),
      sb().rpc('homework_answer_keys', { p_homework: id })
    ]);
    for (let i = 0; i < 3; i++) if (r[i].error) throw r[i].error;
    if (!r[0].data) throw new Error('Homework not found.');
    return { hw: r[0].data, blocks: r[1].data, sub: r[2].data, keys: (!r[3].error && r[3].data) ? r[3].data : {} };
  }

  function answerGiven(b, a) {
    if (b.type === 'choice') return typeof a === 'number';
    if (b.type === 'gaps') return Array.isArray(a) && a.length > 0 && a.every(function (x) { return String(x || '').trim() !== ''; });
    if (b.type === 'text') return typeof a === 'string' && a.trim() !== '';
    if (b.type === 'done') return a === true;
    if (b.type === 'vocab') {
      const ids = (b.config.word_ids || []);
      return ids.length > 0 && ids.every(function (wid) { return !C().wordById(wid) || C().statusOf(wid) === 'good'; });
    }
    return false;
  }

  function gapCount(text) { return String(text || '').split('___').length - 1; }

  async function renderStudentView(host) {
    const id = route.id;
    if (!sv || sv.id !== id) {
      add(host, backBtn('All homework', function () { go('list'); }), loadingEl());
      try {
        const d = await loadDetail(id);
        if (route.name !== 'view' || route.id !== id) return;
        sv = { id: id, hw: d.hw, blocks: d.blocks, sub: d.sub, keys: d.keys, answers: {}, timer: null, saving: false, again: false, statusEl: null, progEl: null, progFill: null };
        const given = d.sub && d.sub.answers ? d.sub.answers : {};
        Object.keys(given).forEach(function (k) { sv.answers[k] = given[k]; });
        rerender();
      } catch (err) {
        if (route.name !== 'view' || route.id !== id) return;
        fill(host, backBtn('All homework', function () { go('list'); }), errorBox(err, rerender));
      }
      return;
    }
    drawStudentView(host);
  }

  function flushThen(next) {
    if (sv && sv.timer) {
      clearTimeout(sv.timer);
      sv.timer = null;
      saveNow().then(next, next);
    } else next();
  }

  function scheduleSave() {
    if (!sv) return;
    sv.dirty = true;
    setStatusText('Unsaved changes…');
    clearTimeout(sv.timer);
    sv.timer = setTimeout(function () { sv.timer = null; saveNow(); }, 1200);
  }

  function setStatusText(t) { if (sv && sv.statusEl) sv.statusEl.textContent = t; }

  async function saveNow() {
    if (!sv) return;
    const mine = sv;
    if (mine.saving) { mine.again = true; return; }
    mine.saving = true;
    setStatusText('Saving…');
    try {
      do {
        mine.again = false;
        mine.dirty = false;
        const res = await sb().rpc('save_homework_draft', { p_homework: mine.id, p_answers: mine.answers });
        if (res.error) throw res.error;
      } while (mine.again);
      if (sv === mine) setStatusText('All changes saved');
      mine.saveFailed = false;
    } catch (err) {
      mine.dirty = true;
      if (sv === mine) setStatusText('Not saved — will retry');
      if (!mine.saveFailed) C().toast('Could not save your answers. ' + C().friendlyError(err));
      mine.saveFailed = true;
      clearTimeout(mine.timer);
      mine.timer = setTimeout(function () { mine.timer = null; saveNow(); }, 5000);
    } finally {
      mine.saving = false;
    }
  }

  function isEditable(s) {
    const st = s.sub ? s.sub.status : null;
    if (st === 'submitted' || st === 'reviewed') return false;
    if (isPast(s.hw.due_at) && !s.hw.allow_late) return false;
    return true;
  }

  function resultChip(res, hw) {
    if (!res) return null;
    const label = { correct: 'Correct', partial: 'Partly correct', wrong: 'Incorrect', pending: 'Waiting for teacher', empty: 'Not answered' }[res.state] || '';
    const kind = { correct: 'done', partial: 'soon', wrong: 'late', pending: '', empty: 'late' }[res.state] || '';
    let t = label;
    if (hw.points_enabled && res.max > 0 && res.state !== 'pending') t += ' · ' + num(res.earned) + '/' + num(res.max);
    return pill(t, kind);
  }

  function drawStudentView(host) {
    const s = sv;
    const hw = s.hw;
    const editable = isEditable(s);
    const st = s.sub ? s.sub.status : null;
    const results = (s.sub && s.sub.results) || {};
    const manual = (s.sub && s.sub.manual) || {};
    const showResults = st === 'submitted' || st === 'reviewed';
    const interactive = s.blocks.filter(function (b) { return b.type !== 'material'; });

    const parts = [];
    parts.push(backBtn('All homework', function () { flushThen(function () { go('list'); }); }));
    parts.push(h('div', { class: 'hw-head' }, h('h2', { text: hw.title })));
    parts.push(h('div', { class: 'hw-meta tight' }, duePill(hw), pill(STATE_LABEL[studentState(hw, s.sub)], studentState(hw, s.sub) === 'reviewed' ? 'done' : '')));
    if (hw.description) parts.push(h('p', { class: 'hw-desc full', text: hw.description }));

    // ---- banners
    if (st === 'returned') {
      parts.push(h('div', { class: 'banner warn' },
        h('strong', { text: 'Your teacher asked for changes.' }),
        s.sub.teacher_comment ? h('p', { text: s.sub.teacher_comment }) : null));
    }
    if (st === 'reviewed') {
      parts.push(h('div', { class: 'banner ok' },
        h('strong', { text: hw.points_enabled && s.sub.score !== null ? 'Reviewed · score ' + num(s.sub.score) + ' / ' + num(s.sub.max_score) : 'Reviewed by your teacher' }),
        s.sub.teacher_comment ? h('p', { text: s.sub.teacher_comment }) : null));
    }
    if (st === 'submitted') {
      const pending = Object.keys(results).some(function (k) { return results[k].state === 'pending'; });
      const bits = ['Submitted ' + fmtDate(s.sub.submitted_at) + '.'];
      if (hw.points_enabled) bits.push('Auto-check: ' + num(s.sub.auto_score) + ' / ' + num(s.sub.max_score) + '.');
      if (pending) bits.push('Your written answers are waiting for your teacher.');
      const canReopen = hw.allow_resubmit && !isPast(hw.due_at);
      parts.push(h('div', { class: 'banner info' },
        h('strong', { text: bits.join(' ') }),
        canReopen ? h('button', { class: 'link-btn', type: 'button', text: 'Edit my answers', onclick: reopen }) : null));
    }
    if (!editable && !st) {
      parts.push(h('div', { class: 'banner warn' }, h('strong', { text: 'The deadline has passed and late work is not accepted.' })));
    }

    // ---- progress
    if (editable && interactive.length) {
      s.progFill = h('div', { class: 'progress-fill' });
      s.progEl = h('span', { text: '' });
      parts.push(h('div', { class: 'stats' }, s.progEl, h('span', { text: '' })));
      parts.push(h('div', { class: 'progress-track' }, s.progFill));
    }

    // ---- blocks
    s.blocks.forEach(function (b) {
      const info = BLOCK_INFO[b.type] || { icon: '', label: b.type };
      const res = showResults ? results[b.id] : null;
      const key = s.keys[b.id];
      const cls = 'blk' + (res ? ' r-' + res.state : '');
      const head = h('div', { class: 'blk-head' },
        h('span', { class: 'blk-type', text: info.icon + ' ' + (b.title || info.label) }),
        (hw.points_enabled && b.points > 0 && b.type !== 'material') ? h('span', { class: 'blk-pts', text: num(b.points) + ' pt' + (num(b.points) === 1 ? '' : 's') }) : null,
        res ? resultChip(res, hw) : null);
      const body = h('div', { class: 'blk-body' });
      renderBlock(body, b, { editable: editable, res: res, key: key, manual: manual[b.id], hw: hw });
      parts.push(h('section', { class: cls }, head, body));
    });

    // ---- submit bar
    if (editable) {
      s.statusEl = h('span', { class: 'save-status', text: s.sub ? 'All changes saved' : '' });
      s.submitBtn = h('button', { class: 'primary-btn', type: 'button', text: st === 'returned' ? 'Submit again' : 'Submit homework', onclick: submit });
      s.msg = h('p', { class: 'form-msg error hidden', role: 'alert' });
      parts.push(s.msg);
      parts.push(h('div', { class: 'submit-bar' }, s.statusEl, s.submitBtn));
    }

    host.append.apply(host, parts);
    if (editable) updateProgress();
  }

  function updateProgress() {
    const s = sv;
    if (!s || !s.progEl) return;
    const items = s.blocks.filter(function (b) { return b.type !== 'material'; });
    let n = 0;
    items.forEach(function (b) { if (answerGiven(b, s.answers[b.id])) n++; });
    s.progEl.textContent = n + ' of ' + items.length + ' done';
    s.progFill.style.width = (items.length ? n / items.length * 100 : 0) + '%';
  }

  async function submit() {
    const s = sv;
    const open = s.blocks.filter(function (b) { return b.type !== 'material' && !answerGiven(b, s.answers[b.id]); }).length;
    const q = open
      ? 'You have ' + open + ' part' + (open === 1 ? '' : 's') + ' not finished yet. Submit anyway?'
      : 'Submit this homework? Your teacher will see it.';
    if (!window.confirm(q)) return;
    clearTimeout(s.timer);
    s.timer = null;
    s.submitBtn.disabled = true;
    s.msg.classList.add('hidden');
    try {
      const res = await sb().rpc('submit_homework', { p_homework: s.id, p_answers: s.answers });
      if (res.error) throw res.error;
      sv = null;
      await ensureLoaded(true);
      C().toast('Homework submitted');
      C().updateBadge();
      rerender();
      window.scrollTo(0, 0);
    } catch (err) {
      s.msg.textContent = C().friendlyError(err);
      s.msg.classList.remove('hidden');
      s.submitBtn.disabled = false;
    }
  }

  async function reopen() {
    const s = sv;
    try {
      const res = await sb().rpc('reopen_submission', { p_homework: s.id });
      if (res.error) throw res.error;
      sv = null;
      await ensureLoaded(true);
      C().updateBadge();
      rerender();
    } catch (err) {
      C().toast(C().friendlyError(err));
    }
  }

  // ------------------------------------------------------ student: block UIs
  function renderBlock(body, b, ctx) {
    const put = function (n) { if (n) add(body, n); };
    if (b.type === 'material') put(materialEl(b.config));
    else if (b.type === 'vocab') put(vocabEl(b, ctx));
    else if (b.type === 'choice') put(choiceEl(b, ctx));
    else if (b.type === 'gaps') put(gapsEl(b, ctx));
    else if (b.type === 'text') put(textEl(b, ctx));
    else if (b.type === 'done') put(doneEl(b, ctx));
  }
  HW.util.renderMaterial = function (cfg) { return materialEl(cfg); };

  function materialEl(cfg) {
    const kind = cfg.kind;
    const url = safeUrl(cfg.url);
    if (kind === 'text') return h('div', { class: 'pre', text: cfg.body || '' });
    const caption = cfg.body ? h('p', { class: 'caption', text: cfg.body }) : null;
    if (!url) return h('p', { class: 'caption', text: 'This link is not available.' });
    if (kind === 'image') {
      return h('div', null,
        h('img', { class: 'mat-img', src: url, alt: cfg.body || 'Homework image', loading: 'lazy', referrerpolicy: 'no-referrer' }),
        caption);
    }
    const link = h('a', { class: 'ext-link', href: url, target: '_blank', rel: 'noopener noreferrer',
      text: kind === 'video' ? 'Open video ↗' : (cfg.body || url) + ' ↗' });
    if (kind === 'video') {
      const yt = youTubeId(url);
      return h('div', null,
        yt ? h('div', { class: 'video-wrap' }, h('iframe', {
          src: 'https://www.youtube-nocookie.com/embed/' + yt, title: 'Video', loading: 'lazy', allowfullscreen: true,
          referrerpolicy: 'strict-origin-when-cross-origin',
          allow: 'accelerometer; encrypted-media; gyroscope; picture-in-picture' })) : null,
        caption, link);
    }
    return h('div', null, link);
  }

  function vocabEl(b, ctx) {
    const ids = (b.config.word_ids || []);
    const words = ids.map(function (i) { return C().wordById(i); }).filter(Boolean);
    const wrap = h('div');
    function draw() {
      const good = words.filter(function (w) { return C().statusOf(w.id) === 'good'; }).length;
      const rows = words.map(function (w) {
        const st = C().statusOf(w.id);
        return h('div', { class: 'vocab-row' },
          h('span', { class: 'list-dot ' + (st === 'new' ? '' : st) }),
          h('span', { class: 'v-es', text: w.es }),
          h('span', { class: 'v-en', text: w.en }));
      });
      fill(wrap, 
        h('div', { class: 'vocab-top' },
          h('span', { class: 'caption', text: good + ' of ' + words.length + ' marked "Got it"' }),
          (ctx.editable && words.length) ? h('button', { class: 'ctrl-btn study-btn', type: 'button', text: 'Study these words',
            onclick: function () { openStudy(words, function () { draw(); updateProgress(); }); } }) : null),
        h('div', { class: 'vocab-list' }, rows),
        ctx.editable ? h('p', { class: 'caption', text: 'This part counts as done when every word is marked "Got it" in the flashcards.' }) : null);
    }
    draw();
    return wrap;
  }

  function openStudy(words, onClose) {
    const order = words.slice().sort(function (a, b) {
      return (C().statusOf(a.id) === 'good' ? 1 : 0) - (C().statusOf(b.id) === 'good' ? 1 : 0);
    });
    let first = order.filter(function (w) { return C().statusOf(w.id) !== 'good'; });
    let rest = order.filter(function (w) { return C().statusOf(w.id) === 'good'; });
    const deck = C().shuffled(first).concat(C().shuffled(rest));
    let i = 0;
    const host = h('div');
    const modal = C().openModal('Study', function () { draw(); return host; });
    modal.onClose = onClose;

    function draw() {
      if (i >= deck.length) {
        const good = deck.filter(function (w) { return C().statusOf(w.id) === 'good'; }).length;
        fill(host, h('div', { class: 'empty' },
          h('h2', { text: 'Round finished' }),
          h('p', { text: good + ' of ' + deck.length + ' words marked "Got it".' }),
          h('div', { class: 'modal-actions' },
            h('button', { class: 'secondary-btn', type: 'button', text: 'Go again', onclick: function () { i = 0; draw(); } }),
            h('button', { class: 'primary-btn', type: 'button', text: 'Done', onclick: function () { modal.close(); } }))));
        return;
      }
      const w = deck[i];
      const s = C().statusOf(w.id);
      const flip = h('button', { type: 'button', class: 'card study-card', 'aria-label': 'Flip card' },
        h('span', { class: 'face front' },
          h('span', { class: 'eyebrow', text: 'Spanish' }),
          h('span', { class: 'es-word', text: w.es }),
          h('span', { class: 'hint', text: 'Tap to reveal' })),
        h('span', { class: 'face back' },
          h('span', { class: 'back-es', text: w.es }),
          h('span', { class: 'en-word', text: w.en }),
          w.ctx ? h('span', { class: 'ctx', text: w.ctx }) : null));
      flip.addEventListener('click', function () { flip.classList.toggle('flipped'); });
      function mark(status) { C().setStatus(w.id, status); i++; draw(); }
      fill(host, 
        h('div', { class: 'stats' }, h('span', { text: 'Card ' + (i + 1) + ' of ' + deck.length })),
        h('div', { class: 'stage' }, flip),
        h('div', { class: 'status-row' },
          h('button', { type: 'button', class: 'status-btn review' + (s === 'review' ? ' active' : ''), text: 'Still practicing', onclick: function () { mark('review'); } }),
          h('button', { type: 'button', class: 'status-btn good' + (s === 'good' ? ' active' : ''), text: 'Got it ✓', onclick: function () { mark('good'); } })));
    }
  }

  function choiceEl(b, ctx) {
    const cfg = b.config;
    const s = sv;
    const cur = s.answers[b.id];
    const correctIdx = ctx.key && typeof ctx.key.correct === 'number' ? ctx.key.correct : null;
    const group = h('div', { class: 'opts', role: 'radiogroup', 'aria-label': cfg.prompt });
    (cfg.options || []).forEach(function (opt, idx) {
      const picked = cur === idx;
      const row = h('label', { class: 'opt' + (picked ? ' picked' : '') +
        (!ctx.editable && correctIdx !== null && idx === correctIdx ? ' is-correct' : '') +
        (!ctx.editable && picked && correctIdx !== null && idx !== correctIdx ? ' is-wrong' : '') });
      const input = h('input', { type: 'radio', name: 'q' + b.id, disabled: !ctx.editable });
      input.checked = picked;
      input.addEventListener('change', function () {
        s.answers[b.id] = idx;
        group.querySelectorAll('.opt').forEach(function (o) { o.classList.remove('picked'); });
        row.classList.add('picked');
        scheduleSave();
        updateProgress();
      });
      add(row, input, h('span', { text: opt }));
      add(group, row);
    });
    return h('div', null, h('p', { class: 'prompt', text: cfg.prompt }), group);
  }

  function gapsEl(b, ctx) {
    const s = sv;
    const parts = String(b.config.text || '').split('___');
    const n = parts.length - 1;
    let cur = Array.isArray(s.answers[b.id]) ? s.answers[b.id].slice() : [];
    while (cur.length < n) cur.push('');
    const keyAns = ctx.key && Array.isArray(ctx.key.answers) ? ctx.key.answers : null;
    const line = h('div', { class: 'gap-line' });
    parts.forEach(function (part, i) {
      if (part) add(line, document.createTextNode(part));
      if (i < n) {
        const input = h('input', { class: 'gap-input', type: 'text', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false',
          'aria-label': 'Gap ' + (i + 1), disabled: !ctx.editable });
        input.value = cur[i] || '';
        input.style.width = Math.max(6, Math.min(24, (cur[i] || '').length + 3)) + 'ch';
        if (!ctx.editable && keyAns && keyAns[i]) {
          const ok = keyAns[i].some(function (a) { return norm(a) === norm(cur[i]); });
          input.classList.add(norm(cur[i]) === '' ? 'blank' : (ok ? 'ok' : 'bad'));
        }
        input.addEventListener('input', function () {
          cur[i] = input.value;
          s.answers[b.id] = cur.slice();
          input.style.width = Math.max(6, Math.min(24, input.value.length + 3)) + 'ch';
          scheduleSave();
          updateProgress();
        });
        add(line, input);
      }
    });
    const wrap = h('div', null, line);
    if (!ctx.editable && keyAns) {
      add(wrap, h('p', { class: 'caption', text: 'Correct: ' + keyAns.map(function (a) { return a.join(' / '); }).join('  ·  ') }));
    }
    return wrap;
  }

  function textEl(b, ctx) {
    const s = sv;
    const ta = h('textarea', { class: 'answer-box', rows: '5', maxlength: '6000', disabled: !ctx.editable, placeholder: ctx.editable ? 'Write your answer…' : '' });
    ta.value = typeof s.answers[b.id] === 'string' ? s.answers[b.id] : '';
    ta.addEventListener('input', function () { s.answers[b.id] = ta.value; scheduleSave(); updateProgress(); });
    const wrap = h('div', null, h('p', { class: 'prompt', text: b.config.prompt }), ta);
    if (ctx.manual) {
      add(wrap, h('div', { class: 'teacher-note' },
        h('strong', { text: 'Teacher' + (ctx.hw.points_enabled ? ' · ' + num(ctx.manual.points) + '/' + num(b.points) : '') }),
        ctx.manual.comment ? h('p', { text: ctx.manual.comment }) : null));
    }
    if (!ctx.editable && ctx.key && ctx.key.model) {
      add(wrap, h('div', { class: 'teacher-note model' }, h('strong', { text: 'Model answer' }), h('p', { text: ctx.key.model })));
    }
    return wrap;
  }

  function doneEl(b, ctx) {
    const s = sv;
    const input = h('input', { type: 'checkbox', disabled: !ctx.editable });
    input.checked = s.answers[b.id] === true;
    input.addEventListener('change', function () { s.answers[b.id] = input.checked; scheduleSave(); updateProgress(); });
    return h('label', { class: 'opt check' }, input, h('span', { text: b.config.label }));
  }

  // ------------------------------------------------------------ teacher: list
  function renderTeacherList(host) {
    route.name = 'list';
    add(host, h('div', { class: 'hw-head' },
      h('h2', { text: 'Homework' }),
      h('button', { class: 'add-btn', type: 'button', text: '+ New homework', onclick: function () { go('edit', { id: null }); } })));

    if (!store.homeworks.length) {
      add(host, h('div', { class: 'empty' },
        h('h2', { text: 'No homework yet' }),
        h('p', { text: 'Build one from blocks: reading material, vocabulary, questions, gaps and written answers.' }),
        h('button', { class: 'primary-btn', type: 'button', text: 'Create the first homework', onclick: function () { go('edit', { id: null }); } })));
      return;
    }

    add(host, h('div', { class: 'hw-list' }, store.homeworks.map(function (hw) {
      const aud = HW.util.audience(hw);
      const subs = store.submissions.filter(function (s) { return s.homework_id === hw.id; });
      const submitted = subs.filter(function (s) { return s.status === 'submitted' || s.status === 'reviewed'; }).length;
      const toReview = subs.filter(function (s) { return s.status === 'submitted'; }).length;
      const published = hw.status === 'published';
      const audText = hw.assign_all ? 'All students' : (aud.length + ' student' + (aud.length === 1 ? '' : 's'));
      const card = h('div', { class: 'hw-card static' },
        h('button', { type: 'button', class: 'hw-card-main', onclick: function () { go(published ? 'review' : 'edit', { id: hw.id }); } },
          h('div', { class: 'hw-card-top' },
            h('span', { class: 'hw-title', text: hw.title }),
            published ? pill('Published', 'done') : pill('Draft', 'soon')),
          h('div', { class: 'hw-meta' },
            hw.due_at ? duePill(hw) : pill('No deadline'),
            pill(audText),
            published ? pill(submitted + '/' + (hw.assign_all ? store.students.length : aud.length) + ' submitted') : null,
            toReview ? pill(toReview + ' to review', 'accent') : null)),
        h('div', { class: 'hw-actions' },
          published ? h('button', { class: 'link-btn', type: 'button', text: 'Results', onclick: function () { go('review', { id: hw.id }); } }) : null,
          h('button', { class: 'link-btn', type: 'button', text: 'Edit', onclick: function () { go('edit', { id: hw.id }); } }),
          h('button', { class: 'link-btn', type: 'button', text: 'Duplicate', onclick: function () { go('edit', { id: null, draft: { copyOf: hw.id } }); } }),
          h('button', { class: 'link-btn danger', type: 'button', text: 'Delete', onclick: function () { removeHomework(hw); } })));
      return card;
    })));
  }

  async function removeHomework(hw) {
    const n = store.submissions.filter(function (s) { return s.homework_id === hw.id; }).length;
    const msg = 'Delete "' + hw.title + '"?' + (n ? ' ' + n + ' submission' + (n === 1 ? '' : 's') + ' will be deleted too.' : '') + ' This cannot be undone.';
    if (!window.confirm(msg)) return;
    try {
      const res = await sb().from('homeworks').delete().eq('id', hw.id);
      if (res.error) throw res.error;
      await ensureLoaded(true);
      C().updateBadge();
      rerender();
      C().toast('Homework deleted');
    } catch (err) {
      C().toast('Could not delete. ' + C().friendlyError(err));
    }
  }
})();
