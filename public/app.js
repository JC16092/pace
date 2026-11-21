/* ══════════════════════════════════════════════════════════════
   Pace — one number a day.
   Vanilla ES modules + Firebase v10. No build step.
   ══════════════════════════════════════════════════════════════ */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  initializeAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged,
  indexedDBLocalPersistence, browserLocalPersistence, browserPopupRedirectResolver
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  getFirestore, collection, doc, onSnapshot, setDoc, addDoc, updateDoc, deleteDoc
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { firebaseConfig, OWNER_EMAIL } from "./firebase-config.js";

/* ─────────── firebase ─────────── */
const fbApp = initializeApp(firebaseConfig);
const auth = initializeAuth(fbApp, {
  persistence: [indexedDBLocalPersistence, browserLocalPersistence],
  popupRedirectResolver: browserPopupRedirectResolver
});
const db = getFirestore(fbApp);

/* ─────────── constants ─────────── */
const CATS = {
  rent:      { label: "Rent",          icon: "🏠", color: "#8E7CC3" },
  loan:      { label: "Loan / debt",   icon: "🏦", color: "#C97B7B" },
  groceries: { label: "Groceries",     icon: "🥬", color: "#6FA86B" },
  transport: { label: "Transport",     icon: "🚆", color: "#6E9BC5" },
  bills:     { label: "Phone & bills", icon: "💡", color: "#C9A227" },
  eating:    { label: "Eating out",    icon: "🍜", color: "#D08A5D" },
  education: { label: "Education",     icon: "📚", color: "#5D8FA8" },
  health:    { label: "Health",        icon: "🩺", color: "#7FB3A3" },
  fun:       { label: "Fun",           icon: "🎧", color: "#B07CC6" },
  other:     { label: "Other",         icon: "•",  color: "#9A9087" }
};
const CAT_KEYS = Object.keys(CATS);

const CONSEQ = {
  essential: { label: "Can't miss",     rank: 0, cls: "c-ess" },
  credit:    { label: "Credit score",   rank: 1, cls: "c-cred" },
  interest:  { label: "Interest grows", rank: 2, cls: "c-int" },
  fee:       { label: "Late fee",       rank: 3, cls: "c-fee" },
  none:      { label: "No penalty",     rank: 4, cls: "c-none" }
};
const conseqOf = (g) => CONSEQ[g.consequence] ? g.consequence : null;

const QUOTES = [
  "Small and boring beats big and never.",
  "You are not behind. You are part-way.",
  "The number only looks big before you divide it.",
  "One shift at a time is the entire strategy.",
  "You don't have to feel ready to do the next hour.",
  "Today's number is the only one that's real.",
  "Money arrives the same way it always has — slowly, then it's there.",
  "A missed day is arithmetic, not a verdict.",
  "You've already done harder things than this week.",
  "Progress you can't feel is still progress.",
  "The deadline is far. The next hour is close. Work on the close one.",
  "Nothing about today's number requires you to panic about the total.",
  "Rest is part of the plan, not a break from it.",
  "You only ever have to earn today's share."
];

const DEFAULT_PROFILE = {
  currency: "AUD",
  startingBalance: 0,
  defaultRate: 30,
  workDaysPerWeek: 5,
  capEnabled: true,
  capHours: 48,
  capPeriod: "fortnight",
  onBreak: false,
  setupDone: false
};

const BUILD = "2026-09-22 · v12 weekly bills";

/* ─────────── state ─────────── */
const state = {
  user: null,
  profile: { ...DEFAULT_PROFILE },
  goals: [], shifts: [], income: [], expenses: [], recurring: [],
  restDays: new Set(),
  snapshots: {},
  tab: "today",
  capOpen: false,
  openGoal: null,
  logFilter: "all",
  logMonth: null,          // "YYYY-MM"
  ready: new Set(),
  bigAnimated: false
};

/* ─────────── tiny helpers ─────────── */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const sum = (arr, f) => arr.reduce((t, x) => t + (Number(f(x)) || 0), 0);
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

function localISO(d = new Date()) {
  const z = new Date(d.getTime() - d.getTimezoneOffset() * 6e4);
  return z.toISOString().slice(0, 10);
}
function parseISO(s) { const [y, m, d] = String(s).split("-").map(Number); return new Date(y, m - 1, d); }
const TODAY = () => localISO();
function daysBetween(aISO, bISO) { return Math.round((parseISO(bISO) - parseISO(aISO)) / 864e5); }
function addDays(iso, n) { const d = parseISO(iso); d.setDate(d.getDate() + n); return localISO(d); }
function monthOf(iso) { return String(iso).slice(0, 7); }

const WD_LONG  = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
const WD_SHORT = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const WD_ORDER = [1, 2, 3, 4, 5, 6, 0];   // Monday-first for pickers

/** Next date on/after `fromISO` that falls on weekday `wd` (0=Sun). */
function nextWeekday(fromISO, wd) {
  const gap = (wd - parseISO(fromISO).getDay() + 7) % 7;
  return addDays(fromISO, gap);
}

/** How a repeating bill reads in plain English. */
function recSchedule(r) {
  const freq = r.freq || "monthly";
  if (freq === "weekly")      return `every ${WD_LONG[Number(r.weekday ?? 1)]}`;
  if (freq === "fortnightly") return `every 2nd ${WD_LONG[Number(r.weekday ?? 1)]}`;
  return `day ${r.dayOfMonth || 1} each month`;
}

/** The day this bill first counts from. */
function recStart(r) {
  if (r.since && String(r.since).length === 10) return r.since;
  if (r.createdAt) return localISO(new Date(r.createdAt));
  return TODAY();
}

/** Every weekly / fortnightly due date in [fromISO, toISO]. */
function recOccurrences(r, fromISO, toISO) {
  const out = [], freq = r.freq || "monthly";
  if (freq === "monthly" || fromISO > toISO) return out;
  const wd = Number(r.weekday ?? 1);
  const anchorISO = r.anchor && String(r.anchor).length === 10 ? r.anchor : null;
  let d = nextWeekday(fromISO, wd), guard = 0;
  while (d <= toISO && guard++ < 200) {
    if (freq === "weekly") out.push(d);
    else if (!anchorISO) out.push(d);
    else if (d >= anchorISO && daysBetween(anchorISO, d) % 14 === 0) out.push(d);
    d = addDays(d, 7);
  }
  return out;
}

function fmt(n, cents = false) {
  const v = Number(n) || 0;
  const neg = v < 0;
  const s = Math.abs(v).toLocaleString("en-AU", {
    minimumFractionDigits: cents ? 2 : 0,
    maximumFractionDigits: cents ? 2 : 0
  });
  return (neg ? "−$" : "$") + s;
}
function hrs(h) {
  const v = Math.max(0, Number(h) || 0);
  if (v === 0) return "0 m";
  const H = Math.floor(v), M = Math.round((v - H) * 60);
  if (M === 60) return `${H + 1} h`;
  if (H === 0) return `${M} m`;
  return M ? `${H} h ${M} m` : `${H} h`;
}
function niceDate(iso) {
  const d = parseISO(iso), t = TODAY();
  if (iso === t) return "Today";
  if (iso === addDays(t, -1)) return "Yesterday";
  const opts = { weekday: "short", day: "numeric", month: "short" };
  if (monthOf(iso).slice(0, 4) !== t.slice(0, 4)) opts.year = "numeric";
  return d.toLocaleDateString("en-AU", opts);
}
function niceDue(iso) {
  return parseISO(iso).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
}

function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("show"), 2600);
}

/* ══════════════════════════════════════════════════════════════
   THE ENGINE
   Everything the app says comes out of this one function.
   ══════════════════════════════════════════════════════════════ */

/** Working days between today and `dueISO`, given how many days a week you work. */
function workingDaysUntil(dueISO, wdpw) {
  const cal = daysBetween(TODAY(), dueISO);
  if (cal <= 0) return 0;
  return Math.max(1, Math.round(cal * wdpw / 7));
}

/** Goal priority, defaulting anything unset to "normal". */
const prioOf = (g) => (g.priority === "urgent" || g.priority === "later") ? g.priority : "normal";
const PRIO_RANK = { urgent: 0, normal: 1, later: 2 };

/**
 * @param {number} poolDelta  pretend the pool is this much bigger/smaller
 *                            (used by the purchase simulator)
 * @param {{id:string, priority:string}|null} override
 *                            pretend one goal has a different priority
 *                            (used to preview what changing it would do)
 */
