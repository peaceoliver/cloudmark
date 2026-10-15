const test = require('node:test');
const assert = require('node:assert/strict');
const parser = require('../public/js/task-parser');

// 2026-10-15 csütörtök, 10:00 budapesti idő szerint (UTC+2, nyári idő).
const NOW = '2026-10-15T08:00:00Z';
const TZ = 'Europe/Budapest';
const parse = text => parser.parse(text, { now: NOW, timeZone: TZ });

test('dátum, időpont, prioritás, címke és projekt egy mondatból', () => {
    const result = parse('holnap 9-kor számla befizetése !1 #pénzügy @Otthon');
    assert.equal(result.title, 'számla befizetése');
    assert.equal(result.dueDate, '2026-10-16');
    assert.equal(result.dueTime, '09:00');
    assert.equal(result.dueAt, '2026-10-16T07:00:00.000Z');
    assert.equal(result.dueAllDay, false);
    assert.equal(result.priority, 1);
    assert.deepEqual(result.tags, ['pénzügy']);
    assert.equal(result.project, 'Otthon');
    assert.deepEqual(result.tokens.map(token => token.kind), ['date', 'time', 'priority', 'tag', 'project']);
});

test('relatív napok és hétnapok', () => {
    assert.equal(parse('ma bevásárlás').dueDate, '2026-10-15');
    assert.equal(parse('holnapután edzés').dueDate, '2026-10-17');
    assert.equal(parse('hétfőn megbeszélés').dueDate, '2026-10-19');
    assert.equal(parse('csütörtökön valami').dueDate, '2026-10-22', 'a mai hétnap a következő hétre esik');
    assert.equal(parse('jövő szerdán fogorvos').dueDate, '2026-10-21');
    assert.equal(parse('jövő héten tervezés').dueDate, '2026-10-19');
    assert.equal(parse('hétvégén takarítás').dueDate, '2026-10-17');
    assert.equal(parse('hónap végén számla').dueDate, '2026-10-31');
    assert.equal(parse('3 nap múlva csomag').dueDate, '2026-10-18');
    assert.equal(parse('két hét múlva csomag').dueDate, '2026-10-29');
    assert.equal(parse('ma bevásárlás').dueAllDay, true);
});

test('pontos dátumok', () => {
    assert.equal(parse('okt 20 vizsga').dueDate, '2026-10-20');
    assert.equal(parse('október 20-án vizsga').dueDate, '2026-10-20');
    assert.equal(parse('2027.01.05 határidő').dueDate, '2027-01-05');
    assert.equal(parse('10.20. vizsga').dueDate, '2026-10-20');
    assert.equal(parse('márc 3 adóbevallás').dueDate, '2027-03-03', 'elmúlt dátum a következő évre kerül');
    assert.notEqual(parse('2026.02.30 rossz dátum').dueDate, '2026-02-30');
});

test('időpontok napszakkal', () => {
    assert.equal(parse('délután 3-kor hívás').dueTime, '15:00');
    assert.equal(parse('este 8 film').dueTime, '20:00');
    assert.equal(parse('holnap 9:30 orvos').dueTime, '09:30');
    assert.equal(parse('holnap fél 3-kor').dueTime, '02:30');
    assert.equal(parse('holnap du fél 3-kor').dueTime, '14:30');
    assert.equal(parse('14h meeting').dueTime, '14:00');
    assert.equal(parse('délben ebéd').dueTime, '12:00');
});

test('csak időpont: ma, vagy holnap, ha már elmúlt', () => {
    assert.equal(parse('15:00 hívás').dueDate, '2026-10-15');
    assert.equal(parse('8-kor hívás').dueDate, '2026-10-16');
});

