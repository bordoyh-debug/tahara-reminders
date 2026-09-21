// ============================================================================
// tahara-send-reminders — scheduled script (GitHub Actions cron)
// ============================================================================
// This is the "no credit card needed" twin of the Cloud Function in
// ../cloud-function/index.js — same reminder logic byte-for-byte, just a
// different entry point at the bottom (a plain script that runs to
// completion and exits, instead of an HTTP request handler), since GitHub
// Actions has no notion of Cloud Functions' (req,res) signature. See
// ../push-notifications-setup-guide.md for why either exists at all — the
// Cloud Function needs a paid (Blaze) Firebase plan to deploy at all, even
// though real usage cost is 0 ₪ at this scale; this version runs on
// GitHub's own free scheduled-workflow minutes instead, no card required
// anywhere, at the cost of the timing being "best effort" rather than a
// guaranteed exact interval (GitHub can delay a scheduled run under load —
// occasionally by a fair number of minutes, rarely more).
//
// It re-implements, in Node, the SAME three reminder rules already shown as
// in-app banners on the calendar screen client-side (buildTopBannersHtml in
// the main app) — hefsek reminder, mikveh/tevilah reminder, bedika reminder
// — but sends a REAL phone push via Firebase Cloud Messaging to every device
// a woman has registered (see enablePush() / "התראות אמיתיות בטלפון" in
// Settings), reading her data straight from the same Firestore document her
// phone already keeps synced (users/{uid}.data).
//
// This file intentionally duplicates a small, careful subset of the client's
// halachic day-counting logic (the "half-day slot" onah model — see
// vesetRelativeSlot below) rather than importing the app's own code, since
// the app is a single browser-only HTML file with no shared module to import
// from. If that logic is ever changed in the app (tahara_prototype.html),
// the equivalent change needs to be made here too — look for functions with
// matching names and comments in the main file.
// ============================================================================

const admin = require('firebase-admin');
// @hebcal/core (used client-side, for Hebrew-date display the app needs and
// this script doesn't) publishes ESM-only in this version, which this plain
// CommonJS script can't require() — see the comment on sunsetOf() below for
// why suncalc is used here instead, just for the one thing this script
// actually needs: today's sunset time.
const suncalc = require('suncalc');

// GitHub Actions has no automatic Google credentials the way a Cloud
// Function does, so the workflow writes the Firebase service-account key
// (stored as a GitHub secret — see the setup guide) to this path before
// running the script; GOOGLE_APPLICATION_CREDENTIALS is how the Admin SDK
// picks it up automatically.
admin.initializeApp({
  credential: admin.credential.applicationDefault(),
});
const db = admin.firestore();
const messaging = admin.messaging();

// All of the app's own time-of-day concepts (reminder times, sunset,
// "today") are implicitly Israel-local — the client just uses the phone's
// own clock, which for this app's actual users is always Israel time.
// GitHub Actions runners run in UTC, so without this, every "07:00" / "3
// hours before sunset" check below would silently be off by 2-3 hours.
process.env.TZ = 'Asia/Jerusalem';

const LOCATIONS = [
  { id: 'jerusalem', name: 'ירושלים', lat: 31.7683, lon: 35.2137, tzid: 'Asia/Jerusalem' },
  { id: 'telaviv', name: 'תל אביב', lat: 32.0853, lon: 34.7818, tzid: 'Asia/Jerusalem' },
  { id: 'haifa', name: 'חיפה', lat: 32.7940, lon: 34.9896, tzid: 'Asia/Jerusalem' },
  { id: 'beersheva', name: 'באר שבע', lat: 31.2530, lon: 34.7915, tzid: 'Asia/Jerusalem' },
  { id: 'bneibrak', name: 'בני ברק', lat: 32.0807, lon: 34.8338, tzid: 'Asia/Jerusalem' },
  { id: 'ashdod', name: 'אשדוד', lat: 31.7940, lon: 34.6446, tzid: 'Asia/Jerusalem' },
];