function compute(poolDelta = 0, override = null) {
  const p = state.profile;
  const wdpw = clamp(Number(p.workDaysPerWeek) || 5, 1, 7);
  const today = TODAY();

  /* — what you've actually got — */
  const earnedShifts = sum(state.shifts, s => s.gross);
  const earnedOther = sum(state.income, i => i.amount);
  const spent = sum(state.expenses, e => e.amount);
  const pool = (Number(p.startingBalance) || 0) + earnedShifts + earnedOther - spent + poolDelta;

  /* — your real hourly rate, learned from logged shifts — */
  const tH = sum(state.shifts, s => s.hours);
  const avgRate = tH > 0 ? (earnedShifts / tH) : (Number(p.defaultRate) || 30);
  const recent = state.shifts.slice(-20);
  const avgShiftHours = recent.length ? (sum(recent, s => s.hours) / recent.length) : 6;

  /* — your usual daily spending, last 30 days —
       goal payoffs are excluded: they leave your balance, but they aren't daily life. */
  const from30 = addDays(today, -30);
  const spend30 = sum(
    state.expenses.filter(e => e.date > from30 && e.date <= today && !e.goalId),
    e => e.amount
  );
  // A stated weekly figure beats inferring it from receipts you'll never log.
  const weeklySpend = Number(p.weeklySpend) || 0;
  const avgDailySpend = weeklySpend > 0 ? weeklySpend / 7 : spend30 / 30;

  /* — money already paid toward each goal (any expense carrying its goalId) — */
  const paidFor = {};
  for (const e of state.expenses) {
    if (e.goalId) paidFor[e.goalId] = (paidFor[e.goalId] || 0) + (Number(e.amount) || 0);
  }

  /* — fund goals: urgent first, then normal, then shelved — each group by date — */
  const live = state.goals.filter(g => g.active !== false).map(g => {
    const amount = Number(g.amount) || 0;
    const paid = paidFor[g.id] || 0;
    const outstanding = Math.max(0, amount - paid);
    const minAmt = Number(g.minimum) || 0;
    return {
      ...g,
      _paid: paid,
      _outstanding: outstanding,
      // only this much is actually bound to the deadline; the rest is balance
      _dueNow: g.minMetOn === g.due ? 0 : (minAmt > 0 ? Math.min(minAmt, outstanding) : outstanding),
      _hasMin: minAmt > 0 && minAmt < amount,
      _cleared: !!g.completed || outstanding <= 0.005
    };
  });
  const completed = live.filter(g => g._cleared);
  const goals = live
    .filter(g => !g._cleared && !(override && override.id === g.id && override.exclude))
    .map(g => ({
      ...g,
      _prio: (override && override.id === g.id && override.priority) ? override.priority : prioOf(g)
    }))
    .sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : 0));

  const fundOrder = goals.slice()
    .sort((a, b) => (PRIO_RANK[a._prio] - PRIO_RANK[b._prio]) || (a.due < b.due ? -1 : a.due > b.due ? 1 : 0));

  // pass 1 — cover what's actually due by its date; pass 2 — chip at the balances
  let left = Math.max(0, pool);
  for (const g of fundOrder) {
    g._fundedDue = Math.min(left, g._dueNow);
    left -= g._fundedDue;
  }
  for (const g of fundOrder) {
    const rest = Math.max(0, g._outstanding - g._dueNow);
    g._fundedExtra = Math.min(left, rest);
    left -= g._fundedExtra;

    g._funded = g._fundedDue + g._fundedExtra;
    g._needByDue = Math.max(0, g._dueNow - g._fundedDue);
    g._remaining = Math.max(0, g._outstanding - g._funded);
    g._wd = workingDaysUntil(g.due, wdpw);
    g._pct = g.amount > 0 ? clamp((g._paid + g._funded) / g.amount, 0, 1) : 1;
    g._solo = g._wd > 0 ? g._needByDue / g._wd : g._needByDue;
    g._overdue = daysBetween(today, g.due) < 0 && g._needByDue > 0;
    g._done = g._remaining <= 0.005;
    g._shelved = g._prio === "later";
  }
  const surplus = left;

  /* — critical path: the daily rate that satisfies EVERY deadline —
       for each goal, everything due by then must be covered by then.  */
  const paced = goals.filter(g => !g._shelved);
  let cum = 0, required = 0, binding = null;
  for (const g of paced) {
    cum += g._needByDue;
    const rate = g._wd > 0 ? cum / g._wd : cum;
    g._cumRate = rate;
    g._cumRemaining = cum;
    if (rate > required + 1e-9) { required = rate; binding = g; }
  }

  /* — your ceiling — */
  const capWeeklyHours = (p.capEnabled && !p.onBreak)
    ? (p.capPeriod === "fortnight" ? (Number(p.capHours) || 48) / 2 : (Number(p.capHours) || 24))
    : Infinity;
  const maxWeeklyGross = capWeeklyHours === Infinity ? Infinity : capWeeklyHours * avgRate;
  const maxDailyKeep = capWeeklyHours === Infinity
    ? Infinity
    : (maxWeeklyGross - avgDailySpend * 7) / wdpw;

  const hoursNeededDaily = avgRate > 0 ? required / avgRate : 0;
  const hoursNeededWeekly = hoursNeededDaily * wdpw;
  const atRisk = required > maxDailyKeep;

  /* — today — */
  const tEarn = sum(state.shifts.filter(s => s.date === today), s => s.gross)
              + sum(state.income.filter(i => i.date === today), i => i.amount);
  const tSpend = sum(state.expenses.filter(e => e.date === today && !e.goalId), e => e.amount);
  const tKept = tEarn - tSpend;
  const resting = state.restDays.has(today);
  const stillNeeded = resting ? 0 : Math.max(0, required - tKept);
  const doneToday = !resting && required > 0 && tKept >= required;

  return {
    pool, surplus, goals, binding, required,
    avgRate, avgShiftHours, avgDailySpend,
    capWeeklyHours, maxWeeklyGross, maxDailyKeep, atRisk,
    hoursNeededDaily, hoursNeededWeekly,
    tEarn, tSpend, tKept, stillNeeded, doneToday, resting,
    earnTarget: required + avgDailySpend,
    wdpw,
    paced,
    completed,
    balanceBeyondMinimums: sum(goals.filter(g => !g._shelved), g => Math.max(0, g._remaining - g._needByDue)),
    weeklySpend,
    shelved: goals.filter(g => g._shelved),
    anyGoals: goals.length > 0,
    hasGoals: paced.length > 0
  };
}

/** What you kept on a given day. */
function keptOn(iso) {
  return sum(state.shifts.filter(s => s.date === iso), s => s.gross)
       + sum(state.income.filter(i => i.date === iso), i => i.amount)
       - sum(state.expenses.filter(e => e.date === iso && !e.goalId), e => e.amount);
}

/* ══════════════════════════════════════════════════════════════
   RENDER
   ══════════════════════════════════════════════════════════════ */

function renderAll() {
  if (!state.user) return;
  const c = compute();
  renderToday(c);
  renderGoals(c);
  renderLog(c);
  renderPlan(c);
  saveSnapshot(c);
}

/* ─────────── today ─────────── */
function renderToday(c) {
  const today = TODAY();
  $("#todayDate").textContent = parseISO(today)
    .toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long" });

  const big = $("#bigNumber"), val = $("#bigNumberVal");

  if (c.resting && c.hasGoals) {
    val.textContent = "Rest";
    big.classList.remove("behind");
    $("#heroSub").textContent = "no target today — you've called it off";
    // one fewer earning day, so the rest of the run picks it up
    const b = c.binding;
    const after = (b && b._wd > 1) ? b._cumRemaining / (b._wd - 1) : c.required;
    // only worth naming the new figure when it's a difference you'd actually feel
    const notable = after > c.required * 1.02 && after > c.required + 1;
    let line = `<span class="hero-earn">Today's ${fmt(Math.ceil(c.required))} spreads into the days ahead`
      + `${notable ? ` — about ${fmt(Math.ceil(after))} a day instead of ${fmt(Math.ceil(c.required))}` : ""}.</span>`;
    if (c.tKept > 0.005) {
      line += `<span class="hero-earn">You kept ${fmt(c.tKept)} anyway — it still counts.</span>`;
    }
    $("#heroHours").innerHTML = line;
    $("#tapHint").hidden = true;
  } else if (!c.hasGoals) {
    val.textContent = c.anyGoals ? "Clear" : "—";
    big.classList.remove("behind");
    $("#heroSub").textContent = c.anyGoals
      ? `everything's shelved for now — nothing to keep today`
      : "Add a goal and this becomes your daily number";
    $("#heroHours").innerHTML = c.anyGoals
      ? `<span class="hero-earn">${c.shelved.length} goal${c.shelved.length === 1 ? "" : "s"} waiting. Move one back to Normal whenever you're ready.</span>`
      : "";
    $("#tapHint").hidden = true;
  } else if (c.doneToday) {
    val.textContent = "Done";
    big.classList.remove("behind");
    $("#heroSub").textContent = "today's share is covered";
    $("#heroHours").innerHTML = `<span class="hero-earn">You kept ${fmt(c.tKept)} — ${fmt(c.tKept - c.required)} past today's number.</span>`;
    $("#tapHint").hidden = false;
  } else {
    val.textContent = fmt(Math.ceil(c.stillNeeded));
    big.classList.toggle("behind", false);
    $("#heroSub").textContent = c.tKept > 0 ? "still to keep today" : "to keep today";
    let h = `≈ ${hrs(c.stillNeeded / c.avgRate)} of work`;
    if (c.avgDailySpend > 0.5) {
      h += `<span class="hero-earn">about ${fmt(Math.ceil(c.stillNeeded + c.avgDailySpend))} earned, once a usual day's spending comes out</span>`;
    }
    $("#heroHours").innerHTML = h;
    $("#tapHint").hidden = false;
  }

  const pct = c.resting ? 1 : c.required > 0 ? clamp(c.tKept / c.required, 0, 1) : (c.hasGoals ? 0 : 1);
  requestAnimationFrame(() => { $("#paceFill").style.width = (pct * 100) + "%"; });
  $("#paceFill").classList.toggle("resting", !!c.resting);
  $("#heroKept").textContent = c.resting
    ? "a day off is part of the plan"
    : c.hasGoals
      ? `kept ${fmt(c.tKept, true)} of ${fmt(Math.ceil(c.required))} today`
      : "";

  const rb = $("#restBtn");
  rb.textContent = c.resting ? "Actually, I am working today" : "Not working today";
  rb.classList.toggle("on", !!c.resting);

  /* binding goal */
  const b = c.binding;
  $("#bindingCard").hidden = !b;
  if (b) {
    $("#bindingName").textContent = b.name;
    const stacked = (b._cumRemaining ?? b._remaining) > b._remaining + 0.5;
    $("#bindingMeta").textContent = b._overdue
      ? `was due ${niceDue(b.due)} · ${fmt(b._remaining)} short`
      : stacked
        ? `with everything ahead of it, ${fmt(b._cumRemaining)} by ${niceDue(b.due)} · ${b._wd} working days`
        : `${fmt(b._remaining)} to go · ${b._wd} working days · due ${niceDue(b.due)}`;
  }

  /* the only loud warning in the app */
  const notice = $("#capNotice");
  let head = "", body = "";
  if (c.hasGoals && c.atRisk && c.maxDailyKeep !== Infinity) {
    head = "Needs more hours than you're allowed";
    body = `Staying on pace needs about ${hrs(c.hoursNeededWeekly)} a week, but your cap is `
      + `${c.capWeeklyHours} h. Lowering an amount to its minimum or moving a due date closes that gap `
      + `faster than extra hours can — <a href="#" data-go="goals">open Goals</a>.`;
  } else if (c.hasGoals && c.maxDailyKeep !== Infinity && c.required > c.maxDailyKeep * 0.85) {
    head = "Close to your hours ceiling";
    body = `About ${hrs(c.hoursNeededWeekly)} a week of the ${c.capWeeklyHours} h you're allowed to work.`;
  }
  notice.hidden = !head;
  if (head) {
    // a warning that never folds away stops being a warning
    notice.innerHTML = `
      <button class="notice-head" id="capHead" aria-expanded="${state.capOpen ? "true" : "false"}">
        <span>${head}</span>
        <svg class="chev ${state.capOpen ? "up" : ""}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
      </button>
      <div class="notice-body" ${state.capOpen ? "" : "hidden"}>${body}</div>`;
    $("#capHead").addEventListener("click", () => {
      state.capOpen = !state.capOpen;
      renderToday(compute());
    });
  }

  /* a quiet line, steady for the whole day */
  const seed = parseISO(today).getTime() / 864e5 | 0;
  $("#quote").textContent = QUOTES[seed % QUOTES.length];

  /* today's entries */
  const entries = entriesFor(today);
  $("#todayPanel").hidden = entries.length === 0;
  $("#todayList").innerHTML = entries.map(rowHTML).join("");

  /* week strip */
  renderWeek(c);
}

function renderWeek(c) {
  const today = TODAY();
  const days = [];
  for (let i = 6; i >= 0; i--) days.push(addDays(today, -i));
  const vals = days.map(keptOn);
  const peak = Math.max(c.required || 0, ...vals.map(Math.abs), 1);

  $("#weekStrip").innerHTML = days.map((iso, i) => {
    const v = vals[i];
    const rest = state.restDays.has(iso);
    const h = rest ? 12 : clamp(Math.abs(v) / peak, 0, 1) * 100;
    const miss = !rest && c.required > 0 && v < c.required;
    const L = parseISO(iso).toLocaleDateString("en-AU", { weekday: "narrow" });
    return `<div class="wday ${iso === today ? "today" : ""}">
      <div class="wday-bar"><div class="wday-fill ${miss ? "miss" : ""} ${rest ? "rest" : ""}" data-h="${h}"></div></div>
      <p class="wday-l">${L}</p>
    </div>`;
  }).join("");
  requestAnimationFrame(() => {
    $$("#weekStrip .wday-fill").forEach(el => { el.style.height = el.dataset.h + "%"; });
  });

  const kept7 = sum(vals, v => v);
  const restCount = days.filter(d => state.restDays.has(d)).length;
  const target7 = c.required * Math.max(0, Math.min(7, c.wdpw) - restCount);
  if (!c.hasGoals) { $("#weekFoot").textContent = ""; return; }
  if (target7 <= 0) {
    $("#weekFoot").textContent = `Kept ${fmt(kept7)} this week.`;
    return;
  }
  $("#weekFoot").textContent = kept7 >= target7
    ? `Kept ${fmt(kept7)} this week — ahead of the ${fmt(target7)} you needed.`
    : `Kept ${fmt(kept7)} of about ${fmt(target7)} this week. The gap is already spread into today's number.`;
}

