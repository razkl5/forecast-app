import { useState, useEffect, useCallback } from "react";

const STORAGE_KEY = "forecast_data_v1";

async function persistState(state) {
  try { await window.storage.set(STORAGE_KEY, JSON.stringify(state)); } catch {}
}

async function hydrateState() {
  try {
    const result = await window.storage.get(STORAGE_KEY);
    if (result?.value) return JSON.parse(result.value);
  } catch {}
  return { teeTimes: [] };
}

async function requestNotificationPermission() {
  if (typeof Notification === "undefined") return false;
  const perm = await Notification.requestPermission();
  return perm === "granted";
}

function sendPush(title, body) {
  if (typeof Notification !== "undefined" && Notification.permission === "granted") {
    try { new Notification(title, { body, icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E⛳%3C/text%3E%3C/svg%3E" }); } catch {}
  }
}

function formatDateTime(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function formatDeadline(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString("en-US", { month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function calcDeadline(dateStr) {
  if (!dateStr) return null;
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d - 2, 15, 0, 0).toISOString();
}

function isWeekend(isoDateTime) {
  const day = new Date(isoDateTime).getDay();
  return day === 0 || day === 6;
}

function getTeeTimeStatus(tt) {
  if (tt.cancelled) return "cancelled";
  if (tt.upgraded) return "upgraded";
  if (tt.deadline && Date.now() > new Date(tt.deadline).getTime()) return "locked";
  return "open";
}

function countFilledSlots(signups) {
  return signups.reduce((acc, s) => acc + 1 + (s.friends?.length || 0), 0);
}

function Avatar({ name, highlight }) {
  const initials = name.trim().split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase();
  const colors = ["#2d7a3e","#1565c0","#6d4c41","#ad1457","#00695c","#4527a0","#558b2f"];
  const color = colors[name.charCodeAt(0) % colors.length];
  return (
    <div style={{
      width: 28, height: 28, borderRadius: "50%",
      background: highlight ? "var(--green)" : color,
      color: "white", fontSize: "0.65rem", fontWeight: 700,
      display: "flex", alignItems: "center", justifyContent: "center",
      flexShrink: 0, border: highlight ? "2px solid var(--green)" : "none",
    }}>{initials}</div>
  );
}

// ─── ADMIN VIEW ───────────────────────────────────────────────────────────────
function AdminView({ teeTimes, persist }) {
  const [step, setStep] = useState(1);
  const [form, setForm] = useState({ course: "", date: "", time: "", spots: 3, notes: "", walkOn: false });
  const [upgradeTarget, setUpgradeTarget] = useState(null);
  const [upgradeForm, setUpgradeForm] = useState({ course: "", date: "", time: "", notes: "" });
  const [savedCourses, setSavedCourses] = useState(() => {
    try { return JSON.parse(localStorage.getItem("teetime_saved_courses") || "[]"); } catch { return []; }
  });

  function saveCourse(name) {
    if (!name || savedCourses.includes(name)) return;
    const updated = [...savedCourses, name];
    setSavedCourses(updated);
    localStorage.setItem("teetime_saved_courses", JSON.stringify(updated));
  }

  function removeCourse(name) {
    const updated = savedCourses.filter(c => c !== name);
    setSavedCourses(updated);
    localStorage.setItem("teetime_saved_courses", JSON.stringify(updated));
  }

  function postTeeTime() {
    if (!form.course || !form.date || !form.time) return;
    const isoDateTime = `${form.date}T${form.time}`;
    const newTT = {
      id: Date.now(), course: form.course, dateTime: isoDateTime,
      spots: Number(form.spots), deadline: calcDeadline(form.date),
      notes: form.notes, walkOn: form.walkOn,
      signups: [], waitlist: [],
      postedAt: new Date().toISOString(),
      cancelled: false, upgraded: false, upgradedTo: null, firstDibsOrder: [],
    };
    persist({ teeTimes: [newTT, ...teeTimes] });
    sendPush("⛳ New Tee Time Posted!", `${form.course} — ${formatDateTime(isoDateTime)} · ${form.spots} spots${form.walkOn ? " · Walk-on" : ""}`);
    setForm({ course: "", date: "", time: "", spots: 3, notes: "", walkOn: false });
    setStep(1);
  }

  function cancelTeeTime(id) { persist({ teeTimes: teeTimes.map(tt => tt.id === id ? { ...tt, cancelled: true } : tt) }); }
  function lockTeeTime(id) { persist({ teeTimes: teeTimes.map(tt => tt.id === id ? { ...tt, deadline: new Date().toISOString() } : tt) }); }

  function startUpgrade(tt) {
    setUpgradeTarget(tt);
    setUpgradeForm({ course: tt.course, date: tt.dateTime.split("T")[0], time: "", notes: "" });
  }

  function confirmUpgrade() {
    if (!upgradeForm.course || !upgradeForm.date || !upgradeForm.time) return;
    const isoDateTime = `${upgradeForm.date}T${upgradeForm.time}`;
    const newTT = {
      id: Date.now(), course: upgradeForm.course, dateTime: isoDateTime,
      spots: upgradeTarget.spots, deadline: calcDeadline(upgradeForm.date),
      notes: upgradeForm.notes, walkOn: false,
      signups: [], waitlist: [],
      postedAt: new Date().toISOString(),
      cancelled: false, upgraded: false, upgradedTo: null,
      firstDibsOrder: upgradeTarget.signups.map(s => s.name),
      isUpgrade: true,
    };
    const updated = teeTimes.map(tt => tt.id === upgradeTarget.id ? { ...tt, upgraded: true, upgradedTo: newTT.id } : tt);
    updated.unshift(newTT);
    persist({ teeTimes: updated });
    sendPush("⛳ Tee Time Updated!", `Updated: ${upgradeForm.course} — ${formatDateTime(isoDateTime)} · First dibs for previous signups!`);
    setUpgradeTarget(null);
  }

  const openTimes = teeTimes.filter(tt => !tt.cancelled && !tt.upgraded);
  const step1Done = form.course && form.date && form.time;

  return (
    <div className="admin-view">
      {/* ── POST FORM (2-step) ── */}
      <section className="post-card card">
        <div className="card-label">Post a Tee Time</div>

        {/* Step indicators */}
        <div className="steps">
          <div className={`step ${step >= 1 ? "active" : ""}`}>
            <div className="step-dot">1</div>
            <span>When &amp; Where</span>
          </div>
          <div className="step-line" />
          <div className={`step ${step >= 2 ? "active" : ""}`}>
            <div className="step-dot">2</div>
            <span>Details</span>
          </div>
        </div>

        {step === 1 && (
          <div className="form-grid">
            <div className="field full">
              <label>Course</label>
              {savedCourses.length > 0 && (
                <div className="course-chips">
                  {savedCourses.map(c => (
                    <div key={c} className={`course-chip ${form.course === c ? "active" : ""}`} onClick={() => setForm(f => ({ ...f, course: c }))}>
                      <span>{c}</span>
                      <button className="chip-remove" onClick={e => { e.stopPropagation(); removeCourse(c); }}>×</button>
                    </div>
                  ))}
                </div>
              )}
              <div className="course-input-row">
                <input value={form.course} onChange={e => setForm(f => ({ ...f, course: e.target.value }))} placeholder="Type a course name…" />
                {form.course && !savedCourses.includes(form.course) && (
                  <button className="btn-save-course" onClick={() => saveCourse(form.course)}>+ Save</button>
                )}
              </div>
            </div>
            <div className="field">
              <label>Date</label>
              <input type="date" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} />
            </div>
            <div className="field">
              <label>Tee Time</label>
              <input type="time" value={form.time} onChange={e => setForm(f => ({ ...f, time: e.target.value }))} />
            </div>
            <div className="field full">
              <button className={`btn-primary ${!step1Done ? "btn-disabled" : ""}`} onClick={() => step1Done && setStep(2)}>
                Next →
              </button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="form-grid">
            <div className="step2-summary">
              <span className="step2-course">{form.course}</span>
              <span className="step2-dt">{form.date && form.time ? formatDateTime(`${form.date}T${form.time}`) : ""}</span>
              <button className="step2-edit" onClick={() => setStep(1)}>Edit</button>
            </div>
            <div className="field">
              <label>Open Spots</label>
              <input type="number" min="1" max="7" value={form.spots} onChange={e => setForm(f => ({ ...f, spots: e.target.value }))} />
            </div>
            <div className="field walkon-field">
              <label>Walk-on?</label>
              <div className={`walkon-toggle ${form.walkOn ? "on" : ""}`} onClick={() => setForm(f => ({ ...f, walkOn: !f.walkOn }))}>
                <div className="walkon-knob" />
                <span className="walkon-label">{form.walkOn ? "Yes — no reserved slot" : "No — reserved"}</span>
              </div>
            </div>
            <div className="field full">
              <label>Respond by <span className="optional">(auto)</span></label>
              <div className="deadline-preview">
                {form.date ? `${new Date(calcDeadline(form.date)).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })} at 3:00 PM` : "—"}
              </div>
            </div>
            <div className="field full">
              <label>Notes <span className="optional">(optional)</span></label>
              <input value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} placeholder="Walking only, bring cash, etc." />
            </div>
            <div className="field full" style={{ display: "flex", gap: 8 }}>
              <button className="btn-ghost" style={{ flex: 1 }} onClick={() => setStep(1)}>← Back</button>
              <button className="btn-primary" style={{ flex: 2 }} onClick={postTeeTime}>Post + Notify</button>
            </div>
          </div>
        )}
      </section>

      {/* ── UPGRADE MODAL ── */}
      {upgradeTarget && (
        <div className="modal-overlay" onClick={() => setUpgradeTarget(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-title">Post Updated Tee Time</div>
            <p className="modal-sub">Previous signups get first dibs in signup order.</p>
            {upgradeTarget.signups.length > 0 && (
              <div className="dibs-list">
                {upgradeTarget.signups.map((s, i) => (
                  <span key={s.name} className="dibs-chip"><span className="dibs-rank">#{i + 1}</span> {s.name}</span>
                ))}
              </div>
            )}
            <div className="form-grid">
              <div className="field full"><label>Course</label><input value={upgradeForm.course} onChange={e => setUpgradeForm(f => ({ ...f, course: e.target.value }))} /></div>
              <div className="field"><label>Date</label><input type="date" value={upgradeForm.date} onChange={e => setUpgradeForm(f => ({ ...f, date: e.target.value }))} /></div>
              <div className="field"><label>New Time</label><input type="time" value={upgradeForm.time} onChange={e => setUpgradeForm(f => ({ ...f, time: e.target.value }))} /></div>
              <div className="field full"><label>Notes</label><input value={upgradeForm.notes} onChange={e => setUpgradeForm(f => ({ ...f, notes: e.target.value }))} /></div>
            </div>
            <div className="modal-actions">
              <button className="btn-ghost" onClick={() => setUpgradeTarget(null)}>Cancel</button>
              <button className="btn-primary" onClick={confirmUpgrade}>Post Update</button>
            </div>
          </div>
        </div>
      )}

      {/* ── ACTIVE TIMES ── */}
      <div className="section-header">Active</div>
      {openTimes.length === 0 && <div className="empty">No active tee times posted</div>}
      {openTimes.map(tt => {
        const status = getTeeTimeStatus(tt);
        const filled = countFilledSlots(tt.signups);
        const pct = filled / tt.spots;
        const ttWeekend = isWeekend(tt.dateTime);
        return (
          <div key={tt.id} className={`tee-card ${status} ${ttWeekend ? "weekend" : "weekday"}`}>
            <div className="card-top-band" />
            {tt.isUpgrade && <div className="badge badge-upgrade">Updated Time</div>}
            {tt.walkOn && <div className="badge badge-walkon">Walk-on</div>}
            {tt.firstDibsOrder?.length > 0 && (
              <div className="dibs-banner">First dibs: {tt.firstDibsOrder.join(" → ")}</div>
            )}
            <div className="card-inner">
            <div className="tee-header">
              <div>
                <div className="tee-course">{tt.course}</div>
                <div className="tee-datetime">{formatDateTime(tt.dateTime)}</div>
              </div>
              <div className={`status-pill ${status}`}>{status}</div>
            </div>
            {tt.notes && <div className="tee-notes">{tt.notes}</div>}

            {/* Capacity */}
            <div className="capacity-row">
              <div className="capacity-bar"><div className="capacity-fill" style={{ width: `${Math.min(pct, 1) * 100}%` }} /></div>
              <div className="capacity-count"><strong>{filled}</strong>/{tt.spots}</div>
            </div>

            {tt.signups.length > 0 && (
              <div className="signup-list">
                {tt.signups.map((s, i) => (
                  <div key={s.name}>
                    <div className="signup-row">
                      <Avatar name={s.name} />
                      <span className="signup-name">{s.name}</span>
                      <span className="signup-time">{new Date(s.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                    </div>
                    {s.friends?.map(f => (
                      <div key={f} className="signup-row friend-row">
                        <div style={{ width: 28, textAlign: "center", color: "var(--ink-light)", fontSize: "0.8rem" }}>↳</div>
                        <span className="signup-name">{f} <span className="friend-tag">guest</span></span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}

            {tt.waitlist?.length > 0 && (
              <div className="waitlist-section">
                <div className="waitlist-label">Waitlist · {tt.waitlist.length}</div>
                {tt.waitlist.map((w, i) => (
                  <div key={w.name} className="signup-row">
                    <Avatar name={w.name} />
                    <span className="signup-name">{w.name}</span>
                    <span className="signup-time">W{i + 1}</span>
                  </div>
                ))}
              </div>
            )}

            {status === "open" && tt.deadline && (
              <div className="respond-by-row">
                <span className="respond-by-label">Respond by</span>
                <span className="respond-by-date">{formatDeadline(tt.deadline)}</span>
              </div>
            )}

            <div className="admin-actions">
              <button className="btn-sm btn-ghost" onClick={() => lockTeeTime(tt.id)}>Lock</button>
              <button className="btn-sm btn-upgrade" onClick={() => startUpgrade(tt)}>Update Time ⬆</button>
              <button className="btn-sm btn-danger" onClick={() => cancelTeeTime(tt.id)}>Cancel</button>
            </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── PLAYER VIEW ──────────────────────────────────────────────────────────────
function PlayerView({ teeTimes, persist }) {
  const [name, setName] = useState(() => localStorage.getItem("teetimes_player_name") || "");
  const [nameInput, setNameInput] = useState("");
  const [notifEnabled, setNotifEnabled] = useState(() => typeof Notification !== "undefined" && Notification.permission === "granted");
  const [notifPrefs, setNotifPrefs] = useState(() => {
    try { return JSON.parse(localStorage.getItem("teetimes_notif_prefs") || '{"weekday":true,"weekend":true}'); } catch { return { weekday: true, weekend: true }; }
  });
  const [showPrefs, setShowPrefs] = useState(false);
  const [friendInputs, setFriendInputs] = useState({});
  const [bringingFriend, setBringingFriend] = useState({});

  function saveName() {
    const n = nameInput.trim();
    if (!n) return;
    localStorage.setItem("teetimes_player_name", n);
    setName(n);
  }

  function saveNotifPrefs(prefs) {
    setNotifPrefs(prefs);
    localStorage.setItem("teetimes_notif_prefs", JSON.stringify(prefs));
  }

  async function enableNotifs() {
    const ok = await requestNotificationPermission();
    setNotifEnabled(ok);
    if (ok) sendPush("Notifications on", "You'll get pinged when new tee times drop.");
  }

  function getFriendInputs(ttId) { return friendInputs[ttId] || ["", ""]; }
  function setFriendInput(ttId, idx, val) {
    setFriendInputs(prev => ({ ...prev, [ttId]: Object.assign([...(prev[ttId] || ["", ""])], { [idx]: val }) }));
  }

  function signUp(tt) {
    if (!name) return;
    if (tt.signups.find(s => s.name === name)) return;
    const filled = countFilledSlots(tt.signups);
    const friends = getFriendInputs(tt.id).map(f => f.trim()).filter(Boolean);
    if (filled + 1 + friends.length > tt.spots) {
      if (tt.waitlist?.find(w => w.name === name)) return;
      persist({ teeTimes: teeTimes.map(t => t.id === tt.id ? { ...t, waitlist: [...(t.waitlist || []), { name, at: new Date().toISOString() }] } : t) });
      sendPush("⏳ Waitlist", `${name} joined the waitlist for ${tt.course}`);
      return;
    }
    const friendSuffix = friends.length > 0 ? ` (+${friends.length} guest${friends.length > 1 ? "s" : ""})` : "";
    persist({ teeTimes: teeTimes.map(t => t.id === tt.id ? { ...t, signups: [...t.signups, { name, at: new Date().toISOString(), friends }] } : t) });
    sendPush("✅ New Sign-up", `${name}${friendSuffix} signed up for ${tt.course}`);
    setFriendInputs(prev => ({ ...prev, [tt.id]: ["", ""] }));
  }

  function withdraw(tt) {
    if (!name) return;
    setBringingFriend(prev => ({ ...prev, [tt.id]: false }));
    setFriendInputs(prev => ({ ...prev, [tt.id]: ["", ""] }));
    persist({ teeTimes: teeTimes.map(t => {
      if (t.id !== tt.id) return t;
      const newSignups = t.signups.filter(s => s.name !== name);
      let newWaitlist = [...(t.waitlist || [])];
      if (countFilledSlots(newSignups) < t.spots && newWaitlist.length > 0) {
        const promoted = newWaitlist.shift();
        newSignups.push({ name: promoted.name, at: new Date().toISOString(), friends: [] });
        sendPush("You're in!", `A spot opened at ${t.course} — you've been moved off the waitlist.`);
      }
      return { ...t, signups: newSignups, waitlist: newWaitlist };
    })});
  }

  function leaveWaitlist(tt) {
    persist({ teeTimes: teeTimes.map(t => t.id === tt.id ? { ...t, waitlist: (t.waitlist || []).filter(w => w.name !== name) } : t) });
  }

  const activeTimes = teeTimes.filter(tt => !tt.cancelled && !tt.upgraded);

  if (!name) {
    return (
      <div className="player-name-gate">
        <div className="gate-icon">⛳</div>
        <div className="gate-title">What's your name?</div>
        <div className="gate-sub">Your name will appear on the sign-up list</div>
        <div className="gate-input-row">
          <input className="gate-input" placeholder="First name or nickname" value={nameInput}
            onChange={e => setNameInput(e.target.value)} onKeyDown={e => e.key === "Enter" && saveName()} autoFocus />
          <button className="btn-primary" onClick={saveName}>Let's Go</button>
        </div>
      </div>
    );
  }

  return (
    <div className="player-view">
      <div className="player-bar">
        <span className="player-greeting">Hey, <strong>{name}</strong></span>
        <div className="player-bar-right">
          {!notifEnabled && <button className="btn-notif" onClick={enableNotifs}>Enable Notifications</button>}
          {notifEnabled && (
            <button className="btn-notif active" onClick={() => setShowPrefs(p => !p)}>
              {notifPrefs.weekday && notifPrefs.weekend ? "All days" : notifPrefs.weekday ? "Weekdays" : notifPrefs.weekend ? "Weekends" : "Muted"} ▾
            </button>
          )}
          <button className="btn-ghost-sm" onClick={() => { localStorage.removeItem("teetimes_player_name"); setName(""); }}>Switch</button>
        </div>
      </div>

      {showPrefs && notifEnabled && (
        <div className="prefs-panel">
          <div className="prefs-title">Notify me for</div>
          <div className="prefs-options">
            <label className="pref-option">
              <input type="checkbox" checked={notifPrefs.weekday} onChange={e => saveNotifPrefs({ ...notifPrefs, weekday: e.target.checked })} />
              <span>Weekday tee times</span>
            </label>
            <label className="pref-option">
              <input type="checkbox" checked={notifPrefs.weekend} onChange={e => saveNotifPrefs({ ...notifPrefs, weekend: e.target.checked })} />
              <span>Weekend tee times</span>
            </label>
          </div>
        </div>
      )}

      {activeTimes.length === 0 && (
        <div className="empty-state">
          <div className="empty-icon">⛳</div>
          <div className="empty-msg">Nothing posted yet</div>
          <div className="empty-sub">You'll get a notification when a tee time drops</div>
        </div>
      )}

      {activeTimes.map(tt => {
        const status = getTeeTimeStatus(tt);
        const mySignup = tt.signups.find(s => s.name === name);
        const myRank = tt.signups.findIndex(s => s.name === name) + 1;
        const myWaitlist = tt.waitlist?.find(w => w.name === name);
        const myWaitlistRank = (tt.waitlist || []).findIndex(w => w.name === name) + 1;
        const filled = countFilledSlots(tt.signups);
        const full = filled >= tt.spots;
        const isFirstDibs = tt.firstDibsOrder?.includes(name);
        const pct = filled / tt.spots;
        const inputs = getFriendInputs(tt.id);
        const ttWeekend = isWeekend(tt.dateTime);

        return (
          <div key={tt.id} className={`tee-card ${status} ${mySignup ? "mine" : ""} ${myWaitlist ? "waitlisted" : ""} ${ttWeekend ? "weekend" : "weekday"}`}>
            <div className="card-top-band" />
            {tt.isUpgrade && <div className="badge badge-upgrade">Updated Time</div>}
            {tt.walkOn && <div className="badge badge-walkon">Walk-on</div>}
            {isFirstDibs && !mySignup && status === "open" && (
              <div className="dibs-banner mine">First dibs on this updated time — you're up!</div>
            )}
            {mySignup && (
              <div className="my-spot-banner">
                You're in #{myRank}{mySignup.friends?.length > 0 ? ` · +${mySignup.friends.length} guest${mySignup.friends.length > 1 ? "s" : ""}` : ""}
              </div>
            )}
            {myWaitlist && (
              <div className="waitlist-banner">Waitlist #{myWaitlistRank} — you'll be auto-added if a spot opens</div>
            )}
            <div className="card-inner">
            <div className="tee-header">
              <div>
                <div className="tee-course">{tt.course}</div>
                <div className="tee-datetime">{formatDateTime(tt.dateTime)}</div>
              </div>
              <div className={`status-pill ${status}`}>{status}</div>
            </div>
            {tt.notes && <div className="tee-notes">{tt.notes}</div>}

            <div className="capacity-row">
              <div className="capacity-bar"><div className="capacity-fill" style={{ width: `${Math.min(pct, 1) * 100}%` }} /></div>
              <div className="capacity-count"><strong>{filled}</strong>/{tt.spots}</div>
            </div>

            {tt.signups.length > 0 && (
            <div className="signup-list">
              {tt.signups.map((s, i) => (
                <div key={s.name}>
                  <div className={`signup-row ${s.name === name ? "highlight" : ""}`}>
                    <Avatar name={s.name} highlight={s.name === name} />
                    <span className="signup-name">{s.name}</span>
                  </div>
                  {s.friends?.map(f => (
                    <div key={f} className="signup-row friend-row">
                      <div style={{ width: 28, textAlign: "center", color: "var(--ink-light)", fontSize: "0.8rem" }}>↳</div>
                      <span className="signup-name">{f} <span className="friend-tag">guest</span></span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
            )}

            {tt.waitlist?.length > 0 && (
              <div className="waitlist-section">
                <div className="waitlist-label">Waitlist · {tt.waitlist.length}</div>
                {tt.waitlist.map((w, i) => (
                  <div key={w.name} className={`signup-row ${w.name === name ? "highlight" : ""}`}>
                    <Avatar name={w.name} highlight={w.name === name} />
                    <span className="signup-name">{w.name}</span>
                    <span className="signup-time">W{i + 1}</span>
                  </div>
                ))}
              </div>
            )}

            {status === "open" && tt.deadline && (
              <div className="respond-by-row">
                <span className="respond-by-label">Respond by</span>
                <span className="respond-by-date">{formatDeadline(tt.deadline)}</span>
              </div>
            )}

            {status === "open" && !mySignup && !myWaitlist && (
              <div className="player-actions">
                {!full && (
                  <>
                    <label className="bringing-toggle">
                      <input
                        type="checkbox"
                        checked={!!bringingFriend[tt.id]}
                        onChange={e => {
                          setBringingFriend(prev => ({ ...prev, [tt.id]: e.target.checked }));
                          if (!e.target.checked) setFriendInputs(prev => ({ ...prev, [tt.id]: ["", ""] }));
                        }}
                      />
                      <span>Bringing someone?</span>
                    </label>
                    {bringingFriend[tt.id] && (
                      <div className="friend-section">
                        <input className="friend-input" placeholder="Friend's name" value={inputs[0]} onChange={e => setFriendInput(tt.id, 0, e.target.value)} />
                        <input className="friend-input" placeholder="2nd friend (optional)" value={inputs[1]} onChange={e => setFriendInput(tt.id, 1, e.target.value)} />
                      </div>
                    )}
                  </>
                )}
                <button className="btn-primary" onClick={() => signUp(tt)}>
                  {full ? "Join Waitlist" : "Claim Spot"}
                </button>
              </div>
            )}
            {status === "open" && myWaitlist && (
              <div className="player-actions">
                <button className="btn-withdraw" onClick={() => leaveWaitlist(tt)}>Leave Waitlist</button>
              </div>
            )}
            {status === "open" && mySignup && (
              <div className="player-actions">
                <button className="btn-withdraw" onClick={() => withdraw(tt)}>Drop Out</button>
              </div>
            )}
            {status === "locked" && !mySignup && !myWaitlist && (
              <div className="locked-msg">Deadline passed · Spots locked</div>
            )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── ROOT APP ─────────────────────────────────────────────────────────────────
export default function App() {
  const [view, setView] = useState(() => {
    const hash = window.location.hash;
    if (hash === "#admin") return "admin";
    if (hash === "#player") return "player";
    return "choose";
  });
  const [teeTimes, setTeeTimes] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [helpTab, setHelpTab] = useState("player");

  useEffect(() => {
    hydrateState().then(s => { setTeeTimes(s.teeTimes || []); setLoaded(true); });
    // Show help on first ever visit
    const seen = localStorage.getItem("forecast_help_seen");
    if (!seen) { setShowHelp(true); localStorage.setItem("forecast_help_seen", "1"); }
  }, []);

  const persist = useCallback(({ teeTimes: tts }) => {
    setTeeTimes(tts);
    persistState({ teeTimes: tts });
  }, []);

  useEffect(() => {
    const onFocus = () => hydrateState().then(s => setTeeTimes(s.teeTimes || []));
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  if (!loaded) return <div className="loading">Loading…</div>;

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700;900&family=DM+Sans:wght@300;400;500;600&display=swap');
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        :root {
          --green: #1a5c2a; --green-mid: #2d7a3e; --green-light: #4caf6a;
          --fairway: #e8f4e0;
          --ink: #0f1a10; --ink-mid: #3a4a3c; --ink-light: #8a9a84;
          --danger: #b71c1c; --amber: #e65100; --teal: #00695c;
          --walkon: #6d4c41; --radius: 16px;
          --shadow: 0 1px 12px rgba(15,26,16,0.08), 0 4px 24px rgba(15,26,16,0.06);
        }

        body {
          font-family: 'DM Sans', sans-serif;
          background: var(--fairway);
          background-image: url("data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%23c8dfc0' fill-opacity='0.35'%3E%3Cpath d='M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E");
          color: var(--ink);
          min-height: 100vh;
        }

        .app-shell { max-width: 480px; margin: 0 auto; padding: 0 0 80px; }

        .app-header { background: var(--green); color: white; padding: 16px 20px 18px; position: sticky; top: 0; z-index: 50; }
        .app-title { font-family: 'Playfair Display', serif; font-size: 2rem; line-height: 1; }
        .app-subtitle { font-size: 0.72rem; opacity: 0.6; letter-spacing: 1.5px; text-transform: uppercase; margin-top: 3px; }
        .view-tabs { display: flex; background: rgba(255,255,255,0.1); border-radius: 10px; margin-top: 14px; padding: 3px; gap: 2px; }
        .view-tab { flex: 1; padding: 8px; border: none; background: transparent; color: rgba(255,255,255,0.65); border-radius: 8px; font-family: 'DM Sans', sans-serif; font-size: 0.82rem; font-weight: 500; cursor: pointer; transition: all 0.15s; }
        .view-tab.active { background: white; color: var(--green); font-weight: 600; }

        /* Choose screen */
        .choose-screen { display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 80vh; gap: 14px; padding: 24px; }
        .choose-icon { font-size: 3.5rem; }
        .choose-title { font-family: 'Playfair Display', serif; font-size: 2.2rem; color: var(--green); }
        .choose-sub { color: var(--ink-light); font-size: 0.88rem; }
        .choose-btn { width: 100%; padding: 18px 20px; border-radius: var(--radius); border: none; cursor: pointer; font-family: 'DM Sans', sans-serif; font-size: 0.95rem; font-weight: 600; transition: transform 0.12s, box-shadow 0.12s; text-align: left; }
        .choose-btn:active { transform: scale(0.98); }
        .choose-btn.admin { background: var(--green); color: white; box-shadow: 0 4px 20px rgba(26,92,42,0.25); }
        .choose-btn.player { background: white; color: var(--green); border: 1.5px solid #c8dfc0; }
        .choose-btn-label { font-size: 1rem; }
        .choose-btn-sub { font-size: 0.78rem; opacity: 0.65; font-weight: 400; margin-top: 2px; }

        /* Name gate */
        .player-name-gate { display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 70vh; gap: 10px; padding: 24px; }
        .gate-icon { font-size: 3rem; }
        .gate-title { font-family: 'Playfair Display', serif; font-size: 1.8rem; color: var(--green); }
        .gate-sub { color: var(--ink-light); font-size: 0.85rem; margin-bottom: 4px; }
        .gate-input-row { display: flex; gap: 10px; width: 100%; }
        .gate-input { flex: 1; padding: 13px 16px; border: 1.5px solid #c8dfc0; border-radius: 12px; font-family: 'DM Sans', sans-serif; font-size: 1rem; background: white; outline: none; transition: border 0.15s; color: #0f1a10; -webkit-text-fill-color: #0f1a10; }
        .gate-input:focus { border-color: var(--green); }

        /* Cards */
        .tee-card { background: white; border-radius: var(--radius); margin: 12px 16px; box-shadow: var(--shadow); overflow: hidden; position: relative; }
        .card-top-band { height: 4px; background: var(--green-light); }
        .tee-card.weekend .card-top-band { background: var(--teal); }
        .tee-card.locked .card-top-band { background: #bdbdbd; }
        .tee-card.cancelled .card-top-band { background: var(--danger); }
        .tee-card.mine { box-shadow: var(--shadow), 0 0 0 2px var(--green); }
        .tee-card.waitlisted { box-shadow: var(--shadow), 0 0 0 2px var(--amber); }
        .card-inner { padding: 14px 18px 16px; }

        .badge { display: inline-block; font-size: 0.68rem; font-weight: 700; letter-spacing: 0.8px; text-transform: uppercase; padding: 5px 18px; border-radius: 0 0 8px 0; margin-bottom: 2px; }
        .badge-upgrade { background: #e3f2fd; color: var(--teal); }
        .badge-walkon { background: #efebe9; color: var(--walkon); }

        .dibs-banner { font-size: 0.8rem; font-weight: 500; color: #5d4037; background: #fff8e1; border-radius: 8px; padding: 7px 12px; margin: 4px 18px 8px; }
        .dibs-banner.mine { background: #e8f5e9; color: var(--green); }
        .my-spot-banner { background: var(--green); color: white; font-size: 0.82rem; font-weight: 600; padding: 8px 18px; margin-bottom: 0; }
        .waitlist-banner { background: #fff3e0; color: var(--amber); font-size: 0.82rem; font-weight: 600; padding: 8px 18px; margin-bottom: 0; }

        .tee-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; margin-bottom: 6px; }
        .tee-course { font-family: 'Playfair Display', serif; font-size: 1.35rem; color: var(--green); line-height: 1.1; }
        .tee-datetime { font-size: 0.85rem; color: var(--ink-mid); font-weight: 500; margin-top: 2px; }
        .tee-notes { font-size: 0.8rem; color: var(--ink-light); font-style: italic; margin-bottom: 10px; }

        .status-pill { font-size: 0.65rem; font-weight: 700; letter-spacing: 0.8px; text-transform: uppercase; padding: 4px 10px; border-radius: 20px; white-space: nowrap; flex-shrink: 0; margin-top: 3px; }
        .status-pill.open { background: #e8f5e0; color: var(--green); }
        .status-pill.locked { background: #f5f5f5; color: #757575; }
        .status-pill.cancelled { background: #fdecea; color: var(--danger); }
        .status-pill.upgraded { background: #e0f2f1; color: var(--teal); }

        .capacity-row { display: flex; align-items: center; gap: 10px; margin: 12px 0 8px; }
        .capacity-bar { flex: 1; height: 8px; background: #e8f0e4; border-radius: 4px; overflow: hidden; }
        .capacity-fill { height: 100%; background: linear-gradient(90deg, var(--green-light), var(--green)); border-radius: 4px; transition: width 0.4s ease; }
        .capacity-count { font-size: 0.8rem; color: var(--ink-light); font-weight: 600; white-space: nowrap; }
        .capacity-count strong { color: var(--green); }

        /* Signups */
        .signup-list { display: flex; flex-direction: column; gap: 2px; margin: 4px 0 10px; }
        .signup-row { display: flex; align-items: center; gap: 10px; padding: 6px 0; border-bottom: 1px solid #f5f5f5; }
        .signup-row.highlight { background: #f0faf2; border-radius: 8px; padding: 6px 8px; margin: 0 -8px; border-bottom: none; }
        .signup-row.friend-row { padding-left: 10px; opacity: 0.75; }
        .signup-name { flex: 1; font-size: 0.88rem; font-weight: 500; }
        .signup-time { font-size: 0.72rem; color: var(--ink-light); }
        .friend-tag { font-size: 0.65rem; background: #e8f5e0; color: var(--green); border-radius: 4px; padding: 1px 5px; margin-left: 4px; font-weight: 600; }

        /* Waitlist */
        .waitlist-section { margin: 4px 0 10px; background: #fffde7; border-radius: 8px; padding: 8px 12px; }
        .waitlist-label { font-size: 0.7rem; font-weight: 700; color: var(--amber); letter-spacing: 0.5px; text-transform: uppercase; margin-bottom: 6px; }

        /* Respond by */
        .respond-by-row { display: flex; align-items: center; justify-content: space-between; background: #f7faf5; padding: 10px 0; margin-top: 4px; border-radius: 8px; padding: 8px 12px; }
        .respond-by-label { font-size: 0.75rem; color: var(--ink-light); font-weight: 500; text-transform: uppercase; letter-spacing: 0.5px; }
        .respond-by-date { font-size: 0.9rem; font-weight: 600; color: var(--ink-mid); }

        /* Buttons */
        .btn-primary { width: 100%; padding: 14px; background: var(--green); color: white; border: none; border-radius: 12px; font-family: 'DM Sans', sans-serif; font-size: 0.95rem; font-weight: 600; cursor: pointer; transition: background 0.15s, transform 0.1s; letter-spacing: 0.2px; }
        .btn-primary:hover { background: var(--green-mid); }
        .btn-primary:active { transform: scale(0.98); }
        .btn-primary.btn-disabled { opacity: 0.4; cursor: not-allowed; }
        .btn-withdraw { width: 100%; padding: 12px; background: transparent; color: var(--danger); border: 1.5px solid #ffcdd2; border-radius: 12px; font-family: 'DM Sans', sans-serif; font-size: 0.88rem; font-weight: 600; cursor: pointer; transition: all 0.15s; }
        .btn-withdraw:hover { background: #fdecea; }
        .btn-ghost { padding: 10px 16px; background: transparent; color: var(--ink-mid); border: 1.5px solid #d8e4d0; border-radius: 10px; font-family: 'DM Sans', sans-serif; font-size: 0.88rem; cursor: pointer; transition: all 0.15s; }
        .btn-ghost:hover { background: #f0f4ec; }
        .btn-ghost-sm { padding: 5px 10px; background: transparent; color: rgba(255,255,255,0.65); border: 1px solid rgba(255,255,255,0.25); border-radius: 6px; font-family: 'DM Sans', sans-serif; font-size: 0.75rem; cursor: pointer; }
        .btn-sm { padding: 7px 14px; border-radius: 8px; font-family: 'DM Sans', sans-serif; font-size: 0.78rem; font-weight: 600; cursor: pointer; border: none; transition: all 0.12s; }
        .btn-sm:active { transform: scale(0.97); }
        .btn-danger { background: #fdecea; color: var(--danger); }
        .btn-danger:hover { background: #ffcdd2; }
        .btn-upgrade { background: #e0f2f1; color: var(--teal); }
        .btn-upgrade:hover { background: #b2dfdb; }
        .admin-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
        .player-actions { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; }

        /* Post form */
        .post-card { margin: 12px 16px; padding: 20px; background: white; border-radius: var(--radius); box-shadow: var(--shadow); }
        .card-label { font-family: 'Playfair Display', serif; font-size: 1.15rem; color: var(--green); margin-bottom: 16px; }

        /* 2-step indicators */
        .steps { display: flex; align-items: center; margin-bottom: 18px; }
        .step { display: flex; align-items: center; gap: 6px; font-size: 0.78rem; font-weight: 500; color: var(--ink-light); }
        .step.active { color: var(--green); font-weight: 600; }
        .step-dot { width: 22px; height: 22px; border-radius: 50%; background: #e8f0e4; color: var(--ink-light); font-size: 0.7rem; font-weight: 700; display: flex; align-items: center; justify-content: center; }
        .step.active .step-dot { background: var(--green); color: white; }
        .step-line { flex: 1; height: 1px; background: #e0e8d8; margin: 0 8px; }

        /* Step 2 summary */
        .step2-summary { grid-column: 1 / -1; display: flex; align-items: center; gap: 10px; background: #f5f9f3; border: 1.5px solid #c8dfc0; border-radius: 10px; padding: 10px 14px; margin-bottom: 4px; }
        .step2-course { font-weight: 700; font-size: 0.9rem; color: var(--green); flex: 1; }
        .step2-dt { font-size: 0.78rem; color: var(--ink-light); }
        .step2-edit { background: none; border: none; color: var(--green); font-size: 0.75rem; font-weight: 600; cursor: pointer; text-decoration: underline; font-family: 'DM Sans', sans-serif; }

        .form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
        .field { display: flex; flex-direction: column; gap: 5px; }
        .field.full, .field.walkon-field { grid-column: 1 / -1; }
        label { font-size: 0.7rem; font-weight: 600; color: var(--ink-light); letter-spacing: 0.3px; }
        .optional { font-weight: 400; opacity: 0.7; }
        input[type="text"], input[type="number"], input[type="date"], input[type="time"] { padding: 10px 13px; border: 1.5px solid #d8e4d0; border-radius: 10px; font-family: 'DM Sans', sans-serif; font-size: 0.92rem; background: #fafcf8 !important; outline: none; transition: border 0.15s; color: #0f1a10 !important; -webkit-text-fill-color: #0f1a10 !important; }
        input:focus { border-color: var(--green); background: white !important; -webkit-text-fill-color: #0f1a10 !important; }
        input:-webkit-autofill,
        input:-webkit-autofill:hover,
        input:-webkit-autofill:focus,
        input:-webkit-autofill:active { -webkit-text-fill-color: #0f1a10 !important; -webkit-box-shadow: 0 0 0px 1000px #fafcf8 inset !important; box-shadow: 0 0 0px 1000px #fafcf8 inset !important; background-color: #fafcf8 !important; transition: background-color 5000s ease-in-out 0s; caret-color: #0f1a10; }

        .walkon-toggle { display: flex; align-items: center; gap: 10px; cursor: pointer; padding: 10px 13px; background: #fafcf8; border: 1.5px solid #d8e4d0; border-radius: 10px; transition: all 0.2s; user-select: none; }
        .walkon-toggle.on { background: #efebe9; border-color: #bcaaa4; }
        .walkon-knob { width: 36px; height: 20px; background: #ccc; border-radius: 10px; position: relative; flex-shrink: 0; transition: background 0.2s; }
        .walkon-toggle.on .walkon-knob { background: var(--walkon); }
        .walkon-knob::after { content: ''; position: absolute; width: 14px; height: 14px; background: white; border-radius: 50%; top: 3px; left: 3px; transition: left 0.2s; }
        .walkon-toggle.on .walkon-knob::after { left: 19px; }
        .walkon-label { font-size: 0.85rem; color: var(--ink-mid); font-weight: 500; }

        .deadline-preview { padding: 10px 13px; background: #f0faf2; border: 1.5px solid #a5d6a7; border-radius: 10px; font-size: 0.88rem; color: var(--green); font-weight: 500; }

        .course-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
        .course-chip { display: flex; align-items: center; gap: 4px; padding: 5px 10px 5px 12px; background: #f0f4ec; border: 1.5px solid #c8dfc0; border-radius: 20px; font-size: 0.82rem; font-weight: 500; color: var(--ink-mid); cursor: pointer; transition: all 0.15s; }
        .course-chip.active { background: var(--green); border-color: var(--green); color: white; }
        .course-chip.active .chip-remove { color: rgba(255,255,255,0.8); }
        .chip-remove { background: none; border: none; cursor: pointer; font-size: 1rem; color: var(--ink-light); padding: 0 0 0 2px; line-height: 1; }
        .course-input-row { display: flex; gap: 8px; align-items: center; }
        .course-input-row input { flex: 1; }
        .btn-save-course { white-space: nowrap; padding: 10px 12px; background: #e8f5e0; color: var(--green); border: 1.5px solid #a5d6a7; border-radius: 10px; font-family: 'DM Sans', sans-serif; font-size: 0.78rem; font-weight: 700; cursor: pointer; }

        /* Player bar */
        .player-bar { display: flex; align-items: center; justify-content: space-between; padding: 11px 16px; background: rgba(255,255,255,0.7); backdrop-filter: blur(4px); border-bottom: 1px solid #dcebd4; }
        .player-greeting { font-size: 0.88rem; color: var(--ink-mid); }
        .player-greeting strong { color: var(--green); }
        .player-bar-right { display: flex; align-items: center; gap: 8px; }
        .btn-notif { padding: 6px 12px; background: #fff8e1; color: #795548; border: 1px solid #ffe082; border-radius: 8px; font-family: 'DM Sans', sans-serif; font-size: 0.75rem; font-weight: 600; cursor: pointer; }
        .btn-notif.active { background: #e8f5e9; color: var(--green); border-color: #a5d6a7; }

        .prefs-panel { background: white; border-bottom: 1px solid #dcebd4; padding: 12px 16px; }
        .prefs-title { font-size: 0.72rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: var(--ink-light); margin-bottom: 10px; }
        .prefs-options { display: flex; gap: 16px; }
        .pref-option { display: flex; align-items: center; gap: 8px; font-size: 0.87rem; font-weight: 500; color: var(--ink-mid); cursor: pointer; }
        .pref-option input[type="checkbox"] { width: 16px; height: 16px; accent-color: var(--green); cursor: pointer; }

        .bringing-toggle { display: flex; align-items: center; gap: 8px; font-size: 0.88rem; font-weight: 500; color: var(--ink-mid); cursor: pointer; padding: 2px 0; }
        .bringing-toggle input[type="checkbox"] { width: 16px; height: 16px; accent-color: var(--green); cursor: pointer; flex-shrink: 0; }

        /* Friend inputs */
        .friend-section { display: flex; flex-direction: column; gap: 6px; background: #f5f9f3; border: 1.5px solid #c8dfc0; border-radius: 12px; padding: 12px; }
        .friend-label { font-size: 0.72rem; font-weight: 600; color: var(--ink-light); text-transform: uppercase; letter-spacing: 0.3px; }
        .friend-input { padding: 9px 12px; border: 1.5px solid #d8e4d0; border-radius: 9px; font-family: 'DM Sans', sans-serif; font-size: 0.88rem; background: white; outline: none; color: #0f1a10; -webkit-text-fill-color: #0f1a10; }
        .friend-input:focus { border-color: var(--green); }

        /* Modal */
        .modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.45); z-index: 100; display: flex; align-items: flex-end; }
        .modal { background: white; border-radius: 20px 20px 0 0; padding: 24px 20px 40px; width: 100%; max-height: 85vh; overflow-y: auto; }
        .modal-title { font-family: 'Playfair Display', serif; font-size: 1.3rem; color: var(--teal); margin-bottom: 6px; }
        .modal-sub { font-size: 0.83rem; color: var(--ink-light); margin-bottom: 14px; }
        .dibs-list { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 16px; }
        .dibs-chip { background: #e8f5e9; color: var(--green); border-radius: 20px; padding: 4px 12px; font-size: 0.8rem; font-weight: 500; display: flex; align-items: center; gap: 4px; }
        .dibs-rank { font-size: 0.68rem; opacity: 0.7; }
        .modal-actions { display: flex; gap: 10px; margin-top: 16px; }
        .modal-actions .btn-primary { flex: 2; }
        .modal-actions .btn-ghost { flex: 1; }

        /* Section headers */
        .section-header { font-family: 'DM Sans', sans-serif; font-size: 0.72rem; font-weight: 700; letter-spacing: 1.5px; text-transform: uppercase; color: var(--ink-light); padding: 16px 20px 4px; }

        .locked-msg { font-size: 0.82rem; color: #9e9e9e; padding: 10px 0; text-align: center; }
        .empty { text-align: center; color: var(--ink-light); font-size: 0.88rem; padding: 28px; }
        .empty-state { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 64px 24px; text-align: center; }
        .empty-icon { font-size: 2.8rem; }
        .empty-msg { font-family: 'Playfair Display', serif; font-size: 1.3rem; color: var(--green); }
        .empty-sub { font-size: 0.83rem; color: var(--ink-light); max-width: 220px; line-height: 1.5; }
        .loading { display: flex; align-items: center; justify-content: center; height: 100vh; color: var(--ink-light); font-family: 'DM Sans', sans-serif; }

        /* Help button */
        .app-header-top { display: flex; align-items: flex-start; justify-content: space-between; }
        .help-btn { width: 28px; height: 28px; border-radius: 50%; background: rgba(255,255,255,0.2); border: 1.5px solid rgba(255,255,255,0.35); color: white; font-size: 0.85rem; font-weight: 700; cursor: pointer; display: flex; align-items: center; justify-content: center; flex-shrink: 0; margin-top: 4px; transition: background 0.15s; font-family: 'DM Sans', sans-serif; }
        .help-btn:hover { background: rgba(255,255,255,0.3); }

        /* Help modal */
        .help-modal { padding: 0 0 24px; }
        .help-header { display: flex; align-items: center; justify-content: space-between; padding: 20px 20px 0; margin-bottom: 16px; }
        .help-title { font-family: 'Playfair Display', serif; font-size: 1.3rem; color: var(--green); }
        .help-close { background: none; border: none; font-size: 1rem; color: var(--ink-light); cursor: pointer; padding: 4px; line-height: 1; }
        .help-tabs { display: flex; gap: 0; margin: 0 20px 16px; background: #f0f4ec; border-radius: 10px; padding: 3px; }
        .help-tab { flex: 1; padding: 8px; border: none; background: transparent; border-radius: 8px; font-family: 'DM Sans', sans-serif; font-size: 0.85rem; font-weight: 500; color: var(--ink-light); cursor: pointer; transition: all 0.15s; }
        .help-tab.active { background: white; color: var(--green); font-weight: 600; box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
        .help-content { display: flex; flex-direction: column; gap: 0; margin: 0 20px; }
        .help-item { display: flex; gap: 14px; align-items: flex-start; padding: 12px 0; border-bottom: 1px solid #f0f4ec; }
        .help-item:last-child { border-bottom: none; }
        .help-icon { font-size: 1.3rem; flex-shrink: 0; margin-top: 1px; }
        .help-item-title { font-size: 0.9rem; font-weight: 600; color: var(--ink); margin-bottom: 2px; }
        .help-item-desc { font-size: 0.8rem; color: var(--ink-light); line-height: 1.5; }
        .help-modal .btn-primary { margin: 8px 20px 0; width: calc(100% - 40px); }
      `}</style>

      <div className="app-shell">
        <div className="app-header">
          <div className="app-header-top">
            <div>
              <div className="app-title">ForeCast</div>
              <div className="app-subtitle">Group Tee Time Manager</div>
            </div>
            <button className="help-btn" onClick={() => { setShowHelp(true); }}>?</button>
          </div>
          {view !== "choose" && (
            <div className="view-tabs">
              <button className={`view-tab ${view === "admin" ? "active" : ""}`} onClick={() => setView("admin")}>Admin</button>
              <button className={`view-tab ${view === "player" ? "active" : ""}`} onClick={() => setView("player")}>Player</button>
            </div>
          )}
        </div>

        {showHelp && (
          <div className="modal-overlay" onClick={() => setShowHelp(false)}>
            <div className="modal help-modal" onClick={e => e.stopPropagation()}>
              <div className="help-header">
                <div className="help-title">How to use ForeCast</div>
                <button className="help-close" onClick={() => setShowHelp(false)}>✕</button>
              </div>

              <div className="help-tabs">
                <button className={`help-tab ${helpTab === "player" ? "active" : ""}`} onClick={() => setHelpTab("player")}>Playing</button>
                <button className={`help-tab ${helpTab === "admin" ? "active" : ""}`} onClick={() => setHelpTab("admin")}>Posting</button>
                <button className={`help-tab ${helpTab === "circles" ? "active" : ""}`} onClick={() => setHelpTab("circles")}>Circles</button>
              </div>

              {helpTab === "player" && (
                <div className="help-content">
                  <div className="help-item">
                    <div className="help-icon">👤</div>
                    <div>
                      <div className="help-item-title">Enter your name once</div>
                      <div className="help-item-desc">Your name is saved to your device — you won't need to re-enter it.</div>
                    </div>
                  </div>
                  <div className="help-item">
                    <div className="help-icon">🔔</div>
                    <div>
                      <div className="help-item-title">Enable notifications</div>
                      <div className="help-item-desc">Tap "Enable Notifications" so you get pinged the moment a tee time is posted. You can choose weekdays, weekends, or both.</div>
                    </div>
                  </div>
                  <div className="help-item">
                    <div className="help-icon">✅</div>
                    <div>
                      <div className="help-item-title">Claim your spot</div>
                      <div className="help-item-desc">Tap "Claim Spot" to sign up. Check "Bringing someone?" to add up to 2 guests — they'll take up spots too.</div>
                    </div>
                  </div>
                  <div className="help-item">
                    <div className="help-icon">⏳</div>
                    <div>
                      <div className="help-item-title">Waitlist</div>
                      <div className="help-item-desc">If it's full, join the waitlist. You'll be automatically added and notified if someone drops out.</div>
                    </div>
                  </div>
                  <div className="help-item">
                    <div className="help-icon">🕒</div>
                    <div>
                      <div className="help-item-title">Respond by deadline</div>
                      <div className="help-item-desc">Each posting has a "Respond by" date — spots lock automatically at that time. Respond before then or you'll miss out.</div>
                    </div>
                  </div>
                  <div className="help-item">
                    <div className="help-icon">🚶</div>
                    <div>
                      <div className="help-item-title">Walk-on times</div>
                      <div className="help-item-desc">If a posting is marked Walk-on, there's no reserved tee time — you're showing up and hoping for a spot on the course.</div>
                    </div>
                  </div>
                  <div className="help-item">
                    <div className="help-icon">⭕</div>
                    <div>
                      <div className="help-item-title">Circles</div>
                      <div className="help-item-desc">ForeCast uses Circles to keep groups separate. You'll need a join code from someone in your group to see their tee times. Tap the Circles tab above to learn more.</div>
                    </div>
                  </div>
                </div>
              )}

              {helpTab === "admin" && (
                <div className="help-content">
                  <div className="help-item">
                    <div className="help-icon">📋</div>
                    <div>
                      <div className="help-item-title">Post a tee time</div>
                      <div className="help-item-desc">Use the Admin view to post. Step 1 is course, date and time. Step 2 is spots, walk-on toggle, and notes. Hit "Post + Notify" to send it out.</div>
                    </div>
                  </div>
                  <div className="help-item">
                    <div className="help-icon">⛳</div>
                    <div>
                      <div className="help-item-title">Save your courses</div>
                      <div className="help-item-desc">Type a course and hit "+ Save" to store it as a chip. Tap it next time to fill the field instantly.</div>
                    </div>
                  </div>
                  <div className="help-item">
                    <div className="help-icon">🔔</div>
                    <div>
                      <div className="help-item-title">Sign-up notifications</div>
                      <div className="help-item-desc">You'll get a push notification whenever someone claims a spot or joins the waitlist — as long as notifications are enabled on your device.</div>
                    </div>
                  </div>
                  <div className="help-item">
                    <div className="help-icon">⬆️</div>
                    <div>
                      <div className="help-item-title">Found a better time?</div>
                      <div className="help-item-desc">Tap "Update Time" on a posting to replace it with a new one. Everyone who already signed up gets notified and has first dibs on the new time.</div>
                    </div>
                  </div>
                  <div className="help-item">
                    <div className="help-icon">🔒</div>
                    <div>
                      <div className="help-item-title">Lock or cancel</div>
                      <div className="help-item-desc">"Lock" closes signups immediately. "Cancel" removes the posting entirely. Spots also lock automatically at the respond-by deadline.</div>
                    </div>
                  </div>
                  <div className="help-item">
                    <div className="help-icon">🕒</div>
                    <div>
                      <div className="help-item-title">Auto deadline</div>
                      <div className="help-item-desc">The respond-by time is automatically set to 3:00 PM two days before the tee time. No need to set it manually.</div>
                    </div>
                  </div>
                  <div className="help-item">
                    <div className="help-icon">⭕</div>
                    <div>
                      <div className="help-item-title">Circles</div>
                      <div className="help-item-desc">Tee times are posted within a Circle so only your group sees them. Any member of a Circle can post a time. Tap the Circles tab above to learn more.</div>
                    </div>
                  </div>
                </div>
              )}

              {helpTab === "circles" && (
                <div className="help-content">
                  <div className="help-item">
                    <div className="help-icon">⭕</div>
                    <div>
                      <div className="help-item-title">What is a Circle?</div>
                      <div className="help-item-desc">A Circle is your private group. Only members of a Circle can see its tee times and get notified. You can be in multiple Circles at once.</div>
                    </div>
                  </div>
                  <div className="help-item">
                    <div className="help-icon">✏️</div>
                    <div>
                      <div className="help-item-title">Creating a Circle</div>
                      <div className="help-item-desc">Pick a unique name for your Circle (e.g. "Saturday Crew"). You can edit the name later — just note that no two Circles can share the same name.</div>
                    </div>
                  </div>
                  <div className="help-item">
                    <div className="help-icon">🔑</div>
                    <div>
                      <div className="help-item-title">Your join code</div>
                      <div className="help-item-desc">When you create a Circle, you get a short code like FORE-4821. Share this with anyone you want to invite. The code stays the same even if you rename the Circle.</div>
                    </div>
                  </div>
                  <div className="help-item">
                    <div className="help-icon">📨</div>
                    <div>
                      <div className="help-item-title">Joining a Circle</div>
                      <div className="help-item-desc">Got a code from a friend? Enter it to join their Circle. You'll instantly see their tee times and start receiving notifications.</div>
                    </div>
                  </div>
                  <div className="help-item">
                    <div className="help-icon">📣</div>
                    <div>
                      <div className="help-item-title">Anyone can post</div>
                      <div className="help-item-desc">Any member of a Circle can post a tee time. When they do, everyone else in that Circle gets notified — not people in other Circles.</div>
                    </div>
                  </div>
                  <div className="help-item">
                    <div className="help-icon">👥</div>
                    <div>
                      <div className="help-item-title">Multiple Circles</div>
                      <div className="help-item-desc">You can create or join as many Circles as you like — for example, your regular Saturday group and a separate work colleagues group.</div>
                    </div>
                  </div>
                </div>
              )}

              <button className="btn-primary" style={{ marginTop: 8 }} onClick={() => setShowHelp(false)}>Got it</button>
            </div>
          </div>
        )}

        {view === "choose" && (
          <div className="choose-screen">
            <div className="choose-icon">⛳</div>
            <div className="choose-title">ForeCast</div>
            <div className="choose-sub">Who are you?</div>
            <button className="choose-btn admin" onClick={() => setView("admin")}>
              <div className="choose-btn-label">I'm Posting Times</div>
              <div className="choose-btn-sub">Admin — post, manage & update tee times</div>
            </button>
            <button className="choose-btn player" onClick={() => setView("player")}>
              <div className="choose-btn-label">I'm Signing Up</div>
              <div className="choose-btn-sub">Player — claim spots & get notifications</div>
            </button>
          </div>
        )}

        {view === "admin" && <AdminView teeTimes={teeTimes} persist={persist} />}
        {view === "player" && <PlayerView teeTimes={teeTimes} persist={persist} />}
      </div>
    </>
  );
}
