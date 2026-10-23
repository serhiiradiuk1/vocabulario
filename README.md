# Vocabulario

Spanish vocabulary app with two ways to study — **flashcards** and a **sortable list** — backed by Supabase.

- Sign up / sign in with email + password (teachers and students)
- One shared word list: **both teachers and students can add words**
- Students can edit or delete their own words; teachers can edit or delete any word
- Each person's "Still practicing" / "Got it" progress is private and syncs across devices
- Filter by topic and by status, search, and sort the list by Spanish, English, topic, status or date added
- **Homework**: teachers build assignments from blocks, students do them on one page, teachers review (see below)
- Static site (plain HTML/CSS/JS, no build step) — hosts for free on GitHub Pages

## Setup

### 1. Create the Supabase project

1. Create a project at <https://supabase.com> (the free tier is enough).
2. Open **SQL Editor** and run, in this order:
   1. `supabase/migrations/0001_init.sql` — tables, row-level security, role protection
   2. `supabase/migrations/0002_homework.sql` — homework (blocks, answer keys, submissions, review)
   3. `supabase/seed.sql` — the original 357 words (optional, run it once)
3. **Authentication → Providers → Email**: for quick testing you can turn off *Confirm email*.
   Leave it on if you want people to verify their address.

### 2. Connect the app

Open `js/config.js` and fill in the two values from **Project Settings → API**:

```js
window.APP_CONFIG = {
  SUPABASE_URL: "https://xxxx.supabase.co",
  SUPABASE_ANON_KEY: "eyJ..."   // the anon / publishable key
};
```

The anon key is meant to be public — what it can do is limited by the row-level security policies.
**Never** put the `service_role` key in this repo.

### 3. Deploy on GitHub Pages

1. Push this folder to a GitHub repository.
2. **Settings → Pages → Build and deployment**: *Deploy from a branch*, branch `main`, folder `/ (root)`.
3. Your site will be at `https://<user>.github.io/<repo>/`.
4. In Supabase, **Authentication → URL Configuration**: set *Site URL* to that address and add it
   under *Redirect URLs* (needed for confirmation and password-reset links).

To try it locally first: `python3 -m http.server 8000` in this folder, then open <http://localhost:8000>
(and add `http://localhost:8000` to the Supabase redirect URLs if you use email confirmation).

### 4. Make someone a teacher

Everyone who signs up is a **student**. Nobody can promote themselves — the `role` column can only be
changed from the Supabase dashboard. After the teacher has created their account, run in the SQL Editor:

```sql
update public.profiles
set role = 'teacher'
where id = (select id from auth.users where email = 'teacher@example.com');
```

They will see the *Teacher* badge after reloading the app.

## How access is enforced

All permissions live in the database (`0001_init.sql`), not in the browser, so they hold even if someone
calls the API directly:

| Table | Read | Add | Edit / delete |
|-------|------|-----|---------------|
| `words` | any signed-in user | any signed-in user (as themselves) | the author, or a teacher |
| `progress` | only your own rows | only your own rows | only your own rows |
| `profiles` | any signed-in user (name + role, no emails) | automatic on sign-up | you can change only your display name; `role` is dashboard-only |

Signed-out visitors can't read anything.

## Homework

Open the **Homework** tab.

**Teacher** — *New homework*: title, instructions, deadline, who gets it (all students or a selection), then add blocks:

| Block | What the student does | Checked |
|-------|----------------------|---------|
| Material | reads text / opens a link / watches a YouTube video / sees an image (by URL) | – |
| Vocabulary | studies chosen words with flashcards; done when all are marked "Got it" | automatically |
| Question | picks one option | automatically |
| Fill in the gaps | types words into `___` gaps in a sentence (alternatives: `como / comer`) | automatically |
| Written answer | writes text | by the teacher (points + comment) |
| Checklist | ticks "I did it" | automatically |

Settings: points on/off, whether students may edit after submitting, whether late work is accepted,
and when correct answers become visible (after the deadline / right after submitting / never).
*Duplicate* copies a homework (including its answers) as a new draft. Drafts are invisible to students.

**Student** — sees assigned homework with deadlines, answers on one page (autosaved), presses *Submit*.
Auto-checked parts are scored immediately; written answers wait for the teacher.

**Review** — *Results* shows who handed in, who did not, and scores. Open a submission, give points and
comments, then *Mark as reviewed* or *Send back for changes* (the student can then fix and submit again).

Answer keys live in a separate table that only teachers can read; students get them from
`homework_answer_keys()` only when the settings allow it. Gap answers ignore capitals, extra spaces and
surrounding punctuation, but accents must match (`está` ≠ `esta`).

## Project layout

```
index.html                       page shell
css/style.css                    styles (light + dark)
js/config.js                     your Supabase URL + anon key
js/app.js                        the app (auth, flashcards, list, add/edit words)
js/homework.js                   homework: data layer, student view, teacher list
js/homework-builder.js           homework builder (teachers)
js/homework-review.js            results table + review screen (teachers)
supabase/migrations/0001_init.sql  schema + security
supabase/migrations/0002_homework.sql  homework tables, RLS, grading + review functions
supabase/seed.sql                the original 357 words
```

## Notes

- Topics are a fixed list (enforced by a check constraint on `words.topic`). To add a topic, add it to
  `TOPICS` in `js/app.js` and to the check constraint in the database.
- Display preferences (selected topics, view, theme) are stored per browser; words and progress are stored in Supabase.