/* ─────────── shared row rendering ─────────── */
function entriesFor(iso) {
  const out = [];
  state.shifts.filter(s => s.date === iso).forEach(s => out.push({ ...s, _k: "shift" }));
  state.income.filter(i => i.date === iso).forEach(i => out.push({ ...i, _k: "income" }));
  state.expenses.filter(e => e.date === iso).forEach(e => out.push({ ...e, _k: "expense" }));
  return out;
}

function rowHTML(x) {
  const del = `<button class="row-del" data-del="${x._k}:${x.id}" aria-label="Delete">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>`;

  if (x._k === "shift") {
    return `<div class="row">
      <div class="row-ico">⏱</div>
      <div class="row-main">
        <p class="row-t">${esc(x.job || "Shift")} · ${x.hours} h</p>
        <p class="row-s">${niceDate(x.date)} · ${fmt(x.rate, true)}/h</p>
      </div>
      <p class="row-v pos">+${fmt(x.gross, true)}</p>${del}</div>`;
  }
  if (x._k === "income") {
    return `<div class="row">
      <div class="row-ico">💵</div>
      <div class="row-main">
        <p class="row-t">${esc(x.source || "Income")}</p>
        <p class="row-s">${niceDate(x.date)}</p>
      </div>
      <p class="row-v pos">+${fmt(x.amount, true)}</p>${del}</div>`;
  }
  const cat = CATS[x.category] || CATS.other;
  return `<div class="row">
    <div class="row-ico" style="background:${cat.color}22">${cat.icon}</div>
    <div class="row-main">
      <p class="row-t">${esc(x.desc || cat.label)}</p>
      <p class="row-s">${niceDate(x.date)} · ${cat.label}${x.recurringId ? " · repeats" : ""}</p>
    </div>
    <p class="row-v">−${fmt(x.amount, true)}</p>${del}</div>`;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, m =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}

/* ─────────── goals ─────────── */
function renderLadder(c) {
  const panel = $("#ladderPanel");
  const all = state.goals.filter(g => g.active !== false);
  if (!all.length) { panel.hidden = true; return; }

  const total = sum(all, g => Number(g.amount) || 0);
  const left = sum(c.goals, g => g._outstanding);
  const cleared = Math.max(0, total - left);
  const pct = total > 0 ? clamp(cleared / total, 0, 1) : 0;
  const goneCount = c.completed.length;

  panel.hidden = false;
  panel.innerHTML = `
    <p class="ladder-k">Still owed</p>
    <p class="ladder-v">${fmt(left)}</p>
    <div class="ladder-bar"><div class="ladder-fill" data-w="${(pct * 100).toFixed(1)}"></div></div>
    <p class="ladder-foot">
      ${cleared > 0.005 ? `<b>${fmt(cleared)}</b> cleared of ${fmt(total)}` : `nothing cleared yet of ${fmt(total)}`}
      ${goneCount ? ` · ${goneCount} of ${all.length} gone` : ""}
    </p>`;
  requestAnimationFrame(() => {
    const el = $("#ladderPanel .ladder-fill");
    if (el) el.style.width = el.dataset.w + "%";
  });
}

function renderGoals(c) {
  const list = $("#goalsList");
  renderLadder(c);

  if (!c.goals.length && !c.completed.length) {
    list.innerHTML = `<div class="panel">
      <p class="panel-lead">No goals yet. A goal is just an amount and a date — the app turns it into today's number.</p>
      <button class="btn btn-primary" id="seedBtn" style="margin-top:16px">Start with my 2027 goals</button>
      <p class="panel-foot">Adds TR visa (Dec 2026), Masters semester 1 (Jun 2027) and a $5,000 buffer. Edit or delete any of them after.</p>
    </div>`;
    $("#goalsNote").textContent = "";
    $("#surplusPanel").hidden = true;
    return;
  }

  const nUrgent = c.goals.filter(g => g._prio === "urgent").length;
  $("#goalsNote").textContent = !c.goals.length
    ? "Everything's paid off. Add a goal whenever the next one comes up."
    : c.shelved.length && nUrgent
      ? "Urgent first, shelved left out. Tap a row for detail."
      : nUrgent
        ? "Urgent goals are funded first. Tap a row for detail."
        : c.shelved.length
          ? "Shelved goals keep their progress but stay out of today's number."
          : "Soonest first. Tap a row for detail.";

  const ordered = c.goals.slice().sort((a, b) =>
    (PRIO_RANK[a._prio] - PRIO_RANK[b._prio]) || (a.due < b.due ? -1 : a.due > b.due ? 1 : 0));

  list.innerHTML = ordered.map(g => {
    const open = state.openGoal === g.id;
    const done = g._done, shelved = g._shelved;
    const ck = conseqOf(g);
    const rate = done || shelved ? "—" : fmt(Math.ceil(g._solo));
    const dueShort = parseISO(g.due).toLocaleDateString("en-AU", { day: "numeric", month: "short" });

    const status = done ? "covered"
      : shelved ? "set aside"
      : g._needByDue <= 0.005 ? "nothing due"
      : `${fmt(g._needByDue)} by then`;

    return `<div class="grow ${open ? "open" : ""} ${g._prio === "urgent" ? "urgent" : ""} ${shelved ? "later" : ""} ${done ? "done" : ""}">
      <button class="grow-head" data-goalrow="${g.id}" aria-expanded="${open}">
        <span class="grow-l">
          <span class="grow-name">${esc(g.name)}${ck ? `<span class="dot ${CONSEQ[ck].cls}"></span>` : ""}</span>
          <span class="grow-sub">${g._overdue ? "overdue · " : ""}${dueShort} · ${status}</span>
        </span>
        <span class="grow-r">
          <span class="grow-v">${rate}</span>
          <span class="grow-k">${done ? "covered" : shelved ? "shelved" : "a day"}</span>
        </span>
      </button>
      <div class="grow-bar"><div class="grow-fill" data-w="${(g._pct * 100).toFixed(1)}"></div></div>
      ${open ? `<div class="grow-body">
        ${ck ? `<div class="chip-row"><span class="conseq ${CONSEQ[ck].cls}">${CONSEQ[ck].label}${g.consequenceNote ? " · " + esc(g.consequenceNote) : ""}</span></div>` : ""}
        <div class="goal-foot">
          <span><b>${fmt(g._paid + g._funded)}</b> of ${fmt(g.amount)}</span>
          <span>${g._wd} working days left</span>
        </div>
        ${g._hasMin ? `<p class="goal-min">${
          g._dueNow > 0.005 ? `minimum <b>${fmt(g._dueNow)}</b> by the date` : `minimum covered for ${niceDue(g.due)}`
        } · balance ${fmt(g._outstanding)}</p>` : ""}
        ${g._paid > 0.005 ? `<p class="goal-min">${fmt(g._paid)} already paid</p>` : ""}
        ${!done && !shelved && g._needByDue > 0.005 ? `<p class="goal-min">${hrs(g._needByDue / c.avgRate)} of work to cover it</p>` : ""}
        <div class="goal-actions">
          <button class="prio-btn ${g._prio}" data-prio="${g.id}">${{ urgent: "⚡ Urgent", normal: "Normal", later: "Shelved" }[g._prio]}</button>
          <button class="btn btn-small" data-editgoal="${g.id}">Edit</button>
          <button class="btn btn-small" data-breathegoal="${g.id}">Break down</button>
          <button class="btn btn-small done-btn" data-done="${g.id}">Pay</button>
        </div>
      </div>` : ""}
    </div>`;
  }).join("");

  if (c.completed.length) {
    list.innerHTML += `<p class="goals-sub">Paid</p>` + c.completed
      .slice()
      .sort((a, b) => ((b.completedDate || "") < (a.completedDate || "") ? -1 : 1))
      .map(g => `<div class="grow paid">
        <div class="grow-head static">
          <span class="grow-l">
            <span class="grow-name"><span class="tick">✓</span>${esc(g.name)}</span>
            <span class="grow-sub">${fmt(g.amount)} · ${g.completedDate ? niceDate(g.completedDate) : "settled"}</span>
          </span>
          <button class="btn btn-small" data-reopen="${g.id}">Reopen</button>
        </div>
      </div>`).join("");
  }

  requestAnimationFrame(() => {
    $$("#goalsList .grow-fill").forEach(el => { el.style.width = el.dataset.w + "%"; });
  });

  $("#surplusPanel").hidden = c.surplus <= 0.005;
  $("#surplusVal").textContent = fmt(c.surplus);
}

/* ─────────── log ─────────── */
function renderLog(c) {
  const m = state.logMonth || monthOf(TODAY());
  state.logMonth = m;
  const [y, mo] = m.split("-").map(Number);
  $("#monthLabel").textContent = new Date(y, mo - 1, 1)
    .toLocaleDateString("en-AU", { month: "long", year: "numeric" });
  $("#monthNext").disabled = m >= monthOf(TODAY());

  const inM = x => monthOf(x.date) === m;
  const sh = state.shifts.filter(inM);
  const inc = state.income.filter(inM);
  const ex = state.expenses.filter(inM);

  const earned = sum(sh, s => s.gross) + sum(inc, i => i.amount);
  const spent = sum(ex, e => e.amount);
  $("#mEarned").textContent = fmt(earned);
  $("#mSpent").textContent = fmt(spent);
  $("#mKept").textContent = fmt(earned - spent);
  $("#mKept").classList.toggle("pos", earned - spent >= 0);

  const h = sum(sh, s => s.hours);
  $("#mHours").textContent = h > 0
    ? `${hrs(h)} worked across ${sh.length} shift${sh.length === 1 ? "" : "s"} · averaging ${fmt(earned && h ? sum(sh, s => s.gross) / h : 0, true)}/h`
    : "No shifts logged this month.";

  /* category bars */
  const byCat = {};
  ex.forEach(e => { byCat[e.category || "other"] = (byCat[e.category || "other"] || 0) + Number(e.amount || 0); });
  const pairs = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  const top = pairs[0]?.[1] || 1;
  $("#catBars").innerHTML = pairs.length
    ? pairs.map(([k, v]) => {
        const cat = CATS[k] || CATS.other;
        return `<div>
          <div class="catbar-top">
            <span class="catbar-name">${cat.label}</span>
            <span class="catbar-v">${fmt(v)}</span>
          </div>
          <div class="catbar-track"><div class="catbar-fill" style="background:${cat.color}" data-w="${(v / top * 100).toFixed(1)}"></div></div>
        </div>`;
      }).join("")
    : `<p class="empty">Nothing spent this month yet.</p>`;
  requestAnimationFrame(() => {
    $$("#catBars .catbar-fill").forEach(el => { el.style.width = el.dataset.w + "%"; });
  });

  /* entries */
  let rows = [];
  const f = state.logFilter;
  if (f === "all" || f === "shift") rows.push(...sh.map(s => ({ ...s, _k: "shift" })));
  if (f === "all" || f === "income") rows.push(...inc.map(i => ({ ...i, _k: "income" })));
  if (f === "all" || f === "expense") rows.push(...ex.map(e => ({ ...e, _k: "expense" })));
  rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  $("#logList").innerHTML = rows.length
    ? rows.map(rowHTML).join("")
    : `<p class="empty">Nothing logged here yet.</p>`;
}

