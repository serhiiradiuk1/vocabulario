-- Vocabulario: homework (block-based assignments).
-- Run after 0001_init.sql in the Supabase SQL Editor (or `supabase db push`).
--
-- Model
--   homeworks             header: title, due date, audience, settings
--   homework_blocks       ordered building blocks (material / vocab / choice / gaps / text / done)
--   homework_keys         answer keys — teachers only, never readable by students
--   homework_assignees    who gets a homework (or homeworks.assign_all = every student)
--   homework_submissions  one row per student per homework: draft answers, auto-check
--                         results, teacher review
--
-- Teachers write through save_homework() / review_submission(); students write
-- only through save_homework_draft() / submit_homework() / reopen_submission().
-- Those functions enforce every rule, so the browser is never trusted.

-- ---------------------------------------------------------------------------
-- tables
-- ---------------------------------------------------------------------------
create table if not exists public.homeworks (
  id             bigint generated always as identity primary key,
  title          text not null check (char_length(btrim(title)) between 1 and 120),
  description    text not null default '' check (char_length(description) <= 2000),
  due_at         timestamptz,
  status         text not null default 'draft' check (status in ('draft', 'published')),
  assign_all     boolean not null default false,
  points_enabled boolean not null default false,
  -- when students may see the correct answers
  show_answers   text not null default 'never'
                   check (show_answers in ('after_submit', 'after_due', 'never')),
  allow_resubmit boolean not null default true,
  allow_late     boolean not null default true,
  created_by     uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  -- showing answers right after submit would let a student "fix" a resubmission
  constraint homeworks_resubmit_vs_answers
    check (not (allow_resubmit and show_answers = 'after_submit')),
  constraint homeworks_after_due_needs_due
    check (show_answers <> 'after_due' or due_at is not null)
);

create table if not exists public.homework_blocks (
  id          bigint generated always as identity primary key,
  homework_id bigint not null references public.homeworks (id) on delete cascade,
  pos         int not null default 0,
  type        text not null check (type in ('material', 'vocab', 'choice', 'gaps', 'text', 'done')),
  title       text not null default '' check (char_length(title) <= 120),
  config      jsonb not null default '{}'::jsonb,
  points      numeric(6, 2) not null default 1 check (points >= 0 and points <= 1000)
);
create index if not exists homework_blocks_hw_idx on public.homework_blocks (homework_id, pos);

create table if not exists public.homework_keys (
  block_id bigint primary key references public.homework_blocks (id) on delete cascade,
  key      jsonb not null default '{}'::jsonb
);

create table if not exists public.homework_assignees (
  homework_id bigint not null references public.homeworks (id) on delete cascade,
  student_id  uuid not null references public.profiles (id) on delete cascade,
  primary key (homework_id, student_id)
);
create index if not exists homework_assignees_student_idx on public.homework_assignees (student_id);

