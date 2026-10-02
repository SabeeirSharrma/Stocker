/** Screen 8 — Learn (spec §7.8, T1 glossary, T2 challenges, T4/T5 material,
 *  RM12 known limits, readiness checklist). */

import { useState } from 'react';
import type { AppStore } from '../state/store';
import {
  GLOSSARY, KNOWN_LIMITS, READINESS_CHECKLIST, READINESS_FOOTER,
} from '../teaching/content';
import { CHALLENGES } from '../teaching/challenges';
import { TopBar, useStore } from './common';

type Section = 'challenges' | 'glossary' | 'journal' | 'ready';

export function Learn({ store }: { store: AppStore }) {
  useStore(store);
  const [section, setSection] = useState<Section>('challenges');
  const [query, setQuery] = useState('');

  const progress = store.state.challengeProgress;
  const doneCount = CHALLENGES.filter((c) => progress[c.id]).length;

  return (
    <>
      <TopBar title="Learn" />
      <main className="app-main">
        <div className="seg" role="group" aria-label="Learn section" style={{ marginBottom: 12 }}>
          <button type="button" aria-pressed={section === 'challenges'} onClick={() => setSection('challenges')}>
            Challenges
          </button>
          <button type="button" aria-pressed={section === 'glossary'} onClick={() => setSection('glossary')}>
            Glossary
          </button>
          <button type="button" aria-pressed={section === 'journal'} onClick={() => setSection('journal')}>
            Journal
          </button>
          <button type="button" aria-pressed={section === 'ready'} onClick={() => setSection('ready')}>
            Limits
          </button>
        </div>

        {section === 'challenges' && (
          <div className="card">
            <div className="row between">
              <h2 style={{ margin: 0 }}>Practice challenges (T2)</h2>
              <span className="badge">
                {doneCount}/{CHALLENGES.length}
              </span>
            </div>
            <div className="progressbar" style={{ margin: '8px 0 4px' }}>
              <i style={{ width: `${Math.round((doneCount / CHALLENGES.length) * 100)}%` }} />
            </div>
            <div className="tiny dim">Completed automatically as you use the app — progress is kept on this device.</div>

            {CHALLENGES.map((c) => {
              const at = progress[c.id];
              return (
                <div className="challenge" key={c.id}>
                  <div className="title">
                    <span aria-hidden="true">{at ? '✓' : '○'}</span>
                    {c.title}
                    {at && <span className="badge ok">done {new Date(at).toLocaleDateString()}</span>}
                  </div>
                  <div className="desc">{c.description}</div>
                  {!at && <div className="hint">Hint: {c.hint}</div>}
                </div>
              );
            })}
          </div>
        )}

        {section === 'glossary' && (
          <div className="card">
            <h2>Glossary (T1)</h2>
            <div className="field">
              <label htmlFor="gq">Filter terms</label>
              <input id="gq" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="spread, settlement…" />
            </div>
            {GLOSSARY.filter((g) => {
              const q = query.trim().toLowerCase();
              if (!q) return true;
              return `${g.term} ${g.short} ${g.body}`.toLowerCase().includes(q);
            }).map((g) => (
              <details className="gloss" key={g.id}>
                <summary>
                  {g.term} <span className="tiny dim">— {g.short}</span>
                </summary>
                <p>{g.body}</p>
              </details>
            ))}
            {GLOSSARY.length === 0 && <div className="empty">No entries.</div>}
          </div>
        )}

        {section === 'journal' && <Journal store={store} />}

        {section === 'ready' && (
          <>
            <div className="card">
              <h2>Known limits of this simulator (RM12)</h2>
              <div className="stack-sm">
                {KNOWN_LIMITS.map((l) => (
                  <div key={l.title}>
                    <strong className="small">{l.title}</strong>
                    <div className="small dim">{l.body}</div>
                  </div>
                ))}
              </div>
            </div>

            <div className="card">
              <h2>What real trading adds (readiness checklist)</h2>
              <div className="stack-sm">
                {READINESS_CHECKLIST.map((c) => (
                  <div key={c.area}>
                    <strong className="small">{c.area}</strong>
                    <ul className="small dim" style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                      {c.points.map((p) => (
                        <li key={p}>{p}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
              <div className="disclaimer tiny" style={{ marginTop: 10 }}>
                {READINESS_FOOTER.join(' ')}
              </div>
            </div>
          </>
        )}
      </main>
    </>
  );
}

function Journal({ store }: { store: AppStore }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [thesis, setThesis] = useState('');
  const [exitPlan, setExitPlan] = useState('');
  const entries = store.state.journal;

  async function save() {
    if (!reason.trim()) return;
    await store.addJournal({ instrument: null, side: null, reason: reason.trim(), thesis: thesis.trim(), exitPlan: exitPlan.trim() });
    setReason('');
    setThesis('');
    setExitPlan('');
    setOpen(false);
  }

  return (
    <div className="card">
      <div className="row between">
        <h2 style={{ margin: 0 }}>Trade journal</h2>
        <button className="btn" style={{ minHeight: 40 }} onClick={() => setOpen((o) => !o)}>
          {open ? 'Close' : '+ New entry'}
        </button>
      </div>
      <p className="tiny dim">
        Write down why you're entering, your thesis and your exit plan <em>before</em> you know the outcome. Journaling
        is the single habit that turns a trade into a lesson.
      </p>

      {open && (
        <div style={{ marginTop: 8 }}>
          <div className="field">
            <label htmlFor="jr">Reason for entering</label>
            <input id="jr" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="What is the setup?" />
          </div>
          <div className="field">
            <label htmlFor="jt">Thesis</label>
            <textarea id="jt" value={thesis} onChange={(e) => setThesis(e.target.value)} placeholder="Why should this work?" />
          </div>
          <div className="field">
            <label htmlFor="je">Exit plan (price or condition)</label>
            <input id="je" value={exitPlan} onChange={(e) => setExitPlan(e.target.value)} placeholder="When do I get out, right or wrong?" />
          </div>
          <button className="btn primary block" onClick={save} disabled={!reason.trim()}>
            Save entry
          </button>
        </div>
      )}

      {entries.length === 0 ? (
        <div className="empty small">No entries yet.</div>
      ) : (
        <div style={{ marginTop: 10 }}>
          {[...entries].reverse().map((j) => (
            <div className="challenge" key={j.id}>
              <div className="title">
                {j.reason}
                <span className="badge">{new Date(j.openedAtUtc).toLocaleDateString()}</span>
                {j.instrument && <span className="badge">{j.instrument.exchange}:{j.instrument.symbol}</span>}
              </div>
              {j.thesis && <div className="desc">Thesis: {j.thesis}</div>}
              {j.exitPlan && <div className="hint">Exit: {j.exitPlan}</div>}
              {j.outcomeNote && <div className="desc">Outcome: {j.outcomeNote}</div>}
              <button
                className="btn ghost tiny"
                style={{ minHeight: 34, marginTop: 6 }}
                onClick={() => void store.removeJournal(j.id)}
              >
                Delete
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
