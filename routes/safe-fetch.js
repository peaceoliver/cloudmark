/*
 * Weboldal lekérése a felhasználó nevében (könyvjelző metaadat, AI kitöltés), csak nyilvános címekre.
 * A DNS-feloldást maga a kapcsolat ellenőrzi (saját lookup), így egy átirányítás vagy egy közben
 * megváltozó DNS válasz sem vezethet belső gépre (localhost, magánhálózat, felhő metaadat cím).
 */
const dns = require('dns');
const net = require('net');
const http = require('http');
const https = require('https');

const BLOCKED_V4 = ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.168.0.0/16', '198.18.0.0/15', '224.0.0.0/3'];
const BLOCKED_V6 = ['::/128', '::1/128', 'fc00::/7', 'fe80::/10', 'ff00::/8'];

const blockList = new net.BlockList();
BLOCKED_V4.forEach(range => { const [ip, prefix] = range.split('/'); blockList.addSubnet(ip, Number(prefix), 'ipv4'); });
BLOCKED_V6.forEach(range => { const [ip, prefix] = range.split('/'); blockList.addSubnet(ip, Number(prefix), 'ipv6'); });

/** Addresses the server must never call on a user's behalf (loopback, private networks, link-local, metadata). */
function isPrivateAddress(address) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped) return blockList.check(mapped[1], 'ipv4');
    if (!net.isIP(address)) return true;
    return blockList.check(address, net.isIPv6(address) ? 'ipv6' : 'ipv4');
}

/** dns.lookup replacement for http(s).request: fails instead of connecting to a private address. */
function publicLookup(hostname, options, callback) {
    dns.lookup(hostname, { ...options, all: true, verbatim: true }, (err, addresses) => {
        if (err) return callback(err);
        const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: options.family || 4 }];
        if (!list.length || list.some(entry => isPrivateAddress(entry.address))) {
            const blocked = new Error('Blocked private address');
            blocked.code = 'EPRIVATE';
            return callback(blocked);
        }
        if (options.all) return callback(null, list);
        return callback(null, list[0].address, list[0].family);
    });
}

/** http(s) URL with a host name or a public IP, no credentials. Returns a URL or null. */
function publicHttpUrl(value) {
    let url;
    try { url = new URL(String(value || '').trim()); } catch (err) { return null; }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) return null;
    if (net.isIP(host) && isPrivateAddress(host)) return null;
    return url;
}

function requestOnce(url, { timeoutMs, maxBytes, headers }) {
    return new Promise((resolve, reject) => {
        const client = url.protocol === 'https:' ? https : http;
        const request = client.get(url, { headers, lookup: publicLookup, timeout: timeoutMs }, response => {
            const status = response.statusCode || 0;
            if (status >= 300 && status < 400 && response.headers.location) {
                response.resume();
                resolve({ status, location: response.headers.location });
                return;
            }
            const chunks = [];
            let size = 0;
            response.on('data', chunk => {
                size += chunk.length;
                if (size > maxBytes) {
                    chunks.push(chunk.subarray(0, Math.max(0, maxBytes - (size - chunk.length))));
                    response.destroy();
                    resolve({ status, contentType: response.headers['content-type'] || '', body: Buffer.concat(chunks).toString('utf8') });
                    return;
                }
                chunks.push(chunk);
            });
            response.on('end', () => resolve({ status, contentType: response.headers['content-type'] || '', body: Buffer.concat(chunks).toString('utf8') }));
            response.on('error', reject);
        });
        request.on('timeout', () => request.destroy(new Error('Timeout')));
        request.on('error', reject);
    });
}

/**
 * GETs a public web page and returns { status, contentType, body } (body cut at maxBytes).
 * Follows at most `maxRedirects` redirects, each checked again. Throws on a blocked or unreachable address.
 */
async function fetchPublicText(value, { timeoutMs = 5000, maxBytes = 512 * 1024, maxRedirects = 3, headers = {} } = {}) {
    let url = publicHttpUrl(value);
    if (!url) throw new Error('Blocked URL');
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
        const result = await requestOnce(url, { timeoutMs, maxBytes, headers });
        if (!result.location) return result;
        url = publicHttpUrl(new URL(result.location, url).href);
        if (!url) throw new Error('Blocked redirect');
    }
    throw new Error('Too many redirects');
}

module.exports = { isPrivateAddress, publicLookup, publicHttpUrl, fetchPublicText };
