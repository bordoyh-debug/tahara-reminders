process.env.TZ = 'Asia/Jerusalem';
const { resolveHefsekDayNum, isNiddahDay, vesetDayIndexFor, nekiimInfoFor, sunsetOf, toKey, addDays } = require('./index.js')._internal;

let failures = 0;
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) { console.log('FAIL:', label, '— got', a, 'expected', e); failures++; }
  else console.log('ok:', label);
}

// --- Scenario: same night-onah example verified against the client (Sunday, span 5) ---
const sunday = new Date(2026, 8, 20); // a Sunday
const dataNight = {
  profile: 'ashkenazi',
  minhagim: {},
  vesetEvents: [{ date: toKey(sunday), onah: 'night', span: 5 }],
  hefsekEvents: [],
  pregnancy: {},
};
const hefsekDayNum = resolveHefsekDayNum(dataNight);
assertEq(hefsekDayNum, 5, 'default (non-ovadia) hefsek day is 5');

const expectedNiddah = [true, true, true, true, true, true, false]; // Sun..Sat — Sun is niddah (bottom), Sat is not
for (let i = 0; i <= 6; i++) {
  const d = addDays(sunday, i);
  assertEq(isNiddahDay(dataNight, d, hefsekDayNum), expectedNiddah[i], 'night-onah isNiddahDay day+' + i);
}
// dayIndex: Sunday should read 1 (from its bottom half), Friday should read 5 (from its top half)
assertEq(vesetDayIndexFor(dataNight, sunday, hefsekDayNum), 1, 'night-onah veset day index on Sunday (onset)');
assertEq(vesetDayIndexFor(dataNight, addDays(sunday, 5), hefsekDayNum), 5, 'night-onah veset day index on Friday (last painted)');
assertEq(vesetDayIndexFor(dataNight, addDays(sunday, 6), hefsekDayNum), null, 'night-onah veset day index on Saturday (first empty day) is null');

// --- Scenario: plain day-onah veset (regression vs. the pre-onah-fix formula) ---
const dataDay = {
  profile: 'ashkenazi',
  minhagim: {},
  vesetEvents: [{ date: toKey(sunday), onah: 'day', span: 5 }],
  hefsekEvents: [],
  pregnancy: {},
};
const expectedNiddahDay = [true, true, true, true, true, false, false];
for (let i = 0; i <= 6; i++) {
  const d = addDays(sunday, i);
  assertEq(isNiddahDay(dataDay, d, hefsekDayNum), expectedNiddahDay[i], 'day-onah isNiddahDay day+' + i);
}
assertEq(vesetDayIndexFor(dataDay, addDays(sunday, 4), hefsekDayNum), 5, 'day-onah veset day index on its 5th (last) day');

// --- Scenario: pregnancy suppresses niddah painting entirely, even mid-veset ---
const dataPreg = {
  profile: 'ashkenazi',
  minhagim: {},
  vesetEvents: [{ date: toKey(sunday), onah: 'day', span: 5 }],
  hefsekEvents: [],
  pregnancy: { start: toKey(addDays(sunday, -30)) },
};
assertEq(isNiddahDay(dataPreg, sunday, hefsekDayNum), false, 'pregnancy suppresses niddah painting');

// --- Scenario: nekiimInfoFor — hefsek on Friday (matches the "still bleeding" example) ---
const friday = addDays(sunday, 5);
const dataHefsek = { hefsekEvents: [{ date: toKey(friday) }] };
assertEq(nekiimInfoFor(dataHefsek, friday), { isHefsekDay: true, nekiimDayIndex: null, isTevilah: false }, 'hefsek day itself');
assertEq(nekiimInfoFor(dataHefsek, addDays(friday, 1)), { isHefsekDay: false, nekiimDayIndex: 1, isTevilah: false }, 'nekiim day 1');
assertEq(nekiimInfoFor(dataHefsek, addDays(friday, 6)), { isHefsekDay: false, nekiimDayIndex: 6, isTevilah: false }, 'nekiim day 6');
assertEq(nekiimInfoFor(dataHefsek, addDays(friday, 7)), { isHefsekDay: false, nekiimDayIndex: 7, isTevilah: true }, 'tevilah day (day 7)');
assertEq(nekiimInfoFor(dataHefsek, addDays(friday, 8)), null, 'day after tevilah is uncovered');

// --- Scenario: sunset calc sanity (Jerusalem, late Sept ~18:38 IDT) ---
const sset = sunsetOf({ locId: 'jerusalem' }, sunday);
const hh = sset.getHours(), mm = sset.getMinutes();
console.log('Jerusalem sunset for', toKey(sunday), '=', sset.toString());
assertEq(hh >= 17 && hh <= 19, true, 'Jerusalem late-Sept sunset falls in a plausible local hour range');

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