/* ─────────── what this week actually covers ─────────── */
function renderShortfall(c) {
  const box = $("#shortBox");
  if (!c.hasGoals) {
    box.innerHTML = `<p class="empty">Nothing due — nothing to juggle.</p>`;
    return;
  }

  const weekEarn = c.capWeeklyHours !== Infinity
    ? c.capWeeklyHours * c.avgRate
    : c.avgShiftHours * c.wdpw * c.avgRate;
  const living = c.avgDailySpend * 7;
  const toward = Math.max(0, weekEarn - living);

  const DAYS = 14;
  const horizon = addDays(TODAY(), DAYS);
  const due = c.paced
    .filter(g => g.due <= horizon && g._needByDue > 0.005)
    .sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : 0));

  if (!due.length) {
    box.innerHTML = `<p class="empty">Nothing falls due in the next two weeks.</p>`;
    return;
  }

  const available = toward * (DAYS / 7);
  const needed = sum(due, g => g._needByDue);

  let purse = available;
  const rows = due.map(g => {
    const take = Math.min(purse, g._needByDue);
    purse -= take;
    const short = g._needByDue - take;
    const ck = conseqOf(g);
    return { g, short, ck };
  });
  const uncovered = rows.filter(r => r.short > 0.005);
  const gap = needed - available;

  box.innerHTML = `
    <div class="short-top">
      <div><p class="short-k">Can earn</p><p class="short-v">${fmt(available)}</p></div>
      <div><p class="short-k">Falls due</p><p class="short-v">${fmt(needed)}</p></div>
      <div><p class="short-k">${gap > 0 ? "Short" : "Spare"}</p>
        <p class="short-v ${gap > 0 ? "bad" : "good"}">${fmt(Math.abs(gap))}</p></div>
    </div>
    <p class="panel-foot" style="margin-top:12px">
      Next ${DAYS} days at ${c.capWeeklyHours !== Infinity ? `${c.capWeeklyHours} h a week` : "your usual hours"},
      ${fmt(c.avgRate, true)} an hour${living > 0.5 ? `, after about ${fmt(living)} a week of living` : ""}.
    </p>
    <div class="short-list">
      ${rows.map(r => `
        <div class="short-row ${r.short > 0.005 ? "gapped" : ""}">
          <div class="short-row-l">
            <p class="short-row-t">${esc(r.g.name)}</p>
            <p class="short-row-s">${niceDue(r.g.due)}${r.ck ? ` · ${CONSEQ[r.ck].label}` : ""}</p>
          </div>
          <div class="short-row-r">
            <p class="short-row-v">${fmt(r.g._needByDue)}</p>
            <p class="short-row-k">${r.short > 0.005 ? `${fmt(r.short)} short` : "covered"}</p>
          </div>
        </div>`).join("")}
    </div>
    ${uncovered.length ? `
      <p class="panel-foot">${uncovered.length === 1 ? "One of these doesn't fit" : `${uncovered.length} of these don't fit`}${
        uncovered.some(r => r.ck) ? " — what each costs you late is shown above, so you can choose" : ""}.
        Lowering an amount to its minimum, or moving a date, closes the gap faster than extra hours can.</p>` : `
      <p class="panel-foot">Everything due in the next two weeks fits inside what you can earn.</p>`}
  `;
}

/* ─────────── plan ─────────── */
function renderPlan(c) {
  renderShortfall(c);
  const box = $("#capBox");
  const capped = c.capWeeklyHours !== Infinity;
  const pctUsed = capped ? clamp(c.hoursNeededWeekly / c.capWeeklyHours, 0, 1.4) : 0;

  box.innerHTML = `
    <div class="cap-line"><span>Your rate, from logged shifts</span><b>${fmt(c.avgRate, true)}/h</b></div>
    <div class="cap-line"><span>Days a week you work</span><b>${c.wdpw}</b></div>
    ${capped ? `<div class="cap-line"><span>Hours you're allowed</span><b>${c.capWeeklyHours} h / week</b></div>` : ""}
    ${capped ? `<div class="cap-line"><span>Most you can earn</span><b>${fmt(c.maxWeeklyGross)} / week</b></div>` : ""}
    <div class="cap-line"><span>Your usual spending</span><b>${fmt(c.avgDailySpend, true)} / day</b></div>
    ${c.hasGoals ? `<div class="cap-line"><span>Hours your goals need</span><b>${hrs(c.hoursNeededWeekly)} / week</b></div>` : ""}
    ${capped && c.hasGoals ? `
      <div class="cap-meter"><div class="cap-meter-fill ${c.atRisk ? "over" : ""}" data-w="${clamp(pctUsed, 0, 1) * 100}"></div></div>
      <p class="panel-foot" style="margin-top:0">${
        c.atRisk
          ? `Your goals need more hours than your cap allows. Something has to move — a date, an amount, or your rate.`
          : `You're using about ${Math.round(pctUsed * 100)}% of the hours you're allowed to work.`
      }</p>` : ""}
    ${!capped ? `<p class="panel-foot">No hours cap set. Turn one on in settings if your visa limits you.</p>` : ""}
  `;
  requestAnimationFrame(() => {
    const el = $("#capBox .cap-meter-fill");
    if (el) el.style.width = el.dataset.w + "%";
  });

  /* recurring bills */
  $("#recList").innerHTML = state.recurring.length
    ? state.recurring.map(r => {
        const cat = CATS[r.category] || CATS.other;
        return `<div class="row">
          <div class="row-ico" style="background:${cat.color}22">${cat.icon}</div>
          <div class="row-main">
            <p class="row-t">${esc(r.desc)}</p>
            <p class="row-s">${recSchedule(r)} · ${cat.label}${r.active === false ? " · paused" : ""}</p>
          </div>
          <p class="row-v">${fmt(r.amount)}</p>
          <button class="row-del" data-editrec="${r.id}" aria-label="Edit">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 20h16"/><path d="M14 5l5 5-9 9H5v-5z"/></svg>
          </button></div>`;
      }).join("")
    : `<p class="empty">No repeating bills yet.</p>`;
}

/* ══════════════════════════════════════════════════════════════
   SHEETS
   ══════════════════════════════════════════════════════════════ */

function openSheet(title, html, onMount) {
  $("#sheetTitle").textContent = title;
  $("#sheetBody").innerHTML = html;
  $("#sheet").hidden = false;
  $("#scrim").hidden = false;
  document.body.style.overflow = "hidden";
  if (onMount) onMount($("#sheetBody"));
}
function closeSheet() {
  $("#sheet").hidden = true;
  $("#scrim").hidden = true;
  document.body.style.overflow = "";
}

const catOptions = (sel) => CAT_KEYS
  .map(k => `<option value="${k}" ${k === sel ? "selected" : ""}>${CATS[k].label}</option>`)
  .join("");

/* ─────────── log a shift ─────────── */
function sheetShift() {
  const c = compute();
  openSheet("Log a shift", `
    <div class="f"><label>Date</label><input type="date" id="sDate" value="${TODAY()}" max="${TODAY()}"></div>
    <div class="f-2">
      <div class="f"><label>Hours worked</label><input type="number" id="sHours" inputmode="decimal" step="0.25" min="0" placeholder="0"></div>
      <div class="f"><label>Rate per hour</label><input type="number" id="sRate" inputmode="decimal" step="0.01" min="0" value="${(c.avgRate || 30).toFixed(2)}"></div>
    </div>
    <div class="f"><label>Where (optional)</label><input type="text" id="sJob" placeholder="e.g. cafe, warehouse"></div>
    <div class="f-calc" id="sCalc">Enter your hours and this works out the rest.</div>
    <div class="f-actions">
      <button class="btn btn-ghost" data-close>Cancel</button>
      <button class="btn btn-primary" id="sSave">Save shift</button>
    </div>
  `, () => {
    const calc = () => {
      const h = Number($("#sHours").value) || 0, r = Number($("#sRate").value) || 0;
      const g = h * r;
      const c2 = compute();
      $("#sCalc").textContent = g > 0
        ? `${fmt(g, true)} earned${c2.required > 0 ? ` — that's ${Math.round(clamp(g / c2.required, 0, 9) * 100)}% of today's number` : ""}`
        : "Enter your hours and this works out the rest.";
    };
    $("#sHours").addEventListener("input", calc);
    $("#sRate").addEventListener("input", calc);
    $("#sHours").focus();
    $("#sSave").addEventListener("click", async () => {
      const date = $("#sDate").value, h = Number($("#sHours").value), r = Number($("#sRate").value);
      if (!date || !(h > 0) || !(r > 0)) return toast("Add your hours and rate first");
      await addDoc(collection(db, "shifts"), {
        date, hours: h, rate: r, gross: +(h * r).toFixed(2), job: $("#sJob").value.trim() || "", createdAt: Date.now()
      });
      closeSheet();
      toast(`${hrs(h)} logged · ${fmt(h * r, true)}`);
    });
  });
}

/* ─────────── spending ─────────── */
function sheetExpense() {
  openSheet("What did you spend?", `
    <div class="f"><label>Amount</label><input type="number" id="eAmt" inputmode="decimal" step="0.01" min="0" placeholder="0.00"></div>
    <div class="f"><label>Category</label><select id="eCat">${catOptions("groceries")}</select></div>
    <div class="f"><label>What for (optional)</label><input type="text" id="eDesc" placeholder="e.g. weekly shop"></div>
    <div class="f"><label>Date</label><input type="date" id="eDate" value="${TODAY()}" max="${TODAY()}"></div>
    <div class="f-calc" id="eCalc" hidden></div>
    <div class="f-actions">
      <button class="btn btn-ghost" data-close>Cancel</button>
      <button class="btn btn-primary" id="eSave">Save</button>
    </div>
  `, () => {
    const calc = () => {
      const a = Number($("#eAmt").value) || 0;
      const c = compute();
      const box = $("#eCalc");
      if (a > 0 && c.avgRate > 0) {
        box.hidden = false;
        box.textContent = `That's ${hrs(a / c.avgRate)} of work.`;
      } else box.hidden = true;
    };
    $("#eAmt").addEventListener("input", calc);
    $("#eAmt").focus();
    $("#eSave").addEventListener("click", async () => {
      const a = Number($("#eAmt").value);
      if (!(a > 0)) return toast("Add an amount first");
      await addDoc(collection(db, "expenses"), {
        date: $("#eDate").value || TODAY(), amount: a,
        category: $("#eCat").value, desc: $("#eDesc").value.trim() || "", createdAt: Date.now()
      });
      closeSheet();
      toast(`${fmt(a, true)} logged`);
    });
  });
}

