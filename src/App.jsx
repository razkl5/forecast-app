import { useState, useEffect, useCallback, useRef } from "react";
import { initializeApp } from "firebase/app";
import { getFirestore, doc, collection, setDoc, getDoc, getDocs, updateDoc, onSnapshot, query, where, arrayUnion, arrayRemove, deleteField } from "firebase/firestore";
import { getMessaging, getToken, onMessage } from "firebase/messaging";

// ─── Firebase ─────────────────────────────────────────────────────────────────
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID
};

const VAPID_KEY = import.meta.env.VITE_VAPID_KEY;

const fbApp = initializeApp(firebaseConfig);
const db = getFirestore(fbApp);
let messaging = null;
try { messaging = getMessaging(fbApp); } catch {}

// Send config to service worker at runtime so no secrets are hardcoded there
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.ready.then(reg => {
    reg.active?.postMessage({
      type: 'FIREBASE_CONFIG',
      config: firebaseConfig
    });
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
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
  return (signups || []).reduce((acc, s) => acc + 1 + (s.friends?.length || 0), 0);
}

function generateCode() {
  const digits = Math.floor(1000 + Math.random() * 9000);
  return `FORE-${digits}`;
}

function Avatar({ name, highlight }) {
  const initials = name.trim().split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase();
  const colors = ["#2d7a3e","#1565c0","#6d4c41","#ad1457","#00695c","#4527a0","#558b2f"];
  const color = colors[name.charCodeAt(0) % colors.length];
  return (
    <div style={{
      width: 30, height: 30, borderRadius: "50%",
      background: highlight ? "var(--green)" : color,
      color: "white", fontSize: "0.68rem", fontWeight: 700,
      display: "flex", alignItems: "center", justifyContent: "center",
      flexShrink: 0, border: highlight ? "2px solid var(--green)" : "none",
    }}>{initials}</div>
  );
}

// ─── Firebase helpers ─────────────────────────────────────────────────────────
async function sendPushToCircle(circleId, title, body) {
  // Store a notification record in Firestore — in production a Cloud Function
  // would pick this up and fan out to FCM tokens. For now we store it so
  // members see it on next load, and foreground push fires directly.
  try {
    await setDoc(doc(collection(db, "circles", circleId, "notifications")), {
      title, body, sentAt: new Date().toISOString()
    });
  } catch {}
  // Foreground push for current user
  if (typeof Notification !== "undefined" && Notification.permission === "granted") {
    try { new Notification(title, { body, icon: "/favicon.svg" }); } catch {}
  }
}

async function registerFCMToken(circleId, userName) {
  if (!messaging) return;
  try {
    const token = await getToken(messaging, { vapidKey: VAPID_KEY });
    if (token) {
      await setDoc(doc(db, "circles", circleId, "fcmTokens", token), {
        userName, token, updatedAt: new Date().toISOString()
      });
    }
  } catch (e) { console.log("FCM token error:", e); }
}

// ─── CIRCLES GATE ─────────────────────────────────────────────────────────────
function CirclesGate({ userName, onEnterCircle }) {
  const [mode, setMode] = useState(null); // "create" | "join"
  const [circleName, setCircleName] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [myCircles, setMyCircles] = useState(() => {
    try { return JSON.parse(localStorage.getItem(`forecast_circles_${userName}`) || "[]"); } catch { return []; }
  });

  async function createCircle() {
    if (!circleName.trim()) return;
    setLoading(true); setError("");
    try {
      // Check name uniqueness
      const snap = await getDocs(query(collection(db, "circles"), where("name", "==", circleName.trim())));
      if (!snap.empty) { setError("That circle name is already taken — try another."); setLoading(false); return; }
      const code = generateCode();
      const circleId = code.toLowerCase().replace("-", "_");
      await setDoc(doc(db, "circles", circleId), {
        name: circleName.trim(),
        code,
        createdBy: userName,
        createdAt: new Date().toISOString(),
        members: [userName],
        teeTimes: [],
      });
      const newCircle = { id: circleId, name: circleName.trim(), code };
      const updated = [...myCircles, newCircle];
      setMyCircles(updated);
      localStorage.setItem(`forecast_circles_${userName}`, JSON.stringify(updated));
      onEnterCircle(newCircle);
    } catch (e) { setError("Something went wrong. Try again."); }
    setLoading(false);
  }

  async function joinCircle() {
    if (!joinCode.trim()) return;
    setLoading(true); setError("");
    const fullCode = `FORE-${joinCode.trim()}`;
    try {
      const snap = await getDocs(query(collection(db, "circles"), where("code", "==", fullCode.toUpperCase())));
      if (snap.empty) { setError("Code not found — double check and try again."); setLoading(false); return; }
      const circleDoc = snap.docs[0];
      const data = circleDoc.data();
      await updateDoc(doc(db, "circles", circleDoc.id), { members: arrayUnion(userName) });
      const newCircle = { id: circleDoc.id, name: data.name, code: data.code };
      const updated = [...myCircles.filter(c => c.id !== circleDoc.id), newCircle];
      setMyCircles(updated);
      localStorage.setItem(`forecast_circles_${userName}`, JSON.stringify(updated));
      onEnterCircle(newCircle);
    } catch (e) { setError("Something went wrong. Try again."); }
    setLoading(false);
  }

  return (
    <div className="circles-gate">
      <div className="circles-gate-icon">⭕</div>
      <div className="circles-gate-title">Your Circles</div>
      <div className="circles-gate-sub">Join or create a group to see tee times</div>

      {myCircles.length > 0 && (
        <div className="my-circles-list">
          {myCircles.map(c => (
            <button key={c.id} className="my-circle-btn" onClick={() => onEnterCircle(c)}>
              <div className="my-circle-name">{c.name}</div>
              <div className="my-circle-code">{c.code}</div>
            </button>
          ))}
        </div>
      )}

      {!mode && (
        <div className="circles-actions">
          <button className="btn-primary" onClick={() => setMode("create")}>Create a Circle</button>
          <button className="btn-ghost" onClick={() => setMode("join")}>Join with a Code</button>
        </div>
      )}

      {mode === "create" && (
        <div className="circles-form">
          <div className="circles-form-title">Name your Circle</div>
          <input
            value={circleName}
            onChange={e => { setCircleName(e.target.value); setError(""); }}
            placeholder="e.g. Saturday Crew"
            onKeyDown={e => e.key === "Enter" && createCircle()}
          />
          {error && <div className="circles-error">{error}</div>}
          <div className="circles-form-actions">
            <button className="btn-ghost" onClick={() => { setMode(null); setError(""); }}>Back</button>
            <button className="btn-primary" onClick={createCircle} disabled={loading}>
              {loading ? "Creating…" : "Create Circle"}
            </button>
          </div>
        </div>
      )}

      {mode === "join" && (
        <div className="circles-form">
          <div className="circles-form-title">Enter your join code</div>
          <div className="fore-input-row">
            <span className="fore-prefix">FORE-</span>
            <input
              type="text"
              inputMode="numeric"
              maxLength={4}
              value={joinCode}
              onChange={e => { setJoinCode(e.target.value.replace(/\D/g, "").slice(0, 4)); setError(""); }}
              placeholder="4821"
              onKeyDown={e => e.key === "Enter" && joinCircle()}
            />
          </div>
          {error && <div className="circles-error">{error}</div>}
          <div className="circles-form-actions">
            <button className="btn-ghost" onClick={() => { setMode(null); setError(""); }}>Back</button>
            <button className="btn-primary" onClick={joinCircle} disabled={loading}>
              {loading ? "Joining…" : "Join Circle"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── CIRCLE SETTINGS ──────────────────────────────────────────────────────────
function CircleSettings({ circle, userName, onRename, onClose }) {
  const [newName, setNewName] = useState(circle.name);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);

  async function rename() {
    if (!newName.trim() || newName.trim() === circle.name) return;
    setLoading(true); setError(""); setSuccess(false);
    try {
      const snap = await getDocs(query(collection(db, "circles"), where("name", "==", newName.trim())));
      if (!snap.empty) { setError("That name is already taken."); setLoading(false); return; }
      await updateDoc(doc(db, "circles", circle.id), { name: newName.trim() });
      onRename(newName.trim());
      setSuccess(true);
    } catch { setError("Something went wrong."); }
    setLoading(false);
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-title">Circle Settings</div>
        <div className="modal-sub">Code: <strong>{circle.code}</strong> · Share this with friends to invite them.</div>
        <div className="field" style={{ marginBottom: 12 }}>
          <label>Circle Name</label>
          <input value={newName} onChange={e => { setNewName(e.target.value); setError(""); setSuccess(false); }} />
        </div>
        {error && <div className="circles-error">{error}</div>}
        {success && <div className="circles-success">Name updated!</div>}
        <div className="modal-actions">
          <button className="btn-ghost" onClick={onClose}>Close</button>
          <button className="btn-primary" onClick={rename} disabled={loading || newName.trim() === circle.name}>
            {loading ? "Saving…" : "Save Name"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── ADMIN VIEW ───────────────────────────────────────────────────────────────
function AdminView({ teeTimes, circle, userName, onUpdateTeeTimes }) {
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

  async function postTeeTime() {
    if (!form.course || !form.date || !form.time) return;
    const isoDateTime = `${form.date}T${form.time}`;
    const newTT = {
      id: `tt_${Date.now()}`, course: form.course, dateTime: isoDateTime,
      spots: Number(form.spots), deadline: calcDeadline(form.date),
      notes: form.notes, walkOn: form.walkOn,
      signups: [], waitlist: [],
      postedAt: new Date().toISOString(), postedBy: userName,
      cancelled: false, upgraded: false, upgradedTo: null, firstDibsOrder: [],
    };
    const updated = [newTT, ...teeTimes];
    await updateDoc(doc(db, "circles", circle.id), { teeTimes: updated });
    onUpdateTeeTimes(updated);
    sendPushToCircle(circle.id, "⛳ New Tee Time!", `${form.course} — ${formatDateTime(isoDateTime)} · ${form.spots} spots${form.walkOn ? " · Walk-on" : ""}`);
    setForm({ course: "", date: "", time: "", spots: 3, notes: "", walkOn: false });
    setStep(1);
  }

  async function cancelTeeTime(id) {
    const updated = teeTimes.map(tt => tt.id === id ? { ...tt, cancelled: true } : tt);
    await updateDoc(doc(db, "circles", circle.id), { teeTimes: updated });
    onUpdateTeeTimes(updated);
  }

  async function lockTeeTime(id) {
    const updated = teeTimes.map(tt => tt.id === id ? { ...tt, deadline: new Date().toISOString() } : tt);
    await updateDoc(doc(db, "circles", circle.id), { teeTimes: updated });
    onUpdateTeeTimes(updated);
  }

  function startUpgrade(tt) {
    setUpgradeTarget(tt);
    setUpgradeForm({ course: tt.course, date: tt.dateTime.split("T")[0], time: "", notes: "" });
  }

  async function confirmUpgrade() {
    if (!upgradeForm.course || !upgradeForm.date || !upgradeForm.time) return;
    const isoDateTime = `${upgradeForm.date}T${upgradeForm.time}`;
    const newTT = {
      id: `tt_${Date.now()}`, course: upgradeForm.course, dateTime: isoDateTime,
      spots: upgradeTarget.spots, deadline: calcDeadline(upgradeForm.date),
      notes: upgradeForm.notes, walkOn: false,
      signups: [], waitlist: [],
      postedAt: new Date().toISOString(), postedBy: userName,
      cancelled: false, upgraded: false, upgradedTo: null,
      firstDibsOrder: upgradeTarget.signups.map(s => s.name),
      isUpgrade: true,
    };
    const updated = teeTimes.map(tt => tt.id === upgradeTarget.id ? { ...tt, upgraded: true, upgradedTo: newTT.id } : tt);
    updated.unshift(newTT);
    await updateDoc(doc(db, "circles", circle.id), { teeTimes: updated });
    onUpdateTeeTimes(updated);
    sendPushToCircle(circle.id, "⛳ Tee Time Updated!", `${upgradeForm.course} — ${formatDateTime(isoDateTime)} · First dibs for previous signups!`);
    setUpgradeTarget(null);
  }

  const openTimes = teeTimes.filter(tt => !tt.cancelled && !tt.upgraded);
  const step1Done = form.course && form.date && form.time;

  return (
    <div className="admin-view">
      <section className="post-card card">
        <div className="card-label">Post a Tee Time</div>
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
              <button className={`btn-primary ${!step1Done ? "btn-disabled" : ""}`} onClick={() => step1Done && setStep(2)}>Next →</button>
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
              <div className="capacity-row">
                <div className="capacity-bar"><div className="capacity-fill" style={{ width: `${Math.min(pct, 1) * 100}%` }} /></div>
                <div className="capacity-count"><strong>{filled}</strong>/{tt.spots}</div>
              </div>
              {tt.signups?.length > 0 && (
                <div className="signup-list">
                  {tt.signups.map((s) => (
                    <div key={s.name}>
                      <div className="signup-row">
                        <Avatar name={s.name} />
                        <span className="signup-name">{s.name}</span>
                        <span className="signup-time">{new Date(s.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                      </div>
                      {s.friends?.map(f => (
                        <div key={f} className="signup-row friend-row">
                          <div style={{ width: 30, textAlign: "center", color: "var(--ink-light)", fontSize: "0.8rem" }}>↳</div>
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
function PlayerView({ teeTimes, circle, userName, onUpdateTeeTimes }) {
  const [notifEnabled, setNotifEnabled] = useState(() => typeof Notification !== "undefined" && Notification.permission === "granted");
  const [notifPrefs, setNotifPrefs] = useState(() => {
    try { return JSON.parse(localStorage.getItem("teetimes_notif_prefs") || '{"weekday":true,"weekend":true}'); } catch { return { weekday: true, weekend: true }; }
  });
  const [showPrefs, setShowPrefs] = useState(false);
  const [friendInputs, setFriendInputs] = useState({});
  const [bringingFriend, setBringingFriend] = useState({});

  async function enableNotifs() {
    if (typeof Notification === "undefined") return;
    const perm = await Notification.requestPermission();
    if (perm === "granted") {
      setNotifEnabled(true);
      await registerFCMToken(circle.id, userName);
      new Notification("Notifications on ✅", { body: "You'll get pinged when tee times are posted." });
    }
  }

  function saveNotifPrefs(prefs) {
    setNotifPrefs(prefs);
    localStorage.setItem("teetimes_notif_prefs", JSON.stringify(prefs));
  }

  function getFriendInputs(ttId) { return friendInputs[ttId] || ["", ""]; }
  function setFriendInput(ttId, idx, val) {
    setFriendInputs(prev => ({ ...prev, [ttId]: Object.assign([...(prev[ttId] || ["", ""])], { [idx]: val }) }));
  }

  async function signUp(tt) {
    const filled = countFilledSlots(tt.signups || []);
    const friends = getFriendInputs(tt.id).map(f => f.trim()).filter(Boolean);
    if (filled + 1 + friends.length > tt.spots) {
      if ((tt.waitlist || []).find(w => w.name === userName)) return;
      const updated = teeTimes.map(t => t.id === tt.id ? { ...t, waitlist: [...(t.waitlist || []), { name: userName, at: new Date().toISOString() }] } : t);
      await updateDoc(doc(db, "circles", circle.id), { teeTimes: updated });
      onUpdateTeeTimes(updated);
      sendPushToCircle(circle.id, "⏳ Waitlist", `${userName} joined the waitlist for ${tt.course}`);
      return;
    }
    const friendSuffix = friends.length > 0 ? ` (+${friends.length} guest${friends.length > 1 ? "s" : ""})` : "";
    const updated = teeTimes.map(t => t.id === tt.id ? { ...t, signups: [...(t.signups || []), { name: userName, at: new Date().toISOString(), friends }] } : t);
    await updateDoc(doc(db, "circles", circle.id), { teeTimes: updated });
    onUpdateTeeTimes(updated);
    sendPushToCircle(circle.id, "✅ New Sign-up", `${userName}${friendSuffix} signed up for ${tt.course}`);
    setFriendInputs(prev => ({ ...prev, [tt.id]: ["", ""] }));
    setBringingFriend(prev => ({ ...prev, [tt.id]: false }));
  }

  async function withdraw(tt) {
    setBringingFriend(prev => ({ ...prev, [tt.id]: false }));
    setFriendInputs(prev => ({ ...prev, [tt.id]: ["", ""] }));
    const updated = teeTimes.map(t => {
      if (t.id !== tt.id) return t;
      const newSignups = (t.signups || []).filter(s => s.name !== userName);
      let newWaitlist = [...(t.waitlist || [])];
      if (countFilledSlots(newSignups) < t.spots && newWaitlist.length > 0) {
        const promoted = newWaitlist.shift();
        newSignups.push({ name: promoted.name, at: new Date().toISOString(), friends: [] });
        if (typeof Notification !== "undefined" && Notification.permission === "granted") {
          new Notification("You're in! ✅", { body: `A spot opened at ${t.course} — you've been moved off the waitlist.` });
        }
      }
      return { ...t, signups: newSignups, waitlist: newWaitlist };
    });
    await updateDoc(doc(db, "circles", circle.id), { teeTimes: updated });
    onUpdateTeeTimes(updated);
  }

  async function leaveWaitlist(tt) {
    const updated = teeTimes.map(t => t.id === tt.id ? { ...t, waitlist: (t.waitlist || []).filter(w => w.name !== userName) } : t);
    await updateDoc(doc(db, "circles", circle.id), { teeTimes: updated });
    onUpdateTeeTimes(updated);
  }

  const activeTimes = teeTimes.filter(tt => !tt.cancelled && !tt.upgraded);

  return (
    <div className="player-view">
      <div className="player-bar">
        <span className="player-greeting">Hey, <strong>{userName}</strong></span>
        <div className="player-bar-right">
          {!notifEnabled && <button className="btn-notif" onClick={enableNotifs}>Enable Notifications</button>}
          {notifEnabled && (
            <div className="notif-toggle-row">
              <span className="notif-for-label">Notify me for</span>
              <button className="btn-notif active" onClick={() => setShowPrefs(p => !p)}>
                {notifPrefs.weekday && notifPrefs.weekend ? "All days" : notifPrefs.weekday ? "Weekdays" : notifPrefs.weekend ? "Weekends" : "Muted"} ▾
              </button>
            </div>
          )}
        </div>
      </div>

      {showPrefs && notifEnabled && (
        <div className="prefs-panel">
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
        const mySignup = (tt.signups || []).find(s => s.name === userName);
        const myWaitlist = (tt.waitlist || []).find(w => w.name === userName);
        const myWaitlistRank = (tt.waitlist || []).findIndex(w => w.name === userName) + 1;
        const filled = countFilledSlots(tt.signups || []);
        const full = filled >= tt.spots;
        const isFirstDibs = tt.firstDibsOrder?.includes(userName);
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
                You're in!{mySignup.friends?.length > 0 ? ` · +${mySignup.friends.length} guest${mySignup.friends.length > 1 ? "s" : ""}` : ""}
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
              {(tt.signups || []).length > 0 && (
                <div className="signup-list">
                  {tt.signups.map((s) => (
                    <div key={s.name}>
                      <div className={`signup-row ${s.name === userName ? "highlight" : ""}`}>
                        <Avatar name={s.name} highlight={s.name === userName} />
                        <span className="signup-name">{s.name}</span>
                      </div>
                      {s.friends?.map(f => (
                        <div key={f} className="signup-row friend-row">
                          <div style={{ width: 30, textAlign: "center", color: "var(--ink-light)", fontSize: "0.8rem" }}>↳</div>
                          <span className="signup-name">{f} <span className="friend-tag">guest</span></span>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              )}
              {(tt.waitlist || []).length > 0 && (
                <div className="waitlist-section">
                  <div className="waitlist-label">Waitlist · {tt.waitlist.length}</div>
                  {tt.waitlist.map((w, i) => (
                    <div key={w.name} className={`signup-row ${w.name === userName ? "highlight" : ""}`}>
                      <Avatar name={w.name} highlight={w.name === userName} />
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
                        <input type="checkbox" checked={!!bringingFriend[tt.id]}
                          onChange={e => {
                            setBringingFriend(prev => ({ ...prev, [tt.id]: e.target.checked }));
                            if (!e.target.checked) setFriendInputs(prev => ({ ...prev, [tt.id]: ["", ""] }));
                          }} />
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
  const [userName, setUserName] = useState(() => localStorage.getItem("teetimes_player_name") || "");
  const [nameInput, setNameInput] = useState("");
  const [circle, setCircle] = useState(null);
  const [teeTimes, setTeeTimes] = useState([]);
  const [view, setView] = useState("admin");
  const [loading, setLoading] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [helpTab, setHelpTab] = useState("player");
  const [showCircleSettings, setShowCircleSettings] = useState(false);
  const unsubRef = useRef(null);

  useEffect(() => {
    const seen = localStorage.getItem("forecast_help_seen");
    if (!seen) { setShowHelp(true); localStorage.setItem("forecast_help_seen", "1"); }
  }, []);

  useEffect(() => {
    if (!circle) return;
    // Real-time listener on circle document
    if (unsubRef.current) unsubRef.current();
    unsubRef.current = onSnapshot(doc(db, "circles", circle.id), (snap) => {
      if (snap.exists()) {
        setTeeTimes(snap.data().teeTimes || []);
      }
    });
    return () => { if (unsubRef.current) unsubRef.current(); };
  }, [circle?.id]);

  function saveName() {
    const n = nameInput.trim();
    if (!n) return;
    localStorage.setItem("teetimes_player_name", n);
    setUserName(n);
  }

  function handleEnterCircle(c) {
    setCircle(c);
    setLoading(true);
    // Snap will fire and set teeTimes via listener
    setTimeout(() => setLoading(false), 1000);
  }

  function handleRename(newName) {
    const updated = { ...circle, name: newName };
    setCircle(updated);
    // Update local cache
    try {
      const circles = JSON.parse(localStorage.getItem(`forecast_circles_${userName}`) || "[]");
      const updatedCircles = circles.map(c => c.id === circle.id ? { ...c, name: newName } : c);
      localStorage.setItem(`forecast_circles_${userName}`, JSON.stringify(updatedCircles));
    } catch {}
  }

  // Name gate
  if (!userName) {
    return (
      <>
        <style>{CSS}</style>
        <div className="app-shell">
          <div className="app-header" style={{ padding: "10px 20px 16px" }}>
            <div className="app-title">ForeCast</div>
            <div className="app-subtitle">Group Tee Time Manager</div>
          </div>
          <div className="player-name-gate">
            <div className="gate-icon">⛳</div>
            <div className="gate-title">What's your name?</div>
            <div className="gate-sub">Your name will appear on sign-ups</div>
            <div className="gate-input-row">
              <input className="gate-input" placeholder="First name or nickname" value={nameInput}
                onChange={e => setNameInput(e.target.value)} onKeyDown={e => e.key === "Enter" && saveName()} autoFocus />
              <button className="btn-primary" onClick={saveName}>Let's Go</button>
            </div>
          </div>
        </div>
      </>
    );
  }

  // Circles gate
  if (!circle) {
    return (
      <>
        <style>{CSS}</style>
        <div className="app-shell">
          <div className="app-header" style={{ padding: "10px 20px 16px" }}>
            <div className="app-header-top">
              <div>
                <div className="app-title">ForeCast</div>
                <div className="app-subtitle">Group Tee Time Manager</div>
              </div>
              <button className="help-btn" onClick={() => setShowHelp(true)}>?</button>
            </div>
          </div>
          {showHelp && renderHelpModal(showHelp, setShowHelp, helpTab, setHelpTab)}
          <CirclesGate userName={userName} onEnterCircle={handleEnterCircle} />
        </div>
      </>
    );
  }

  return (
    <>
      <style>{CSS}</style>
      <div className="app-shell">
        <div className="app-header">
          <div className="app-header-top">
            <div>
              <div className="app-title">ForeCast</div>
              <div className="app-subtitle-row">
                <span className="app-subtitle">Group Tee Time Manager</span>
                <button className="circle-name-btn" onClick={() => setShowCircleSettings(true)}>
                  {circle.name} ✎
                </button>
              </div>
            </div>
            <button className="help-btn" onClick={() => setShowHelp(true)}>?</button>
          </div>
          <div className="view-tabs">
            <button className={`view-tab ${view === "admin" ? "active" : ""}`} onClick={() => setView("admin")}>Post</button>
            <button className={`view-tab ${view === "player" ? "active" : ""}`} onClick={() => setView("player")}>Sign Up</button>
            <button className="view-tab" onClick={() => setCircle(null)}>⭕ Circles</button>
          </div>
        </div>

        {showHelp && renderHelpModal(showHelp, setShowHelp, helpTab, setHelpTab)}
        {showCircleSettings && (
          <CircleSettings
            circle={circle} userName={userName}
            onRename={handleRename}
            onClose={() => setShowCircleSettings(false)}
          />
        )}

        {loading && <div className="loading">Loading…</div>}
        {!loading && view === "admin" && <AdminView teeTimes={teeTimes} circle={circle} userName={userName} onUpdateTeeTimes={setTeeTimes} />}
        {!loading && view === "player" && <PlayerView teeTimes={teeTimes} circle={circle} userName={userName} onUpdateTeeTimes={setTeeTimes} />}
      </div>
    </>
  );
}

// ─── HELP MODAL ───────────────────────────────────────────────────────────────
function renderHelpModal(showHelp, setShowHelp, helpTab, setHelpTab) {
  return (
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
            {[
              ["👤","Enter your name once","Your name is saved to your device — you won't need to re-enter it."],
              ["🔔","Enable notifications","Tap 'Enable Notifications' so you get pinged the moment a tee time is posted. You can choose weekdays, weekends, or both."],
              ["✅","Claim your spot","Tap 'Claim Spot' to sign up. Check 'Bringing someone?' to add up to 2 guests — they'll take up spots too."],
              ["⏳","Waitlist","If it's full, join the waitlist. You'll be automatically added and notified if someone drops out."],
              ["🕒","Respond by deadline","Each posting has a 'Respond by' date — spots lock automatically at that time. Respond before then or you'll miss out."],
              ["🚶","Walk-on times","If a posting is marked Walk-on, there's no reserved tee time — you're showing up and hoping for a spot on the course."],
              ["⭕","Circles","ForeCast uses Circles to keep groups separate. You'll need a join code from someone in your group to see their tee times. Tap the Circles tab above to learn more."],
            ].map(([icon, title, desc]) => (
              <div className="help-item" key={title}>
                <div className="help-icon">{icon}</div>
                <div><div className="help-item-title">{title}</div><div className="help-item-desc">{desc}</div></div>
              </div>
            ))}
          </div>
        )}
        {helpTab === "admin" && (
          <div className="help-content">
            {[
              ["📋","Post a tee time","Use the Post tab to post. Step 1 is course, date and time. Step 2 is spots, walk-on toggle, and notes. Hit 'Post + Notify' to send it out."],
              ["⛳","Save your courses","Type a course and hit '+ Save' to store it as a chip. Tap it next time to fill the field instantly."],
              ["🔔","Sign-up notifications","You'll get a push notification whenever someone claims a spot or joins the waitlist."],
              ["⬆️","Found a better time?","Tap 'Update Time' on a posting to replace it with a new one. Everyone who signed up gets notified and has first dibs on the new time."],
              ["🔒","Lock or cancel","'Lock' closes signups immediately. 'Cancel' removes the posting entirely. Spots also lock automatically at the respond-by deadline."],
              ["🕒","Auto deadline","The respond-by time is automatically set to 3:00 PM two days before the tee time. No need to set it manually."],
              ["⭕","Circles","Tee times are posted within a Circle so only your group sees them. Any member of a Circle can post a time."],
            ].map(([icon, title, desc]) => (
              <div className="help-item" key={title}>
                <div className="help-icon">{icon}</div>
                <div><div className="help-item-title">{title}</div><div className="help-item-desc">{desc}</div></div>
              </div>
            ))}
          </div>
        )}
        {helpTab === "circles" && (
          <div className="help-content">
            {[
              ["⭕","What is a Circle?","A Circle is your private group. Only members of a Circle can see its tee times and get notified. You can be in multiple Circles at once."],
              ["✏️","Creating a Circle","Pick a unique name for your Circle (e.g. 'Saturday Crew'). You can edit the name later — no two Circles can share the same name."],
              ["🔑","Your join code","When you create a Circle, you get a short code like FORE-4821. Share this with anyone you want to invite. The code stays the same even if you rename the Circle."],
              ["📨","Joining a Circle","Got a code from a friend? Enter it to join their Circle. You'll instantly see their tee times and start receiving notifications."],
              ["📣","Anyone can post","Any member of a Circle can post a tee time. When they do, everyone else in that Circle gets notified — not people in other Circles."],
              ["👥","Multiple Circles","You can create or join as many Circles as you like — for example, your regular Saturday group and a separate work colleagues group."],
            ].map(([icon, title, desc]) => (
              <div className="help-item" key={title}>
                <div className="help-icon">{icon}</div>
                <div><div className="help-item-title">{title}</div><div className="help-item-desc">{desc}</div></div>
              </div>
            ))}
          </div>
        )}
        <button className="btn-primary" style={{ marginTop: 8 }} onClick={() => setShowHelp(false)}>Got it</button>
        <div className="help-feedback">
          <a href="mailto:wpak35@gmail.com?subject=ForeCast Feedback" className="help-feedback-link">🐛 Report a bug or suggest a feature</a>
        </div>
      </div>
    </div>
  );
}

// ─── CSS ──────────────────────────────────────────────────────────────────────
const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700;900&family=DM+Sans:wght@300;400;500;600&display=swap');
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --green: #1a5c2a; --green-mid: #2d7a3e; --green-light: #4caf6a;
    --fairway: #e8f4e0; --ink: #0f1a10; --ink-mid: #3a4a3c; --ink-light: #8a9a84;
    --danger: #b71c1c; --amber: #e65100; --teal: #00695c;
    --walkon: #6d4c41; --radius: 16px;
    --shadow: 0 1px 12px rgba(15,26,16,0.08), 0 4px 24px rgba(15,26,16,0.06);
  }
  body {
    font-family: 'DM Sans', sans-serif; background: var(--fairway);
    background-image: url("data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%23c8dfc0' fill-opacity='0.35'%3E%3Cpath d='M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z'/%3E%3C/g%3E%3C%2Fg%3E%3C/svg%3E");
    color: var(--ink); min-height: 100vh;
  }
  .app-shell { max-width: 480px; margin: 0 auto; padding: 0 0 80px; }
  .app-header { background: var(--green); color: white; padding: 10px 20px 16px; position: sticky; top: 0; z-index: 50; }
  .app-header-top { display: flex; align-items: flex-start; justify-content: space-between; }
  .app-title { font-family: 'Playfair Display', serif; font-size: 2rem; line-height: 1; }
  .app-subtitle { font-size: 0.72rem; opacity: 0.6; letter-spacing: 1.5px; text-transform: uppercase; margin-top: 3px; }
  .app-subtitle-row { display: flex; align-items: center; gap: 10px; margin-top: 3px; }
  .circle-name-btn { background: rgba(255,255,255,0.15); border: 1px solid rgba(255,255,255,0.3); color: white; font-size: 0.75rem; font-weight: 600; padding: 3px 8px; border-radius: 6px; cursor: pointer; font-family: 'DM Sans', sans-serif; }
  .circle-name-btn:hover { background: rgba(255,255,255,0.25); }
  .view-tabs { display: flex; background: rgba(255,255,255,0.1); border-radius: 10px; margin-top: 12px; padding: 3px; gap: 2px; }
  .view-tab { flex: 1; padding: 8px; border: none; background: transparent; color: rgba(255,255,255,0.65); border-radius: 8px; font-family: 'DM Sans', sans-serif; font-size: 0.82rem; font-weight: 500; cursor: pointer; transition: all 0.15s; }
  .view-tab.active { background: white; color: var(--green); font-weight: 600; }
  .help-btn { width: 28px; height: 28px; border-radius: 50%; background: rgba(255,255,255,0.2); border: 1.5px solid rgba(255,255,255,0.35); color: white; font-size: 0.85rem; font-weight: 700; cursor: pointer; display: flex; align-items: center; justify-content: center; flex-shrink: 0; margin-top: 4px; font-family: 'DM Sans', sans-serif; }

  /* Name gate */
  .player-name-gate { display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 70vh; gap: 10px; padding: 24px; }
  .gate-icon { font-size: 3rem; }
  .gate-title { font-family: 'Playfair Display', serif; font-size: 1.8rem; color: var(--green); }
  .gate-sub { color: var(--ink-light); font-size: 0.88rem; margin-bottom: 4px; }
  .gate-input-row { display: flex; gap: 10px; width: 100%; }
  .gate-input { flex: 1; padding: 13px 16px; border: 1.5px solid #c8dfc0; border-radius: 12px; font-family: 'DM Sans', sans-serif; font-size: 1rem; background: white; outline: none; transition: border 0.15s; color: #0f1a10 !important; -webkit-text-fill-color: #0f1a10 !important; }
  .gate-input:focus { border-color: var(--green); }

  /* Circles gate */
  .circles-gate { display: flex; flex-direction: column; align-items: center; padding: 32px 24px; gap: 12px; }
  .circles-gate-icon { font-size: 3rem; }
  .circles-gate-title { font-family: 'Playfair Display', serif; font-size: 1.8rem; color: var(--green); }
  .circles-gate-sub { color: var(--ink-light); font-size: 0.88rem; margin-bottom: 8px; }
  .my-circles-list { width: 100%; display: flex; flex-direction: column; gap: 8px; margin-bottom: 8px; }
  .my-circle-btn { width: 100%; background: white; border: 1.5px solid #c8dfc0; border-radius: 12px; padding: 14px 16px; cursor: pointer; text-align: left; box-shadow: var(--shadow); transition: all 0.15s; display: flex; align-items: center; justify-content: space-between; }
  .my-circle-btn:hover { border-color: var(--green); background: #f4fbf6; }
  .my-circle-name { font-size: 1rem; font-weight: 600; color: var(--ink); }
  .my-circle-code { font-size: 0.78rem; color: var(--ink-light); font-weight: 500; }
  .circles-actions { width: 100%; display: flex; flex-direction: column; gap: 8px; }
  .circles-form { width: 100%; display: flex; flex-direction: column; gap: 10px; background: white; border-radius: 14px; padding: 18px; box-shadow: var(--shadow); }
  .circles-form-title { font-size: 0.95rem; font-weight: 600; color: var(--ink); }
  .circles-form-actions { display: flex; gap: 8px; }
  .circles-form-actions .btn-primary { flex: 2; }
  .circles-form-actions .btn-ghost { flex: 1; }
  .circles-error { font-size: 0.82rem; color: var(--danger); font-weight: 500; }
  .circles-success { font-size: 0.82rem; color: var(--green); font-weight: 500; }
  .fore-input-row { display: flex; align-items: center; border: 1.5px solid #d8e4d0; border-radius: 10px; overflow: hidden; background: #fafcf8; }
  .fore-prefix { padding: 10px 4px 10px 13px; font-family: 'DM Sans', sans-serif; font-size: 0.95rem; font-weight: 700; color: var(--green); white-space: nowrap; background: #fafcf8; }
  .fore-input-row input { border: none !important; border-radius: 0 !important; background: transparent !important; padding-left: 4px !important; flex: 1; min-width: 0; }

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
  .dibs-banner { font-size: 0.82rem; font-weight: 500; color: #5d4037; background: #fff8e1; border-radius: 8px; padding: 7px 12px; margin: 4px 18px 8px; }
  .dibs-banner.mine { background: #e8f5e9; color: var(--green); }
  .my-spot-banner { background: var(--green); color: white; font-size: 0.92rem; font-weight: 600; padding: 8px 18px; }
  .waitlist-banner { background: #fff3e0; color: var(--amber); font-size: 0.92rem; font-weight: 600; padding: 8px 18px; }
  .tee-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; margin-bottom: 6px; }
  .tee-course { font-family: 'Playfair Display', serif; font-size: 1.5rem; color: var(--green); line-height: 1.1; }
  .tee-datetime { font-size: 0.95rem; color: var(--ink-mid); font-weight: 500; margin-top: 2px; }
  .tee-notes { font-size: 0.88rem; color: var(--ink-light); font-style: italic; margin-bottom: 10px; }
  .status-pill { font-size: 0.68rem; font-weight: 700; letter-spacing: 0.8px; text-transform: uppercase; padding: 4px 10px; border-radius: 20px; white-space: nowrap; flex-shrink: 0; margin-top: 3px; }
  .status-pill.open { background: #e8f5e0; color: var(--green); }
  .status-pill.locked { background: #f5f5f5; color: #757575; }
  .status-pill.cancelled { background: #fdecea; color: var(--danger); }
  .status-pill.upgraded { background: #e0f2f1; color: var(--teal); }
  .capacity-row { display: flex; align-items: center; gap: 10px; margin: 12px 0 8px; }
  .capacity-bar { flex: 1; height: 8px; background: #e8f0e4; border-radius: 4px; overflow: hidden; }
  .capacity-fill { height: 100%; background: linear-gradient(90deg, var(--green-light), var(--green)); border-radius: 4px; transition: width 0.4s ease; }
  .capacity-count { font-size: 0.88rem; color: var(--ink-light); font-weight: 600; white-space: nowrap; }
  .capacity-count strong { color: var(--green); }
  .signup-list { display: flex; flex-direction: column; gap: 2px; margin: 4px 0 10px; }
  .signup-row { display: flex; align-items: center; gap: 10px; padding: 6px 0; border-bottom: 1px solid #f5f5f5; }
  .signup-row.highlight { background: #f0faf2; border-radius: 8px; padding: 6px 8px; margin: 0 -8px; border-bottom: none; }
  .signup-row.friend-row { padding-left: 10px; opacity: 0.75; }
  .signup-name { flex: 1; font-size: 0.95rem; font-weight: 500; }
  .signup-time { font-size: 0.8rem; color: var(--ink-light); }
  .friend-tag { font-size: 0.68rem; background: #e8f5e0; color: var(--green); border-radius: 4px; padding: 1px 5px; margin-left: 4px; font-weight: 600; }
  .waitlist-section { margin: 4px 0 10px; background: #fffde7; border-radius: 8px; padding: 8px 12px; }
  .waitlist-label { font-size: 0.75rem; font-weight: 700; color: var(--amber); letter-spacing: 0.5px; text-transform: uppercase; margin-bottom: 6px; }
  .respond-by-row { display: flex; align-items: center; justify-content: space-between; background: #f7faf5; padding: 8px 12px; margin-top: 4px; border-radius: 8px; }
  .respond-by-label { font-size: 0.82rem; color: var(--ink-light); font-weight: 500; text-transform: uppercase; letter-spacing: 0.5px; }
  .respond-by-date { font-size: 1rem; font-weight: 600; color: var(--ink-mid); }

  /* Buttons */
  .btn-primary { width: 100%; padding: 14px; background: var(--green); color: white; border: none; border-radius: 12px; font-family: 'DM Sans', sans-serif; font-size: 0.95rem; font-weight: 600; cursor: pointer; transition: background 0.15s; }
  .btn-primary:hover { background: var(--green-mid); }
  .btn-primary:disabled { opacity: 0.45; cursor: not-allowed; }
  .btn-primary.btn-disabled { opacity: 0.4; cursor: not-allowed; }
  .btn-withdraw { width: 100%; padding: 12px; background: transparent; color: var(--danger); border: 1.5px solid #ffcdd2; border-radius: 12px; font-family: 'DM Sans', sans-serif; font-size: 0.92rem; font-weight: 600; cursor: pointer; }
  .btn-withdraw:hover { background: #fdecea; }
  .btn-ghost { padding: 10px 16px; background: transparent; color: var(--ink-mid); border: 1.5px solid #d8e4d0; border-radius: 10px; font-family: 'DM Sans', sans-serif; font-size: 0.92rem; cursor: pointer; }
  .btn-ghost:hover { background: #f0f4ec; }
  .btn-sm { padding: 7px 14px; border-radius: 8px; font-family: 'DM Sans', sans-serif; font-size: 0.82rem; font-weight: 600; cursor: pointer; border: none; }
  .btn-danger { background: #fdecea; color: var(--danger); }
  .btn-upgrade { background: #e0f2f1; color: var(--teal); }
  .admin-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
  .player-actions { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; }

  /* Post form */
  .post-card { margin: 12px 16px; padding: 20px; background: white; border-radius: var(--radius); box-shadow: var(--shadow); }
  .card-label { font-family: 'Playfair Display', serif; font-size: 1.15rem; color: var(--green); margin-bottom: 16px; }
  .steps { display: flex; align-items: center; margin-bottom: 18px; }
  .step { display: flex; align-items: center; gap: 6px; font-size: 0.82rem; font-weight: 500; color: var(--ink-light); }
  .step.active { color: var(--green); font-weight: 600; }
  .step-dot { width: 22px; height: 22px; border-radius: 50%; background: #e8f0e4; color: var(--ink-light); font-size: 0.7rem; font-weight: 700; display: flex; align-items: center; justify-content: center; }
  .step.active .step-dot { background: var(--green); color: white; }
  .step-line { flex: 1; height: 1px; background: #e0e8d8; margin: 0 8px; }
  .step2-summary { grid-column: 1 / -1; display: flex; align-items: center; gap: 10px; background: #f5f9f3; border: 1.5px solid #c8dfc0; border-radius: 10px; padding: 10px 14px; margin-bottom: 4px; }
  .step2-course { font-weight: 700; font-size: 0.95rem; color: var(--green); flex: 1; }
  .step2-dt { font-size: 0.82rem; color: var(--ink-light); }
  .step2-edit { background: none; border: none; color: var(--green); font-size: 0.78rem; font-weight: 600; cursor: pointer; text-decoration: underline; font-family: 'DM Sans', sans-serif; }
  .form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .field { display: flex; flex-direction: column; gap: 5px; }
  .field.full, .field.walkon-field { grid-column: 1 / -1; }
  label { font-size: 0.75rem; font-weight: 600; color: var(--ink-light); letter-spacing: 0.3px; }
  .optional { font-weight: 400; opacity: 0.7; }
  input, input[type="text"], input[type="number"], input[type="date"], input[type="time"] {
    padding: 10px 13px; border: 1.5px solid #d8e4d0; border-radius: 10px;
    font-family: 'DM Sans', sans-serif; font-size: 0.95rem; background: #fafcf8 !important;
    outline: none; transition: border 0.15s; color: #0f1a10 !important; -webkit-text-fill-color: #0f1a10 !important;
  }
  input:focus { border-color: var(--green); background: white !important; }
  input:-webkit-autofill, input:-webkit-autofill:hover, input:-webkit-autofill:focus, input:-webkit-autofill:active {
    -webkit-text-fill-color: #0f1a10 !important;
    -webkit-box-shadow: 0 0 0px 1000px #fafcf8 inset !important;
    transition: background-color 5000s ease-in-out 0s;
  }
  .walkon-toggle { display: flex; align-items: center; gap: 10px; cursor: pointer; padding: 10px 13px; background: #fafcf8; border: 1.5px solid #d8e4d0; border-radius: 10px; transition: all 0.2s; user-select: none; }
  .walkon-toggle.on { background: #efebe9; border-color: #bcaaa4; }
  .walkon-knob { width: 36px; height: 20px; background: #ccc; border-radius: 10px; position: relative; flex-shrink: 0; transition: background 0.2s; }
  .walkon-toggle.on .walkon-knob { background: var(--walkon); }
  .walkon-knob::after { content: ''; position: absolute; width: 14px; height: 14px; background: white; border-radius: 50%; top: 3px; left: 3px; transition: left 0.2s; }
  .walkon-toggle.on .walkon-knob::after { left: 19px; }
  .walkon-label { font-size: 0.88rem; color: var(--ink-mid); font-weight: 500; }
  .deadline-preview { padding: 10px 13px; background: #f0faf2; border: 1.5px solid #a5d6a7; border-radius: 10px; font-size: 0.92rem; color: var(--green); font-weight: 500; }
  .course-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
  .course-chip { display: flex; align-items: center; gap: 4px; padding: 5px 10px 5px 12px; background: #f0f4ec; border: 1.5px solid #c8dfc0; border-radius: 20px; font-size: 0.85rem; font-weight: 500; color: var(--ink-mid); cursor: pointer; transition: all 0.15s; }
  .course-chip.active { background: var(--green); border-color: var(--green); color: white; }
  .course-chip.active .chip-remove { color: rgba(255,255,255,0.8); }
  .chip-remove { background: none; border: none; cursor: pointer; font-size: 1rem; color: var(--ink-light); padding: 0 0 0 2px; line-height: 1; }
  .course-input-row { display: flex; gap: 8px; align-items: center; }
  .course-input-row input { flex: 1; }
  .btn-save-course { white-space: nowrap; padding: 10px 12px; background: #e8f5e0; color: var(--green); border: 1.5px solid #a5d6a7; border-radius: 10px; font-family: 'DM Sans', sans-serif; font-size: 0.82rem; font-weight: 700; cursor: pointer; }

  /* Player bar */
  .player-bar { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; background: rgba(255,255,255,0.7); backdrop-filter: blur(4px); border-bottom: 1px solid #dcebd4; }
  .player-greeting { font-size: 1rem; color: var(--ink-mid); }
  .player-greeting strong { color: var(--green); }
  .player-bar-right { display: flex; align-items: center; gap: 8px; }
  .notif-toggle-row { display: flex; align-items: center; gap: 6px; }
  .notif-for-label { font-size: 0.78rem; color: rgba(255,255,255,0.75); font-weight: 500; white-space: nowrap; }
  .btn-notif { padding: 7px 13px; background: #fff8e1; color: #795548; border: 1px solid #ffe082; border-radius: 8px; font-family: 'DM Sans', sans-serif; font-size: 0.85rem; font-weight: 600; cursor: pointer; }
  .btn-notif.active { background: #e8f5e9; color: var(--green); border-color: #a5d6a7; }
  .prefs-panel { background: white; border-bottom: 1px solid #dcebd4; padding: 12px 16px; }
  .prefs-options { display: flex; gap: 20px; }
  .pref-option { display: flex; align-items: center; gap: 10px; font-size: 0.95rem; font-weight: 500; color: var(--ink-mid); cursor: pointer; user-select: none; }
  .pref-option input[type="checkbox"] { width: 22px; height: 22px; cursor: pointer; appearance: none; -webkit-appearance: none; border: 2.5px solid var(--green); border-radius: 5px; background: white; position: relative; flex-shrink: 0; transition: background 0.15s; }
  .pref-option input[type="checkbox"]:checked { background: var(--green); border-color: var(--green); }
  .pref-option input[type="checkbox"]:checked::after { content: ''; position: absolute; left: 6px; top: 2px; width: 6px; height: 11px; border: 2.5px solid white; border-top: none; border-left: none; transform: rotate(45deg); }
  .bringing-toggle { display: flex; align-items: center; gap: 10px; font-size: 0.95rem; font-weight: 500; color: var(--ink-mid); cursor: pointer; padding: 2px 0; user-select: none; }
  .bringing-toggle input[type="checkbox"] { width: 22px; height: 22px; cursor: pointer; appearance: none; -webkit-appearance: none; border: 2.5px solid var(--green); border-radius: 5px; background: white; position: relative; flex-shrink: 0; transition: background 0.15s; }
  .bringing-toggle input[type="checkbox"]:checked { background: var(--green); border-color: var(--green); }
  .bringing-toggle input[type="checkbox"]:checked::after { content: ''; position: absolute; left: 6px; top: 2px; width: 6px; height: 11px; border: 2.5px solid white; border-top: none; border-left: none; transform: rotate(45deg); }
  .friend-section { display: flex; flex-direction: column; gap: 6px; background: #f5f9f3; border: 1.5px solid #c8dfc0; border-radius: 12px; padding: 12px; }
  .friend-input { padding: 9px 12px; border: 1.5px solid #d8e4d0; border-radius: 9px; font-family: 'DM Sans', sans-serif; font-size: 0.92rem; background: white; outline: none; color: #0f1a10 !important; -webkit-text-fill-color: #0f1a10 !important; }
  .friend-input:focus { border-color: var(--green); }

  /* Modal */
  .modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.45); z-index: 100; display: flex; align-items: flex-end; }
  .modal { background: white; border-radius: 20px 20px 0 0; padding: 24px 20px 40px; width: 100%; max-height: 88vh; overflow-y: auto; }
  .modal-title { font-family: 'Playfair Display', serif; font-size: 1.3rem; color: var(--teal); margin-bottom: 6px; }
  .modal-sub { font-size: 0.88rem; color: var(--ink-light); margin-bottom: 14px; }
  .dibs-list { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 16px; }
  .dibs-chip { background: #e8f5e9; color: var(--green); border-radius: 20px; padding: 4px 12px; font-size: 0.82rem; font-weight: 500; display: flex; align-items: center; gap: 4px; }
  .dibs-rank { font-size: 0.7rem; opacity: 0.7; }
  .modal-actions { display: flex; gap: 10px; margin-top: 16px; }
  .modal-actions .btn-primary { flex: 2; }
  .modal-actions .btn-ghost { flex: 1; }

  /* Help modal */
  .help-modal { padding: 0 0 24px; }
  .help-header { display: flex; align-items: center; justify-content: space-between; padding: 20px 20px 0; margin-bottom: 16px; }
  .help-title { font-family: 'Playfair Display', serif; font-size: 1.3rem; color: var(--green); }
  .help-close { background: none; border: none; font-size: 1rem; color: var(--ink-light); cursor: pointer; padding: 4px; }
  .help-tabs { display: flex; margin: 0 20px 16px; background: #f0f4ec; border-radius: 10px; padding: 3px; gap: 2px; }
  .help-tab { flex: 1; padding: 8px; border: none; background: transparent; border-radius: 8px; font-family: 'DM Sans', sans-serif; font-size: 0.85rem; font-weight: 500; color: var(--ink-light); cursor: pointer; transition: all 0.15s; }
  .help-tab.active { background: white; color: var(--green); font-weight: 600; box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
  .help-content { display: flex; flex-direction: column; margin: 0 20px; }
  .help-item { display: flex; gap: 14px; align-items: flex-start; padding: 12px 0; border-bottom: 1px solid #f0f4ec; }
  .help-item:last-child { border-bottom: none; }
  .help-icon { font-size: 1.3rem; flex-shrink: 0; margin-top: 1px; }
  .help-item-title { font-size: 0.95rem; font-weight: 600; color: var(--ink); margin-bottom: 2px; }
  .help-item-desc { font-size: 0.85rem; color: var(--ink-light); line-height: 1.5; }
  .help-modal .btn-primary { margin: 8px 20px 0; width: calc(100% - 40px); }
  .help-feedback { text-align: center; padding: 12px 20px 4px; }
  .help-feedback-link { font-size: 0.88rem; color: var(--ink-light); text-decoration: none; font-weight: 500; }

  /* Misc */
  .section-header { font-family: 'DM Sans', sans-serif; font-size: 0.75rem; font-weight: 700; letter-spacing: 1.5px; text-transform: uppercase; color: var(--ink-light); padding: 16px 20px 4px; }
  .locked-msg { font-size: 0.88rem; color: #9e9e9e; padding: 10px 0; text-align: center; }
  .empty { text-align: center; color: var(--ink-light); font-size: 0.92rem; padding: 28px; }
  .empty-state { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 64px 24px; text-align: center; }
  .empty-icon { font-size: 2.8rem; }
  .empty-msg { font-family: 'Playfair Display', serif; font-size: 1.3rem; color: var(--green); }
  .empty-sub { font-size: 0.88rem; color: var(--ink-light); max-width: 220px; line-height: 1.5; }
  .loading { display: flex; align-items: center; justify-content: center; height: 60vh; color: var(--ink-light); font-family: 'DM Sans', sans-serif; font-size: 0.95rem; }

  /* Choose screen (fallback) */
  .choose-screen { display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 80vh; gap: 14px; padding: 24px; }
`;