test('ismétlődések', () => {
    const daily = parse('minden nap gyógyszer 8-kor');
    assert.equal(daily.recurrenceRule, 'FREQ=DAILY');
    assert.equal(daily.title, 'gyógyszer');
    assert.equal(daily.dueDate, '2026-10-16');
    assert.equal(parse('minden hétfőn és csütörtökön edzés').recurrenceRule, 'FREQ=WEEKLY;BYDAY=MO,TH');
    assert.equal(parse('minden hétfőn és csütörtökön edzés').dueDate, '2026-10-15');
    assert.equal(parse('minden hétfőn heti terv').dueDate, '2026-10-19');
    assert.equal(parse('minden hétköznap standup').recurrenceRule, 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR');
    assert.equal(parse('kéthetente szemét').recurrenceRule, 'FREQ=WEEKLY;INTERVAL=2');
    assert.equal(parse('minden hónap 1-jén lakbér').recurrenceRule, 'FREQ=MONTHLY;BYMONTHDAY=1');
    assert.equal(parse('minden hónap 1-jén lakbér').dueDate, '2026-11-01');
    assert.equal(parse('minden hónap utolsó napján zárás').recurrenceRule, 'FREQ=MONTHLY;BYMONTHDAY=-1');
    assert.equal(parse('évente szerződés').recurrenceRule, 'FREQ=YEARLY');
    assert.equal(parse('3 naponta öntözés').recurrenceRule, 'FREQ=DAILY;INTERVAL=3');
});

test('emlékeztető', () => {
    assert.deepEqual(parse('holnap 9-kor orvos ^30').reminders, [30]);
    assert.deepEqual(parse('holnap 9-kor orvos ^2ó').reminders, [120]);
    assert.deepEqual(parse('holnap orvos emlékeztess 1 nappal előtte').reminders, [1440]);
});

test('ami nem értelmezhető, a címben marad', () => {
    const result = parse('Mama születésnapja email@cim.hu 2 db');
    assert.equal(result.title, 'Mama születésnapja email@cim.hu 2 db');
    assert.equal(result.dueDate, null);
    assert.deepEqual(result.tokens, []);
    assert.equal(parse('mai menü #a #b #a').tags.join(','), 'a,b');
});

test('ismétlődés: következő esedékesség', () => {
    assert.equal(parser.nextOccurrence('FREQ=DAILY', '2026-10-31'), '2026-11-01');
    assert.equal(parser.nextOccurrence('FREQ=WEEKLY;BYDAY=MO,TH', '2026-10-15'), '2026-10-19');
    assert.equal(parser.nextOccurrence('FREQ=WEEKLY;BYDAY=MO,TH', '2026-10-19'), '2026-10-22');
    assert.equal(parser.nextOccurrence('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO', '2026-10-19'), '2026-11-02');
    assert.equal(parser.nextOccurrence('FREQ=WEEKLY;BYDAY=SU', '2026-10-18'), '2026-10-25');
    assert.equal(parser.nextOccurrence('FREQ=MONTHLY', '2026-01-31'), '2026-02-28');
    assert.equal(parser.nextOccurrence('FREQ=MONTHLY;BYMONTHDAY=-1', '2026-01-31'), '2026-02-28');
    assert.equal(parser.nextOccurrence('FREQ=MONTHLY;BYMONTHDAY=15', '2026-10-01'), '2026-10-15');
    assert.equal(parser.nextOccurrence('FREQ=YEARLY', '2028-02-29'), '2029-02-28');
    assert.equal(parser.normalizeRecurrence('freq=weekly;byday=th,mo'), 'FREQ=WEEKLY;BYDAY=MO,TH');
    assert.equal(parser.normalizeRecurrence('FREQ=HOURLY'), null);
    assert.equal(parser.normalizeRecurrence('FREQ=DAILY;COUNT=3'), null);
    assert.equal(parser.describeRecurrence('FREQ=WEEKLY;BYDAY=MO,TH'), 'minden hétfőn, csütörtökön');
});

test('időzóna: téli időszámítás váltása', () => {
    assert.equal(parser.zonedTimeToUtc('2026-10-24', '09:00', TZ).toISOString(), '2026-10-24T07:00:00.000Z');
    assert.equal(parser.zonedTimeToUtc('2026-10-26', '09:00', TZ).toISOString(), '2026-10-26T08:00:00.000Z');
    assert.equal(parser.localDate(new Date('2026-10-15T22:30:00Z'), TZ), '2026-10-16');
});