/* ─────────── other income ─────────── */
function sheetIncome() {
  openSheet("Money in", `
    <div class="f"><label>Amount</label><input type="number" id="iAmt" inputmode="decimal" step="0.01" min="0" placeholder="0.00"></div>
    <div class="f"><label>Where from (optional)</label><input type="text" id="iSrc" placeholder="e.g. cash job, refund, gift"></div>
    <div class="f"><label>Date</label><input type="date" id="iDate" value="${TODAY()}" max="${TODAY()}"></div>
    <p class="f-hint">Use this for anything that isn't an hourly shift — cash work, one-off payments, refunds.</p>
    <div class="f-actions">
      <button class="btn btn-ghost" data-close>Cancel</button>
      <button class="btn btn-primary" id="iSave">Save</button>
    </div>
  `, () => {
    $("#iAmt").focus();
    $("#iSave").addEventListener("click", async () => {
      const a = Number($("#iAmt").value);
      if (!(a > 0)) return toast("Add an amount first");
      await addDoc(collection(db, "income"), {
        date: $("#iDate").value || TODAY(), amount: a,
        source: $("#iSrc").value.trim() || "", createdAt: Date.now()
      });
      closeSheet();
      toast(`${fmt(a, true)} in`);
    });
  });
}

/* ─────────── goal ─────────── */
function sheetGoal(id) {
  const g = id ? state.goals.find(x => x.id === id) : null;
  openSheet(g ? "Edit goal" : "New goal", `
    <div class="f"><label>What is it?</label><input type="text" id="gName" value="${esc(g?.name || "")}" placeholder="e.g. TR visa fees"></div>
    <div class="f"><label>How much</label><input type="number" id="gAmt" inputmode="decimal" step="0.01" min="0" value="${g?.amount ?? ""}" placeholder="0.00"></div>
    <div class="f"><label>Needed by</label><input type="date" id="gDue" value="${g?.due || ""}"></div>
    <div class="f"><label>Type</label>
      <div class="seg" id="gType">
        <button type="button" data-v="goal" class="${(g?.type || "goal") === "goal" ? "on" : ""}">Saving up</button>
        <button type="button" data-v="loan" class="${g?.type === "loan" ? "on" : ""}">Paying off</button>
      </div>
    </div>
    <div class="f"><label>Smallest payment they'll accept <span class="opt">optional</span></label>
      <input type="number" id="gMin" inputmode="decimal" step="0.01" min="0" value="${g?.minimum ?? ""}" placeholder="leave blank if it's all or nothing">
    </div>
    <p class="f-hint">For cards, BNPL and loans that take a minimum. Only this much drives your daily number — the rest stays as a balance you chip away at.</p>
    <div class="f"><label>If it's late <span class="opt">optional</span></label>
      <select id="gConseq">
        <option value="">— not set —</option>
        ${Object.keys(CONSEQ).map(k => `<option value="${k}" ${g?.consequence === k ? "selected" : ""}>${CONSEQ[k].label}</option>`).join("")}
      </select>
    </div>
    <div class="f"><input type="text" id="gConseqNote" value="${esc(g?.consequenceNote || "")}" placeholder="e.g. $10 fee, 24% p.a."></div>
    <div class="f"><label>Priority</label>
      <div class="seg" id="gPrio">
        <button type="button" data-v="urgent" class="${g && prioOf(g) === "urgent" ? "on" : ""}">Urgent</button>
        <button type="button" data-v="normal" class="${!g || prioOf(g) === "normal" ? "on" : ""}">Normal</button>
        <button type="button" data-v="later" class="${g && prioOf(g) === "later" ? "on" : ""}">Shelved</button>
      </div>
    </div>
    <div class="f-calc" id="gCalc" hidden></div>
    <p class="f-hint">Goals fill in date order. The earliest deadline gets your money first.</p>
    <div class="f-actions">
      ${g ? `<button class="btn btn-danger" id="gDel">Delete</button>` : `<button class="btn btn-ghost" data-close>Cancel</button>`}
      <button class="btn btn-primary" id="gSave">Save</button>
    </div>
  `, () => {
    let type = g?.type || "goal";
    $$("#gType button").forEach(b => b.addEventListener("click", () => {
      type = b.dataset.v;
      $$("#gType button").forEach(x => x.classList.toggle("on", x === b));
    }));
    let priority = g ? prioOf(g) : "normal";
    $$("#gPrio button").forEach(b => b.addEventListener("click", () => {
      priority = b.dataset.v;
      $$("#gPrio button").forEach(x => x.classList.toggle("on", x === b));
    }));

    const calc = () => {
      const a = Number($("#gAmt").value) || 0, d = $("#gDue").value;
      const box = $("#gCalc");
      if (a > 0 && d) {
        const c = compute();
        const wd = workingDaysUntil(d, c.wdpw);
        if (wd <= 0) { box.hidden = false; box.textContent = "That date has already passed."; return; }
        box.hidden = false;
        box.textContent = `${fmt(Math.ceil(a / wd))} a day on its own — about ${hrs(a / wd / c.avgRate)} of work, ${wd} working days.`;
      } else box.hidden = true;
    };
    $("#gAmt").addEventListener("input", calc);
    $("#gDue").addEventListener("input", calc);
    calc();

    $("#gSave").addEventListener("click", async () => {
      const name = $("#gName").value.trim(), a = Number($("#gAmt").value), d = $("#gDue").value;
      if (!name || !(a > 0) || !d) return toast("Needs a name, an amount and a date");
      const data = {
        name, amount: a, due: d, type, priority, active: true,
        minimum: Math.max(0, Number($("#gMin").value) || 0),
        consequence: $("#gConseq").value || "",
        consequenceNote: $("#gConseqNote").value.trim()
      };
      if (g) await updateDoc(doc(db, "goals", g.id), data);
      else await addDoc(collection(db, "goals"), { ...data, createdAt: Date.now() });
      closeSheet();
      toast(g ? "Goal updated" : "Goal added");
    });
    $("#gDel")?.addEventListener("click", async () => {
      if (!confirm(`Delete "${g.name}"?`)) return;
      await deleteDoc(doc(db, "goals", g.id));
      closeSheet();
      toast("Goal deleted");
    });
  });
}

/* ─────────── priority ─────────── */
function sheetPriority(id) {
  const g = state.goals.find(x => x.id === id);
  if (!g) return;
  const cur = prioOf(g);
  const now = compute();

  const opts = [
    { v: "urgent", t: "⚡ Urgent", d: "Funded before every other goal. Your money fills this one first." },
    { v: "normal", t: "Normal",   d: "Funded in deadline order, alongside everything else." },
    { v: "later",  t: "Shelved",  d: "Set aside. Keeps the progress it has, but stays out of today's number." }
  ].map(o => {
    const c = compute(0, { id, priority: o.v });
    const delta = c.required - now.required;
    return {
      ...o,
      num: c.hasGoals ? fmt(Math.ceil(c.required)) : "Clear",
      key: c.hasGoals ? "a day" : "nothing due",
      delta,
      risky: c.atRisk && c.maxDailyKeep !== Infinity,
      deltaText: Math.abs(delta) < 0.5 ? "no change to today"
        : delta > 0 ? `+${fmt(Math.ceil(delta))} a day`
        : `−${fmt(Math.ceil(-delta))} a day`
    };
  });

  const picked = opts.find(o => o.v === "urgent");
  const warn = picked.risky && !now.atRisk
    ? `<p class="f-hint" style="margin-top:14px">Heads up — marking this urgent starves a nearer deadline enough to push your goals past the hours you're allowed to work.</p>`
    : "";

  openSheet(esc(g.name), `
    <p class="panel-lead" style="margin-bottom:2px">How hard should this one pull on your money?</p>
    <div class="prio-opts">
      ${opts.map(o => `
        <button class="prio-opt ${o.v === cur ? "on" : ""}" data-set="${o.v}">
          <span class="prio-opt-l">
            <span class="prio-opt-t">${o.t}${o.v === cur ? " · now" : ""}</span>
            <span class="prio-opt-d">${o.d}</span>
          </span>
          <span class="prio-opt-r">
            <span class="prio-opt-n">${o.num}</span>
            <span class="prio-opt-k">${o.key}</span>
            <span class="prio-opt-delta ${o.delta > 0.5 ? "up" : o.delta < -0.5 ? "down" : ""}">${o.deltaText}</span>
          </span>
        </button>`).join("")}
    </div>
    ${warn}
    <p class="panel-foot">The figures show what today's number becomes with each setting. Nothing changes until you pick one.</p>
  `, () => {
    $$(".prio-opt").forEach(b => b.addEventListener("click", async () => {
      const v = b.dataset.set;
      closeSheet();
      if (v === cur) return;
      await updateDoc(doc(db, "goals", id), { priority: v });
      toast(v === "urgent" ? `${g.name} is now first in line`
          : v === "later" ? `${g.name} shelved — it's out of today's number`
          : `${g.name} back to normal`);
    }));
  });
}

