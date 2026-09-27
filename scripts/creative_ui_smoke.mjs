/**
 * Browser smoke test for the creative panel. Needs MindServer running on :8080.
 *
 *   bun scripts/creative_ui_smoke.mjs
 *
 * The panel builds a COMMAND STRING from user input, so the two things that actually matter are
 * that a crafted item name cannot close the quote and append another command, and that a silly
 * count cannot be sent. Both are asserted below, not eyeballed.
 */
import puppeteer from 'puppeteer';

const URL = process.env.MINDSERVER_URL || 'http://localhost:8080/';
let failures = 0;
const check = (label, got, want) => {
    if (got !== want) { console.error(`FAIL ${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); failures++; }
    else console.log(`ok   ${label}`);
};

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
try {
    const page = await browser.newPage();
    const pageErrors = [];
    const badResponses = [];
    page.on('pageerror', e => pageErrors.push(e.message));
    // A console "Failed to load resource" carries no URL, so it cannot be filtered on its text -
    // and this app 404s on favicon.ico already, which is not ours. Judge resource failures on the
    // response event, where the URL is available, and drop the useless console echo.
    page.on('console', m => {
        if (m.type() === 'error' && !/Failed to load resource/i.test(m.text())) pageErrors.push(m.text());
    });
    page.on('response', res => {
        if (res.status() >= 400 && !/favicon\.ico$/i.test(res.url())) {
            badResponses.push(`${res.status()} ${res.url()}`);
        }
    });

    await page.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 });

    const r = await page.evaluate(() => {
        const out = [];
        window.sendMessage = (agent, msg) => out.push({ agent, msg });   // capture, do not send
        window.confirm = () => true;                                      // auto-accept the clear prompt

        window.openCreativePanel('test-agent');
        const visible = document.getElementById('creative-overlay')?.style.display;
        const title = document.getElementById('creative-title')?.textContent;

        document.querySelector('.creative-item')?.click();                // default count

        // A hostile item name: closes the quote, adds a second command, comments out the rest.
        document.getElementById('creative-count').value = '99999';
        document.getElementById('creative-custom').value = 'Blaze Spawn Egg"); !stop(); //';
        document.getElementById('creative-custom-btn').click();

        document.querySelector('.creative-btn.kit')?.click();
        document.getElementById('creative-clear-btn').click();

        document.getElementById('creative-search').value = 'pickaxe';
        document.getElementById('creative-search').dispatchEvent(new Event('input'));
        const filtered = [...document.querySelectorAll('.creative-item')].map(e => e.textContent);

        // A search matching nothing must explain the curated list, not show a blank box.
        document.getElementById('creative-search').value = 'zzzznope';
        document.getElementById('creative-search').dispatchEvent(new Event('input'));
        const emptyMsg = document.querySelector('.creative-empty')?.textContent || '';

        window.CreativePanel.close();
        const afterClose = document.getElementById('creative-overlay')?.style.display;

        return { visible, title, out, filtered, emptyMsg, afterClose };
    });

    check('overlay opens', r.visible, 'flex');
    check('title names the agent', /test-agent/.test(r.title), true);
    check('item click sends a give', r.out[0]?.msg, '!creativeGive("cobblestone", 64)');
    check('give targets the right agent', r.out[0]?.agent, 'test-agent');

    const injected = r.out[1]?.msg || '';
    check('injection is neutralised', injected, '!creativeGive("blaze_spawn_egg_stop_", 2304)');
    check('no stray quote survives', /"\)/.test(injected.slice(0, injected.indexOf('_stop_'))), false);
    check('count is clamped to 2304', /2304/.test(injected), true);

    check('kit button sends a kit', r.out[2]?.msg, '!creativeKit("building")');
    check('clear button sends a clear', r.out[3]?.msg, '!creativeClear');

    check('search filters', r.filtered.join('|'), 'netherite pickaxe|diamond pickaxe');
    check('empty search explains itself', /Give by name/.test(r.emptyMsg), true);
    check('close hides the overlay', r.afterClose, 'none');
    check('no page errors', pageErrors.length ? pageErrors.join('; ') : 'none', 'none');
    check('no failed requests', badResponses.length ? badResponses.join('; ') : 'none', 'none');
} finally {
    await browser.close();
}

if (failures) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
}
console.log('\nPASS: creative panel behaves');
