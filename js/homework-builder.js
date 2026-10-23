/* Vocabulario — homework builder (teachers).
 * A homework is a header (title, deadline, audience, settings) plus an ordered
 * list of blocks. The whole thing is saved in one call to save_homework().
 */
(function () {
  'use strict';

  function C() { return window.VocabCore; }
  function U() { return window.VocabHW.util; }
  function h() { return C().h.apply(null, arguments); }
  function add() { return U().add.apply(null, arguments); }
  function fill() { return U().fill.apply(null, arguments); }

  const MAX_BLOCKS = 40;
  const MAX_WORDS = 100;
  const TYPES = ['material', 'vocab', 'choice', 'gaps', 'text', 'done'];
  const TYPE_HELP = {
    material: 'Text, a link, a video or an image for the student to read or watch.',
    vocab:    'Pick words; the student studies them with flashcards.',
    choice:   'A question with options. Checked automatically.',
    gaps:     'A sentence with gaps to fill in. Checked automatically.',
    text:     'The student writes an answer; you review it.',
    done:     '"I did it" checkbox, e.g. for a workbook page.'
  };

  let B = null;          // builder state for the homework being edited
  let loadingFor = null;
  let uidSeq = 0;

  // ---------------------------------------------------------------- models
  function newBlock(type) {
    const d = {
      material: { kind: 'text', body: '', url: '' },
      vocab:    { word_ids: [] },
      choice:   { prompt: '', options: ['', ''], correct: 0 },
      gaps:     { text: '', answers: [] },
      text:     { prompt: '', model: '' },
      done:     { label: '' }
    }[type];
    return { uid: ++uidSeq, id: null, type: type, title: '', points: type === 'material' ? 0 : 1, d: d };
  }

  function fromDb(b, key) {
    const c = b.config || {};
    const k = key || {};
    const blk = newBlock(b.type);
    blk.id = b.id;
    blk.title = b.title || '';
    blk.points = Number(b.points);
    if (b.type === 'material') blk.d = { kind: c.kind || 'text', body: c.body || '', url: c.url || '' };
    else if (b.type === 'vocab') blk.d = { word_ids: (c.word_ids || []).slice() };
    else if (b.type === 'choice') blk.d = { prompt: c.prompt || '', options: (c.options || ['', '']).slice(), correct: typeof k.correct === 'number' ? k.correct : 0 };
    else if (b.type === 'gaps') blk.d = { text: c.text || '', answers: (k.answers || []).map(function (a) { return a.join(' / '); }) };
    else if (b.type === 'text') blk.d = { prompt: c.prompt || '', model: k.model || '' };
    else if (b.type === 'done') blk.d = { label: c.label || '' };
    return blk;
  }

  function toPayload(blk) {
    const d = blk.d;
    const out = { type: blk.type, title: blk.title.trim(), points: blk.type === 'material' ? 0 : blk.points, config: {}, key: {} };
    if (blk.id) out.id = blk.id;
    if (blk.type === 'material') {
      out.config = { kind: d.kind, body: d.body, url: d.kind === 'text' ? '' : d.url.trim() };
    } else if (blk.type === 'vocab') {
      out.config = { word_ids: d.word_ids };
    } else if (blk.type === 'choice') {
      out.config = { prompt: d.prompt.trim(), options: d.options.map(function (o) { return o.trim(); }) };
      out.key = { correct: d.correct };
    } else if (blk.type === 'gaps') {
      out.config = { text: d.text };
      const n = gapCount(d.text);
      const answers = [];
      for (let i = 0; i < n; i++) {
        answers.push(String(d.answers[i] || '').split('/').map(function (x) { return x.trim(); }).filter(Boolean));
      }
      out.key = { answers: answers };
    } else if (blk.type === 'text') {
      out.config = { prompt: d.prompt.trim() };
      out.key = { model: d.model.trim() };
    } else if (blk.type === 'done') {
      out.config = { label: d.label.trim() };
    }
    return out;
  }

  function gapCount(t) { return String(t || '').split('___').length - 1; }

  function pad(n) { return n < 10 ? '0' + n : String(n); }
  function toLocalInput(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function blankState() {
    return {
      id: null, title: '', description: '', due: '', status: 'draft', assign_all: true, assignees: new Set(),
      points_enabled: false, show_answers: 'never', allow_resubmit: true, allow_late: true,
      blocks: [], dirty: false, saving: false, started: 0
    };
  }

  // -------------------------------------------------------------- loading
  async function loadInto(homeworkId, asCopy) {
    const sb = U().sb();
    const st = U().store;
    const hw = st.homeworks.find(function (x) { return x.id === homeworkId; });
    if (!hw) throw new Error('Homework not found.');
    const r = await Promise.all([
      sb.from('homework_blocks').select('id, pos, type, title, config, points').eq('homework_id', homeworkId).order('pos').order('id'),
      sb.from('homework_keys').select('block_id, key')
    ]);
    if (r[0].error) throw r[0].error;
    if (r[1].error) throw r[1].error;
    const keys = {};
    r[1].data.forEach(function (k) { keys[k.block_id] = k.key; });
    const s = blankState();
    s.title = hw.title;
    s.description = hw.description || '';
    s.due = toLocalInput(hw.due_at);
    s.status = hw.status;
    s.assign_all = hw.assign_all;
    s.assignees = new Set(U().audienceIds(hw.id));
    s.points_enabled = hw.points_enabled;
    s.show_answers = hw.show_answers;
    s.allow_resubmit = hw.allow_resubmit;
    s.allow_late = hw.allow_late;
    s.blocks = r[0].data.map(function (b) { return fromDb(b, keys[b.id]); });
    s.started = U().store.submissions.filter(function (x) { return x.homework_id === hw.id; }).length;
    if (asCopy) {
      s.id = null;
      s.title = hw.title + ' (copy)';
      s.status = 'draft';
      s.due = '';
      s.started = 0;
      if (s.show_answers === 'after_due') s.show_answers = 'never';
      s.blocks.forEach(function (b) { b.id = null; });
      s.dirty = true;
    } else {
      s.id = hw.id;
    }
    return s;
  }

  function leave() {
    B = null;
    loadingFor = null;
    U().go('list');
  }

  function touch() { if (B) B.dirty = true; }

  // --------------------------------------------------------------- render
  function render(host, route) {
    if (!B) {
      const want = route.draft && route.draft.copyOf ? 'copy:' + route.draft.copyOf : 'id:' + route.id;
      add(host, U().backBtn('All homework', function () { leave(); }), U().loadingEl());
      if (loadingFor === want) return;
      loadingFor = want;
      (async function () {
        try {
          let s;
          if (route.draft && route.draft.copyOf) s = await loadInto(route.draft.copyOf, true);
          else if (route.id) s = await loadInto(route.id, false);
          else s = blankState();
          if (loadingFor !== want || U().route.name !== 'edit') return;
          B = s;
          loadingFor = null;
          U().rerender();
        } catch (err) {
          if (loadingFor !== want) return;
          loadingFor = null;
          fill(host, U().backBtn('All homework', function () { leave(); }), U().errorBox(err, U().rerender));
        }
      })();
      return;
    }
    draw(host);
  }

  function field(label, input, hint) {
    return h('div', { class: 'field' }, h('label', { text: label }), input, hint ? h('p', { class: 'hint-line', text: hint }) : null);
  }

  function draw(host) {
    const s = B;
    const msg = h('p', { class: 'form-msg error hidden', role: 'alert' });
    s.msgEl = msg;

    const titleIn = h('input', { type: 'text', maxlength: '120', placeholder: 'e.g. Week 3 — food and verbs', autocomplete: 'off' });
    titleIn.value = s.title;
    titleIn.addEventListener('input', function () { s.title = titleIn.value; touch(); });
    const descIn = h('textarea', { rows: '2', maxlength: '2000', placeholder: 'Short instructions for the student (optional)' });
    descIn.value = s.description;
    descIn.addEventListener('input', function () { s.description = descIn.value; touch(); });

    const settingsHost = h('div', { class: 'bld-panel' });
    const audienceHost = h('div', { class: 'bld-panel' });
    const blocksHost = h('div', { class: 'bld-blocks' });
    s.blocksHost = blocksHost;

    // ---- due date
    const dueIn = h('input', { type: 'datetime-local' });
    dueIn.value = s.due;
    function setDue(v) { s.due = v; dueIn.value = v; touch(); fixSettings(); drawSettings(); }
    dueIn.addEventListener('change', function () { s.due = dueIn.value; touch(); fixSettings(); drawSettings(); });
    function quick(label, days) {
      return h('button', { type: 'button', class: 'sort-chip', text: label, onclick: function () {
        const d = new Date();
        d.setDate(d.getDate() + days);
        d.setHours(23, 59, 0, 0);
        setDue(toLocalInput(d.toISOString()));
      } });
    }
    const dueBlock = h('div', { class: 'field' },
      h('label', { text: 'Deadline' }), dueIn,
      h('div', { class: 'quick-row' }, quick('Tomorrow', 1), quick('In 3 days', 3), quick('In a week', 7),
        h('button', { type: 'button', class: 'sort-chip', text: 'No deadline', onclick: function () { setDue(''); } })));

    // ---- copy-from (new homework only)
    let copyRow = null;
    const others = U().store.homeworks;
    if (!s.id && !s.blocks.length && !s.title && others.length) {
      const sel = h('select', null, h('option', { value: '', text: 'Blank homework' }),
        others.map(function (o) { return h('option', { value: String(o.id), text: 'Copy of: ' + o.title }); }));
      sel.addEventListener('change', function () {
        if (!sel.value) return;
        B = null;
        U().go('edit', { id: null, draft: { copyOf: Number(sel.value) } });
      });
      copyRow = field('Start from', sel);
    }

    function fixSettings() {
      if (!s.due && s.show_answers === 'after_due') s.show_answers = 'never';
      if (s.allow_resubmit && s.show_answers === 'after_submit') s.show_answers = s.due ? 'after_due' : 'never';
    }

    function drawSettings() {
      const pointsCb = h('input', { type: 'checkbox' });
      pointsCb.checked = s.points_enabled;
      pointsCb.addEventListener('change', function () { s.points_enabled = pointsCb.checked; touch(); drawBlocks(); });

      const resubCb = h('input', { type: 'checkbox' });
      resubCb.checked = s.allow_resubmit;
      resubCb.addEventListener('change', function () { s.allow_resubmit = resubCb.checked; touch(); fixSettings(); drawSettings(); });

      const lateCb = h('input', { type: 'checkbox' });
      lateCb.checked = s.allow_late;
      lateCb.addEventListener('change', function () { s.allow_late = lateCb.checked; touch(); });

      const showSel = h('select', null,
        h('option', { value: 'after_due', text: 'After the deadline', disabled: !s.due }),
        h('option', { value: 'after_submit', text: 'Right after the student submits', disabled: s.allow_resubmit }),
        h('option', { value: 'never', text: 'Never' }));
      showSel.value = s.show_answers;
      showSel.addEventListener('change', function () { s.show_answers = showSel.value; touch(); });

      function check(cb, label, hint) {
        return h('label', { class: 'opt check' }, cb, h('span', null, h('span', { text: label }), hint ? h('span', { class: 'hint-line block', text: hint }) : null));
      }
      fill(settingsHost, 
        h('h3', { text: 'Settings' }),
        check(pointsCb, 'Give points', 'Each question gets points; written answers are scored by you.'),
        check(resubCb, 'Students can edit after submitting', 'Until the deadline, as long as you have not reviewed it.'),
        check(lateCb, 'Accept late work', 'If off, nobody can start or submit after the deadline.'),
        field('Show correct answers', showSel,
          !s.due ? 'Set a deadline to enable "After the deadline".' :
            (s.allow_resubmit ? 'To show answers right after submitting, turn off editing after submit.' : null)));
    }

    // ---- audience
    function drawAudience() {
      const students = U().store.students;
      const allRadio = h('input', { type: 'radio', name: 'aud' });
      allRadio.checked = s.assign_all;
      const pickRadio = h('input', { type: 'radio', name: 'aud' });
      pickRadio.checked = !s.assign_all;
      allRadio.addEventListener('change', function () { s.assign_all = true; touch(); drawAudience(); });
      pickRadio.addEventListener('change', function () { s.assign_all = false; touch(); drawAudience(); });
      const list = h('div', { class: 'aud-list' });
      if (!s.assign_all) {
        if (!students.length) add(list, h('p', { class: 'caption', text: 'No students yet. They appear here after they create an account.' }));
        else {
          const countEl = h('span', { class: 'caption', text: s.assignees.size + ' selected' });
          add(list, h('div', { class: 'aud-tools' },
            h('button', { class: 'link-btn', type: 'button', text: 'Select all', onclick: function () { students.forEach(function (x) { s.assignees.add(x.id); }); touch(); drawAudience(); } }),
            h('button', { class: 'link-btn', type: 'button', text: 'Clear', onclick: function () { s.assignees.clear(); touch(); drawAudience(); } }),
            countEl));
          students.forEach(function (stu) {
            const cb = h('input', { type: 'checkbox' });
            cb.checked = s.assignees.has(stu.id);
            cb.addEventListener('change', function () {
              if (cb.checked) s.assignees.add(stu.id); else s.assignees.delete(stu.id);
              touch();
              countEl.textContent = s.assignees.size + ' selected';
            });
            add(list, h('label', { class: 'opt check' }, cb, h('span', { text: stu.display_name || 'Student' })));
          });
        }
      }
      fill(audienceHost, 
        h('h3', { text: 'Who gets it' }),
        h('label', { class: 'opt check' }, allRadio, h('span', { text: 'All students (including people who join later)' })),
        h('label', { class: 'opt check' }, pickRadio, h('span', { text: 'Selected students' })),
        list);
    }

    // ---- blocks
    function drawBlocks() {
      fill(blocksHost);
      s.blocks.forEach(function (blk, i) { add(blocksHost, blockEditor(blk, i)); });
      if (!s.blocks.length) add(blocksHost, h('p', { class: 'caption center', text: 'No blocks yet. Add the first one below.' }));
    }

    function move(i, d) {
      const j = i + d;
      if (j < 0 || j >= s.blocks.length) return;
      const t = s.blocks[i]; s.blocks[i] = s.blocks[j]; s.blocks[j] = t;
      touch();
      drawBlocks();
    }
    function removeAt(i) {
      s.blocks.splice(i, 1);
      touch();
      drawBlocks();
    }
    function dupAt(i) {
      if (s.blocks.length >= MAX_BLOCKS) return;
      const src = s.blocks[i];
      const copy = newBlock(src.type);
      copy.title = src.title;
      copy.points = src.points;
      copy.d = JSON.parse(JSON.stringify(src.d));
      s.blocks.splice(i + 1, 0, copy);
      touch();
      drawBlocks();
    }

    function blockEditor(blk, i) {
      const info = U().BLOCK_INFO[blk.type];
      const titleIn2 = h('input', { type: 'text', class: 'blk-title-in', maxlength: '120', placeholder: info.label + ' title (optional)' });
      titleIn2.value = blk.title;
      titleIn2.addEventListener('input', function () { blk.title = titleIn2.value; touch(); });
      let ptsIn = null;
      if (s.points_enabled && blk.type !== 'material') {
        ptsIn = h('input', { type: 'number', class: 'pts-in', min: '0', max: '1000', step: '0.5', 'aria-label': 'Points' });
        ptsIn.value = String(blk.points);
        ptsIn.addEventListener('input', function () { const v = parseFloat(ptsIn.value); blk.points = isNaN(v) ? 0 : Math.max(0, Math.min(1000, v)); touch(); });
      }
      const body = h('div', { class: 'bld-body' });
      blockBody(body, blk);
      return h('section', { class: 'bld-block' },
        h('div', { class: 'bld-head' },
          h('span', { class: 'bld-num', text: '#' + (i + 1) + ' ' + info.icon + ' ' + info.label }),
          h('span', { class: 'bld-tools' },
            ptsIn ? h('label', { class: 'pts-wrap' }, ptsIn, h('span', { text: 'pts' })) : null,
            h('button', { type: 'button', class: 'icon-mini', title: 'Move up', 'aria-label': 'Move up', text: '↑', disabled: i === 0, onclick: function () { move(i, -1); } }),
            h('button', { type: 'button', class: 'icon-mini', title: 'Move down', 'aria-label': 'Move down', text: '↓', disabled: i === s.blocks.length - 1, onclick: function () { move(i, 1); } }),
            h('button', { type: 'button', class: 'icon-mini', title: 'Duplicate', 'aria-label': 'Duplicate block', text: '⧉', onclick: function () { dupAt(i); } }),
            h('button', { type: 'button', class: 'icon-mini danger', title: 'Remove', 'aria-label': 'Remove block', text: '✕', onclick: function () { removeAt(i); } }))),
        titleIn2,
        body);
    }

    function blockBody(body, blk) {
      const d = blk.d;
      if (blk.type === 'material') {
        const kindSel = h('select', null,
          h('option', { value: 'text', text: 'Text' }), h('option', { value: 'link', text: 'Link' }),
          h('option', { value: 'video', text: 'Video (YouTube or link)' }), h('option', { value: 'image', text: 'Image (link to a picture)' }));
        kindSel.value = d.kind;
        kindSel.addEventListener('change', function () { d.kind = kindSel.value; touch(); fill(body); blockBody(body, blk); });
        add(body, field('Type', kindSel));
        if (d.kind === 'text') {
          const ta = h('textarea', { rows: '5', maxlength: '5000', placeholder: 'Write or paste the text…' });
          ta.value = d.body;
          ta.addEventListener('input', function () { d.body = ta.value; touch(); });
          add(body, field('Text', ta));
        } else {
          const urlIn = h('input', { type: 'url', maxlength: '500', placeholder: 'https://…', autocomplete: 'off', autocapitalize: 'none' });
          urlIn.value = d.url;
          urlIn.addEventListener('input', function () { d.url = urlIn.value; touch(); });
          const cap = h('input', { type: 'text', maxlength: '300', placeholder: d.kind === 'link' ? 'Link text (optional)' : 'Short note (optional)' });
          cap.value = d.body;
          cap.addEventListener('input', function () { d.body = cap.value; touch(); });
          add(body, field('Web address', urlIn, d.kind === 'image' ? 'Use a direct link to the picture (ends with .jpg, .png…).' : null),
            field(d.kind === 'link' ? 'Link text' : 'Note', cap));
        }
      } else if (blk.type === 'vocab') {
        const chips = h('div', { class: 'chips-wrap' });
        function drawChips() {
          const words = d.word_ids.map(function (i) { return C().wordById(i); }).filter(Boolean);
          fill(chips, 
            h('p', { class: 'caption', text: words.length ? words.length + ' word' + (words.length === 1 ? '' : 's') + ' selected' : 'No words selected yet.' }),
            h('div', { class: 'word-chips' }, words.map(function (w) {
              return h('span', { class: 'word-chip' }, h('span', { text: w.es }),
                h('button', { type: 'button', 'aria-label': 'Remove ' + w.es, text: '×', onclick: function () {
                  d.word_ids = d.word_ids.filter(function (x) { return x !== w.id; }); touch(); drawChips();
                } }));
            })));
        }
        drawChips();
        add(body, chips, h('button', { class: 'ctrl-btn', type: 'button', text: 'Choose words…', onclick: function () {
          openWordPicker(d.word_ids, function (ids) { d.word_ids = ids; touch(); drawChips(); });
        } }));
      } else if (blk.type === 'choice') {
        const q = h('textarea', { rows: '2', maxlength: '500', placeholder: 'Question' });
        q.value = d.prompt;
        q.addEventListener('input', function () { d.prompt = q.value; touch(); });
        const optsHost = h('div', { class: 'opt-edit' });
        function drawOpts() {
          fill(optsHost);
          d.options.forEach(function (o, idx) {
            const radio = h('input', { type: 'radio', name: 'correct-' + blk.uid, 'aria-label': 'Correct answer' });
            radio.checked = d.correct === idx;
            radio.addEventListener('change', function () { d.correct = idx; touch(); });
            const inp = h('input', { type: 'text', maxlength: '200', placeholder: 'Option ' + (idx + 1), autocomplete: 'off' });
            inp.value = o;
            inp.addEventListener('input', function () { d.options[idx] = inp.value; touch(); });
            add(optsHost, h('div', { class: 'opt-row' }, radio, inp,
              h('button', { type: 'button', class: 'icon-mini', 'aria-label': 'Remove option', text: '✕', disabled: d.options.length <= 2, onclick: function () {
                d.options.splice(idx, 1);
                if (d.correct === idx) d.correct = 0; else if (d.correct > idx) d.correct--;
                touch(); drawOpts();
              } })));
          });
          if (d.options.length < 8) {
            add(optsHost, h('button', { type: 'button', class: 'link-btn', text: '+ Add option', onclick: function () { d.options.push(''); touch(); drawOpts(); } }));
          }
        }
        drawOpts();
        add(body, field('Question', q), h('div', { class: 'field' }, h('label', { text: 'Options (select the correct one)' }), optsHost));
      } else if (blk.type === 'gaps') {
        const ta = h('textarea', { rows: '3', maxlength: '1000', placeholder: 'Yo ___ paella y tú ___ vino' });
        ta.value = d.text;
        const ansHost = h('div', { class: 'gap-answers' });
        function drawAns() {
          const n = gapCount(d.text);
          fill(ansHost);
          if (!n) { add(ansHost, h('p', { class: 'caption', text: 'Type ___ (three underscores) where the student should fill in a word.' })); return; }
          for (let i = 0; i < n; i++) {
            const inp = h('input', { type: 'text', maxlength: '300', placeholder: 'Correct answer (alternatives: como / comer)', autocomplete: 'off', autocapitalize: 'none' });
            inp.value = d.answers[i] || '';
            inp.addEventListener('input', function () { d.answers[i] = inp.value; touch(); });
            add(ansHost, h('div', { class: 'gap-ans-row' }, h('span', { class: 'gap-n', text: 'Gap ' + (i + 1) }), inp));
          }
        }
        ta.addEventListener('input', function () {
          const before = gapCount(d.text);
          d.text = ta.value;
          touch();
          if (gapCount(d.text) !== before) drawAns();
        });
        drawAns();
        add(body, field('Sentence', ta, 'Capitals, spaces and punctuation at the ends are ignored when checking. Accents must match.'), ansHost);
      } else if (blk.type === 'text') {
        const q = h('textarea', { rows: '3', maxlength: '1000', placeholder: 'e.g. Describe your weekend in 5 sentences.' });
        q.value = d.prompt;
        q.addEventListener('input', function () { d.prompt = q.value; touch(); });
        const m = h('textarea', { rows: '3', maxlength: '2000', placeholder: 'Model answer (optional, shown to students according to the "Show correct answers" setting)' });
        m.value = d.model;
        m.addEventListener('input', function () { d.model = m.value; touch(); });
        add(body, field('Task', q), field('Model answer', m));
      } else if (blk.type === 'done') {
        const l = h('input', { type: 'text', maxlength: '200', placeholder: 'e.g. I did the exercises on page 42', autocomplete: 'off' });
        l.value = d.label;
        l.addEventListener('input', function () { d.label = l.value; touch(); });
        add(body, field('Checkbox text', l));
      }
    }

    // ---- add block menu
    const addHost = h('div', { class: 'add-block' });
    function drawAdd() {
      fill(addHost, 
        h('h3', { text: 'Add a block' }),
        h('div', { class: 'add-grid' }, TYPES.map(function (t) {
          const info = U().BLOCK_INFO[t];
          return h('button', { type: 'button', class: 'add-tile', title: TYPE_HELP[t], onclick: function () {
            if (s.blocks.length >= MAX_BLOCKS) { C().toast('A homework can have up to ' + MAX_BLOCKS + ' blocks.'); return; }
            s.blocks.push(newBlock(t));
            touch();
            drawBlocks();
            const last = blocksHost.lastElementChild;
            if (last && last.scrollIntoView) last.scrollIntoView({ block: 'center', behavior: 'smooth' });
          } },
            h('span', { class: 'add-ico', text: info.icon }),
            h('span', { class: 'add-name', text: info.label }),
            h('span', { class: 'add-help', text: TYPE_HELP[t] }));
        })));
    }

    // ---- save
    const draftBtn = h('button', { class: 'ctrl-btn', type: 'button', onclick: function () { save('draft'); } },
      s.status === 'published' ? 'Move back to drafts' : 'Save draft');
    const pubBtn = h('button', { class: 'primary-btn', type: 'button', onclick: function () { save('published'); } },
      s.status === 'published' ? 'Save changes' : 'Publish');
    s.btns = [draftBtn, pubBtn];

    fixSettings();
    drawSettings();
    drawAudience();
    drawBlocks();
    drawAdd();

    add(host, 
      U().backBtn('All homework', function () {
        if (B.dirty && !window.confirm('Discard your changes?')) return;
        leave();
      }),
      h('div', { class: 'hw-head' }, h('h2', { text: s.id ? 'Edit homework' : 'New homework' })),
      s.started ? h('div', { class: 'banner info' },
        h('strong', { text: s.started + ' student' + (s.started === 1 ? ' has' : 's have') + ' already started this homework.' }),
        h('p', { text: 'Changing answers or points does not re-grade work that is already submitted.' })) : null,
      copyRow,
      h('div', { class: 'bld-panel' }, field('Title', titleIn), field('Instructions', descIn), dueBlock),
      audienceHost,
      settingsHost,
      h('h3', { class: 'bld-h', text: 'Blocks' }),
      blocksHost,
      addHost,
      msg,
      h('div', { class: 'save-bar' }, draftBtn, pubBtn));
  }

  // ------------------------------------------------------------ word picker
  function openWordPicker(selectedIds, onDone) {
    const chosen = new Set(selectedIds);
    let query = '';
    let topic = '';
    const listHost = h('div', { class: 'picker-list' });
    const countEl = h('span', { class: 'modal-count' });

    function matches() {
      const q = query.trim().toLowerCase();
      return C().state.words.filter(function (w) {
        if (topic && w.topic !== topic) return false;
        if (q && (w.es + ' ' + w.en).toLowerCase().indexOf(q) === -1) return false;
        return true;
      });
    }
    function draw() {
      const ms = matches();
      const shown = ms.slice(0, 150);
      fill(listHost, 
        shown.map(function (w) {
          const cb = h('input', { type: 'checkbox' });
          cb.checked = chosen.has(w.id);
          cb.addEventListener('change', function () {
            if (cb.checked) {
              if (chosen.size >= MAX_WORDS) { cb.checked = false; C().toast('Up to ' + MAX_WORDS + ' words per block.'); return; }
              chosen.add(w.id);
            } else chosen.delete(w.id);
            countEl.textContent = chosen.size + ' selected';
          });
          return h('label', { class: 'picker-row' }, cb, h('span', { class: 'v-es', text: w.es }), h('span', { class: 'v-en', text: w.en }));
        }),
        ms.length > shown.length ? h('p', { class: 'caption center', text: 'Showing the first ' + shown.length + ' of ' + ms.length + '. Narrow the search to see more.' }) : null,
        !ms.length ? h('p', { class: 'caption center', text: 'No words found.' }) : null);
      countEl.textContent = chosen.size + ' selected';
    }

    const modal = C().openModal('Choose words', function () {
      const search = h('input', { class: 'search', type: 'search', placeholder: 'Search…', autocomplete: 'off' });
      search.addEventListener('input', function () { query = search.value; draw(); });
      const topicSel = h('select', { class: 'picker-topic' }, h('option', { value: '', text: 'All topics' }),
        C().TOPICS.map(function (t) { return h('option', { value: t.key, text: t.emoji + ' ' + t.label }); }));
      topicSel.addEventListener('change', function () { topic = topicSel.value; draw(); });
      draw();
      return h('div', null,
        h('div', { class: 'picker-tools' }, search, topicSel),
        h('div', { class: 'modal-sub' },
          h('div', { class: 'modal-sub-links' },
            h('button', { class: 'link-btn', type: 'button', text: 'Add all shown', onclick: function () {
              const ms = matches();
              let skipped = 0;
              ms.forEach(function (w) { if (chosen.size < MAX_WORDS) chosen.add(w.id); else if (!chosen.has(w.id)) skipped++; });
              if (skipped) C().toast('Stopped at ' + MAX_WORDS + ' words.');
              draw();
            } }),
            h('button', { class: 'link-btn', type: 'button', text: 'Clear all', onclick: function () { chosen.clear(); draw(); } })),
          countEl),
        listHost,
        h('button', { class: 'primary-btn', type: 'button', text: 'Use these words', onclick: function () {
          onDone(Array.from(chosen));
          modal.close();
        } }));
    });
  }

  // ------------------------------------------------------------------ save
  function showMsg(text) {
    if (!B || !B.msgEl) return;
    B.msgEl.textContent = text;
    B.msgEl.classList.remove('hidden');
    if (B.msgEl.scrollIntoView) B.msgEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  async function save(status) {
    const s = B;
    if (s.saving) return;
    s.msgEl.classList.add('hidden');
    if (!s.title.trim()) { showMsg('Give the homework a title.'); return; }
    if (status === 'published' && !s.blocks.length) { showMsg('Add at least one block before publishing.'); return; }
    if (status === 'published' && !s.assign_all && !s.assignees.size) { showMsg('Choose at least one student, or switch to "All students".'); return; }

    const payload = {
      title: s.title.trim(),
      description: s.description.trim(),
      due_at: s.due ? new Date(s.due).toISOString() : null,
      status: status,
      assign_all: s.assign_all,
      assignees: s.assign_all ? [] : Array.from(s.assignees),
      points_enabled: s.points_enabled,
      show_answers: s.show_answers,
      allow_resubmit: s.allow_resubmit,
      allow_late: s.allow_late,
      blocks: s.blocks.map(toPayload)
    };
    if (s.id) payload.id = s.id;

    s.saving = true;
    s.btns.forEach(function (b) { b.disabled = true; });
    try {
      const res = await U().sb().rpc('save_homework', { p: payload });
      if (res.error) throw res.error;
      await U().ensureLoaded(true);
      B = null;
      C().updateBadge();
      C().toast(status === 'published' ? 'Homework published' : 'Draft saved');
      U().go('list');
    } catch (err) {
      s.saving = false;
      s.btns.forEach(function (b) { b.disabled = false; });
      showMsg(C().friendlyError(err));
    }
  }

  window.VocabHW.ext.builder = { render: render };
})();