/* ─────────── log a payment ─────────── */
function sheetComplete(id) {
  const g0 = state.goals.find(x => x.id === id);
  if (!g0) return;
  const base = compute();
  const g = base.goals.find(x => x.id === id) || base.completed.find(x => x.id === id);
  if (!g) return;

  const outstanding = g._outstanding;
  const suggested = Math.round((g._dueNow > 0 ? g._dueNow : outstanding) * 100) / 100;
  const defCat = g.type === "loan" ? "loan" : "other";

  openSheet(esc(g.name), `
    <p class="panel-lead" style="margin-bottom:2px">Balance <b>${fmt(outstanding)}</b>${
      g._hasMin ? ` · minimum <b>${fmt(g._dueNow)}</b> by ${niceDue(g.due)}` : ""}</p>
    <div class="f"><label>How much are you paying?</label>
      <input type="number" id="cAmt" inputmode="decimal" step="0.01" min="0" value="${suggested}">
    </div>
    <div class="quickamt" id="quickAmt">
      ${g._dueNow > 0 && g._hasMin ? `<button type="button" data-a="${g._dueNow}">Minimum ${fmt(g._dueNow)}</button>` : ""}
      <button type="button" data-a="${outstanding}">Clear it ${fmt(outstanding)}</button>
    </div>
    <div class="f"><label>Log it under</label><select id="cCat">${catOptions(defCat)}</select></div>
    <div class="f"><label>Date</label><input type="date" id="cDate" value="${TODAY()}" max="${TODAY()}"></div>
    <div class="f-calc" id="cCalc"></div>
    <div class="f-actions">
      <button class="btn btn-ghost" data-close>Cancel</button>
      <button class="btn btn-primary" id="cSave">Log payment</button>
    </div>
    <div class="sheet-sec">
      <h3>Didn't come from here?</h3>
      <p class="f-hint" style="margin-bottom:12px">If someone else paid it, or it came from money this app never saw, clear it without touching your balance.</p>
      <button class="btn btn-ghost" id="cOutside" style="width:100%">Mark settled, no money logged</button>
    </div>
  `, () => {
    const preview = () => {
      const a = Math.max(0, Number($("#cAmt").value) || 0);
      const clears = a >= outstanding - 0.005;
      const after = compute(-a, clears ? { id, exclude: true } : null);
      const box = $("#cCalc");
      const bits = [];
      bits.push(clears ? "That clears it." : `Balance drops to ${fmt(outstanding - a)}.`);
      if (base.hasGoals) {
        const d = base.required - after.required;
        if (!after.hasGoals) bits.push("Nothing left to keep each day.");
        else if (Math.abs(d) < 0.5) bits.push(`Today's number stays about ${fmt(Math.ceil(after.required))}.`);
        else if (d > 0) bits.push(`Today's number drops ${fmt(Math.ceil(base.required))} → ${fmt(Math.ceil(after.required))}.`);
        else bits.push(`Today's number rises ${fmt(Math.ceil(base.required))} → ${fmt(Math.ceil(after.required))}.`);
      }
      box.textContent = bits.join(" ");
    };
    $("#cAmt").addEventListener("input", preview);
    $$("#quickAmt button").forEach(b => b.addEventListener("click", () => {
      $("#cAmt").value = Math.round(Number(b.dataset.a) * 100) / 100;
      preview();
    }));
    preview();

    $("#cSave").addEventListener("click", async () => {
      const a = Math.max(0, Number($("#cAmt").value) || 0);
      if (!(a > 0)) return toast("Put in an amount, or use the button below");
      const date = $("#cDate").value || TODAY();
      const clears = a >= outstanding - 0.005;
      try {
        await addDoc(collection(db, "expenses"), {
          date, amount: a, category: $("#cCat").value,
          desc: `${clears ? "Paid" : "Payment"}: ${g.name}`, goalId: id, createdAt: Date.now()
        });
        const patch = {};
        if (clears) { patch.completed = true; patch.completedDate = date; patch.completedAt = Date.now(); }
        else if (g._dueNow > 0 && a >= g._dueNow - 0.005) { patch.minMetOn = g.due; }
        if (Object.keys(patch).length) await updateDoc(doc(db, "goals", id), patch);
        closeSheet();
        toast(clears ? `${g.name} — cleared` : `${fmt(a)} off ${g.name}`);
      } catch (e) { toast("Couldn't save that"); }
    });

    $("#cOutside").addEventListener("click", async () => {
      try {
        await updateDoc(doc(db, "goals", id), {
          completed: true, completedDate: TODAY(), completedAt: Date.now()
        });
        closeSheet();
        toast(`${g.name} — settled`);
      } catch (e) { toast("Couldn't save that"); }
    });
  });
}

async function reopenGoal(id) {
  const g = state.goals.find(x => x.id === id);
  if (!g) return;
  if (!confirm(`Put "${g.name}" back in your plan?\n\nAny spend logged when you marked it paid stays in your Log — delete it there if it shouldn't be counted.`)) return;
  await updateDoc(doc(db, "goals", id), { completed: false, completedDate: "", completedAt: 0 });
  toast(`${g.name} is back in your plan`);
}

/* ─────────── recurring bill ─────────── */
function sheetRecurring(id) {
  const r = id ? state.recurring.find(x => x.id === id) : null;
  const freq0 = r?.freq || (r ? "monthly" : "weekly");
  const wd0   = Number(r?.weekday ?? 1);
  const wdOpts = mode => WD_ORDER
    .map(d => `<option value="${d}"${d === wd0 ? " selected" : ""}>${mode === "long" ? WD_LONG[d] : WD_SHORT[d]}</option>`)
    .join("");
  const anchor0 = r?.anchor && String(r.anchor).length === 10 ? r.anchor : nextWeekday(TODAY(), wd0);

  openSheet(r ? "Edit bill" : "Repeating bill", `
    <div class="f"><label>What is it?</label><input type="text" id="rDesc" value="${esc(r?.desc || "")}" placeholder="e.g. Room rent"></div>
    <div class="f"><label>Amount</label><input type="number" id="rAmt" inputmode="decimal" step="0.01" min="0" value="${r?.amount ?? ""}" placeholder="0.00"></div>
    <div class="f"><label>Category</label><select id="rCat">${catOptions(r?.category || "rent")}</select></div>

    <div class="f"><label>How often?</label><select id="rFreq">
      <option value="weekly"${freq0 === "weekly" ? " selected" : ""}>Every week</option>
      <option value="fortnightly"${freq0 === "fortnightly" ? " selected" : ""}>Every 2 weeks</option>
      <option value="monthly"${freq0 === "monthly" ? " selected" : ""}>Every month</option>
    </select></div>

    <div class="f" id="rWdWrap"><label>Which day?</label><select id="rWd">${wdOpts("long")}</select></div>
    <div class="f" id="rAnchorWrap"><label>Next one falls on</label><input type="date" id="rAnchor" value="${anchor0}"></div>
    <div class="f" id="rDayWrap"><label>Day of the month it's due</label><input type="number" id="rDay" inputmode="numeric" min="1" max="28" value="${r?.dayOfMonth || 1}"></div>

    <p class="f-hint" id="rHint"></p>
    <div class="f-actions">
      ${r ? `<button class="btn btn-danger" id="rDel">Delete</button>` : `<button class="btn btn-ghost" data-close>Cancel</button>`}
      <button class="btn btn-primary" id="rSave">Save</button>
    </div>
  `, () => {
    const sync = () => {
      const f = $("#rFreq").value;
      $("#rWdWrap").hidden     = f === "monthly";
      $("#rAnchorWrap").hidden = f !== "fortnightly";
      $("#rDayWrap").hidden    = f !== "monthly";
      $("#rHint").textContent =
        f === "weekly"      ? "Posts itself as a spend every week on that day."
      : f === "fortnightly" ? "Posts itself every second week, counting from the date above."
      : "Use 1–28 so it lands every month. It posts itself as a spend on that day.";
    };
    $("#rFreq").addEventListener("change", sync);
    $("#rWd").addEventListener("change", () => {
      if ($("#rFreq").value === "fortnightly") $("#rAnchor").value = nextWeekday(TODAY(), Number($("#rWd").value));
    });
    sync();

    $("#rSave").addEventListener("click", async () => {
      const desc = $("#rDesc").value.trim(), a = Number($("#rAmt").value);
      if (!desc || !(a > 0)) return toast("Needs a name and an amount");

      const freq = $("#rFreq").value;
      const data = { desc, amount: a, category: $("#rCat").value, freq, active: true };

      if (freq === "monthly") {
        data.dayOfMonth = clamp(Number($("#rDay").value) || 1, 1, 28);
        data.weekday = null; data.anchor = null;
      } else {
        const wd = Number($("#rWd").value);
        data.weekday = wd; data.dayOfMonth = 0;
        data.anchor = freq === "fortnightly"
          ? nextWeekday($("#rAnchor").value || TODAY(), wd)
          : null;
      }

      // If the schedule itself moved, start counting fresh so nothing back-posts.
      const moved = !r || r.freq !== freq
        || (freq !== "monthly" && Number(r.weekday ?? -1) !== data.weekday)
        || (freq === "fortnightly" && r.anchor !== data.anchor)
        || (freq === "monthly" && Number(r.dayOfMonth || 0) !== data.dayOfMonth);
      if (moved) { data.since = TODAY(); data.lastPosted = ""; }

      if (r) await updateDoc(doc(db, "recurring", r.id), data);
      else await addDoc(collection(db, "recurring"), { ...data, lastPosted: "", createdAt: Date.now() });
      closeSheet();
      toast(r ? "Bill updated" : "Bill added");
      setTimeout(postRecurring, 300);
    });

    $("#rDel")?.addEventListener("click", async () => {
      if (!confirm(`Delete "${r.desc}"? Spending already posted stays in your log.`)) return;
      await deleteDoc(doc(db, "recurring", r.id));
      closeSheet();
      toast("Bill deleted");
    });
  });
}

