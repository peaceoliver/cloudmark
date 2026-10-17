/**
 * Kódszínezés a Kódtár kártyáin (VS Code-szerű), a beépített highlight.js-sel (public/js/vendor/highlight.min.js).
 * A kártya soronként rajzol (minden sornak saját másológombja van), ezért a színezett HTML-t sorokra bontjuk úgy,
 * hogy a több soron átnyúló elemek (pl. többsoros szöveg) minden sorban lezáródjanak és újranyíljanak.
 * A sorokra bontás tiszta függvény: Node-ban is fut (test/code-highlight.test.js).
 */
(function (root, factory) {
    const api = factory(() => root.hljs);
    if (typeof module === 'object' && module.exports) module.exports = api;
    else {
        root.CloudMark = root.CloudMark || {};
        root.CloudMark.codeHighlight = api;
    }
})(typeof self !== 'undefined' ? self : this, function (getHljs) {
    const MAX_HIGHLIGHT_CHARS = 20000;
    // A kódtár nyelvnevei → highlight.js nyelv. A docker / git parancsok shellben futnak.
    const ALIASES = {
        sh: 'bash', zsh: 'bash', shell: 'bash', git: 'bash', docker: 'bash', cmd: 'dos', bat: 'dos', batch: 'dos',
        ps: 'powershell', ps1: 'powershell', pwsh: 'powershell', js: 'javascript', ts: 'typescript', py: 'python',
        yml: 'yaml', html: 'xml', dockerfile: 'dockerfile', 'c#': 'csharp', cs: 'csharp', md: 'markdown', regex: 'plaintext'
    };
    // Nyelv nélküli fülnél csak ezek közül tippel (rövid parancsoknál a teljes lista sokat téved).
    const AUTO_SUBSET = ['bash', 'powershell', 'dos', 'python', 'javascript', 'typescript', 'sql', 'json', 'yaml', 'xml', 'css'];

    function esc(value) {
        return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    /** The highlight.js language for a library language name, or null when unknown. */
    function resolveLanguage(language, hljs = getHljs()) {
        const name = String(language || '').trim().toLowerCase();
        if (!name || !hljs) return null;
        const mapped = ALIASES[name] || name;
        return hljs.getLanguage(mapped) ? mapped : null;
    }

    /**
     * Splits highlighted HTML into lines. Open <span> tags are closed at each line end and reopened on the next line,
     * so every line is valid HTML on its own.
     */
    function splitHtmlLines(html) {
        const lines = [];
        const open = [];
        let current = '';
        const tokens = String(html).match(/<\/?span[^>]*>|[^<]+|</g) || [];
        tokens.forEach(token => {
            if (token.startsWith('</span')) { open.pop(); current += token; return; }
            if (token.startsWith('<span')) { open.push(token); current += token; return; }
            const parts = token.split('\n');
            parts.forEach((part, index) => {
                if (index > 0) {
                    lines.push(current + '</span>'.repeat(open.length));
                    current = open.join('');
                }
                current += part;
            });
        });
        lines.push(current);
        return lines;
    }

    /** Highlighted HTML per line (same count as code.split('\n')); plain escaped lines when highlighting is not possible. */
    function highlightLines(code, language) {
        const text = String(code ?? '');
        const plain = () => text.split('\n').map(esc);
        const hljs = getHljs();
        if (!hljs || !text.trim() || text.length > MAX_HIGHLIGHT_CHARS) return plain();
        try {
            const resolved = resolveLanguage(language, hljs);
            if (resolved === 'plaintext') return plain();
            const result = resolved
                ? hljs.highlight(text, { language: resolved, ignoreIllegals: true })
                : hljs.highlightAuto(text, AUTO_SUBSET);
            // Bizonytalan tipp nyelv nélkül: inkább egyszínű, mint félrevezetően színes.
            if (!resolved && result.relevance < 3) return plain();
            const lines = splitHtmlLines(result.value);
            return lines.length === text.split('\n').length ? lines : plain();
        } catch (err) {
            return plain();
        }
    }

    return { ALIASES, resolveLanguage, splitHtmlLines, highlightLines };
});