// ---------------------------------------------------------------- date utils
function diffDaysSimple(a, b) { return Math.round((b - a) / 86400000); }
function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }
function toKey(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function parseKey(k) { const [y, m, dd] = k.split('-').map(Number); return new Date(y, m - 1, dd); }

// ------------------------------------------------- halachic onah day model
// Mirrors resolveHefsekDayNum / effectiveVesetSpan / vesetRelativeSlot /
// vesetJewishDayOf / vesetSlotInfo in tahara_prototype.html — see that
// file's comments for the full derivation ("half-day slot" model).
function resolveHefsekDayNum(data) {
  const m = data.minhagim || {};
  if (m.hefsekDay === 'day4') return 4;
  if (m.hefsekDay === 'day5') return 5;
  if (m.hefsekDay === 'custom') return Math.max(1, parseInt(m.hefsekDayCustom, 10) || 5);
  return data.profile === 'ovadia' ? 4 : 5;
}
function effectiveVesetSpan(ev, hefsekDayNum) { return Math.max(ev.span, hefsekDayNum); }
function vesetRelativeSlot(ev, date, half) {
  const offsetDays = diffDaysSimple(ev.date, date);
  const halfAtQuery = half === 'bottom' ? 1 : 0;
  const halfAtOnset = ev.onah === 'night' ? 1 : 0;
  return offsetDays * 2 + halfAtQuery - halfAtOnset + 1;
}
function vesetJewishDayOf(ev, date, half) { return Math.ceil(vesetRelativeSlot(ev, date, half) / 2); }
function vesetSlotInfo(ev, date, half, hefsekDayNum) {
  const relativeSlot = vesetRelativeSlot(ev, date, half);
  const span = effectiveVesetSpan(ev, hefsekDayNum);
  if (relativeSlot < 1 || relativeSlot > span * 2) return null;
  return { relativeSlot, jewishDay: Math.ceil(relativeSlot / 2) };
}

function parsedVesetEvents(data) {
  return (data.vesetEvents || []).map(raw => ({ date: parseKey(raw.date), onah: raw.onah, span: raw.span }));
}

function inPregnancy(data, d) {
  const p = data.pregnancy;
  if (!p || !p.start) return false;
  const start = parseKey(p.start);
  if (p.birth) return d >= start && d <= parseKey(p.birth);
  return d >= start; // no reported end yet — treat as ongoing, same as the client
}

// is `d` (top OR bottom half) covered by any veset's current niddah span,
// and not suppressed by an active pregnancy? Mirrors buildDayModels' niddah
// painting loop.
function isNiddahDay(data, d, hefsekDayNum) {
  if (inPregnancy(data, d)) return false;
  return parsedVesetEvents(data).some(ev =>
    !!(vesetSlotInfo(ev, d, 'top', hefsekDayNum) || vesetSlotInfo(ev, d, 'bottom', hefsekDayNum))
  );
}

function vesetDayIndexFor(data, d, hefsekDayNum) {
  let idx = null;
  parsedVesetEvents(data).forEach(ev => {
    const info = vesetSlotInfo(ev, d, 'top', hefsekDayNum) || vesetSlotInfo(ev, d, 'bottom', hefsekDayNum);
    if (info) idx = info.jewishDay;
  });
  return idx;
}

// mirrors buildDayModels' hefsekEvents loop: H itself is "isHefsekDay" (last
// day of the veset, not yet a nekiim day); H+1..H+6 are nekiim days 1-6;
// H+7 is nekiim day 7 / tevilah. A day covered by more than one hefsek
// cycle can't normally happen (hefsek clips the veset first), so the first
// match found is used, same as the client's "last one wins" forEach.
function nekiimInfoFor(data, d) {
  let result = null;
  (data.hefsekEvents || []).forEach(raw => {
    const H = parseKey(raw.date);
    const diff = diffDaysSimple(H, d);
    if (diff === 0) result = { isHefsekDay: true, nekiimDayIndex: null, isTevilah: false };
    else if (diff >= 1 && diff <= 6) result = { isHefsekDay: false, nekiimDayIndex: diff, isTevilah: false };
    else if (diff === 7) result = { isHefsekDay: false, nekiimDayIndex: 7, isTevilah: true };
  });
  return result;
}

function locationFor(data) {
  if (data.locId === 'current' && data.customLocation) {
    return { lat: data.customLocation.lat, lon: data.customLocation.lon };
  }
  const l = LOCATIONS.find(x => x.id === data.locId) || LOCATIONS[0];
  return { lat: l.lat, lon: l.lon };
}
// suncalc reads the calendar day off the Date object's UTC fields, so a
// local-midnight Date (e.g. `today` below, built with `new Date(); setHours
// (0,0,0,0)` under process.env.TZ='Asia/Jerusalem') is actually still the
// PREVIOUS day in UTC during Israel's UTC+2/+3 offset — feeding it straight
// in would silently compute the wrong day's sunset. Anchoring to UTC NOON
// of the same intended calendar day sidesteps that entirely while still
// landing on the correct date everywhere sunset can plausibly occur.
function sunsetOf(data, d) {
  const loc = locationFor(data);
  const noonUtc = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), 12));
  return suncalc.getTimes(noonUtc, loc.lat, loc.lon).sunset;
}