/* ─────────── settings ─────────── */
function sheetSettings() {
  const p = state.profile, c = compute();
  openSheet("Settings", `
    <div class="sheet-sec">
      <h3>Your work</h3>
      <div class="f"><label>Usual hourly rate</label><input type="number" id="pRate" inputmode="decimal" step="0.01" min="0" value="${p.defaultRate}"></div>
      <p class="f-hint">${state.shifts.length ? `Only used until you've logged shifts — right now the app is using your real average of ${fmt(c.avgRate, true)}/h.` : "Used until you've logged some shifts, then your real average takes over."}</p>
      <div class="f"><label>Days a week you work</label><input type="number" id="pWdpw" inputmode="numeric" min="1" max="7" value="${p.workDaysPerWeek}"></div>
      <p class="f-hint">Your daily number is per working day, not per calendar day. Be honest here — it's what keeps the number real.</p>
    </div>

    <div class="sheet-sec">
      <h3>Hours cap</h3>
      <div class="switch">
        <div><p class="switch-t">I have an hours limit</p><p class="switch-s">Student visa work cap, or any ceiling you set yourself</p></div>
        <button class="toggle ${p.capEnabled ? "on" : ""}" id="tCap" role="switch" aria-checked="${!!p.capEnabled}"></button>
      </div>
      <div class="f"><label>Hours allowed</label>
        <div class="f-2">
          <input type="number" id="pCapH" inputmode="numeric" min="1" value="${p.capHours}">
          <select id="pCapP">
            <option value="fortnight" ${p.capPeriod === "fortnight" ? "selected" : ""}>per fortnight</option>
            <option value="week" ${p.capPeriod === "week" ? "selected" : ""}>per week</option>
          </select>
        </div>
      </div>
      <div class="switch">
        <div><p class="switch-t">On a study break right now</p><p class="switch-s">Lifts the cap while your course is out of session</p></div>
        <button class="toggle ${p.onBreak ? "on" : ""}" id="tBreak" role="switch" aria-checked="${!!p.onBreak}"></button>
      </div>
    </div>

    <div class="sheet-sec">
      <h3>Living costs</h3>
      <div class="f"><label>Roughly what do you spend a week?</label>
        <input type="number" id="pWeekly" inputmode="decimal" step="0.01" min="0" value="${p.weeklySpend || ""}" placeholder="food, transport, phone…">
      </div>
      <p class="f-hint">One honest number beats logging every purchase. Leave it blank and the app works it out from what you log instead${state.expenses.length ? `, which right now averages ${fmt(c.avgDailySpend * 7)} a week` : ""}.</p>
    </div>

    <div class="sheet-sec">
      <h3>Money you already have</h3>
      <div class="f"><label>Starting balance</label><input type="number" id="pStart" inputmode="decimal" step="0.01" value="${p.startingBalance}"></div>
      <p class="f-hint">What's saved right now, before anything you log here. It counts toward your goals straight away.</p>
    </div>

    <div class="f-actions"><button class="btn btn-primary" id="pSave" style="flex:1">Save</button></div>

    <div class="sheet-sec">
      <h3>Account</h3>
      <p class="f-hint" style="margin-bottom:12px">Signed in as ${esc(state.user?.email || "")}<br>Build ${BUILD}</p>
      <button class="btn btn-ghost" id="outBtn" style="width:100%">Sign out</button>
    </div>
  `, () => {
    let capOn = !!p.capEnabled, brk = !!p.onBreak;
    $("#tCap").addEventListener("click", e => { capOn = !capOn; e.currentTarget.classList.toggle("on", capOn); });
    $("#tBreak").addEventListener("click", e => { brk = !brk; e.currentTarget.classList.toggle("on", brk); });
    $("#pSave").addEventListener("click", async () => {
      await setDoc(doc(db, "config", "profile"), {
        ...p,
        defaultRate: Number($("#pRate").value) || 30,
        workDaysPerWeek: clamp(Number($("#pWdpw").value) || 5, 1, 7),
        capEnabled: capOn,
        capHours: Number($("#pCapH").value) || 48,
        capPeriod: $("#pCapP").value,
        onBreak: brk,
        startingBalance: Number($("#pStart").value) || 0,
        weeklySpend: Math.max(0, Number($("#pWeekly").value) || 0),
        setupDone: true
      }, { merge: true });
      closeSheet();
      toast("Saved");
    });
    $("#outBtn").addEventListener("click", () => signOut(auth));
  });
}

/* ─────────── first run ─────────── */
function sheetWelcome() {
  openSheet("Welcome", `
    <p class="panel-lead" style="margin-bottom:4px">Three quick things and the app can start doing the maths for you.</p>
    <div class="f"><label>What do you earn an hour?</label><input type="number" id="wRate" inputmode="decimal" step="0.01" min="0" placeholder="30.00"></div>
    <div class="f"><label>How many days a week do you work?</label><input type="number" id="wWd" inputmode="numeric" min="1" max="7" value="5"></div>
    <div class="f"><label>How much have you saved already?</label><input type="number" id="wStart" inputmode="decimal" step="0.01" value="0"></div>
    <p class="f-hint">All of it is editable later. Nothing here is locked in.</p>
    <div class="f-actions"><button class="btn btn-primary" id="wSave" style="flex:1">Start</button></div>
  `, () => {
    $("#wSave").addEventListener("click", async () => {
      await setDoc(doc(db, "config", "profile"), {
        ...DEFAULT_PROFILE,
        defaultRate: Number($("#wRate").value) || 30,
        workDaysPerWeek: clamp(Number($("#wWd").value) || 5, 1, 7),
        startingBalance: Number($("#wStart").value) || 0,
        setupDone: true
      }, { merge: true });
      closeSheet();
      toast("You're set. Add a goal next.");
      switchTab("goals");
    });
  });
}

/* ══════════════════════════════════════════════════════════════
   BREAK IT DOWN  — the calm-down view
   ══════════════════════════════════════════════════════════════ */

function openBreathe(goalId) {
  const c = compute();
  const g = goalId ? c.goals.find(x => x.id === goalId) : c.binding;
  if (!g) { toast("Add a goal first"); return; }

  const total = goalId ? g._remaining : (g._cumRemaining ?? g._remaining);
  const wd = Math.max(1, g._wd);
  const perDay = total / wd;
  const perHour = c.avgRate > 0 ? perDay / c.avgRate : 0;

  const steps = [
    { cls: "br-1", big: fmt(total), cap: goalId ? `left for ${g.name}` : `left across everything due by ${niceDue(g.due)}` },
    { cls: "br-2", big: `${wd} days`, cap: "that you actually work, between now and then" },
    { cls: "br-3", big: fmt(Math.ceil(perDay)), cap: "on each of those days" },
    { cls: "br-4", big: hrs(perHour), cap: `of work, at ${fmt(c.avgRate, true)} an hour` }
  ];

  $("#breatheInner").innerHTML = steps.map((s, i) => `
    <div class="br-step" style="animation-delay:${i * 0.75 + 0.15}s">
      <p class="br-big ${s.cls}">${s.big}</p>
      <p class="br-cap">${s.cap}</p>
    </div>
    ${i < steps.length - 1 ? `<span class="br-arrow br-step" style="animation-delay:${i * 0.75 + 0.5}s"></span>` : ""}
  `).join("") + `
    <p class="br-tail br-step" style="animation-delay:${steps.length * 0.75 + 0.2}s">
      That's the whole thing. Not ${fmt(total)} — just ${hrs(perHour)}, today.
    </p>`;

  $("#breathe").hidden = false;
  document.body.style.overflow = "hidden";
}
function closeBreathe() {
  $("#breathe").hidden = true;
  if ($("#sheet").hidden) document.body.style.overflow = "";
}

/* ══════════════════════════════════════════════════════════════
   THE BURDEN SIMULATOR
   ══════════════════════════════════════════════════════════════ */

function runSim() {
  const amt = Number($("#simAmount").value);
  const label = $("#simLabel").value.trim();
  const out = $("#simOut");
  if (!(amt > 0)) { out.hidden = true; return toast("Put in an amount first"); }

  const base = compute();
  const after = compute(-amt);

  const extraHours = base.avgRate > 0 ? amt / base.avgRate : 0;
  const extraShifts = base.avgShiftHours > 0 ? extraHours / base.avgShiftHours : 0;
  const dailyDelta = after.required - base.required;
  const delayDays = base.required > 0 ? amt / base.required : 0;

  const items = [];
  items.push(`<b>${hrs(extraHours)}</b> of extra work${
    extraShifts >= 0.6 ? ` — about <b>${extraShifts < 1.5 ? "1 shift" : Math.round(extraShifts) + " shifts"}</b>` : ""}`);

  if (base.hasGoals && dailyDelta > 0.005) {
    items.push(`Your daily number goes <b>${fmt(Math.ceil(base.required))} → ${fmt(Math.ceil(after.required))}</b>, every working day from here`);
  }
  if (base.hasGoals && base.binding && delayDays >= 0.5) {
    items.push(`<b>${base.binding.name}</b> lands about <b>${Math.round(delayDays)} working day${Math.round(delayDays) === 1 ? "" : "s"}</b> later, unless you make it up`);
  }
  if (base.surplus > 0) {
    items.push(base.surplus >= amt
      ? `You have <b>${fmt(base.surplus)}</b> spare beyond your goals — this comes out of that, not out of them`
      : `You only have <b>${fmt(base.surplus)}</b> spare beyond your goals`);
  }

  let verdict, vClass;
  if (!base.hasGoals) {
    verdict = `No goals set yet, so there's nothing for this to push back. It's ${hrs(extraHours)} of your time.`;
    vClass = "ok";
  } else if (after.atRisk && !base.atRisk) {
    verdict = `This is the one that tips it. After this, ${base.binding?.name || "your goal"} needs more hours than you're allowed to work.`;
    vClass = "care";
  } else if (base.surplus >= amt) {
    verdict = `You can afford this without touching your goals.`;
    vClass = "ok";
  } else if (dailyDelta > base.required * 0.15) {
    verdict = `Affordable, but it's a real dent — your daily number goes up by about ${Math.round(dailyDelta / base.required * 100)}%.`;
    vClass = "care";
  } else {
    verdict = `Manageable. It moves your daily number by ${fmt(Math.ceil(dailyDelta))} — small, but it is real.`;
    vClass = "ok";
  }

  out.hidden = false;
  out.innerHTML = `
    <p class="sim-hero">${hrs(extraHours)}<small>${label ? esc(label) + " — " : ""}${fmt(amt)} priced in your time</small></p>
    <div class="sim-list">${items.map(t => `<div class="sim-item"><span class="sim-bullet">→</span><span>${t}</span></div>`).join("")}</div>
    <div class="sim-verdict ${vClass}">${verdict}</div>`;
}

/* ══════════════════════════════════════════════════════════════
   EXCEL EXPORT
   ══════════════════════════════════════════════════════════════ */

let xlsxLoading = null;
function loadXLSX() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  if (xlsxLoading) return xlsxLoading;
  xlsxLoading = new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
    s.onload = () => res(window.XLSX);
    s.onerror = () => rej(new Error("could not load the spreadsheet library"));
    document.head.appendChild(s);
  });
  return xlsxLoading;
}

async function exportMonth() {
  const btn = $("#exportBtn");
  btn.disabled = true;
  btn.textContent = "Building…";
  try {
    const XLSX = await loadXLSX();
    const m = state.logMonth || monthOf(TODAY());
    const c = compute();
    const inM = x => monthOf(x.date) === m;

    const sh = state.shifts.filter(inM).slice().sort((a, b) => a.date < b.date ? -1 : 1);
    const inc = state.income.filter(inM).slice().sort((a, b) => a.date < b.date ? -1 : 1);
    const ex = state.expenses.filter(inM).slice().sort((a, b) => a.date < b.date ? -1 : 1);

    const earned = sum(sh, s => s.gross) + sum(inc, i => i.amount);
    const spent = sum(ex, e => e.amount);
    const hoursWorked = sum(sh, s => s.hours);

    const byCat = {};
    ex.forEach(e => { byCat[e.category || "other"] = (byCat[e.category || "other"] || 0) + Number(e.amount || 0); });

    const wb = XLSX.utils.book_new();
    const label = new Date(+m.slice(0, 4), +m.slice(5, 7) - 1, 1)
      .toLocaleDateString("en-AU", { month: "long", year: "numeric" });

    /* summary */
    const summary = [
      ["Pace — monthly summary"], [label], [],
      ["Earned", earned], ["Spent", spent], ["Kept", earned - spent], [],
      ["Hours worked", hoursWorked],
      ["Shifts", sh.length],
      ["Average rate", hoursWorked ? sum(sh, s => s.gross) / hoursWorked : 0], [],
      ["Where it went"], ...Object.entries(byCat)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => [CATS[k]?.label || k, v]),
      [],
      ["Goals as at " + TODAY()], ["Goal", "Target", "Funded", "Remaining", "Due", "Per working day"],
      ...c.goals.map(g => [g.name, g.amount, g._funded, g._remaining, g.due, g._solo])
    ];
    const ws1 = XLSX.utils.aoa_to_sheet(summary);
    ws1["!cols"] = [{ wch: 26 }, { wch: 13 }, { wch: 13 }, { wch: 13 }, { wch: 13 }, { wch: 16 }];
    XLSX.utils.book_append_sheet(wb, ws1, "Summary");

    /* transactions */
    const tx = [["Date", "Type", "Detail", "Category", "In", "Out"]];
    sh.forEach(s => tx.push([s.date, "Shift", `${s.job || "Shift"} (${s.hours} h @ ${s.rate})`, "", s.gross, ""]));
    inc.forEach(i => tx.push([i.date, "Income", i.source || "Income", "", i.amount, ""]));
    ex.forEach(e => tx.push([e.date, "Spend", e.desc || "", CATS[e.category]?.label || e.category, "", e.amount]));
    const body = tx.slice(1).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
    const ws2 = XLSX.utils.aoa_to_sheet([tx[0], ...body]);
    ws2["!cols"] = [{ wch: 12 }, { wch: 10 }, { wch: 34 }, { wch: 15 }, { wch: 11 }, { wch: 11 }];
    XLSX.utils.book_append_sheet(wb, ws2, "Transactions");

    /* hours */
    const hrsRows = [["Date", "Where", "Hours", "Rate", "Earned"]];
    sh.forEach(s => hrsRows.push([s.date, s.job || "", s.hours, s.rate, s.gross]));
    hrsRows.push([], ["Total", "", hoursWorked, "", sum(sh, s => s.gross)]);
    const ws3 = XLSX.utils.aoa_to_sheet(hrsRows);
    ws3["!cols"] = [{ wch: 12 }, { wch: 22 }, { wch: 9 }, { wch: 9 }, { wch: 11 }];
    XLSX.utils.book_append_sheet(wb, ws3, "Hours");

    XLSX.writeFile(wb, `Pace ${label}.xlsx`);
    toast("Spreadsheet ready");
  } catch (err) {
    console.error(err);
    toast("Export failed — check your connection");
  } finally {
    btn.disabled = false;
    btn.textContent = "Export this month to Excel";
  }
}

