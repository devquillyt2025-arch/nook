import { useState } from 'react';
import Select from './Select';
import DateInput from './DateInput';
import TimeInput from './TimeInput';
import { motion } from 'framer-motion';
import { CAT_META } from '../utils/categoryMeta';
import { PRI_META } from '../utils/priorityMeta';

// Confirm-before-commit UI for a parsed voice command. Every tool shows this
// EXCEPT complete_task's single-exact-match carve-out, which never reaches
// this component at all (VoiceCommandButton auto-executes it directly).
//
// complete_task DOES land here whenever the match-count check found 0 or 2+
// candidates — there's nothing to inline-edit in that case (no free-text
// field would resolve the ambiguity better than picking a real task), so it
// renders a candidate list instead of a form.
export default function VoiceConfirmModal({ pending, onClose, onConfirm }) {
  const { tool, params, candidates, transcript } = pending;
  const [mode, setMode] = useState('view'); // 'view' | 'edit' — add_task/add_note only
  const [form, setForm] = useState(() => tool === 'add_task'
    ? { name: params.name, dueDate: params.dueDate || '', time: params.time || '', priority: params.priority || 'medium', category: params.category || 'work', notes: params.notes || '' }
    : tool === 'add_note'
    ? { title: params.title, content: params.content || '' }
    : {});

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const title = tool === 'add_task' ? 'Add task' : tool === 'add_note' ? 'Add note' : 'Complete task';

  return (
    <motion.div className="modal-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }} onClick={onClose}>
      <motion.div className="modal-box voice-confirm-box" initial={{ opacity: 0, y: 24, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 24, scale: 0.97 }} transition={{ duration: 0.2, ease: 'easeOut' }} onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Confirm voice command">
        <div className="modal-hdr">
          <h3>Nook heard you</h3>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>

        <div className="voice-confirm-transcript">"{transcript}"</div>

        {tool === 'complete_task' ? (
          <CompleteTaskBody candidates={candidates} onClose={onClose} onConfirm={onConfirm} />
        ) : mode === 'view' ? (
          <ViewBody tool={tool} title={title} form={form} onEdit={() => setMode('edit')} onClose={onClose} onConfirm={() => onConfirm(form)} />
        ) : (
          <EditBody tool={tool} form={form} set={set} onClose={onClose} onConfirm={() => onConfirm(form)} />
        )}
      </motion.div>
    </motion.div>
  );
}

function ViewBody({ tool, title, form, onEdit, onClose, onConfirm }) {
  const catMeta = tool === 'add_task' ? CAT_META[form.category] : null;
  const priMeta = tool === 'add_task' ? PRI_META[form.priority] : null;
  return (
    <div className="modal-form">
      <div className="voice-confirm-summary">
        <strong>{title}:</strong> {tool === 'add_task' ? `"${form.name}"` : `"${form.title}"`}
        {tool === 'add_task' && (
          <ul className="voice-confirm-fields">
            {form.dueDate && <li>Due {form.dueDate}{form.time ? ` at ${form.time}` : ''}</li>}
            {catMeta && <li>Category: {catMeta.label}</li>}
            {priMeta && <li>Priority: {priMeta.label}</li>}
            {form.notes && <li>Notes: {form.notes}</li>}
          </ul>
        )}
        {tool === 'add_note' && form.content && (
          <div className="voice-confirm-note-preview">{form.content}</div>
        )}
      </div>
      <div className="modal-footer">
        <button type="button" className="btn-cancel" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-cancel" onClick={onEdit}>Edit</button>
        <button type="button" className="btn-submit" onClick={onConfirm}>Confirm</button>
      </div>
    </div>
  );
}

function EditBody({ tool, form, set, onClose, onConfirm }) {
  const submit = e => { e.preventDefault(); if (tool === 'add_task' ? form.name.trim() : form.title.trim()) onConfirm(); };
  return (
    <form className="modal-form" onSubmit={submit}>
      {tool === 'add_task' ? (
        <>
          <div className="form-grp">
            <label>Name <span className="req">*</span></label>
            <input type="text" className="form-inp" value={form.name} onChange={e => set('name', e.target.value)} autoFocus required />
          </div>
          <div className="form-grp">
            <label>Due date</label>
            <DateInput className="form-inp" value={form.dueDate} onChange={e => set('dueDate', e.target.value)} />
          </div>
          <div className="form-grp">
            <label>Time</label>
            <TimeInput className="form-inp" value={form.time} onChange={e => set('time', e.target.value)} />
          </div>
          <div className="form-grp">
            <label>Priority</label>
            <Select className="form-inp" value={form.priority} onChange={e => set('priority', e.target.value)}
              options={Object.entries(PRI_META).map(([k, m]) => ({ value: k, label: m.label }))} />
          </div>
          <div className="form-grp">
            <label>Category</label>
            <Select className="form-inp" value={form.category} onChange={e => set('category', e.target.value)}
              options={Object.entries(CAT_META).map(([k, m]) => ({ value: k, label: m.label }))} />
          </div>
          <div className="form-grp">
            <label>Notes</label>
            <input type="text" className="form-inp" value={form.notes} onChange={e => set('notes', e.target.value)} />
          </div>
        </>
      ) : (
        <>
          <div className="form-grp">
            <label>Title <span className="req">*</span></label>
            <input type="text" className="form-inp" value={form.title} onChange={e => set('title', e.target.value)} autoFocus required />
          </div>
          <div className="form-grp">
            <label>Content</label>
            <textarea className="form-inp" rows={4} value={form.content} onChange={e => set('content', e.target.value)} />
          </div>
        </>
      )}
      <div className="modal-footer">
        <button type="button" className="btn-cancel" onClick={onClose}>Cancel</button>
        <button type="submit" className="btn-submit">Confirm</button>
      </div>
    </form>
  );
}

// 0 candidates: nothing to pick — say so and let the user cancel (re-record
// is their only path back in, same as any other unmatched command).
// 2+ candidates: list them; picking one commits immediately, since clicking
// a specific task IS the disambiguation — there's nothing left to confirm.
function CompleteTaskBody({ candidates, onClose, onConfirm }) {
  if (!candidates || candidates.length === 0) {
    return (
      <div className="modal-form">
        <p className="voice-confirm-summary">Didn't find an incomplete task matching that.</p>
        <div className="modal-footer">
          <button type="button" className="btn-submit" onClick={onClose}>Close</button>
        </div>
      </div>
    );
  }
  return (
    <div className="modal-form">
      <p className="voice-confirm-summary">Found {candidates.length} matching tasks — which one?</p>
      <ul className="voice-confirm-candidates">
        {candidates.map(t => (
          <li key={t.id}>
            <button type="button" className="voice-confirm-candidate-btn" onClick={() => onConfirm({ taskId: t.id, name: t.name })}>
              {t.name}
            </button>
          </li>
        ))}
      </ul>
      <div className="modal-footer">
        <button type="button" className="btn-cancel" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}
