-- Vocabulario: schema, row-level security and role protection.
-- Run this once in the Supabase SQL Editor (or with `supabase db push`).
--
-- Roles:
--   student (default for every new sign-up) and teacher.
--   Nobody can promote themselves: `role` can only be changed from the
--   Supabase dashboard / SQL editor (see README, "Make someone a teacher").

-- ---------------------------------------------------------------------------
-- profiles: one row per auth user
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default '' check (char_length(display_name) <= 60),
  role         text not null default 'student' check (role in ('student', 'teacher')),
  created_at   timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- Create the profile automatically when someone signs up. The role always
-- starts as 'student'; anything sent from the browser is ignored for `role`.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    left(
      coalesce(
        nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''),
        split_part(coalesce(new.email, ''), '@', 1)
      ),
      60
    )
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Only the trigger should run this; it must not be callable through the API.
revoke all on function public.handle_new_user() from public, anon, authenticated;

-- Profiles for users that already existed before this migration.
insert into public.profiles (id, display_name)
select id, left(split_part(coalesce(email, ''), '@', 1), 60)
from auth.users
on conflict (id) do nothing;

-- Helper used by the policies below. security definer so it can read profiles
-- without being blocked by profiles' own RLS.
create or replace function public.is_teacher()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'teacher'
  );
$$;

revoke all on function public.is_teacher() from public, anon;
grant execute on function public.is_teacher() to authenticated;

-- Everyone signed in can see names + roles (needed for "added by").
-- No email addresses are stored in this table.
drop policy if exists "profiles are readable by signed-in users" on public.profiles;
create policy "profiles are readable by signed-in users"
  on public.profiles for select to authenticated
  using (true);

-- Fallback so the app can create a missing profile (always as a student).
drop policy if exists "users can create their own profile" on public.profiles;
create policy "users can create their own profile"
  on public.profiles for insert to authenticated
  with check (id = auth.uid());

drop policy if exists "users can update their own profile" on public.profiles;
create policy "users can update their own profile"
  on public.profiles for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- Column-level privileges: users may only ever write display_name.
-- This is what stops a student from setting role = 'teacher'.
revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;
grant insert (id, display_name) on public.profiles to authenticated;
grant update (display_name) on public.profiles to authenticated;

-- ---------------------------------------------------------------------------
-- words: one shared list; teachers and students can both add words
-- ---------------------------------------------------------------------------
create table if not exists public.words (
  id         bigint generated always as identity primary key,
  es         text not null check (char_length(trim(es)) between 1 and 200),
  en         text not null check (char_length(trim(en)) between 1 and 200),
  ctx        text not null default '' check (char_length(ctx) <= 600),
  topic      text not null default 'other' check (topic in (
               'verbs', 'people', 'phrases', 'society', 'work', 'home', 'describe',
               'grammar', 'places', 'body', 'time', 'food', 'sports', 'other')),
  added_by   uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);

create index if not exists words_added_by_idx on public.words (added_by);

alter table public.words enable row level security;

drop policy if exists "words are readable by signed-in users" on public.words;
create policy "words are readable by signed-in users"
  on public.words for select to authenticated
  using (true);

drop policy if exists "signed-in users can add words as themselves" on public.words;
create policy "signed-in users can add words as themselves"
  on public.words for insert to authenticated
  with check (added_by = auth.uid());

-- Students can change/remove their own words; teachers can change/remove any.
drop policy if exists "authors and teachers can edit words" on public.words;
create policy "authors and teachers can edit words"
  on public.words for update to authenticated
  using (added_by = auth.uid() or public.is_teacher())
  with check (added_by = auth.uid() or public.is_teacher());

drop policy if exists "authors and teachers can delete words" on public.words;
create policy "authors and teachers can delete words"
  on public.words for delete to authenticated
  using (added_by = auth.uid() or public.is_teacher());

revoke all on public.words from anon, authenticated;
grant select on public.words to authenticated;
grant insert (es, en, ctx, topic, added_by) on public.words to authenticated;
grant update (es, en, ctx, topic) on public.words to authenticated;
grant delete on public.words to authenticated;

-- ---------------------------------------------------------------------------
-- progress: each user's own "practicing" / "mastered" marks (private)
-- ---------------------------------------------------------------------------
create table if not exists public.progress (
  user_id    uuid not null references public.profiles (id) on delete cascade default auth.uid(),
  word_id    bigint not null references public.words (id) on delete cascade,
  status     text not null check (status in ('review', 'good')),
  updated_at timestamptz not null default now(),
  primary key (user_id, word_id)
);

alter table public.progress enable row level security;

drop policy if exists "users manage their own progress" on public.progress;
create policy "users manage their own progress"
  on public.progress for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

revoke all on public.progress from anon, authenticated;
grant select, insert, update, delete on public.progress to authenticated;