/* ══════════════════════════════════════════════════════════════
   BACKGROUND JOBS
   ══════════════════════════════════════════════════════════════ */

/** Post any repeating bill that has come due and hasn't posted yet. */
let postingRec = false;
async function postRecurring() {
  if (postingRec || !state.user) return;
  postingRec = true;
  try {
    const today = TODAY();
    const ym = monthOf(today);
    const dom = parseISO(today).getDate();

    for (const r of state.recurring) {
      if (r.active === false) continue;
      const freq = r.freq || "monthly";
      const base = {
        amount: Number(r.amount) || 0,
        category: r.category || "other",
        desc: r.desc || "Bill",
        recurringId: r.id
      };

      if (freq === "monthly") {
        if (dom < (r.dayOfMonth || 1)) continue;
        if (r.lastPosted === ym) continue;
        const day = String(r.dayOfMonth || 1).padStart(2, "0");
        await setDoc(doc(db, "expenses", `rec_${r.id}_${ym}`),
          { ...base, date: `${ym}-${day}`, createdAt: Date.now() });
        await updateDoc(doc(db, "recurring", r.id), { lastPosted: ym });
        continue;
      }

      // Weekly / fortnightly: catch up over a bounded window.
      // Doc ids are deterministic, so re-running never duplicates a spend.
      const floor = addDays(today, -45);
      let from = recStart(r) > floor ? recStart(r) : floor;
      if (r.lastPosted && String(r.lastPosted).length === 10) {
        const after = addDays(r.lastPosted, 1);
        if (after > from) from = after;
      }
      const dates = recOccurrences(r, from, today);
      for (const dt of dates) {
        await setDoc(doc(db, "expenses", `rec_${r.id}_${dt}`),
          { ...base, date: dt, createdAt: Date.now() });
      }
      if (dates.length) {
        await updateDoc(doc(db, "recurring", r.id), { lastPosted: dates[dates.length - 1] });
      }
    }
  } catch (e) { console.warn("recurring", e); }
  postingRec = false;
}

/** Mark (or unmark) today as a day you're not working. */
async function toggleRest() {
  const t = TODAY();
  try {
    if (state.restDays.has(t)) {
      await deleteDoc(doc(db, "restdays", t));
      toast("Today counts again");
    } else {
      await setDoc(doc(db, "restdays", t), { at: Date.now() });
      toast("Today's off — it spreads into the days ahead");
    }
  } catch (e) { toast("Couldn't save that"); }
}

/** Remember today's number so tomorrow can show how it moved. */
let snapDone = "";
async function saveSnapshot(c) {
  const today = TODAY();
  if (snapDone === today || !state.user || !c.hasGoals) return;
  snapDone = today;
  try {
    await setDoc(doc(db, "snapshots", today), {
      required: +c.required.toFixed(2), pool: +c.pool.toFixed(2), at: Date.now()
    }, { merge: true });
  } catch (e) { /* non-critical */ }
}

/* ══════════════════════════════════════════════════════════════
   NAV + EVENTS
   ══════════════════════════════════════════════════════════════ */

function switchTab(name) {
  state.tab = name;
  $$("#main .deck").forEach(d => { d.hidden = d.dataset.deck !== name; });
  $$("#tabs .tab").forEach(t => t.classList.toggle("on", t.dataset.tab === name));
  const deck = $(`.deck[data-deck="${name}"]`);
  if (deck) { deck.style.animation = "none"; void deck.offsetWidth; deck.style.animation = ""; }
  window.scrollTo({ top: 0, behavior: "instant" });
}

function wire() {
  $("#tabs").addEventListener("click", e => {
    const t = e.target.closest(".tab");
    if (t) switchTab(t.dataset.tab);
  });

  $("#settingsBtn").addEventListener("click", sheetSettings);
  $("#sheetClose").addEventListener("click", closeSheet);
  $("#scrim").addEventListener("click", closeSheet);
  $("#breatheClose").addEventListener("click", closeBreathe);
  $("#bigNumber").addEventListener("click", () => openBreathe(null));
  $("#restBtn").addEventListener("click", toggleRest);
  $("#addGoalBtn").addEventListener("click", () => sheetGoal(null));
  $("#addRecBtn").addEventListener("click", () => sheetRecurring(null));
  $("#simBtn").addEventListener("click", runSim);
  $("#simAmount").addEventListener("keydown", e => { if (e.key === "Enter") runSim(); });
  $("#exportBtn").addEventListener("click", exportMonth);

  $$(".quick-btn").forEach(b => b.addEventListener("click", () => {
    ({ shift: sheetShift, expense: sheetExpense, income: sheetIncome })[b.dataset.add]();
  }));

  $("#logFilter").addEventListener("click", e => {
    const c = e.target.closest(".chip");
    if (!c) return;
    state.logFilter = c.dataset.filter;
    $$("#logFilter .chip").forEach(x => x.classList.toggle("on", x === c));
    renderLog(compute());
  });

  $("#monthPrev").addEventListener("click", () => {
    const [y, m] = (state.logMonth || monthOf(TODAY())).split("-").map(Number);
    const d = new Date(y, m - 2, 1);
    state.logMonth = localISO(d).slice(0, 7);
    renderLog(compute());
  });
  $("#monthNext").addEventListener("click", () => {
    const [y, m] = (state.logMonth || monthOf(TODAY())).split("-").map(Number);
    const d = new Date(y, m, 1);
    const next = localISO(d).slice(0, 7);
    if (next > monthOf(TODAY())) return;
    state.logMonth = next;
    renderLog(compute());
  });

  /* delegated clicks across rendered content */
  document.addEventListener("click", async e => {
    if (e.target.closest("[data-close]")) { closeSheet(); return; }

    const go = e.target.closest("[data-go]");
    if (go) { e.preventDefault(); switchTab(go.dataset.go); return; }

    const eg = e.target.closest("[data-editgoal]");
    if (eg) { sheetGoal(eg.dataset.editgoal); return; }

    const gr = e.target.closest("[data-goalrow]");
    if (gr) {
      state.openGoal = state.openGoal === gr.dataset.goalrow ? null : gr.dataset.goalrow;
      renderGoals(compute());
      return;
    }

    const dn = e.target.closest("[data-done]");
    if (dn) { sheetComplete(dn.dataset.done); return; }

    const ro = e.target.closest("[data-reopen]");
    if (ro) { reopenGoal(ro.dataset.reopen); return; }

    const pb = e.target.closest("[data-prio]");
    if (pb) { sheetPriority(pb.dataset.prio); return; }

    const bg = e.target.closest("[data-breathegoal]");
    if (bg) { openBreathe(bg.dataset.breathegoal); return; }

    const er = e.target.closest("[data-editrec]");
    if (er) { sheetRecurring(er.dataset.editrec); return; }

    if (e.target.closest("#seedBtn")) { seedGoals(); return; }

    const del = e.target.closest("[data-del]");
    if (del) {
      const [kind, id] = del.dataset.del.split(":");
      const col = { shift: "shifts", income: "income", expense: "expenses" }[kind];
      if (!col) return;
      if (!confirm("Delete this entry?")) return;
      await deleteDoc(doc(db, col, id));
      toast("Deleted");
    }
  });

  document.addEventListener("keydown", e => {
    if (e.key !== "Escape") return;
    if (!$("#breathe").hidden) closeBreathe();
    else if (!$("#sheet").hidden) closeSheet();
  });

  /* a day can roll over while the app sits open on the home screen */
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.user) {
      postRecurring();
      renderAll();
    }
  });
}

/** Optional starter goals, offered on the empty state. */
async function seedGoals() {
  const seeds = [
    { name: "TR visa application", amount: 6100, due: "2026-12-15", type: "goal" },
    { name: "Masters — semester 1", amount: 21200, due: "2027-06-01", type: "goal" },
    { name: "Savings buffer", amount: 5000, due: "2027-06-01", type: "goal" }
  ];
  for (const s of seeds) {
    await addDoc(collection(db, "goals"), { ...s, active: true, createdAt: Date.now() });
  }
  toast("Three goals added — edit any of them");
}

/* ══════════════════════════════════════════════════════════════
   DATA + AUTH
   ══════════════════════════════════════════════════════════════ */

function watch(name, key, sortKey) {
  onSnapshot(collection(db, name), snap => {
    const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (sortKey) rows.sort((a, b) => (a[sortKey] < b[sortKey] ? -1 : a[sortKey] > b[sortKey] ? 1 : 0));
    state[key] = rows;
    state.ready.add(key);
    renderAll();
  }, err => {
    console.error(name, err);
    toast("Can't reach your data — check the Firestore rules are deployed");
  });
}

function startData() {
  onSnapshot(doc(db, "config", "profile"), snap => {
    state.profile = { ...DEFAULT_PROFILE, ...(snap.data() || {}) };
    state.ready.add("profile");
    renderAll();
    if (!state.profile.setupDone && $("#sheet").hidden) sheetWelcome();
  }, err => console.error("profile", err));

  watch("goals", "goals", "due");
  watch("shifts", "shifts", "date");
  watch("income", "income", "date");
  watch("expenses", "expenses", "date");
  watch("recurring", "recurring", "createdAt");

  onSnapshot(collection(db, "restdays"), snap => {
    state.restDays = new Set(snap.docs.map(d => d.id));
    renderAll();
  }, err => console.error("restdays", err));

  setTimeout(postRecurring, 1500);
}

onAuthStateChanged(auth, user => {
  $("#boot").hidden = true;

  if (!user) {
    state.user = null;
    $("#gate").hidden = false;
    $("#app").hidden = true;
    return;
  }
  if ((user.email || "").toLowerCase() !== OWNER_EMAIL.toLowerCase()) {
    $("#gateMsg").textContent = `${user.email} isn't the account this app belongs to.`;
    signOut(auth);
    return;
  }

  state.user = user;
  $("#gate").hidden = true;
  $("#app").hidden = false;
  startData();
});

$("#signInBtn").addEventListener("click", async () => {
  $("#gateMsg").textContent = "";
  try {
    await signInWithPopup(auth, new GoogleAuthProvider());
  } catch (err) {
    console.error(err);
    $("#gateMsg").textContent = err.code === "auth/popup-blocked"
      ? "Your browser blocked the popup — allow popups and try again."
      : err.code === "auth/operation-not-allowed"
        ? "Google sign-in isn't switched on for this project yet."
        : "Couldn't sign in. Try again.";
  }
});

/* ─────────── go ─────────── */
wire();
if ("serviceWorker" in navigator) {
  // A new worker taking over means new code is live — pick it up without a manual refresh.
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").then(reg => {
      reg.update().catch(() => {});
      setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
    }).catch(() => {});
  });
}