create table if not exists public.homework_submissions (
  id              bigint generated always as identity primary key,
  homework_id     bigint not null references public.homeworks (id) on delete cascade,
  student_id      uuid not null references public.profiles (id) on delete cascade default auth.uid(),
  status          text not null default 'draft'
                    check (status in ('draft', 'submitted', 'reviewed', 'returned')),
  answers         jsonb not null default '{}'::jsonb,   -- { "<block id>": answer }
  results         jsonb not null default '{}'::jsonb,   -- { "<block id>": {state, earned, max} }
  manual          jsonb not null default '{}'::jsonb,   -- { "<block id>": {points, comment} }
  auto_score      numeric(8, 2) not null default 0,
  max_score       numeric(8, 2) not null default 0,
  score           numeric(8, 2),                        -- final, set when the teacher marks reviewed
  teacher_comment text not null default '' check (char_length(teacher_comment) <= 2000),
  submitted_at    timestamptz,
  reviewed_at     timestamptz,
  reviewed_by     uuid references public.profiles (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (homework_id, student_id)
);
create index if not exists homework_submissions_student_idx on public.homework_submissions (student_id);

-- ---------------------------------------------------------------------------
-- row-level security (reads only; all writes go through the functions below)
-- ---------------------------------------------------------------------------
alter table public.homeworks            enable row level security;
alter table public.homework_blocks      enable row level security;
alter table public.homework_keys        enable row level security;
alter table public.homework_assignees   enable row level security;
alter table public.homework_submissions enable row level security;

drop policy if exists "homeworks: teachers see all, students see theirs" on public.homeworks;
create policy "homeworks: teachers see all, students see theirs"
  on public.homeworks for select to authenticated
  using (
    public.is_teacher()
    or (status = 'published' and (
          assign_all
          or exists (select 1 from public.homework_assignees a
                     where a.homework_id = homeworks.id and a.student_id = auth.uid())))
  );

drop policy if exists "homeworks: teachers can delete" on public.homeworks;
create policy "homeworks: teachers can delete"
  on public.homeworks for delete to authenticated
  using (public.is_teacher());

-- A block is visible exactly when its homework is visible (RLS of homeworks applies to the subquery).
drop policy if exists "blocks follow their homework" on public.homework_blocks;
create policy "blocks follow their homework"
  on public.homework_blocks for select to authenticated
  using (exists (select 1 from public.homeworks h where h.id = homework_blocks.homework_id));

drop policy if exists "answer keys: teachers only" on public.homework_keys;
create policy "answer keys: teachers only"
  on public.homework_keys for select to authenticated
  using (public.is_teacher());

drop policy if exists "assignees: teachers see all, students see own" on public.homework_assignees;
create policy "assignees: teachers see all, students see own"
  on public.homework_assignees for select to authenticated
  using (public.is_teacher() or student_id = auth.uid());

drop policy if exists "submissions: teachers see all, students see own" on public.homework_submissions;
create policy "submissions: teachers see all, students see own"
  on public.homework_submissions for select to authenticated
  using (public.is_teacher() or student_id = auth.uid());

revoke all on public.homeworks, public.homework_blocks, public.homework_keys,
              public.homework_assignees, public.homework_submissions from anon, authenticated;
grant select on public.homeworks, public.homework_blocks, public.homework_keys,
                public.homework_assignees, public.homework_submissions to authenticated;
grant delete on public.homeworks to authenticated;

-- ---------------------------------------------------------------------------
-- internal helpers (not callable through the API)
-- ---------------------------------------------------------------------------

-- Compare answers ignoring case, surrounding spaces/punctuation and repeated spaces.
-- Accents are NOT ignored: "esta" and "está" are different words.
create or replace function public.hw_norm(t text)
returns text
language sql
immutable
set search_path = ''
as $$
  select lower(regexp_replace(
    regexp_replace(btrim(coalesce(t, '')), '^[\s.,;:!?¡¿]+|[\s.,;:!?¡¿]+$', '', 'g'),
    '\s+', ' ', 'g'))
$$;

create or replace function public.hw_can_access(p_hw bigint, p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.homeworks h
    where h.id = p_hw and h.status = 'published'
      and (h.assign_all
           or exists (select 1 from public.homework_assignees a
                      where a.homework_id = h.id and a.student_id = p_uid))
  )
$$;

-- Auto-check every block of a homework against the answer keys.
-- Returns {results, auto, max, has_text}.
create or replace function public.hw_grade(p_hw bigint, p_student uuid, p_answers jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  b        record;
  a        jsonb;
  res      jsonb := '{}'::jsonb;
  auto     numeric := 0;
  mx       numeric := 0;
  has_text boolean := false;
  earned   numeric;
  st       text;
  total    int;
  ok       int;
  blanks   int;
  i        int;
  u        text;
  acc      text;
  hit      boolean;
begin
  for b in
    select hb.id, hb.type, hb.config, hb.points, coalesce(hk.key, '{}'::jsonb) as bkey
    from public.homework_blocks hb
    left join public.homework_keys hk on hk.block_id = hb.id
    where hb.homework_id = p_hw
    order by hb.pos, hb.id
  loop
    a := p_answers -> (b.id::text);
    earned := 0;
    st := 'empty';

    if b.type = 'choice' then
      if a is not null and jsonb_typeof(a) = 'number' then
        if (a #>> '{}')::numeric = (b.bkey ->> 'correct')::numeric then
          st := 'correct'; earned := b.points;
        else
          st := 'wrong';
        end if;
      end if;

    elsif b.type = 'gaps' then
      total := coalesce(jsonb_array_length(b.bkey -> 'answers'), 0);
      ok := 0; blanks := 0;
      for i in 0 .. total - 1 loop
        u := case when a is not null and jsonb_typeof(a) = 'array' then (a -> i) #>> '{}' else null end;
        if public.hw_norm(u) = '' then
          blanks := blanks + 1;
          continue;
        end if;
        hit := false;
        for acc in select jsonb_array_elements_text(b.bkey -> 'answers' -> i) loop
          if public.hw_norm(acc) = public.hw_norm(u) then hit := true; exit; end if;
        end loop;
        if hit then ok := ok + 1; end if;
      end loop;
      if total > 0 then
        if blanks = total then st := 'empty';
        elsif ok = total then st := 'correct';
        elsif ok = 0 then st := 'wrong';
        else st := 'partial';
        end if;
        earned := round(b.points * ok / total, 2);
      end if;

    elsif b.type = 'vocab' then
      -- done when the student marked the words "Got it" in the flashcards
      select count(*), count(*) filter (where p.status = 'good')
        into total, ok
      from public.words w
      left join public.progress p on p.word_id = w.id and p.user_id = p_student
      where w.id in (select t.v::bigint from jsonb_array_elements_text(b.config -> 'word_ids') as t(v));
      if total = 0 then continue; end if;
      if ok = total then st := 'correct';
      elsif ok = 0 then st := 'empty';
      else st := 'partial';
      end if;
      earned := round(b.points * ok / total, 2);

    elsif b.type = 'text' then
      has_text := true;
      if a is not null and jsonb_typeof(a) = 'string' and btrim(a #>> '{}') <> '' then
        st := 'pending';
      end if;

    elsif b.type = 'done' then
      if a = 'true'::jsonb then st := 'correct'; earned := b.points; end if;

    else
      continue;   -- material: nothing to check
    end if;

    mx := mx + b.points;
    auto := auto + earned;
    res := res || jsonb_build_object(
      b.id::text, jsonb_build_object('state', st, 'earned', earned, 'max', b.points));
  end loop;

  return jsonb_build_object('results', res, 'auto', auto, 'max', mx, 'has_text', has_text);
end;
$$;

revoke all on function public.hw_norm(text)                      from public, anon, authenticated;
revoke all on function public.hw_can_access(bigint, uuid)        from public, anon, authenticated;
revoke all on function public.hw_grade(bigint, uuid, jsonb)      from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- teacher: create / edit a homework (atomic)
-- ---------------------------------------------------------------------------
-- p = { id?, title, description, due_at, status, assign_all, points_enabled,
--       show_answers, allow_resubmit, allow_late, assignees: [uuid],
--       blocks: [ { id?, type, title, points, config, key } ] }
create or replace function public.save_homework(p jsonb)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  hid     bigint;
  blk     jsonb;
  n       int := 0;
  nblocks int;
  bid     bigint;
  btype   text;
  btitle  text;
  cfg     jsonb;
  k       jsonb;
  ccfg    jsonb;
  ckey    jsonb;
  pts     numeric;
  keep    bigint[] := '{}';
  m       int;
  cnt     int;
  stat    text;
  all_    boolean;
begin
  if auth.uid() is null or not public.is_teacher() then
    raise exception 'Only teachers can create homework';
  end if;
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'Bad request'; end if;
  if octet_length(p::text) > 400000 then raise exception 'This homework is too large'; end if;

  hid     := nullif(p ->> 'id', '')::bigint;
  nblocks := case when jsonb_typeof(p -> 'blocks') = 'array' then jsonb_array_length(p -> 'blocks') else 0 end;
  stat    := coalesce(nullif(p ->> 'status', ''), 'draft');
  all_    := coalesce((p ->> 'assign_all')::boolean, false);

  if nblocks > 40 then raise exception 'A homework can have at most 40 blocks'; end if;

  if stat = 'published' then
    if nblocks = 0 then raise exception 'Add at least one block before publishing'; end if;
    if not all_ and (jsonb_typeof(p -> 'assignees') is distinct from 'array'
                     or jsonb_array_length(p -> 'assignees') = 0) then
      raise exception 'Choose who gets this homework';
    end if;
  end if;

  if hid is null then
    insert into public.homeworks (title, description, due_at, status, assign_all, points_enabled,
                                  show_answers, allow_resubmit, allow_late)
    values (
      coalesce(p ->> 'title', ''),
      coalesce(p ->> 'description', ''),
      nullif(p ->> 'due_at', '')::timestamptz,
      stat,
      all_,
      coalesce((p ->> 'points_enabled')::boolean, false),
      coalesce(nullif(p ->> 'show_answers', ''),
               case when nullif(p ->> 'due_at', '') is null then 'never' else 'after_due' end),
      coalesce((p ->> 'allow_resubmit')::boolean, true),
      coalesce((p ->> 'allow_late')::boolean, true)
    ) returning id into hid;
  else
    update public.homeworks set
      title          = coalesce(p ->> 'title', ''),
      description    = coalesce(p ->> 'description', ''),
      due_at         = nullif(p ->> 'due_at', '')::timestamptz,
      status         = stat,
      assign_all     = all_,
      points_enabled = coalesce((p ->> 'points_enabled')::boolean, false),
      show_answers   = coalesce(nullif(p ->> 'show_answers', ''),
               case when nullif(p ->> 'due_at', '') is null then 'never' else 'after_due' end),
      allow_resubmit = coalesce((p ->> 'allow_resubmit')::boolean, true),
      allow_late     = coalesce((p ->> 'allow_late')::boolean, true),
      updated_at     = now()
    where id = hid;
    if not found then raise exception 'Homework not found'; end if;
  end if;

  -- ---- blocks ----
  if nblocks > 0 then
    for blk in select value from jsonb_array_elements(p -> 'blocks') loop
      n := n + 1;
      btype  := blk ->> 'type';
      btitle := left(btrim(coalesce(blk ->> 'title', '')), 120);
      cfg    := case when jsonb_typeof(blk -> 'config') = 'object' then blk -> 'config' else '{}'::jsonb end;
      k      := case when jsonb_typeof(blk -> 'key') = 'object' then blk -> 'key' else '{}'::jsonb end;
      pts    := coalesce((blk ->> 'points')::numeric, 1);
      ckey   := '{}'::jsonb;

      if btype = 'material' then
        pts := 0;
        if coalesce(cfg ->> 'kind', '') not in ('text', 'link', 'video', 'image') then
          raise exception 'Block %: unknown material type', n;
        end if;
        if cfg ->> 'kind' = 'text' then
          if btrim(coalesce(cfg ->> 'body', '')) = '' then raise exception 'Block %: write some text', n; end if;
        else
          if coalesce(cfg ->> 'url', '') !~* '^https?://[^\s]+$' or char_length(cfg ->> 'url') > 500 then
            raise exception 'Block %: the link must start with http:// or https://', n;
          end if;
        end if;
        if char_length(coalesce(cfg ->> 'body', '')) > 5000 then raise exception 'Block %: text is too long', n; end if;
        ccfg := jsonb_build_object('kind', cfg ->> 'kind',
                                   'body', coalesce(cfg ->> 'body', ''),
                                   'url',  coalesce(cfg ->> 'url', ''));

      elsif btype = 'vocab' then
        if jsonb_typeof(cfg -> 'word_ids') is distinct from 'array'
           or jsonb_array_length(cfg -> 'word_ids') not between 1 and 100 then
          raise exception 'Block %: choose between 1 and 100 words', n;
        end if;
        if exists (select 1 from jsonb_array_elements(cfg -> 'word_ids') e where jsonb_typeof(e) <> 'number') then
          raise exception 'Block %: bad word list', n;
        end if;
        select count(distinct t.v::bigint) into cnt
        from jsonb_array_elements_text(cfg -> 'word_ids') as t(v)
        where t.v::bigint in (select id from public.words);
        if cnt <> (select count(distinct t.v::bigint) from jsonb_array_elements_text(cfg -> 'word_ids') as t(v)) then
          raise exception 'Block %: some words no longer exist', n;
        end if;
        ccfg := jsonb_build_object('word_ids',
                  (select jsonb_agg(distinct t.v::bigint) from jsonb_array_elements_text(cfg -> 'word_ids') as t(v)));

      elsif btype = 'choice' then
        if btrim(coalesce(cfg ->> 'prompt', '')) = '' or char_length(cfg ->> 'prompt') > 500 then
          raise exception 'Block %: write the question', n;
        end if;
        if jsonb_typeof(cfg -> 'options') is distinct from 'array'
           or jsonb_array_length(cfg -> 'options') not between 2 and 8 then
          raise exception 'Block %: a question needs 2 to 8 options', n;
        end if;
        if exists (select 1 from jsonb_array_elements(cfg -> 'options') o
                   where jsonb_typeof(o) <> 'string' or btrim(o #>> '{}') = '' or char_length(o #>> '{}') > 200) then
          raise exception 'Block %: options cannot be empty', n;
        end if;
        m := jsonb_array_length(cfg -> 'options');
        if jsonb_typeof(k -> 'correct') is distinct from 'number'
           or (k ->> 'correct')::numeric <> trunc((k ->> 'correct')::numeric)
           or (k ->> 'correct')::int not between 0 and m - 1 then
          raise exception 'Block %: mark the correct option', n;
        end if;
        ccfg := jsonb_build_object('prompt', btrim(cfg ->> 'prompt'), 'options', cfg -> 'options');
        ckey := jsonb_build_object('correct', (k ->> 'correct')::int);

      elsif btype = 'gaps' then
        if char_length(coalesce(cfg ->> 'text', '')) not between 1 and 1000 then
          raise exception 'Block %: write the sentence', n;
        end if;
        m := (char_length(cfg ->> 'text') - char_length(replace(cfg ->> 'text', '___', ''))) / 3;
        if m < 1 or m > 20 then raise exception 'Block %: use ___ (three underscores) for 1 to 20 gaps', n; end if;
        if jsonb_typeof(k -> 'answers') is distinct from 'array' or jsonb_array_length(k -> 'answers') <> m then
          raise exception 'Block %: give the correct answer for each gap', n;
        end if;
        if exists (
             select 1 from jsonb_array_elements(k -> 'answers') g
             where jsonb_typeof(g) <> 'array'
                or jsonb_array_length(g) not between 1 and 10
                or exists (select 1 from jsonb_array_elements(g) x
                           where jsonb_typeof(x) <> 'string' or btrim(x #>> '{}') = '' or char_length(x #>> '{}') > 100)) then
          raise exception 'Block %: each gap needs at least one correct answer', n;
        end if;
        ccfg := jsonb_build_object('text', cfg ->> 'text');
        ckey := jsonb_build_object('answers', k -> 'answers');

      elsif btype = 'text' then
        if btrim(coalesce(cfg ->> 'prompt', '')) = '' or char_length(cfg ->> 'prompt') > 1000 then
          raise exception 'Block %: write the task', n;
        end if;
        if char_length(coalesce(k ->> 'model', '')) > 2000 then raise exception 'Block %: model answer is too long', n; end if;
        ccfg := jsonb_build_object('prompt', btrim(cfg ->> 'prompt'));
        ckey := jsonb_build_object('model', coalesce(k ->> 'model', ''));

      elsif btype = 'done' then
        if btrim(coalesce(cfg ->> 'label', '')) = '' or char_length(cfg ->> 'label') > 200 then
          raise exception 'Block %: write what the student confirms', n;
        end if;
        ccfg := jsonb_build_object('label', btrim(cfg ->> 'label'));

      else
        raise exception 'Block %: unknown block type', n;
      end if;

      bid := nullif(blk ->> 'id', '')::bigint;
      if bid is not null then
        update public.homework_blocks
           set pos = n, type = btype, title = btitle, config = ccfg, points = pts
         where id = bid and homework_id = hid;
        if not found then raise exception 'Block % does not belong to this homework', n; end if;
      else
        insert into public.homework_blocks (homework_id, pos, type, title, config, points)
        values (hid, n, btype, btitle, ccfg, pts)
        returning id into bid;
      end if;

      insert into public.homework_keys (block_id, key) values (bid, ckey)
      on conflict (block_id) do update set key = excluded.key;

      keep := keep || bid;
    end loop;
  end if;

  delete from public.homework_blocks where homework_id = hid and not (id = any (keep));

  -- ---- audience ----
  if jsonb_typeof(p -> 'assignees') = 'array' then
    delete from public.homework_assignees
     where homework_id = hid
       and student_id::text not in (select t.v from jsonb_array_elements_text(p -> 'assignees') as t(v));
    insert into public.homework_assignees (homework_id, student_id)
    select hid, pr.id
    from public.profiles pr
    where pr.id::text in (select t.v from jsonb_array_elements_text(p -> 'assignees') as t(v))
    on conflict do nothing;
  end if;

  return hid;
end;
$$;

-- ---------------------------------------------------------------------------
-- student: save a draft, submit, reopen
-- ---------------------------------------------------------------------------
create or replace function public.hw_prepare_answers(p_hw bigint, p_answers jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare clean jsonb;
begin
  if p_answers is null or jsonb_typeof(p_answers) <> 'object' then raise exception 'Bad request'; end if;
  if octet_length(p_answers::text) > 100000 then raise exception 'Your answers are too long'; end if;
  select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) into clean
  from jsonb_each(p_answers) e
  where e.key in (select id::text from public.homework_blocks where homework_id = p_hw);
  return clean;
end;
$$;
revoke all on function public.hw_prepare_answers(bigint, jsonb) from public, anon, authenticated;

-- Shared checks for saving/submitting. Returns the homework row.
create or replace function public.hw_check_student(p_hw bigint)
returns public.homeworks
language plpgsql
security definer
set search_path = ''
as $$
declare
  h public.homeworks;
  s public.homework_submissions;
begin
  if auth.uid() is null then raise exception 'Please sign in'; end if;
  if not public.hw_can_access(p_hw, auth.uid()) then raise exception 'Homework not found'; end if;
  select * into h from public.homeworks where id = p_hw;
  select * into s from public.homework_submissions where homework_id = p_hw and student_id = auth.uid();
  if s.status in ('submitted', 'reviewed') then
    raise exception 'This homework is already submitted';
  end if;
  if h.due_at is not null and now() > h.due_at and not h.allow_late then
    raise exception 'The deadline has passed';
  end if;
  return h;
end;
$$;
revoke all on function public.hw_check_student(bigint) from public, anon, authenticated;

create or replace function public.save_homework_draft(p_homework bigint, p_answers jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare clean jsonb;
begin
  perform public.hw_check_student(p_homework);
  clean := public.hw_prepare_answers(p_homework, p_answers);
  insert into public.homework_submissions (homework_id, student_id, status, answers)
  values (p_homework, auth.uid(), 'draft', clean)
  on conflict (homework_id, student_id)
  do update set answers = excluded.answers, updated_at = now();
end;
$$;

create or replace function public.submit_homework(p_homework bigint, p_answers jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  clean jsonb;
  g     jsonb;
begin
  perform public.hw_check_student(p_homework);
  clean := public.hw_prepare_answers(p_homework, p_answers);
  g := public.hw_grade(p_homework, auth.uid(), clean);
  insert into public.homework_submissions
    (homework_id, student_id, status, answers, results, auto_score, max_score, score, submitted_at)
  values
    (p_homework, auth.uid(), 'submitted', clean, g -> 'results',
     (g ->> 'auto')::numeric, (g ->> 'max')::numeric, null, now())
  on conflict (homework_id, student_id)
  do update set status = 'submitted', answers = excluded.answers, results = excluded.results,
                auto_score = excluded.auto_score, max_score = excluded.max_score,
                score = null, reviewed_at = null, submitted_at = now(), updated_at = now();
end;
$$;

-- Take a submitted (not yet reviewed) homework back to edit it.
create or replace function public.reopen_submission(p_homework bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  h public.homeworks;
  s public.homework_submissions;
begin
  if auth.uid() is null then raise exception 'Please sign in'; end if;
  select * into h from public.homeworks where id = p_homework;
  select * into s from public.homework_submissions where homework_id = p_homework and student_id = auth.uid();
  if not found or h.id is null then raise exception 'Nothing to reopen'; end if;
  if s.status <> 'submitted' then raise exception 'This homework cannot be reopened'; end if;
  if not h.allow_resubmit then raise exception 'Resubmission is turned off for this homework'; end if;
  if h.due_at is not null and now() > h.due_at then raise exception 'The deadline has passed'; end if;
  update public.homework_submissions set status = 'draft', updated_at = now() where id = s.id;
end;
$$;

-- ---------------------------------------------------------------------------
-- answer keys: teachers always; students only when the settings allow it
-- ---------------------------------------------------------------------------
create or replace function public.homework_answer_keys(p_homework bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  h       public.homeworks;
  s       public.homework_submissions;
  done    boolean;
  allowed boolean;
begin
  if auth.uid() is null then return '{}'::jsonb; end if;
  if not public.is_teacher() then
    if not public.hw_can_access(p_homework, auth.uid()) then return '{}'::jsonb; end if;
    select * into h from public.homeworks where id = p_homework;
    select * into s from public.homework_submissions where homework_id = p_homework and student_id = auth.uid();
    done := coalesce(s.status in ('submitted', 'reviewed'), false);
    allowed := case h.show_answers
      when 'after_submit' then done
      when 'after_due'    then h.due_at is not null and now() > h.due_at and (done or not h.allow_late)
      else false
    end;
    if not allowed then return '{}'::jsonb; end if;
  end if;
  return coalesce((
    select jsonb_object_agg(hb.id::text, hk.key)
    from public.homework_blocks hb
    join public.homework_keys hk on hk.block_id = hb.id
    where hb.homework_id = p_homework
  ), '{}'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- teacher: review a submission
-- ---------------------------------------------------------------------------
-- p_manual = { "<text block id>": {points, comment} }; p_action = 'reviewed' | 'returned'
create or replace function public.review_submission(
  p_submission bigint, p_manual jsonb, p_comment text, p_action text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  s     public.homework_submissions;
  e     record;
  blk   public.homework_blocks;
  clean jsonb := '{}'::jsonb;
  pts   numeric;
  msum  numeric := 0;
begin
  if auth.uid() is null or not public.is_teacher() then raise exception 'Only teachers can review'; end if;
  if p_action not in ('reviewed', 'returned') then raise exception 'Bad request'; end if;
  select * into s from public.homework_submissions where id = p_submission for update;
  if not found then raise exception 'Submission not found'; end if;
  if s.status not in ('submitted', 'reviewed') then raise exception 'This homework is not submitted'; end if;
  if char_length(coalesce(p_comment, '')) > 2000 then raise exception 'Comment is too long'; end if;

  if p_manual is not null and jsonb_typeof(p_manual) = 'object' then
    for e in select key, value from jsonb_each(p_manual) loop
      select * into blk from public.homework_blocks
       where id::text = e.key and homework_id = s.homework_id and type = 'text';
      if not found then continue; end if;
      pts := coalesce(nullif(e.value ->> 'points', '')::numeric, 0);
      if pts < 0 or pts > blk.points then
        raise exception 'Points must be between 0 and %', blk.points;
      end if;
      if char_length(coalesce(e.value ->> 'comment', '')) > 1000 then raise exception 'Comment is too long'; end if;
      clean := clean || jsonb_build_object(e.key, jsonb_build_object(
        'points', pts, 'comment', coalesce(e.value ->> 'comment', '')));
      msum := msum + pts;
    end loop;
  end if;

  update public.homework_submissions set
    manual          = clean,
    teacher_comment = coalesce(p_comment, ''),
    status          = p_action,
    score           = case when p_action = 'reviewed' then auto_score + msum else null end,
    reviewed_at     = now(),
    reviewed_by     = auth.uid(),
    updated_at      = now()
  where id = s.id;
end;
$$;

-- ---------------------------------------------------------------------------
-- who may call what
-- ---------------------------------------------------------------------------
revoke all on function public.save_homework(jsonb)                       from public, anon;
revoke all on function public.save_homework_draft(bigint, jsonb)         from public, anon;
revoke all on function public.submit_homework(bigint, jsonb)             from public, anon;
revoke all on function public.reopen_submission(bigint)                  from public, anon;
revoke all on function public.homework_answer_keys(bigint)               from public, anon;
revoke all on function public.review_submission(bigint, jsonb, text, text) from public, anon;

grant execute on function public.save_homework(jsonb)                       to authenticated;
grant execute on function public.save_homework_draft(bigint, jsonb)         to authenticated;
grant execute on function public.submit_homework(bigint, jsonb)             to authenticated;
grant execute on function public.reopen_submission(bigint)                  to authenticated;
grant execute on function public.homework_answer_keys(bigint)               to authenticated;
grant execute on function public.review_submission(bigint, jsonb, text, text) to authenticated;