// -------------------------------------------------------------- FCM sending
async function sendToUser(uid, tokensSnap, title, body) {
  const tokens = tokensSnap.docs.map(d => d.id);
  if (!tokens.length) return;
  const resp = await messaging.sendEachForMulticast({
    tokens,
    notification: { title, body },
    webpush: { fcmOptions: { link: '/' } },
  });
  // prune tokens Firebase reports as dead (uninstalled / permission revoked
  // / expired) so this collection doesn't grow forever with junk.
  await Promise.all(resp.responses.map((r, i) => {
    if (r.success) return null;
    const code = r.error && r.error.code;
    if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') {
      return tokensSnap.docs[i].ref.delete().catch(() => {});
    }
    return null;
  }));
}

// ------------------------------------------------------------------ main
async function main() {
  const now = new Date();
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const todayKey = toKey(today);

  const usersSnap = await db.collection('users').get();
  let sent = 0, checked = 0;

  for (const userDoc of usersSnap.docs) {
    const uid = userDoc.id;
    const doc = userDoc.data();
    const data = doc && doc.data;
    if (!data) continue;

    const tokensSnap = await db.collection('users').doc(uid).collection('fcmTokens').get();
    if (tokensSnap.empty) continue;
    checked++;

    const hefsekDayNum = resolveHefsekDayNum(data);
    const pushState = doc.pushState || {};
    const updates = {};
    const reminders = data.reminders || {};

    // --- 1. Hefsek reminder — ~3 hours before sunset, on the hefsek day itself ---
    try {
      if (reminders.hefsek && isNiddahDay(data, today, hefsekDayNum)) {
        const dayIndex = vesetDayIndexFor(data, today, hefsekDayNum);
        if (dayIndex === hefsekDayNum) {
          const sset = sunsetOf(data, today);
          const threeHoursBefore = new Date(sset.getTime() - 3 * 60 * 60 * 1000);
          if (now >= threeHoursBefore && now < sset && pushState.lastHefsekSentDate !== todayKey) {
            await sendToUser(uid, tokensSnap, 'לוח טהרה', 'היום יום ' + hefsekDayNum + ' לוסת — כדאי לעשות הפסק טהרה עכשיו, לפני השקיעה.');
            updates.lastHefsekSentDate = todayKey;
            sent++;
          }
        }
      }
    } catch (e) { console.error('hefsek reminder failed for', uid, e); }

    // --- 2. Mikveh/tevilah reminder — once per cycle, as tevilah approaches ---
    try {
      if (reminders.mikveh !== false) {
        for (let i = 0; i <= 5; i++) {
          const d = addDays(today, i);
          const nek = nekiimInfoFor(data, d);
          if (nek && nek.isTevilah) {
            const dKey = toKey(d);
            if (pushState.lastMikvehSentForDate !== dKey) {
              const msg = i === 0
                ? 'היום יום הטבילה במקווה!'
                : ('עוד ' + i + (i === 1 ? ' יום' : ' ימים') + ' לטבילה במקווה — כדאי לתאם תור.');
              await sendToUser(uid, tokensSnap, 'לוח טהרה', msg);
              updates.lastMikvehSentForDate = dKey;
              sent++;
            }
            break;
          }
        }
      }
    } catch (e) { console.error('mikveh reminder failed for', uid, e); }

    // --- 3. Bedika reminder — morning/evening/days147/twice, per her settings ---
    try {
      const bedikaMode = reminders.bedikaMode || 'twice';
      if (bedikaMode !== 'none') {
        const nek = nekiimInfoFor(data, today);
        if (nek && !nek.isHefsekDay && !nek.isTevilah) {
          const times = data.reminderTimes || { morning: '07:00', evening: '16:00' };
          // "has the target time already arrived today?" rather than a fixed
          // window — the pushState de-dup check below is what stops a repeat
          // send, so this stays correct however often (or irregularly) the
          // job actually runs, instead of silently missing a day if a run
          // gets delayed past a fixed window's end.
          function hasArrived(hhmm) {
            const [hh, mm] = String(hhmm).split(':').map(Number);
            const target = new Date(today); target.setHours(hh, mm, 0, 0);
            return now >= target;
          }
          let doMorning = false, doEvening = false;
          if (bedikaMode === 'twice') { doMorning = hasArrived(times.morning); doEvening = hasArrived(times.evening); }
          else if (bedikaMode === 'morning') { doMorning = hasArrived(times.morning); }
          else if (bedikaMode === 'evening') { doEvening = hasArrived(times.evening); }
          else if (bedikaMode === 'days147') {
            if ([1, 4, 7].includes(nek.nekiimDayIndex)) doMorning = hasArrived(times.morning);
          }
          if (doMorning && pushState.lastBedikaMorningSentDate !== todayKey) {
            await sendToUser(uid, tokensSnap, 'לוח טהרה', 'אל תשכחי את בדיקת הבוקר של היום.');
            updates.lastBedikaMorningSentDate = todayKey;
            sent++;
          }
          if (doEvening && pushState.lastBedikaEveningSentDate !== todayKey) {
            await sendToUser(uid, tokensSnap, 'לוח טהרה', 'אל תשכחי את בדיקת הערב של היום.');
            updates.lastBedikaEveningSentDate = todayKey;
            sent++;
          }
        }
      }
    } catch (e) { console.error('bedika reminder failed for', uid, e); }

    if (Object.keys(updates).length) {
      await db.collection('users').doc(uid).set({ pushState: { ...pushState, ...updates } }, { merge: true });
    }
  }

  console.log(`ok — checked ${checked} users with registered devices, sent ${sent} notifications`);
}

// Only actually runs main() when this file is executed directly (`node
// index.js`, which is what the GitHub Actions workflow does) — requiring it
// from test.js, below, does not trigger a real Firestore/FCM run.
if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch(err => { console.error('sendReminders run failed:', err); process.exit(1); });
}

// exported only so this file's own test suite (test.js) can exercise the
// pure date/halacha logic directly, without needing real Firebase
// credentials.
exports._internal = { resolveHefsekDayNum, effectiveVesetSpan, vesetSlotInfo, vesetJewishDayOf, isNiddahDay, vesetDayIndexFor, nekiimInfoFor, sunsetOf, inPregnancy, toKey, parseKey, addDays };
