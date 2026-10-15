/**
 * Feladatok dátumkezelése, amit a böngésző és a szerver is használ:
 * - magyar természetes nyelvű gyors-beírás értelmezése („holnap 9-kor számla !1 #pénzügy”),
 * - ismétlődési szabályok (RRULE részhalmaz) ellenőrzése, leírása és a következő esedékesség számítása,
 * - időzóna-átváltás (helyi naptári idő ↔ UTC időpont) Intl segítségével, külső függőség nélkül.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else {
        root.CloudMark = root.CloudMark || {};
        root.CloudMark.taskParser = api;
    }
})(typeof self !== 'undefined' ? self : this, function () {
    const DEFAULT_TIME_ZONE = 'Europe/Budapest';
    const DAY_MS = 86400000;
    const WEEKDAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
    const WEEKDAY_NAMES = ['vasárnap', 'hétfő', 'kedd', 'szerda', 'csütörtök', 'péntek', 'szombat'];
    const WEEKDAY_ON = ['vasárnap', 'hétfőn', 'kedden', 'szerdán', 'csütörtökön', 'pénteken', 'szombaton'];
    const MONTHS = [
        ['január', 'jan'], ['február', 'febr', 'feb'], ['március', 'márc', 'marc', 'mar'], ['április', 'ápr', 'apr'],
        ['május', 'máj', 'maj'], ['június', 'jún', 'jun'], ['július', 'júl', 'jul'], ['augusztus', 'aug'],
        ['szeptember', 'szept', 'szep'], ['október', 'okt'], ['november', 'nov'], ['december', 'dec']
    ];

    // ---- Időzóna segédek ----------------------------------------------------------------------

    const formatterCache = new Map();
    function formatterFor(timeZone) {
        if (!formatterCache.has(timeZone)) {
            formatterCache.set(timeZone, new Intl.DateTimeFormat('en-US', {
                timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
                hour: '2-digit', minute: '2-digit', second: '2-digit'
            }));
        }
        return formatterCache.get(timeZone);
    }

    function isValidTimeZone(timeZone) {
        if (typeof timeZone !== 'string' || !timeZone || timeZone.length > 64) return false;
        try { formatterFor(timeZone); return true; } catch (err) { return false; }
    }

    /** Wall-clock parts of an instant in a time zone. */
    function localParts(date, timeZone) {
        const parts = {};
        for (const part of formatterFor(timeZone).formatToParts(date)) parts[part.type] = part.value;
        return {
            year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
            hour: Number(parts.hour) % 24, minute: Number(parts.minute), second: Number(parts.second)
        };
    }

    function pad(value) { return String(value).padStart(2, '0'); }

    /** Calendar date (YYYY-MM-DD) of an instant in a time zone. */
    function localDate(date, timeZone) {
        const p = localParts(date, timeZone);
        return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
    }

    function localTime(date, timeZone) {
        const p = localParts(date, timeZone);
        return `${pad(p.hour)}:${pad(p.minute)}`;
    }

    function offsetAt(instant, timeZone) {
        const p = localParts(new Date(instant), timeZone);
        return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(instant / 1000) * 1000;
    }

    /** Converts a wall-clock date and time in a time zone to a Date (handles DST changes). */
    function zonedTimeToUtc(dateText, timeText, timeZone) {
        const [year, month, day] = dateText.split('-').map(Number);
        const [hour, minute] = (timeText || '00:00').split(':').map(Number);
        const guess = Date.UTC(year, month - 1, day, hour, minute);
        let result = guess - offsetAt(guess, timeZone);
        const corrected = guess - offsetAt(result, timeZone);
        if (corrected !== result) result = corrected;
        return new Date(result);
    }

    // ---- Naptári számítások (YYYY-MM-DD szövegeken, időzóna nélkül) ---------------------------

    function toUtcDay(dateText) {
        const [year, month, day] = dateText.split('-').map(Number);
        return new Date(Date.UTC(year, month - 1, day));
    }

    function fromUtcDay(date) {
        return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
    }

    function addDays(dateText, days) {
        return fromUtcDay(new Date(toUtcDay(dateText).getTime() + days * DAY_MS));
    }

    function weekdayOf(dateText) { return toUtcDay(dateText).getUTCDay(); }

    function daysInMonth(year, month) { return new Date(Date.UTC(year, month, 0)).getUTCDate(); }

    /** Day `day` of the month `monthOffset` months after the given date; -1 means the last day, overflow clamps. */
    function monthDay(dateText, monthOffset, day) {
        const [year, month] = dateText.split('-').map(Number);
        const index = (month - 1) + monthOffset;
        const targetYear = year + Math.floor(index / 12);
        const targetMonth = ((index % 12) + 12) % 12 + 1;
        const last = daysInMonth(targetYear, targetMonth);
        const resolved = day < 0 ? last + day + 1 : Math.min(day, last);
        return `${targetYear}-${pad(targetMonth)}-${pad(Math.max(resolved, 1))}`;
    }

    function isValidDate(year, month, day) {
        return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
    }

    // ---- Ismétlődés ---------------------------------------------------------------------------

    /** Parses and validates the supported RRULE subset; returns null when the rule is not supported. */
    function parseRecurrence(rule) {
        if (typeof rule !== 'string' || !rule.trim() || rule.length > 200) return null;
        const parts = {};
        for (const chunk of rule.trim().replace(/^RRULE:/i, '').split(';')) {
            const [key, value] = chunk.split('=');
            if (!key || value === undefined) return null;
            parts[key.toUpperCase()] = value.toUpperCase();
        }
        const allowed = ['FREQ', 'INTERVAL', 'BYDAY', 'BYMONTHDAY'];
        if (Object.keys(parts).some(key => !allowed.includes(key))) return null;
        const freq = parts.FREQ;
        if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)) return null;
        const interval = parts.INTERVAL === undefined ? 1 : Number(parts.INTERVAL);
        if (!Number.isInteger(interval) || interval < 1 || interval > 366) return null;
        let byDay = null;
        if (parts.BYDAY !== undefined) {
            if (freq !== 'WEEKLY') return null;
            const codes = parts.BYDAY.split(',');
            if (!codes.length || codes.some(code => !WEEKDAY_CODES.includes(code))) return null;
            byDay = [...new Set(codes.map(code => WEEKDAY_CODES.indexOf(code)))].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
        }
        let byMonthDay = null;
        if (parts.BYMONTHDAY !== undefined) {
            if (freq !== 'MONTHLY') return null;
            byMonthDay = Number(parts.BYMONTHDAY);
            if (!Number.isInteger(byMonthDay) || byMonthDay === 0 || byMonthDay < -1 || byMonthDay > 31) return null;
        }
        return { freq, interval, byDay, byMonthDay };
    }

    /** Canonical text of a supported rule, or null. */
    function normalizeRecurrence(rule) {
        const parsed = parseRecurrence(rule);
        if (!parsed) return null;
        const parts = [`FREQ=${parsed.freq}`];
        if (parsed.interval > 1) parts.push(`INTERVAL=${parsed.interval}`);
        if (parsed.byDay) parts.push(`BYDAY=${parsed.byDay.map(day => WEEKDAY_CODES[day]).join(',')}`);
        if (parsed.byMonthDay) parts.push(`BYMONTHDAY=${parsed.byMonthDay}`);
        return parts.join(';');
    }

    /** The first occurrence strictly after `dateText` (YYYY-MM-DD). */
    function nextOccurrence(rule, dateText) {
        const parsed = typeof rule === 'string' ? parseRecurrence(rule) : rule;
        if (!parsed) return null;
        const { freq, interval, byDay, byMonthDay } = parsed;
        if (freq === 'DAILY') return addDays(dateText, interval);
        if (freq === 'WEEKLY') {
            if (!byDay) return addDays(dateText, 7 * interval);
            const mondayIndex = (weekdayOf(dateText) + 6) % 7;
            const laterThisWeek = byDay.find(day => ((day + 6) % 7) > mondayIndex);
            if (laterThisWeek !== undefined) return addDays(dateText, ((laterThisWeek + 6) % 7) - mondayIndex);
            const nextWeekMonday = addDays(dateText, 7 * interval - mondayIndex);
            return addDays(nextWeekMonday, (byDay[0] + 6) % 7);
        }
        if (freq === 'MONTHLY') {
            const day = Number(dateText.slice(8, 10));
            if (!byMonthDay) return monthDay(dateText, interval, day);
            const sameMonth = monthDay(dateText, 0, byMonthDay);
            if (sameMonth > dateText) return sameMonth;
            return monthDay(dateText, interval, byMonthDay);
        }
        const [year, month, day] = dateText.split('-').map(Number);
        const targetYear = year + interval;
        return `${targetYear}-${pad(month)}-${pad(Math.min(day, daysInMonth(targetYear, month)))}`;
    }

    /** The first occurrence on or after `dateText`. */
    function firstOccurrence(rule, dateText) {
        const parsed = typeof rule === 'string' ? parseRecurrence(rule) : rule;
        if (!parsed) return null;
        if (!parsed.byDay && !parsed.byMonthDay) return dateText;
        return nextOccurrence(parsed, addDays(dateText, -1));
    }

    /** Short Hungarian description of a rule, e.g. „minden hétfőn” or „2 hetente”. */
    function describeRecurrence(rule) {
        const parsed = parseRecurrence(rule);
        if (!parsed) return '';
        const { freq, interval, byDay, byMonthDay } = parsed;
        if (freq === 'DAILY') return interval === 1 ? 'minden nap' : `${interval} naponta`;
        if (freq === 'WEEKLY') {
            if (byDay && byDay.join() === '1,2,3,4,5' && interval === 1) return 'minden hétköznap';
            const prefix = interval === 1 ? 'minden' : `${interval} hetente`;
            if (!byDay) return interval === 1 ? 'hetente' : `${interval} hetente`;
            return `${prefix} ${byDay.map(day => WEEKDAY_ON[day]).join(', ')}`;
        }
        if (freq === 'MONTHLY') {
            const base = interval === 1 ? 'havonta' : `${interval} havonta`;
            if (!byMonthDay) return base;
            return `${base}, ${byMonthDay === -1 ? 'az utolsó napon' : `${byMonthDay}-én`}`;
        }
        return interval === 1 ? 'évente' : `${interval} évente`;
    }

    // ---- Magyar gyors-beírás ------------------------------------------------------------------

    const L = '\\p{L}\\p{N}';
    const START = `(?<![${L}])`;
    const END = `(?![${L}])`;
    const WEEKDAY_ALT = '(hétfő(?:n|re|ig)?|kedd(?:en|re|ig)?|szerdá(?:n|ra|ig)|szerda|csütörtök(?:ön|re|ig)?|péntek(?:en|re|ig)?|szombat(?:on|ra|ig)?|vasárnap(?:ra|ig)?)';
    const MONTH_ALT = `(${MONTHS.flat().sort((a, b) => b.length - a.length).join('|')})\\.?`;
    const DAY_SUFFIX = '(?:\\.|-?(?:á|é|já|jé)n|-?(?:a|e|ja|je|ig|ra|re|i))?';

    function weekdayIndex(word) {
        const lower = word.toLowerCase();
        return WEEKDAY_NAMES.findIndex(name => lower.startsWith(name.slice(0, 4)));
    }

    function monthIndex(word) {
        const lower = word.toLowerCase().replace(/\.$/, '');
        return MONTHS.findIndex(names => names.includes(lower));
    }

    function hourWithDayPart(hour, part) {
        if (!part) return hour;
        const lower = part.toLowerCase();
        if (/^(du|délután|este|éjjel)/.test(lower) && hour < 12) {
            if (lower.startsWith('éjjel') && hour < 5) return hour;
            return hour + 12;
        }
        if (/^(de|délelőtt|reggel|hajnal)/.test(lower) && hour === 12) return 0;
        return hour;
    }

    /**
     * Rules are tried in order on the not-yet-consumed text; each returns the fields it sets.
     * `ctx.today` is the current calendar date in the user's time zone.
     */
    const RULES = [
        // Ismétlődés (a sima hétnapok előtt, hogy a „minden hétfőn” ne dátumként értelmeződjön)
        { kind: 'recurrence', re: `${START}(?:minden\\s+hétköznap|hétköznaponként|munkanaponként)${END}`, apply: () => ({ recurrence: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR' }) },
        { kind: 'recurrence', re: `${START}minden\\s+${WEEKDAY_ALT}((?:\\s*(?:,|és)\\s*${WEEKDAY_ALT})*)${END}`, apply: match => {
            const days = match[0].replace(/^minden\s+/i, '').split(/\s*(?:,|és)\s*/).map(weekdayIndex).filter(day => day >= 0);
            return { recurrence: `FREQ=WEEKLY;BYDAY=${[...new Set(days)].map(day => WEEKDAY_CODES[day]).join(',')}` };
        } },
        { kind: 'recurrence', re: `${START}minden\\s+hónap(?:ban)?\\s+(?:utolsó\\s+nap(?:ján)?|(\\d{1,2})${DAY_SUFFIX})${END}`, apply: match => ({ recurrence: `FREQ=MONTHLY;BYMONTHDAY=${match[1] ? Math.min(Number(match[1]), 31) : -1}` }) },
        { kind: 'recurrence', re: `${START}(?:minden\\s+(\\d{1,3})\\.\\s*nap(?:on)?|(\\d{1,3})\\s+naponta)${END}`, apply: match => ({ recurrence: `FREQ=DAILY;INTERVAL=${Number(match[1] || match[2]) || 1}` }) },
        { kind: 'recurrence', re: `${START}(?:minden\\s?nap|naponta|mindennap)${END}`, apply: () => ({ recurrence: 'FREQ=DAILY' }) },
        { kind: 'recurrence', re: `${START}(?:kéthetente|két\\s+hetente|minden\\s+második\\s+héten)${END}`, apply: () => ({ recurrence: 'FREQ=WEEKLY;INTERVAL=2' }) },
        { kind: 'recurrence', re: `${START}(\\d{1,2})\\s+hetente${END}`, apply: match => ({ recurrence: `FREQ=WEEKLY;INTERVAL=${Number(match[1]) || 1}` }) },
        { kind: 'recurrence', re: `${START}(?:hetente|minden\\s+héten|hetenként)${END}`, apply: () => ({ recurrence: 'FREQ=WEEKLY' }) },
        { kind: 'recurrence', re: `${START}(?:havonta|minden\\s+hónapban|havonként)${END}`, apply: () => ({ recurrence: 'FREQ=MONTHLY' }) },
        { kind: 'recurrence', re: `${START}(?:negyedévente)${END}`, apply: () => ({ recurrence: 'FREQ=MONTHLY;INTERVAL=3' }) },
        { kind: 'recurrence', re: `${START}(?:évente|minden\\s+évben|évenként)${END}`, apply: () => ({ recurrence: 'FREQ=YEARLY' }) },

        // Emlékeztető
        { kind: 'reminder', re: `\\^(\\d{1,4})\\s?(p|perc|ó|óra|n|nap)?${END}`, apply: match => ({ reminder: reminderMinutes(match[1], match[2]) }) },
        { kind: 'reminder', re: `${START}emlékeztess(?:\\s+(?:előtte|korábban))?\\s+(\\d{1,4})\\s*(perccel|órával|nappal)(?:\\s+(?:előtte|korábban))?${END}`, apply: match => ({ reminder: reminderMinutes(match[1], match[2]) }) },

        // Dátum
        { kind: 'date', re: `${START}(\\d{4})[.\\-/]\\s?(\\d{1,2})[.\\-/]\\s?(\\d{1,2})${DAY_SUFFIX}${END}`, apply: match => {
            const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
            return isValidDate(year, month, day) ? { date: `${year}-${pad(month)}-${pad(day)}` } : null;
        } },
        { kind: 'date', re: `${START}${MONTH_ALT}\\s?(\\d{1,2})${DAY_SUFFIX}${END}`, apply: (match, ctx) => upcomingMonthDay(ctx.today, monthIndex(match[1]) + 1, Number(match[2])) },
        { kind: 'date', re: `${START}(\\d{1,2})\\.\\s?(\\d{1,2})\\.(?:-?(?:á|é|já|jé)n|-?(?:a|e|ja|je|ig|ra|re|i))?${END}`, apply: (match, ctx) => upcomingMonthDay(ctx.today, Number(match[1]), Number(match[2])) },
        { kind: 'date', re: `${START}holnapután${END}`, apply: (match, ctx) => ({ date: addDays(ctx.today, 2) }) },
        { kind: 'date', re: `${START}holnap(?:ra|ig)?${END}`, apply: (match, ctx) => ({ date: addDays(ctx.today, 1) }) },
        { kind: 'date', re: `${START}(?:ma|mára|máma|mai\\s+napon)${END}`, apply: (match, ctx) => ({ date: ctx.today }) },
        { kind: 'date', re: `${START}jövő\\s+${WEEKDAY_ALT}${END}`, apply: (match, ctx) => {
            const target = weekdayIndex(match[1]);
            const nextMonday = addDays(ctx.today, 7 - ((weekdayOf(ctx.today) + 6) % 7));
            return { date: addDays(nextMonday, (target + 6) % 7) };
        } },
        { kind: 'date', re: `${START}${WEEKDAY_ALT}${END}`, apply: (match, ctx) => {
            const target = weekdayIndex(match[1]);
            const diff = (target - weekdayOf(ctx.today) + 7) % 7 || 7;
            return { date: addDays(ctx.today, diff) };
        } },
        { kind: 'date', re: `${START}jövő\\s+hét(?:en|re)${END}`, apply: (match, ctx) => ({ date: addDays(ctx.today, 7 - ((weekdayOf(ctx.today) + 6) % 7)) }) },
        { kind: 'date', re: `${START}(?:(?:a\\s+)?hétvégén|hétvégére)${END}`, apply: (match, ctx) => {
            const weekday = weekdayOf(ctx.today);
            return { date: weekday === 6 || weekday === 0 ? ctx.today : addDays(ctx.today, 6 - weekday) };
        } },
        { kind: 'date', re: `${START}(?:(?:a\\s+)?hónap\\s+végén|hónap\\s+végére)${END}`, apply: (match, ctx) => ({ date: monthDay(ctx.today, 0, -1) }) },
        { kind: 'date', re: `${START}jövő\\s+hónap(?:ban|ra)${END}`, apply: (match, ctx) => ({ date: monthDay(ctx.today, 1, 1) }) },
        { kind: 'date', re: `${START}(\\d{1,3}|egy|két|kettő|három|négy|öt)\\s+(nap|hét|hónap)\\s+múlva${END}`, apply: (match, ctx) => {
            const words = { egy: 1, két: 2, kettő: 2, három: 3, négy: 4, öt: 5 };
            const amount = Number(match[1]) || words[match[1].toLowerCase()];
            const unit = match[2].toLowerCase();
            if (unit === 'hónap') return { date: monthDay(ctx.today, amount, Number(ctx.today.slice(8, 10))) };
            return { date: addDays(ctx.today, unit === 'hét' ? amount * 7 : amount) };
        } },

        // Időpont
        { kind: 'time', re: `${START}(?:(de|du|délelőtt|délután|reggel|este|éjjel|hajnalban)\\s+)?(\\d{1,2})[:.](\\d{2})(?:-?(?:kor|ra|re|ig))?${END}`, apply: match => timeResult(hourWithDayPart(Number(match[2]), match[1]), Number(match[3])) },
        { kind: 'time', re: `${START}(?:(de|du|délelőtt|délután|reggel|este|éjjel|hajnalban)\\s+)?fél\\s+(\\d{1,2})(?:-?(?:kor|re|ig))?${END}`, apply: match => timeResult(hourWithDayPart((Number(match[2]) + 23) % 24, match[1]), 30) },
        { kind: 'time', re: `${START}(?:(de|du|délelőtt|délután|reggel|este|éjjel|hajnalban)\\s+)?(\\d{1,2})\\s?(?:-?kor|órakor|h|-?ra|-?re|-?ig)${END}`, apply: match => timeResult(hourWithDayPart(Number(match[2]), match[1]), 0) },
        { kind: 'time', re: `${START}(de|du|délelőtt|délután|reggel|este|éjjel)\\s+(\\d{1,2})${END}`, apply: match => timeResult(hourWithDayPart(Number(match[2]), match[1]), 0) },
        { kind: 'time', re: `${START}délben${END}`, apply: () => timeResult(12, 0) },

        // Prioritás, címke, projekt
        { kind: 'priority', re: `(?:^|(?<=\\s))(?:!([1-4])|p([1-4]))${END}`, apply: match => ({ priority: Number(match[1] || match[2]) }) },
        { kind: 'tag', re: `(?:^|(?<=\\s))#([${L}_-]{1,50})`, apply: match => ({ tag: match[1].toLowerCase() }) },
        { kind: 'project', re: `(?:^|(?<=\\s))@([${L}_-]{1,100})`, apply: match => ({ project: match[1] }) }
    ].map(rule => ({ ...rule, regex: new RegExp(rule.re, 'giu') }));

    function reminderMinutes(amount, unit) {
        const value = Number(amount);
        const lower = (unit || 'p').toLowerCase();
        if (lower.startsWith('ó')) return value * 60;
        if (lower.startsWith('n')) return value * 1440;
        return value;
    }

    function timeResult(hour, minute) {
        return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 ? { time: `${pad(hour)}:${pad(minute)}` } : null;
    }

    /** The next occurrence of month/day from today (this year, or next year if it has passed). */
    function upcomingMonthDay(today, month, day) {
        const year = Number(today.slice(0, 4));
        if (!isValidDate(2024, month, day)) return null;
        let candidate = isValidDate(year, month, day) ? `${year}-${pad(month)}-${pad(day)}` : null;
        if (!candidate || candidate < today) {
            const nextYear = year + 1;
            candidate = isValidDate(nextYear, month, day) ? `${nextYear}-${pad(month)}-${pad(day)}` : null;
        }
        return candidate ? { date: candidate } : null;
    }

    /**
     * Parses a quick-add sentence.
     * Returns the cleaned title, the recognized fields and the matched tokens (for highlighting).
     * Only the first match of each kind is used, except tags; a token that cannot be used stays in the title.
     */
    function parse(text, options = {}) {
        const input = String(text || '');
        const timeZone = isValidTimeZone(options.timeZone) ? options.timeZone : DEFAULT_TIME_ZONE;
        const now = options.now ? new Date(options.now) : new Date();
        const ctx = { today: localDate(now, timeZone) };
        const consumed = new Array(input.length).fill(false);
        const tokens = [];
        const fields = { tags: [] };

        for (const rule of RULES) {
            rule.regex.lastIndex = 0;
            let match;
            while ((match = rule.regex.exec(input)) !== null) {
                if (!match[0]) { rule.regex.lastIndex += 1; continue; }
                const start = match.index;
                const end = start + match[0].length;
                if (consumed.slice(start, end).some(Boolean)) continue;
                const singular = { recurrence: 'recurrence', reminder: 'reminder', date: 'date', time: 'time', priority: 'priority', project: 'project' }[rule.kind];
                if (singular && fields[singular] !== undefined) continue;
                const result = rule.apply(match, ctx);
                if (!result) continue;
                if (result.tag !== undefined) {
                    if (!fields.tags.includes(result.tag)) fields.tags.push(result.tag);
                } else {
                    Object.assign(fields, result);
                }
                for (let i = start; i < end; i += 1) consumed[i] = true;
                tokens.push({ kind: rule.kind, text: match[0], start, end });
            }
        }

        let title = '';
        for (let i = 0; i < input.length; i += 1) title += consumed[i] ? ' ' : input[i];
        title = title.replace(/\s+/g, ' ').replace(/\s+([,.;:!?])/g, '$1').replace(/^[\s,;:-]+|[\s,;:-]+$/g, '').trim();

        let dueDate = fields.date || null;
        const dueTime = fields.time || null;
        if (fields.recurrence && !dueDate) {
            dueDate = firstOccurrence(fields.recurrence, ctx.today);
            if (dueTime && zonedTimeToUtc(dueDate, dueTime, timeZone) <= now) dueDate = nextOccurrence(fields.recurrence, dueDate);
        }
        if (dueTime && !dueDate) {
            dueDate = ctx.today;
            if (zonedTimeToUtc(dueDate, dueTime, timeZone) <= now) dueDate = addDays(ctx.today, 1);
        }
        if (fields.reminder !== undefined && !dueDate) dueDate = ctx.today;
        const dueAt = dueDate ? zonedTimeToUtc(dueDate, dueTime || '00:00', timeZone).toISOString() : null;

        return {
            title,
            dueDate,
            dueTime,
            dueAt,
            dueAllDay: Boolean(dueDate) && !dueTime,
            priority: fields.priority || null,
            tags: fields.tags,
            project: fields.project || null,
            recurrenceRule: fields.recurrence || null,
            reminders: fields.reminder !== undefined ? [fields.reminder] : [],
            tokens: tokens.sort((a, b) => a.start - b.start)
        };
    }

    return {
        DEFAULT_TIME_ZONE,
        parse,
        isValidTimeZone,
        localParts,
        localDate,
        localTime,
        zonedTimeToUtc,
        addDays,
        parseRecurrence,
        normalizeRecurrence,
        nextOccurrence,
        firstOccurrence,
        describeRecurrence
    };
});
