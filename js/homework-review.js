/* Vocabulario — homework results and review (teachers).
 *  - renderTable: who submitted, who did not, scores
 *  - renderSubmission: one student's answers, auto-check results, points + comments
 */
(function () {
  'use strict';

  function C() { return window.VocabCore; }
  function U() { return window.VocabHW.util; }
  function h() { return C().h.apply(null, arguments); }
  function add() { return U().add.apply(null, arguments); }
  function fill() { return U().fill.apply(null, arguments); }

  const STATUS = {
    none:      { label: 'Not started',  kind: 'late',   rank: 3 },
    draft:     { label: 'In progress',  kind: '',       rank: 2 },
    submitted: { label: 'To review',    kind: 'accent', rank: 0 },
    returned:  { label: 'Sent back',    kind: 'soon',   rank: 1 },
    reviewed:  { label: 'Reviewed',     kind: 'done',   rank: 4 }
  };

  let tableFilter = 'all';

  // ------------------------------------------------------------- results table
  function renderTable(host, hwId) {
    const st = U().store;
    const hw = st.homeworks.find(function (x) { return x.id === hwId; });
    if (!hw) { U().go('list'); return; }
    const students = U().audience(hw);
    const byStudent = {};
    st.submissions.forEach(function (s) { if (s.homework_id === hw.id) byStudent[s.student_id] = s; });

    const rows = students.map(function (stu) {
      const sub = byStudent[stu.id] || null;
      return { stu: stu, sub: sub, key: sub ? sub.status : 'none' };
    });
    rows.sort(function (a, b) {
      const d = STATUS[a.key].rank - STATUS[b.key].rank;
      return d !== 0 ? d : (a.stu.display_name || '').localeCompare(b.stu.display_name || '');
    });

    const count = function (k) { return rows.filter(function (r) { return r.key === k; }).length; };
    const handedIn = count('submitted') + count('reviewed');
    const reviewedScores = rows.filter(function (r) { return r.key === 'reviewed' && r.sub.score !== null; }).map(function (r) { return Number(r.sub.score); });
    const avg = reviewedScores.length ? reviewedScores.reduce(function (a, b) { return a + b; }, 0) / reviewedScores.length : null;

    add(host, 
      U().backBtn('All homework', function () { U().go('list'); }),
      h('div', { class: 'hw-head' },
        h('h2', { text: hw.title }),
        h('button', { class: 'add-btn', type: 'button', text: 'Edit', onclick: function () { U().go('edit', { id: hw.id }); } })),
      h('div', { class: 'hw-meta tight' },
        hw.due_at ? U().duePill(hw) : U().pill('No deadline'),
        hw.status === 'published' ? U().pill('Published', 'done') : U().pill('Draft', 'soon'),
        U().pill(handedIn + ' of ' + students.length + ' handed in'),
        count('submitted') ? U().pill(count('submitted') + ' to review', 'accent') : null,
        (hw.points_enabled && avg !== null) ? U().pill('Average ' + U().num(avg)) : null));

    if (hw.status !== 'published') {
      add(host, h('div', { class: 'banner warn' }, h('strong', { text: 'This homework is a draft — students cannot see it yet.' })));
    }

    const filters = [
      { key: 'all', label: 'All', n: rows.length },
      { key: 'submitted', label: 'To review', n: count('submitted') },
      { key: 'open', label: 'Not handed in', n: count('none') + count('draft') + count('returned') },
      { key: 'reviewed', label: 'Reviewed', n: count('reviewed') }
    ];
    const chips = h('div', { class: 'filters' }, filters.map(function (f) {
      return h('button', { type: 'button', class: 'chip' + (tableFilter === f.key ? ' active' : ''), onclick: function () { tableFilter = f.key; U().rerender(); } },
        f.label, h('span', { class: 'n', text: String(f.n) }));
    }));
    add(host, chips);

    const shown = rows.filter(function (r) {
      if (tableFilter === 'all') return true;
      if (tableFilter === 'open') return r.key === 'none' || r.key === 'draft' || r.key === 'returned';
      return r.key === tableFilter;
    });
    if (!students.length) {
      add(host, h('div', { class: 'empty' }, h('p', { text: 'Nobody is assigned to this homework yet.' })));
      return;
    }
    if (!shown.length) {
      add(host, h('div', { class: 'empty' }, h('p', { text: 'Nobody here.' })));
      return;
    }
    add(host, h('div', { class: 'res-list' }, shown.map(function (r) {
      const sub = r.sub;
      const info = STATUS[r.key];
      let score = '';
      if (hw.points_enabled && sub) {
        if (sub.status === 'reviewed' && sub.score !== null) score = U().num(sub.score) + ' / ' + U().num(sub.max_score);
        else if (sub.status === 'submitted') score = 'auto ' + U().num(sub.auto_score) + ' / ' + U().num(sub.max_score);
      }
      const canOpen = sub && (sub.status === 'submitted' || sub.status === 'reviewed' || sub.status === 'returned');
      const row = h('div', { class: 'res-row' },
        h('div', { class: 'res-main' },
          h('span', { class: 'res-name', text: r.stu.display_name || 'Student' }),
          h('span', { class: 'res-sub', text: sub && sub.submitted_at ? 'Handed in ' + U().fmtDate(sub.submitted_at) : (sub ? 'Last change ' + U().fmtDate(sub.updated_at) : '') })),
        h('span', { class: 'res-score', text: score }),
        U().pill(info.label, info.kind),
        canOpen ? h('button', { class: 'link-btn', type: 'button', text: sub.status === 'submitted' ? 'Review' : 'Open',
          onclick: function () { U().go('submission', { id: hw.id, sub: sub.id }); } }) : h('span', { class: 'res-spacer' }));
      return row;
    })));
  }

  // --------------------------------------------------------------- one student
  let cache = null;   // { subId, data } so a re-render does not refetch or lose typing

  async function loadSubmission(hwId, subId) {
    const sb = U().sb();
    const r = await Promise.all([
      sb.from('homework_blocks').select('id, pos, type, title, config, points').eq('homework_id', hwId).order('pos').order('id'),
      sb.from('homework_keys').select('block_id, key'),
      sb.from('homework_submissions').select('*, student:profiles!student_id(display_name)').eq('id', subId).maybeSingle()
    ]);
    for (let i = 0; i < 3; i++) if (r[i].error) throw r[i].error;
    if (!r[2].data) throw new Error('Submission not found.');
    const keys = {};
    r[1].data.forEach(function (k) { keys[k.block_id] = k.key; });
    return { blocks: r[0].data, keys: keys, sub: U().normSub(r[2].data) };
  }

  function renderSubmission(host, hwId, subId) {
    const st = U().store;
    const hw = st.homeworks.find(function (x) { return x.id === hwId; });
    const back = function () { cache = null; U().go('review', { id: hwId }); };
    if (!hw) { U().go('list'); return; }
    if (!cache || cache.subId !== subId || Date.now() - cache.at > 60000) {
      add(host, U().backBtn('Results', back), U().loadingEl());
      loadSubmission(hwId, subId).then(function (d) {
        if (U().route.name !== 'submission' || U().route.sub !== subId) return;
        cache = { subId: subId, data: d, at: Date.now() };
        U().rerender();
      }).catch(function (err) {
        if (U().route.name !== 'submission') return;
        fill(host, U().backBtn('Results', back), U().errorBox(err, U().rerender));
      });
      return;
    }
    draw(host, hw, cache.data, back);
  }

  function draw(host, hw, d, back) {
    const sub = d.sub;
    const answers = sub.answers || {};
    const results = sub.results || {};
    const manual = sub.manual || {};
    const inputs = {};   // block id -> {points, comment}

    add(host, 
      U().backBtn('Results', back),
      h('div', { class: 'hw-head' }, h('h2', { text: sub.student_name })),
      h('div', { class: 'hw-meta tight' },
        U().pill(hw.title),
        sub.submitted_at ? U().pill('Handed in ' + U().fmtDate(sub.submitted_at)) : null,
        U().pill(STATUS[sub.status] ? STATUS[sub.status].label : sub.status, STATUS[sub.status] ? STATUS[sub.status].kind : ''),
        hw.points_enabled ? U().pill('Auto-check ' + U().num(sub.auto_score) + ' / ' + U().num(sub.max_score)) : null));

    d.blocks.forEach(function (b) {
      const info = U().BLOCK_INFO[b.type] || { icon: '', label: b.type };
      const res = results[b.id];
      const key = d.keys[b.id] || {};
      const a = answers[b.id];
      const body = h('div', { class: 'blk-body' });

      if (b.type === 'material') {
        add(body, U().renderMaterial(b.config));
      } else if (b.type === 'vocab') {
        const words = (b.config.word_ids || []).map(function (i) { return C().wordById(i); }).filter(Boolean);
        add(body, h('div', { class: 'vocab-list' }, words.map(function (w) {
          return h('div', { class: 'vocab-row' }, h('span', { class: 'v-es', text: w.es }), h('span', { class: 'v-en', text: w.en }));
        })), h('p', { class: 'caption', text: 'Counted from the words the student marked "Got it" when they submitted.' }));
      } else if (b.type === 'choice') {
        add(body, h('p', { class: 'prompt', text: b.config.prompt }),
          h('div', { class: 'opts' }, (b.config.options || []).map(function (o, i) {
            const picked = a === i;
            const isKey = key.correct === i;
            return h('div', { class: 'opt static' + (picked ? ' picked' : '') + (isKey ? ' is-correct' : '') + (picked && !isKey ? ' is-wrong' : '') },
              h('span', { text: o }),
              picked ? h('span', { class: 'tag', text: 'Student' }) : null,
              isKey ? h('span', { class: 'tag ok', text: 'Correct' }) : null);
          })),
          a === undefined || a === null ? h('p', { class: 'caption', text: 'No answer.' }) : null);
      } else if (b.type === 'gaps') {
        const parts = String(b.config.text || '').split('___');
        const keyAns = key.answers || [];
        const line = h('div', { class: 'gap-line' });
        const vals = Array.isArray(a) ? a : [];
        parts.forEach(function (part, i) {
          if (part) add(line, document.createTextNode(part));
          if (i < parts.length - 1) {
            const v = vals[i] || '';
            const ok = (keyAns[i] || []).some(function (x) { return U().norm(x) === U().norm(v); });
            add(line, h('span', { class: 'gap-fill ' + (U().norm(v) === '' ? 'blank' : (ok ? 'ok' : 'bad')), text: v || '—' }));
          }
        });
        add(body, line, h('p', { class: 'caption', text: 'Correct: ' + keyAns.map(function (x) { return x.join(' / '); }).join('  ·  ') }));
      } else if (b.type === 'text') {
        add(body, h('p', { class: 'prompt', text: b.config.prompt }),
          h('div', { class: 'student-text' + (typeof a === 'string' && a.trim() ? '' : ' none'), text: typeof a === 'string' && a.trim() ? a : 'No answer.' }));
        if (key.model) add(body, h('div', { class: 'teacher-note model' }, h('strong', { text: 'Model answer' }), h('p', { text: key.model })));
        const m = manual[b.id] || {};
        const pts = h('input', { type: 'number', class: 'pts-in', min: '0', max: String(b.points), step: '0.5', 'aria-label': 'Points' });
        pts.value = m.points !== undefined ? String(m.points) : '';
        const cm = h('textarea', { rows: '2', maxlength: '1000', placeholder: 'Comment for the student (optional)' });
        cm.value = m.comment || '';
        inputs[b.id] = { pts: pts, cm: cm, block: b };
        add(body, h('div', { class: 'grade-row' },
          hw.points_enabled ? h('label', { class: 'pts-wrap' }, pts, h('span', { text: '/ ' + U().num(b.points) + ' pts' })) : null,
          cm));
      } else if (b.type === 'done') {
        add(body, h('div', { class: 'opt static' + (a === true ? ' is-correct' : ' is-wrong') },
          h('span', { text: (a === true ? '☑ ' : '☐ ') + b.config.label })));
      }

      const chip = (res && b.type !== 'material' && b.type !== 'text')
        ? U().pill({ correct: 'Correct', partial: 'Partly correct', wrong: 'Incorrect', empty: 'Not answered' }[res.state] +
          (hw.points_enabled ? ' · ' + U().num(res.earned) + '/' + U().num(res.max) : ''),
          { correct: 'done', partial: 'soon', wrong: 'late', empty: 'late' }[res.state]) : null;
      add(host, h('section', { class: 'blk' + (res && b.type !== 'text' && b.type !== 'material' ? ' r-' + res.state : '') },
        h('div', { class: 'blk-head' },
          h('span', { class: 'blk-type', text: info.icon + ' ' + (b.title || info.label) }),
          (hw.points_enabled && b.points > 0 && b.type !== 'material') ? h('span', { class: 'blk-pts', text: U().num(b.points) + (U().num(b.points) === 1 ? ' pt' : ' pts') }) : null,
          chip),
        body));
    });

    // ---- overall + actions
    const overall = h('textarea', { rows: '3', maxlength: '2000', placeholder: 'Overall comment for the student (optional)' });
    overall.value = sub.teacher_comment || '';
    const msg = h('p', { class: 'form-msg error hidden', role: 'alert' });
    const okBtn = h('button', { class: 'primary-btn', type: 'button', text: sub.status === 'reviewed' ? 'Update review' : 'Mark as reviewed', onclick: function () { send('reviewed'); } });
    const retBtn = h('button', { class: 'ctrl-btn', type: 'button', text: 'Send back for changes', onclick: function () { send('returned'); } });
    const canAct = sub.status === 'submitted' || sub.status === 'reviewed';

    async function send(action) {
      msg.classList.add('hidden');
      const payload = {};
      let total = 0;
      for (const id of Object.keys(inputs)) {
        const it = inputs[id];
        let p = 0;
        if (hw.points_enabled) {
          const raw = it.pts.value.trim();
          p = raw === '' ? 0 : parseFloat(raw);
          if (isNaN(p) || p < 0 || p > Number(it.block.points)) {
            msg.textContent = 'Points for "' + (it.block.title || 'written answer') + '" must be between 0 and ' + U().num(it.block.points) + '.';
            msg.classList.remove('hidden');
            return;
          }
        }
        total += p;
        payload[id] = { points: p, comment: it.cm.value.trim() };
      }
      if (action === 'returned' && !overall.value.trim() && !Object.keys(payload).some(function (k) { return payload[k].comment; })) {
        if (!window.confirm('Send it back without a comment? The student will not know what to change.')) return;
      }
      okBtn.disabled = true; retBtn.disabled = true;
      try {
        const res = await U().sb().rpc('review_submission', {
          p_submission: sub.id, p_manual: payload, p_comment: overall.value.trim(), p_action: action });
        if (res.error) throw res.error;
        cache = null;
        await U().ensureLoaded(true);
        C().updateBadge();
        C().toast(action === 'reviewed' ? 'Review saved' : 'Sent back to the student');
        const next = U().store.submissions.filter(function (s) { return s.homework_id === hw.id && s.status === 'submitted'; })[0];
        if (next) U().go('submission', { id: hw.id, sub: next.id });
        else U().go('review', { id: hw.id });
      } catch (err) {
        msg.textContent = C().friendlyError(err);
        msg.classList.remove('hidden');
        okBtn.disabled = false; retBtn.disabled = false;
      }
    }

    add(host, h('div', { class: 'bld-panel' },
      h('h3', { text: 'Your review' }),
      h('div', { class: 'field' }, h('label', { text: 'Comment' }), overall),
      msg,
      canAct ? h('div', { class: 'save-bar static' }, retBtn, okBtn) : h('p', { class: 'caption', text: 'This work is with the student. You can review it again after they submit.' })));
  }

  window.VocabHW.ext.review = { renderTable: renderTable, renderSubmission: renderSubmission };
})();
