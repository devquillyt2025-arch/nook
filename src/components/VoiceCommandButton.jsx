import { useState, useCallback } from 'react';
import VoiceConfirmModal from './VoiceConfirmModal';
import { parseVoiceCommand } from '../utils/voiceCommandClient';
import { matchIncompleteTasks } from '../utils/voiceCommandMatch';
import { newNote, saveNote as storeSaveNote } from '../utils/notesStore';
import { isAuthConfigured } from '../utils/authClient';
import { useSpeechToText, isSpeechRecognitionSupported } from '../utils/useSpeechToText';
import { useOnlineStatus } from '../utils/useOnlineStatus';

// Global mic button — lives beside SidebarSearch so it's reachable from any
// tab (mirrors why addTask/toggleComplete live in App.jsx: the dispatcher
// needs to work regardless of which view happens to be mounted).
//
// Push-to-talk only: hold to record, release to send. No wake word, no
// always-listening — typing already works fully offline, so the mic is
// purely an additional input path, disabled (not hidden) whenever it
// couldn't do anything useful: unsupported browser, no session to call the
// edge function with, or no network to reach it.
//
// Every parsed action is confirmed before it commits EXCEPT complete_task
// when the transcript's taskQuery resolves to exactly one incomplete task —
// that match-count check (matchIncompleteTasks) is the sole authority for
// that carve-out; the model's own confidence/ambiguous fields are shown in
// the confirm UI for context only and never skip confirmation themselves.
export default function VoiceCommandButton({ tasks, addTask, toggleComplete, showToast }) {
  const [processing, setProcessing] = useState(false);
  const online = useOnlineStatus();
  const [pending, setPending] = useState(null); // { tool, params, candidates?, transcript }

  const handleTranscript = useCallback(async (transcript) => {
    setProcessing(true);
    try {
      const result = await parseVoiceCommand(transcript);

      if (result.tool === 'none') {
        showToast("Didn't catch a command", 'warn');
        return;
      }

      if (result.tool === 'complete_task') {
        // Authoritative gate: ONLY this count decides auto-execute. The
        // model's ambiguous/confidence fields on result never override it.
        const matches = matchIncompleteTasks(result.params.taskQuery, tasks);
        if (matches.length === 1) {
          toggleComplete(matches[0].id);
          showToast(`"${matches[0].name}" completed ✓ (voice)`, 'success');
          return;
        }
        setPending({ tool: 'complete_task', params: result.params, candidates: matches, transcript: result.transcript });
        return;
      }

      // add_task / add_note: always confirm, regardless of confidence.
      setPending({ tool: result.tool, params: result.params, transcript: result.transcript });
    } catch (err) {
      showToast(err?.message || 'Voice command failed', 'error');
    } finally {
      setProcessing(false);
    }
  }, [tasks, toggleComplete, showToast]);

  const { status, start, stop } = useSpeechToText({
    onResult: handleTranscript,
    onEmpty: () => showToast('No speech detected', 'warn'),
    onError: () => showToast('Voice input failed — check mic permission', 'error'),
  });

  const disabledReason = !isSpeechRecognitionSupported
    ? "Voice input isn't supported in this browser"
    : !isAuthConfigured
    ? 'Sign in to use voice commands'
    : !online
    ? 'Voice commands need a connection'
    : status === 'listening'
    ? 'Listening — release to send'
    : processing
    ? 'Thinking…'
    : 'Hold to speak a command';

  const disabled = !isSpeechRecognitionSupported || !isAuthConfigured || !online || processing;

  const commit = (finalParams) => {
    const { tool } = pending;
    if (tool === 'add_task') {
      addTask({
        name: finalParams.name.trim(),
        category: finalParams.category || 'work',
        priority: finalParams.priority || 'medium',
        timeEstimate: 25,
        notes: finalParams.notes || '',
        dueDate: finalParams.dueDate || '',
        recurrence: null,
        recurrenceDays: [],
      }); // addTask already shows its own "added ✓" toast
    } else if (tool === 'complete_task') {
      toggleComplete(finalParams.taskId);
      showToast(`"${finalParams.name}" completed ✓ (voice)`, 'success');
    } else if (tool === 'add_note') {
      const note = newNote({ title: finalParams.title.trim(), content: finalParams.content || '' });
      storeSaveNote(note);
      showToast(`"${note.title}" note added ✓ (voice)`, 'success');
    }
    setPending(null);
  };

  return (
    <>
      <button
        type="button"
        className={`hdr-btn voice-mic-btn${status === 'listening' ? ' voice-mic-listening' : ''}${processing ? ' voice-mic-processing' : ''}`}
        title={disabledReason}
        aria-label={disabledReason}
        disabled={disabled}
        onMouseDown={start}
        onMouseUp={stop}
        onMouseLeave={stop}
        onTouchStart={e => { e.preventDefault(); start(); }}
        onTouchEnd={stop}
        onKeyDown={e => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) start(); }}
        onKeyUp={e => { if (e.key === ' ' || e.key === 'Enter') stop(); }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
          <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
          <line x1="12" y1="19" x2="12" y2="23"/>
          <line x1="8" y1="23" x2="16" y2="23"/>
        </svg>
      </button>
      {pending && (
        <VoiceConfirmModal pending={pending} onClose={() => setPending(null)} onConfirm={commit} />
      )}
    </>
  );
}
