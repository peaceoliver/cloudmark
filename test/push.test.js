const test = require('node:test');
const assert = require('node:assert/strict');
const { isAllowedEndpoint, describeDevice } = require('../routes/push');
const { inQuietHours } = require('../routes/notifications');

test('csak ismert push szolgáltatásra küldünk', () => {
    assert.equal(isAllowedEndpoint('https://fcm.googleapis.com/fcm/send/abc'), true);
    assert.equal(isAllowedEndpoint('https://web.push.apple.com/QGx'), true);
    assert.equal(isAllowedEndpoint('https://updates.push.services.mozilla.com/wpush/v2/x'), true);
    assert.equal(isAllowedEndpoint('https://db5p.notify.windows.com/w/?token=x'), true);
    assert.equal(isAllowedEndpoint('http://fcm.googleapis.com/fcm/send/abc'), false);
    assert.equal(isAllowedEndpoint('https://fcm.googleapis.com:444/x'), false);
    assert.equal(isAllowedEndpoint('https://push.apple.com.evil.example/x'), false);
    assert.equal(isAllowedEndpoint('https://localhost/x'), false);
    assert.equal(isAllowedEndpoint('not a url'), false);
    assert.equal(isAllowedEndpoint(null), false);
});

test('eszköznév a böngésző azonosítójából', () => {
    assert.equal(describeDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1'), 'iPhone · Safari');
    assert.equal(describeDevice('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36'), 'Android · Chrome');
    assert.equal(describeDevice('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36 Edg/130.0'), 'Windows · Edge');
    assert.equal(describeDevice(''), 'Eszköz · böngésző');
});

test('csendes időszak, éjfélen átnyúlva is', () => {
    const at = iso => new Date(iso);
    const tz = 'Europe/Budapest';
    // 2026-10-15: UTC+2
    assert.equal(inQuietHours('22:00-07:00', tz, at('2026-10-15T21:30:00Z')), true); // 23:30
    assert.equal(inQuietHours('22:00-07:00', tz, at('2026-10-15T04:59:00Z')), true); // 06:59
    assert.equal(inQuietHours('22:00-07:00', tz, at('2026-10-15T05:00:00Z')), false); // 07:00
    assert.equal(inQuietHours('22:00-07:00', tz, at('2026-10-15T12:00:00Z')), false); // 14:00
    assert.equal(inQuietHours('12:00-13:00', tz, at('2026-10-15T10:30:00Z')), true); // 12:30
    assert.equal(inQuietHours('12:00-13:00', tz, at('2026-10-15T11:00:00Z')), false); // 13:00
    assert.equal(inQuietHours('off', tz, at('2026-10-15T21:30:00Z')), false);
    assert.equal(inQuietHours(null, tz), false);
    assert.equal(inQuietHours('08:00-08:00', tz), false);
});
