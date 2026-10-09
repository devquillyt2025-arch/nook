import { useState } from 'react';
import DateInput from './DateInput';
import TimeInput from './TimeInput';
import { motion } from 'framer-motion';
import {
  TRACKER_CATS, TRACKER_TYPES, genId, defaultConfig,
} from '../trackers/trackerUtils';

const CATS  = Object.entries(TRACKER_CATS);
const TYPES = Object.entries(TRACKER_TYPES);

// ─── Main modal ───────────────────────────────────────────────────
export default function AddTrackerModal({ onSave, onClose, editTracker = null, existingTrackers = [] }) {
  const isEdit = !!editTracker;
  const [step, setStep] = useState(isEdit ? 2 : 1);
  const [type, setType] = useState(editTracker?.type ?? null);
  const [form, setForm] = useState(() =>
    isEdit
      ? { name: editTracker.name, category: editTracker.category, description: editTracker.description || '', config: editTracker.config }
      : { name: '', category: 'health', description: '', config: {} }
  );
  const [nameError, setNameError] = useState('');

  const setF = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const setC = (k, v) => setForm(f => ({ ...f, config: { ...f.config, [k]: v } }));

  const pickType = (t) => {
    setType(t);
    if (!isEdit) setF('config', defaultConfig(t));
    setStep(2);
  };

  const save = () => {
    if (!form.name.trim()) return;
    if (!isEdit) {
      const key = form.name.trim().toLowerCase();
      const dupe = existingTrackers.some(t => t.name.trim().toLowerCase() === key);
      if (dupe) { setNameError('A tracker with this name already exists'); return; }
    }
    const base = {
      name:        form.name.trim(),
      category:    form.category,
      description: form.description.trim(),
      config:      form.config,
    };
    onSave(isEdit
      ? { ...editTracker, ...base }
      : { id: genId(), type, logs: [], createdAt: new Date().toISOString(), ...base }
    );
  };

  const catColor = TRACKER_CATS[form.category]?.color ?? 'var(--accent)';

  return (
    <motion.div
      className="modal-overlay"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      onClick={onClose}
    >
      <motion.div
        className="modal-box modal-box-wide"
        initial={{ opacity: 0, y: 24, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 24, scale: 0.97 }}
        transition={{ duration: 0.2, ease: 'easeOut' }}
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="modal-hdr">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {step === 2 && !isEdit && (
              <button className="modal-back-btn" onClick={() => setStep(1)} aria-label="Back">←</button>
            )}
            <h3>
              {isEdit
                ? `Edit: ${editTracker.name}`
                : step === 1
                  ? 'Add Tracker'
                  : `New ${TRACKER_TYPES[type]?.label ?? ''} Tracker`}
            </h3>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>

        {/* Step 1: Choose type */}
        {step === 1 && (
          <div className="modal-form">
            <p className="modal-subtitle">What do you want to track?</p>
            <div className="tracker-type-grid">
              {TYPES.map(([key, meta]) => (
                <button key={key} className="tracker-type-card" onClick={() => pickType(key)}>
                  <span className="ttc-icon">{meta.icon}</span>
                  <span className="ttc-label">{meta.label}</span>
                  <span className="ttc-desc">{meta.desc}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Step 2: Fill details */}
        {step === 2 && (
          <div className="modal-form">
            <div className="form-grp">
              <label>Name <span className="req">*</span></label>
              <input
                autoFocus
                className={`form-inp${nameError ? ' form-inp-error' : ''}`}
                type="text"
                value={form.name}
                onChange={e => { setF('name', e.target.value); if (nameError) setNameError(''); }}
                placeholder={
                  type === 'habit'   ? 'e.g. Exercise daily' :
                  type === 'target'  ? 'e.g. Save ₹50,000' :
                  type === 'average' ? 'e.g. Sleep 7 hours' :
                                       'e.g. Launch website'
                }
              />
              {nameError && <span className="form-error">{nameError}</span>}
            </div>

            <div className="form-grp">
              <label>Category</label>
              <div className="cat-picker">
                {CATS.map(([key, m]) => (
                  <button key={key} type="button"
                    className={`cat-pick-btn${form.category === key ? ' cat-pick-active' : ''}`}
                    style={form.category === key ? { background: m.color + '22', borderColor: m.color, color: m.color } : {}}
                    onClick={() => setF('category', key)}
                  >{m.label}</button>
                ))}
              </div>
            </div>

            {type === 'habit'   && <HabitFields   config={form.config} setC={setC} />}
            {type === 'target'  && <TargetFields  config={form.config} setC={setC} />}
            {type === 'average' && <AverageFields config={form.config} setC={setC} />}
            {type === 'project' && <ProjectFields config={form.config} setC={setC} />}

            <div className="form-grp">
              <label>Description (optional)</label>
              <textarea className="form-inp form-textarea" rows={2}
                value={form.description}
                onChange={e => setF('description', e.target.value)}
                placeholder="Why does this matter to you?"
                spellCheck="true" autoCorrect="on" />
            </div>

            <div className="modal-footer">
              <button className="btn-cancel" onClick={onClose}>Cancel</button>
              <button
                className="btn-submit"
                style={{ '--submit-c': catColor }}
                disabled={!form.name.trim()}
                onClick={save}
              >
                {isEdit ? 'Save Changes' : 'Create Tracker'}
              </button>
            </div>
          </div>
        )}
      </motion.div>
    </motion.div>
  );
}

// ─── Habit config fields ──────────────────────────────────────────
function HabitFields({ config, setC }) {
  const sched = config.schedule ?? 'daily';
  const isCustom = Array.isArray(sched);
  const DAY_ABBR = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

  return (
    <>
      <div className="form-grp">
        <label>Schedule</label>
        <div className="cat-picker">
          {['daily', 'weekdays', 'weekends'].map(s => (
            <button key={s} type="button"
              className={`cat-pick-btn${sched === s ? ' cat-pick-active' : ''}`}
              style={sched === s ? { background: 'var(--accent-glow)', borderColor: 'var(--accent)', color: 'var(--accent)' } : {}}
              onClick={() => setC('schedule', s)}
            >{s[0].toUpperCase() + s.slice(1)}</button>
          ))}
          <button type="button"
            className={`cat-pick-btn${isCustom ? ' cat-pick-active' : ''}`}
            style={isCustom ? { background: 'var(--accent-glow)', borderColor: 'var(--accent)', color: 'var(--accent)' } : {}}
            onClick={() => setC('schedule', isCustom ? 'daily' : [1, 2, 3, 4, 5])}
          >Custom</button>
        </div>
        {isCustom && (
          <div className="day-picker">
            {DAY_ABBR.map((d, i) => (
              <button key={i} type="button"
                className={`day-btn${sched.includes(i) ? ' day-btn-active' : ''}`}
                onClick={() => {
                  const next = sched.includes(i) ? sched.filter(x => x !== i) : [...sched, i];
                  setC('schedule', next.length ? next : [i]);
                }}
              >{d}</button>
            ))}
          </div>
        )}
      </div>
      <div className="form-grp">
        <label>Time of Day (optional)</label>
        <div className="cat-picker">
          {[null, 'morning', 'afternoon', 'evening'].map(t => (
            <button key={t ?? 'any'} type="button"
              className={`cat-pick-btn${config.timeTag === t ? ' cat-pick-active' : ''}`}
              style={config.timeTag === t ? { background: 'var(--accent-glow)', borderColor: 'var(--accent)', color: 'var(--accent)' } : {}}
              onClick={() => setC('timeTag', t)}
            >{t ? t[0].toUpperCase() + t.slice(1) : 'Any time'}</button>
          ))}
        </div>
      </div>
      <div className="form-grp">
        <label>Daily Reminder (optional)</label>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <TimeInput className="form-inp" style={{ maxWidth: 150 }}
            value={config.reminderTime ?? ''}
            onChange={e => setC('reminderTime', e.target.value)} />
          <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Get a push notification</span>
        </div>
      </div>
    </>
  );
}

// ─── Target config fields ─────────────────────────────────────────
function TargetFields({ config, setC }) {
  return (
    <>
      <div className="form-row">
        <div className="form-grp">
          <label>Target Value <span className="req">*</span></label>
          <input type="number" className="form-inp" min="0"
            value={config.targetValue ?? ''}
            onChange={e => setC('targetValue', parseFloat(e.target.value) || 0)}
            placeholder="e.g. 50000" />
        </div>
        <div className="form-grp">
          <label>Unit</label>
          <input type="text" className="form-inp"
            value={config.unit ?? ''}
            onChange={e => setC('unit', e.target.value)}
            placeholder="e.g. ₹, kg, steps" />
        </div>
      </div>
      <div className="form-row">
        <div className="form-grp">
          <label>Starting Value</label>
          <input type="number" className="form-inp" min="0"
            value={config.startValue ?? ''}
            onChange={e => setC('startValue', parseFloat(e.target.value) || 0)}
            placeholder="0" />
        </div>
        <div className="form-grp">
          <label>Target Date</label>
          <DateInput className="form-inp"
            value={config.targetDate ?? ''}
            onChange={e => setC('targetDate', e.target.value)} />
        </div>
      </div>
    </>
  );
}

// ─── Average config fields ────────────────────────────────────────
function AverageFields({ config, setC }) {
  const sched = config.schedule ?? 'daily';
  return (
    <>
      <div className="form-row">
        <div className="form-grp">
          <label>Target Average <span className="req">*</span></label>
          <input type="number" className="form-inp" min="0" step="0.1"
            value={config.targetAverage ?? ''}
            onChange={e => setC('targetAverage', parseFloat(e.target.value) || 0)}
            placeholder="e.g. 7" />
        </div>
        <div className="form-grp">
          <label>Unit</label>
          <input type="text" className="form-inp"
            value={config.unit ?? ''}
            onChange={e => setC('unit', e.target.value)}
            placeholder="e.g. hours, L, km" />
        </div>
      </div>
      <div className="form-grp">
        <label>Schedule</label>
        <div className="cat-picker">
          {['daily', 'weekdays'].map(s => (
            <button key={s} type="button"
              className={`cat-pick-btn${sched === s ? ' cat-pick-active' : ''}`}
              style={sched === s ? { background: 'var(--accent-glow)', borderColor: 'var(--accent)', color: 'var(--accent)' } : {}}
              onClick={() => setC('schedule', s)}
            >{s[0].toUpperCase() + s.slice(1)}</button>
          ))}
        </div>
      </div>
      <div className="form-grp">
        <label>Time of Day (optional)</label>
        <div className="cat-picker">
          {[null, 'morning', 'afternoon', 'evening'].map(t => (
            <button key={t ?? 'any'} type="button"
              className={`cat-pick-btn${config.timeTag === t ? ' cat-pick-active' : ''}`}
              style={config.timeTag === t ? { background: 'var(--accent-glow)', borderColor: 'var(--accent)', color: 'var(--accent)' } : {}}
              onClick={() => setC('timeTag', t)}
            >{t ? t[0].toUpperCase() + t.slice(1) : 'Any time'}</button>
          ))}
        </div>
      </div>
    </>
  );
}

// ─── Project config fields ────────────────────────────────────────
function ProjectFields({ config, setC }) {
  const [newText, setNewText] = useState('');
  const milestones = config.milestones || [];

  const add = () => {
    if (!newText.trim()) return;
    setC('milestones', [...milestones, { id: genId(), text: newText.trim(), done: false, doneAt: null }]);
    setNewText('');
  };

  return (
    <>
      <div className="form-grp">
        <label>Target Date</label>
        <DateInput className="form-inp"
          value={config.targetDate ?? ''}
          onChange={e => setC('targetDate', e.target.value)} />
      </div>
      <div className="form-grp">
        <label>Milestones</label>
        <div className="milestone-input-row">
          <input type="text" className="form-inp" value={newText}
            onChange={e => setNewText(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), add())}
            placeholder="Add a milestone… (Enter to add)" />
          <button type="button" className="add-task-btn" onClick={add} style={{ flexShrink: 0 }}>Add</button>
        </div>
        {milestones.length > 0 && (
          <div className="milestone-form-list">
            {milestones.map((m, i) => (
              <div key={m.id} className="milestone-form-row">
                <span className="mfr-num">{i + 1}.</span>
                <span className="mfr-text">{m.text}</span>
                <button type="button" className="task-del-btn" style={{ opacity: 1 }}
                  onClick={() => setC('milestones', milestones.filter(x => x.id !== m.id))}>×</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
