# 10 — AI, voice and chat (built, currently hidden)

Nook contains **three separate AI surfaces**. All three are fully implemented; none is
reachable from the running UI today. They are separate on purpose — different providers,
different trust levels, different data access — so don't merge them.

| Surface | Provider / transport | Can change Nook data? | Entry point today |
|---|---|---|---|
| **Voice commands** (`VoiceCommandButton`) | Claude via edge function `parse-voice-command` | Yes — add task, complete task, add note, **always behind a confirm** (one carve-out, below) | Hidden: the `<VoiceCommandButton …/>` line in `App.jsx` (~L1554) is commented out |
| **Chat tab** (`ChatView`) | Claude via edge function `chat-with-claude` | **No.** Plain conversation, no tools | Unreachable: no nav entry, and `'chat'` is not in `TAB_IDS` |
| **Gemini assistant** (`AssistantChat`) | Google Gemini REST API called **directly from the browser** | No (read-only context) | Hidden: both `{ id:'chat', label:'AI Assistant' }` nav entries are commented out. The Settings "Gemini API Key" field is still visible |

> **Hidden ≠ deleted.** Re-enable by uncommenting, not by rewriting. And note the id
> collision: the (commented) nav entries with `id:'chat'` are wired to toggle the **Gemini**
> panel (`isAssistantOpen`), not to `ChatView`. `ChatView` is only rendered when
> `activeTab === 'chat'`, which nothing can currently set. To expose the Claude Chat tab you
> would add `'chat'` to `TAB_IDS`, add a nav entry that calls `setActiveTab('chat')`, and
> decide what happens to the Gemini panel's `chat` special-casing in the nav `onClick` and
> in `MobileMoreModal`'s `onSelect`.

## They need a session

