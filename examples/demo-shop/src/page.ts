/** The shop's single page: a product, a Buy button, demo controls and live numbers. */
export function page(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Demo shop · guarded by FlagGuard</title>
<style>
  :root { color-scheme: light dark; --fg:#1d1d1f; --muted:#6e6e73; --line:#d2d2d7; --bg:#fbfbfd;
          --ok:#1a7f37; --bad:#cf222e; --accent:#0969da; }
  @media (prefers-color-scheme: dark) { :root { --fg:#f5f5f7; --muted:#a1a1a6; --line:#3a3a3c; --bg:#161618; } }
  * { box-sizing: border-box; }
  body { margin:0; font:16px/1.5 system-ui, -apple-system, Segoe UI, sans-serif; color:var(--fg); background:var(--bg); }
  main { max-width: 860px; margin: 0 auto; padding: 32px 20px 48px; }
  h1 { font-size: 22px; margin: 0 0 4px; } .sub { color: var(--muted); margin: 0 0 28px; }
  .grid { display:grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  @media (max-width: 680px) { .grid { grid-template-columns: 1fr; } }
  .card { border:1px solid var(--line); border-radius: 12px; padding: 20px; }
  .card h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 0 0 12px; }
  button { font: inherit; border-radius: 8px; border: 1px solid var(--line); padding: 8px 14px; cursor: pointer;
           background: transparent; color: var(--fg); }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  button.danger { color: var(--bad); border-color: var(--bad); }
  .row { display:flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .price { font-size: 28px; font-weight: 600; margin: 4px 0 16px; }
  .pill { display:inline-block; padding: 2px 10px; border-radius: 999px; font-size: 13px; font-weight: 600; }
  .on { background: color-mix(in srgb, var(--ok) 15%, transparent); color: var(--ok); }
  .off { background: color-mix(in srgb, var(--muted) 18%, transparent); color: var(--muted); }
  .broken { background: color-mix(in srgb, var(--bad) 15%, transparent); color: var(--bad); }
  table { width:100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
  th, td { text-align:left; padding: 6px 0; border-bottom: 1px solid var(--line); }
  th { color: var(--muted); font-weight: 500; font-size: 14px; } td.n { text-align:right; }
  #result { min-height: 24px; margin-top: 12px; color: var(--muted); }
  .kv { display:flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid var(--line); }
</style>
</head>
<body>
<main>
  <h1>Demo shop</h1>
  <p class="sub">The new one-click checkout is behind the <code>new_checkout</code> flag and guarded by FlagGuard.</p>

  <div class="grid">
    <section class="card">
      <h2>Product</h2>
      <div>Mechanical keyboard</div>
      <div class="price">₹4,999</div>
      <div class="row"><button class="primary" id="buy">Buy now</button></div>
      <div id="result"></div>
    </section>

    <section class="card">
      <h2>Status</h2>
      <div class="kv"><span>new_checkout flag</span><span id="flag" class="pill off">…</span></div>
      <div class="kv"><span>New checkout code</span><span id="bug" class="pill off">…</span></div>
      <div class="kv"><span>Rollout while ON</span><span id="rollout">…</span></div>
      <div class="row" style="margin-top:14px">
        <button class="danger" id="break">Break new checkout</button>
        <button id="fix">Fix it</button>
      </div>
    </section>

    <section class="card" style="grid-column: 1 / -1">
      <h2>Checkouts since start</h2>
      <table>
        <thead><tr><th>Path</th><th class="n">Succeeded</th><th class="n">Failed</th><th class="n">Error rate</th></tr></thead>
        <tbody>
          <tr><td>New (flag ON)</td><td class="n" id="newOk">0</td><td class="n" id="newFailed">0</td><td class="n" id="newRate">–</td></tr>
          <tr><td>Classic (baseline)</td><td class="n" id="classicOk">0</td><td class="n" id="classicFailed">0</td><td class="n" id="classicRate">–</td></tr>
        </tbody>
      </table>
    </section>
  </div>
</main>
<script>
  const $ = (id) => document.getElementById(id);
  const rate = (ok, bad) => (ok + bad === 0 ? '–' : ((100 * bad) / (ok + bad)).toFixed(1) + '%');
  const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });

  async function refresh() {
    const s = await (await fetch('/status')).json();
    $('flag').textContent = s.flag.enabled ? 'ON' : 'OFF';
    $('flag').className = 'pill ' + (s.flag.enabled ? 'on' : 'off');
    $('bug').textContent = s.bug.on ? 'Broken (' + Math.round(s.bug.failRate * 100) + '% fail)' : 'Healthy';
    $('bug').className = 'pill ' + (s.bug.on ? 'broken' : 'on');
    $('rollout').textContent = s.rolloutPercent + '% of users';
    for (const k of ['newOk', 'newFailed', 'classicOk', 'classicFailed']) $(k).textContent = s.stats[k];
    $('newRate').textContent = rate(s.stats.newOk, s.stats.newFailed);
    $('classicRate').textContent = rate(s.stats.classicOk, s.stats.classicFailed);
  }

  $('buy').onclick = async () => {
    const r = await (await post('/checkout', { userId: 'visitor-' + Math.random() })).json();
    $('result').textContent = r.ok ? '✓ ' + r.message : '✗ Checkout failed (' + r.checkout + ' checkout)';
    $('result').style.color = r.ok ? 'var(--ok)' : 'var(--bad)';
    refresh();
  };
  $('break').onclick = () => post('/admin/bug', { on: true }).then(refresh);
  $('fix').onclick = () => post('/admin/bug', { on: false }).then(refresh);
  refresh();
  setInterval(refresh, 1000);
</script>
</body>
</html>`;
}
