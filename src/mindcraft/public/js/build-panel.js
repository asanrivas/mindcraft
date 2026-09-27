/**
 * Build panel: a live view of any agent's blueprint build, above the agent cards.
 *
 * Self-contained on purpose. It opens its OWN socket and listens to the same once-a-second
 * `state-update` the rest of the page uses, reading only `state.build` (getFullState ->
 * BuildTelemetry.snapshot). So it touches no shared UI file beyond one <script> tag, and a bug here
 * cannot break the agent cards. A second listener costs the MindServer nothing: it polls each agent
 * once per tick regardless of how many listeners there are.
 *
 * Why it exists: every question that decides what to do about a running build - how fast, how long
 * left, placing or only failing, which failure dominates now, is it stuck - used to be answerable
 * only by grepping a shared log, after the fact.
 */
(function () {
    const socket = io();
    socket.on('connect', () => socket.emit('listen-to-agents'));

    // ---------------------------------------------------------------- styles (panel-local)
    const style = document.createElement('style');
    style.textContent = `
        #buildPanels { display: grid; gap: var(--space-xl, 16px); margin-bottom: var(--space-xl, 16px); }
        .bp-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 8px; margin: 10px 0; }
        .bp-stat { background: #b4b4b4; border: 2px solid #555; border-top-color: #fff; border-left-color: #fff;
                   padding: 6px 8px; min-width: 0; }
        .bp-stat .k { font-size: 11px; color: #404040; text-transform: uppercase; letter-spacing: .04em; }
        .bp-stat .v { font-size: 16px; color: #1e1e1e; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .bp-stat .s { font-size: 11px; color: #505050; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .bp-stat.warn { background: #e0c070; } .bp-stat.bad { background: #d98080; }
        .bp-h { font-size: 12px; text-transform: uppercase; color: #404040; margin: 12px 0 4px; }
        .bp-fail { display: grid; grid-template-columns: 1fr 64px; gap: 6px; align-items: center; font-size: 12px; margin: 2px 0; }
        .bp-fail .bar { height: 12px; background: #8b8b8b; border: 1px solid #1e1e1e; position: relative; }
        .bp-fail .bar i { position: absolute; inset: 0 auto 0 0; background: #aa3333; }
        .bp-fail .lbl { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .bp-ended { margin-top: 10px; padding: 8px; border: 2px solid #1e1e1e; background: #d98080; color: #1e1e1e; font-size: 13px; }
        .bp-ended.ok { background: #8fce8f; }
        .bp-notes { font-size: 12px; color: #303030; margin: 2px 0; }
        .bp-chart { height: 150px; background: #1e1e1e; border: 2px solid #000; padding: 4px; margin-top: 6px; }
        .badge.bp-run { background: #339933; } .badge.bp-stall { background: #c08000; }
        .badge.bp-stop { background: #aa0000; } .badge.bp-done { background: #555; }
    `;
    document.head.appendChild(style);

    // ---------------------------------------------------------------- helpers
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const n = (x) => (x === null || x === undefined) ? '-' : Number(x).toLocaleString();
    function dur(ms) {
        if (ms === null || ms === undefined || !Number.isFinite(ms)) return '-';
        const s = Math.max(0, Math.round(ms / 1000));
        const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
        if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
        if (m) return `${m}m ${String(sec).padStart(2, '0')}s`;
        return `${sec}s`;
    }
    const stat = (k, v, s = '', cls = '') =>
        `<div class="bp-stat ${cls}"><div class="k">${esc(k)}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;

    // The watchdog stops a build after 200 consecutive attempts that place nothing; warn well before.
    const WATCHDOG = 200;

    /** What the build is doing, as one word and a colour. */
    function status(b) {
        if (b.ended && b.ended !== 'done') return ['stopped', 'bp-stop'];
        if (b.ended === 'done' || b.phase === 'done') return ['done', 'bp-done'];
        // Every phase that does per-cell work records attempts, so "nothing attempted in the whole
        // rate window" means the same thing in all of them.
        const working = /^(pass|retry|clear|foundation)/.test(b.phase || '');
        // Nothing attempted in the whole rate window while in a pass: a hang, not a slow build.
        if (working && b.attemptsPerMin === 0 && b.phaseElapsedMs > 5 * 60_000) return ['stalled?', 'bp-stall'];
        return [b.phase || '?', 'bp-run'];
    }

    // ---------------------------------------------------------------- per-agent cards
    const cards = new Map();   // agentName -> { el, chart }

    function container() {
        let c = document.getElementById('buildPanels');
        if (!c) {
            c = document.createElement('section');
            c.id = 'buildPanels';
            const agents = document.getElementById('agents');
            (agents?.parentNode || document.body).insertBefore(c, agents || null);
        }
        return c;
    }

    function ensureCard(name) {
        if (cards.has(name)) return cards.get(name);
        const el = document.createElement('div');
        el.className = 'agent-card';
        el.innerHTML = `
            <div class="agent-card-header">
                <div class="agent-card-title"><span class="bp-title"></span><span class="badge bp-badge"></span></div>
                <span class="bp-elapsed" style="font-size:12px;color:#404040"></span>
            </div>
            <div class="agent-card-body">
                <div class="progress"><div class="progress-fill bp-fill" style="width:0%"></div><div class="progress-label bp-label"></div></div>
                <div class="bp-grid bp-stats"></div>
                <div class="bp-failwrap"></div>
                <div class="bp-h">Placements per minute (5-min window, one point every 30s)</div>
                <div class="bp-chart"><canvas></canvas></div>
                <div class="bp-endedwrap"></div>
                <div class="bp-sitewrap"></div>
            </div>`;
        container().appendChild(el);
        let chart = null;
        if (window.Chart) {
            chart = new Chart(el.querySelector('canvas'), {
                type: 'line',
                data: { labels: [], datasets: [
                    { label: 'placed/min', data: [], borderColor: '#55ff55', backgroundColor: 'rgba(85,255,85,.15)', fill: true, tension: .25, pointRadius: 0, borderWidth: 2 },
                    { label: 'attempts/min', data: [], borderColor: '#ffaa00', fill: false, tension: .25, pointRadius: 0, borderWidth: 1, borderDash: [4, 3] },
                ] },
                options: {
                    responsive: true, maintainAspectRatio: false, animation: false,
                    plugins: { legend: { labels: { color: '#ddd', boxWidth: 12, font: { size: 11 } } } },
                    scales: {
                        x: { ticks: { color: '#aaa', maxTicksLimit: 6, font: { size: 10 } }, grid: { color: '#333' } },
                        y: { beginAtZero: true, ticks: { color: '#aaa', font: { size: 10 } }, grid: { color: '#333' } },
                    },
                },
            });
        }
        const card = { el, chart, historyKey: '' };
        cards.set(name, card);
        return card;
    }

    function render(name, b) {
        const card = ensureCard(name);
        const q = (sel) => card.el.querySelector(sel);
        const [word, cls] = status(b);
        const file = String(b.file || '').split('/').pop();
        const o = b.origin ? `(${b.origin.x}, ${b.origin.y}, ${b.origin.z})` : '';

        q('.bp-title').textContent = `${name} · ${file} ${o}`;
        const badge = q('.bp-badge');
        badge.textContent = word;
        badge.className = `badge bp-badge ${cls}`;
        q('.bp-elapsed').textContent = `running ${dur(b.elapsedMs)} · ${b.phase} for ${dur(b.phaseElapsedMs)}`;

        const standing = (b.counts?.placed || 0) + (b.counts?.skipped || 0);
        q('.bp-fill').style.width = `${Math.min(100, b.standingPct || 0)}%`;
        q('.bp-label').textContent = b.verified
            ? `VERIFIED ${n(b.verified.match)} / ${n(b.verified.total)} (${b.verified.pct}%)`
            : `${n(standing)} / ${n(b.total)} standing (${b.standingPct}%)`;

        const dry = b.sinceLastPlaced || 0;
        const dryCls = dry >= WATCHDOG * 0.75 ? 'bad' : dry >= WATCHDOG * 0.25 ? 'warn' : '';
        const rateCls = /^(pass|retry)/.test(b.phase) && b.perMin === 0 ? 'warn' : '';
        const pass = b.pass ? `${b.pass.name} ${n(b.pass.planned)} / ${n(b.pass.length)}` : '-';
        const h = b.health || {};
        const stats = [
            stat('rate', `${b.perMin} /min`, `${b.attemptsPerMin} attempts/min`, rateCls),
            stat('pass', esc(pass), b.passEtaMs !== null ? `ETA this pass ${dur(b.passEtaMs)}` : 'ETA -'),
            stat('layer', b.layer !== null ? `y ${b.layer} / ${b.maxLayer}` : '-', b.target ? `at ${b.target.x}, ${b.target.y}, ${b.target.z}` : ''),
            stat('placed', n(b.counts?.placed), `${n(b.counts?.skipped)} already standing`),
            stat('failed', n(b.counts?.failed), 'retried in the retry rounds', b.counts?.failed ? '' : ''),
            stat('since last placed', `${n(dry)}`, `watchdog stops at ${WATCHDOG}`, dryCls),
            stat('waiting for a neighbour', n(b.counts?.waiting), `${n(b.counts?.released)} released so far`),
            stat('orientation', `${n(h.yawAimed)} aimed`, `${n(h.refacing)} re-placed`),
            stat('supports', `${n(h.supportsUsed)} / ${n(h.supportsBuilt)}`, 'used / built'),
            stat('rescues · recentres', `${n(h.rescues)} · ${n(h.recentres)}`, `${n(h.leashed)} walked back`),
        ];
        if (b.phase === 'clear' || b.clear?.targets) stats.push(stat('terrain clear', `layer ${b.clear.layer ?? '-'}`, `${n(b.clear.visited)} / ${n(b.clear.targets)} cells`));
        if (b.foundation?.placed || b.foundation?.tooDeep) stats.push(stat('foundation', `${n(b.foundation.placed)} placed`,
            `${n(b.foundation.tooDeep)} too deep · ${n(b.foundation.unread)} unread`, b.foundation.tooDeep ? 'warn' : ''));
        q('.bp-stats').innerHTML = stats.join('');

        const fails = b.topFailures || [];
        const max = Math.max(1, ...fails.map(f => f.n));
        q('.bp-failwrap').innerHTML = fails.length
            ? `<div class="bp-h">Dominant failures</div>` + fails.map(f =>
                `<div class="bp-fail"><div class="bar"><i style="width:${(f.n / max) * 100}%"></i></div><div>${n(f.n)}</div>
                 <div class="lbl" style="grid-column:1/-1;margin-top:-2px">${esc(f.why)}${f.blocks?.length
                    ? ` <span style="opacity:.7">- ${f.blocks.map(x => `${esc(x.name)} ${n(x.n)}`).join(', ')}</span>` : ''}</div></div>`).join('')
            : '';

        q('.bp-endedwrap').innerHTML = b.ended
            ? `<div class="bp-ended ${b.ended === 'done' ? 'ok' : ''}">${b.ended === 'done' ? 'Finished' : 'Ended'}: ${esc(b.ended)}</div>`
            : (b.stopped ? `<div class="bp-ended">Stopping: ${esc(b.stopped)}</div>` : '');

        const pre = b.site?.preflight || [], notes = b.site?.notes || [];
        q('.bp-sitewrap').innerHTML = (pre.length || notes.length)
            ? `<details><summary class="bp-h" style="cursor:pointer">Site (${pre.length} preflight line${pre.length === 1 ? '' : 's'})</summary>`
              + notes.map(t => `<div class="bp-notes"><b>decided:</b> ${esc(t)}</div>`).join('')
              + pre.map(t => `<div class="bp-notes">${esc(t)}</div>`).join('') + `</details>`
            : '';

        // Redraw the chart only when a new sample has arrived - it changes every 30s, not every second.
        const hist = b.history || [];
        const key = hist.length ? `${hist.length}:${hist[hist.length - 1].ts}` : '0';
        if (card.chart && key !== card.historyKey) {
            card.historyKey = key;
            card.chart.data.labels = hist.map(s => new Date(s.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
            card.chart.data.datasets[0].data = hist.map(s => s.perMin);
            card.chart.data.datasets[1].data = hist.map(s => s.attemptsPerMin);
            card.chart.update('none');
        }
    }

    socket.on('state-update', (states) => {
        for (const [name, state] of Object.entries(states || {})) {
            const b = state?.build;
            if (b && !b.error && b.phase) render(name, b);
            else if (cards.has(name) && !b) { cards.get(name).el.remove(); cards.delete(name); }
        }
    });
})();