Both Claude surfaces call edge functions deployed **with JWT verification**, so they only
work for a signed-in user. The UI gates (`VoiceCommandButton`, `ChatView`) test
`isAuthConfigured` (env vars present) — **not** whether a session exists. With Supabase
configured but nobody signed in, the mic/send controls look enabled and the call comes back
`401 unauthenticated`, surfaced as a toast / chat error. The app is not login-gated, so
"signed out" is a normal state: sign in from Settings → Connections
([01 § Auth status](01-architecture.md#auth-status--read-this-first)). With `VITE_SUPABASE_*`
unset the controls are disabled with an explanatory tooltip ("Sign in to use voice commands" /
"Sign in and connect to chat"). Making the gate test the session instead of the env vars
would be a small, worthwhile follow-up if these features are ever re-enabled.

Voice and Chat also need a network (`useOnlineStatus`) and a browser with the Web Speech API
(`window.SpeechRecognition || webkitSpeechRecognition`; effectively Chromium/Safari, not
Firefox). Typing keeps working offline; the mic is an additional input path, never the only
one, and is **disabled rather than hidden** when it can't work.

## 1. Voice commands

```
hold mic ─► useSpeechToText (en-US, push-to-talk, final result only)
        ─► parseVoiceCommand(transcript)         utils/voiceCommandClient.js
              └─ supabase.functions.invoke('parse-voice-command',
                                           { transcript, currentDate: todayStr() })
        ─► { tool, params, confidence, ambiguous, transcript }
        ─► VoiceCommandButton decides:
              tool 'none'                       → toast "Didn't catch a command"
              complete_task, exactly 1 match    → complete it immediately (the one carve-out)
              anything else                     → VoiceConfirmModal, user confirms/edits
        ─► commit → addTask(...) / toggleComplete(id) / newNote+saveNote(...)
```

### The edge function (`supabase/functions/parse-voice-command`)

- One Claude call with three **strict** tools: `add_task`, `complete_task`, `add_note`. If the
  transcript doesn't clearly ask for one, the model answers in plain text and the function
  returns `tool: 'none'`. Model id, `max_tokens` and `effort: 'low'` are pinned in the file —
  `chat-with-claude` pins its own; change both together.
- It **only parses.** It never writes to Supabase, never sees the user's tasks, and never
  decides whether anything auto-executes.
- `strict: true` forces every property into `required`, so the model fills `''` for "not
  said" rather than omitting a field. `params` is therefore always a complete object.
- The transcript is clipped to 500 chars. `currentDate` comes **from the browser** (local
  `todayStr()` — the local-noon convention in [08](08-conventions-and-gotchas.md)) so
  "tomorrow" near midnight resolves the way the user meant, not per server UTC. A malformed
  `currentDate` falls back to the server's UTC date.
- Only the 5 built-in categories (`learning, fitness, mental, work, growth`) are offered to
  the model; **custom categories live in localStorage and are invisible to it**.
- Needs `ANTHROPIC_API_KEY` in the function's env. Deploy with JWT verification (default) —
  never `--no-verify-jwt` ([05](05-backend.md)).
- The response is a Nook-native camelCase envelope (`tool`, `params`, `confidence` clamped to
  0–1, `ambiguous`, `transcript`), not a proxy of the provider's field names.

### The one auto-execute carve-out

`complete_task` skips confirmation **only** when `matchIncompleteTasks(taskQuery, tasks)`
(`utils/voiceCommandMatch.js`) returns **exactly one** incomplete task. That client-side match
count is the *sole* authority; the model's own `confidence` / `ambiguous` are shown in the
confirm UI for context and **never** skip a confirmation themselves. Matching: incomplete
tasks only; any exact normalised match wins outright (fuzzy candidates are then not mixed in,
so two identically-named tasks correctly give "2 matches", not a silent pick); otherwise
substring either way, or Levenshtein distance ≤ 20% of the longer title. `add_task` and
`add_note` **always** confirm, regardless of confidence. This is covered by
`voiceCommandMatch.test.js` (11 tests) — keep it that way if you touch the matcher.

### Confirm modal and commit

`VoiceConfirmModal` lets the user edit the parsed fields of an `add_task` / `add_note` (it
uses the themed `Select` / `DateInput` / `TimeInput`, [06](06-ui-and-styling.md)). For a
`complete_task` that matched 0 tasks it says so and offers only Cancel (re-record); for 2 or
more it lists them and picking one commits immediately. `VoiceCommandButton.commit` then calls the normal
App-level writers, so a voice-created note goes through `saveNote` → `nook_notes` → the sync
observer like any other note ([09](09-cross-device-sync.md)); a task goes through `addTask`
(and so the usual Supabase/Google task sync).

Known gap: the confirm form collects a `time`, but `commit` builds the `addTask` payload
without it — a spoken time-of-day does not reach the task. Fix it in `commit`, not in the edge
function.

## 2. Chat tab (Claude)

`ChatView` → `utils/chatClient.js#sendChatMessage` → `chat-with-claude`.

- **Deliberately no tools.** The system prompt tells the model it can't add/complete tasks
  or notes and to point the user at voice commands or the relevant tab. Keeping this apart
  from `parse-voice-command` means the confirm-gated 3-tool action router never gains a
  second, less-audited entry point through chat. Don't add tools to this function.
- The function accepts the last **20** turns, each clipped to **4000** chars, and requires the
  last turn to be a `user` turn (`400` otherwise). `max_tokens: 1024`, `effort: 'medium'`
  (pinned in the file). The client keeps and shows the full history; only the tail is sent.
- Replies are shown as bubbles **and read aloud** with `speechSynthesis` unless muted, which is
  why the system prompt asks for short, speakable answers. Speech is cancelled on unmount and
  when muting.
- History: key **`nook_chat_history`**, capped at 200 messages by `chatStore.js`, and it is a
  **synced slice** (`chat_history`, [09](09-cross-device-sync.md)). `ChatView` registers
  `useSyncApplied(['chat_history'], …)` and returns `false` while a reply is in flight, so the
  send flow owns `messages` until the reply lands. Clearing the conversation asks `confirm()`
  first.

## 3. Gemini assistant (`AssistantChat`)

A floating panel (`isAssistantOpen` in `App.jsx`) that predates the Claude work and takes a
completely different path:

- `utils/aiAssistant.js#askAssistant` calls
  `generativelanguage.googleapis.com/v1beta/models/<model>:generateContent?key=<API_KEY>`
  **straight from the browser**, falling back to a second model id on a "not found / overloaded"
  error. Model ids are hard-coded there.
- The key is `import.meta.env.VITE_GEMINI_API_KEY || localStorage['nook_ai_api_key']`. The
  Settings tab has a "Gemini API Key" field that writes the localStorage value.
  **Do not set `VITE_GEMINI_API_KEY`** — Vite would inline it into the shipped bundle (a
  standing violation of the secrets rule, kept only because the feature is hidden). The
  localStorage key is per-browser and is **never synced** (it is a credential).
- `utils/aiContext.js#buildAiContext` assembles a prompt from localStorage — current date,
  up to 50 pending tasks (`nook-tasks`), habits (`nook_habits`), today's intentions
  (`nook-intentions`) and open goals (`nook_goals`) — and sends it to Google with each first
  question. So **enabling this feature sends the user's task/habit/goal titles to a third party**;
  the Settings copy ("Your data never leaves your browser except when sending questions to the
  AI") is accurate but easy to misread. Note it looks up today's intentions with a **UTC**
  date (`toISOString().slice(0,10)`), which can be off by a day near local midnight.
- History: `nook_ai_chat_history`, not synced.

If this feature is ever revived, the right move is to give it a Claude edge function like the
other two (key server-side) rather than keeping a browser-held key.

## Adding or changing an AI feature — checklist

1. Secrets go in the edge function's env (`ANTHROPIC_API_KEY`), never behind `VITE_`.
2. User-invoked function ⇒ deploy **with** JWT verification and verify the user in the function
   (`userClient.auth.getUser()`), as the existing two do. Answer CORS preflight yourself.
3. Browser-callable ⇒ return JSON errors `{ error }`; the clients use the same
   `edgeErrorDetail` helper (duplicated per file by convention) to surface the real message
   instead of supabase-js's generic "non-2xx".
4. Anything that mutates user data needs an explicit confirm, decided **client-side** from live
   state — never from the model's self-reported confidence.
5. Gate the UI on `isAuthConfigured` *and* handle a 401 gracefully; don't assume a session.
6. If it writes to a synced slice, write through the normal store/`localStorage` path so the
   sync observer picks it up — don't add a parallel write.
7. Update [05](05-backend.md) (function table, secrets) and this file.
