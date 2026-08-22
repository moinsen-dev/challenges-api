/**
 * Challenges API — drop-in leaderboard.
 *
 *   <script src="https://challenges.moinsen.dev/embed/leaderboard.js"
 *           data-key="chapi_pk_..."
 *           data-discipline="score-attack"
 *           data-region="hh-altona"
 *           data-limit="10"></script>
 *
 * Renders where the tag sits. No build step, no dependencies, and everything
 * inside a shadow root so it cannot collide with the host page's CSS.
 *
 * Only a public key belongs here. That is enforced, not assumed.
 */
;(function () {
  var script = document.currentScript
  if (!script) return

  var data = script.dataset
  var base = (data.base || 'https://challenges-api.moinsen.dev').replace(/\/$/, '')
  var key = data.key || ''
  var discipline = data.discipline || ''
  var region = data.region || ''
  var limit = Math.min(parseInt(data.limit || '10', 10) || 10, 50)
  var highlight = (data.highlight || '').toLowerCase()

  var host = document.createElement('div')
  host.className = 'challenges-leaderboard'
  script.parentNode.insertBefore(host, script.nextSibling)
  var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host

  var style = document.createElement('style')
  style.textContent = [
    ':host{all:initial}',
    '*{box-sizing:border-box}',
    '.b{font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;',
    'border:1px solid var(--line);border-radius:12px;overflow:hidden;',
    'background:var(--bg);color:var(--fg);max-width:520px}',
    '.b{--bg:#12161a;--fg:#e7ecf3;--muted:#8c97a5;--line:#242b33;--gold:#e9b949;--row:#1a1f25}',
    '@media(prefers-color-scheme:light){.b{--bg:#fff;--fg:#15181c;--muted:#6b7480;--line:#e3e7ec;--gold:#a97a12;--row:#f6f8fa}}',
    '.h{display:flex;gap:8px;align-items:baseline;padding:11px 15px;border-bottom:1px solid var(--line);',
    'font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted)}',
    '.h b{color:var(--fg);font-weight:600}.h .s{margin-left:auto}',
    'ol{list-style:none;margin:0;padding:0}',
    'li{display:grid;grid-template-columns:30px 1fr auto;gap:10px;align-items:center;padding:9px 15px}',
    'li+li{border-top:1px solid var(--line)}',
    'li.me{background:var(--row)}',
    'li.top{background:linear-gradient(90deg,color-mix(in srgb,var(--gold) 14%,transparent),transparent 70%)}',
    '.r{font:12px ui-monospace,Menlo,monospace;color:var(--muted)}',
    'li.top .r,li.top .v{color:var(--gold)}',
    'li.top .n{font-weight:600}',
    '.v{font:13px ui-monospace,Menlo,monospace;color:var(--muted)}',
    '.f{padding:9px 15px;border-top:1px solid var(--line);font-size:12px;color:var(--muted);',
    'display:flex;gap:8px;flex-wrap:wrap}',
    '.f .t{color:var(--gold)}',
    '.m{padding:22px 15px;color:var(--muted);text-align:center;font-size:13px}',
  ].join('')
  root.appendChild(style)

  var box = document.createElement('div')
  box.className = 'b'
  root.appendChild(box)

  var esc = function (value) {
    return String(value == null ? '' : value).replace(/[<>&"]/g, function (ch) {
      return { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[ch]
    })
  }
  var message = function (text) {
    box.innerHTML = '<div class="m">' + esc(text) + '</div>'
  }

  if (!key || !discipline) return message('Set data-key and data-discipline.')
  if (key.indexOf('chapi_sk_') === 0)
    return message('That is a secret key. Only a public key belongs on a page.')

  var url =
    base +
    '/v1/leaderboards/' +
    encodeURIComponent(discipline) +
    '?limit=' +
    limit +
    (region ? '&region=' + encodeURIComponent(region) : '')

  message('Loading…')

  fetch(url, { headers: { 'X-App-Key': key } })
    .then(function (res) {
      return res.json().then(function (body) {
        if (!res.ok) throw new Error(body && body.error ? body.error : res.statusText)
        return body
      })
    })
    .then(function (board) {
      var rows = board.entries || []
      var head =
        '<div class="h"><b>' +
        esc(board.discipline) +
        '</b>' +
        (region ? '<span>· ' + esc(region) + '</span>' : '<span>· global</span>') +
        '<span class="s">' +
        esc(board.season || '') +
        '</span></div>'

      if (!rows.length) {
        box.innerHTML =
          head + '<div class="m">Nobody has qualified yet. Be the first.</div>' + footer(board)
        return
      }

      var list = rows
        .map(function (row) {
          var classes = []
          if (row.rank === 1) classes.push('top')
          if (highlight && String(row.handle).toLowerCase() === highlight) classes.push('me')
          return (
            '<li class="' +
            classes.join(' ') +
            '"><span class="r">' +
            row.rank +
            '</span><span class="n">' +
            esc(row.display_name || row.handle) +
            '</span><span class="v">' +
            formatValue(row.value, board) +
            '</span></li>'
          )
        })
        .join('')
      box.innerHTML = head + '<ol>' + list + '</ol>' + footer(board)
    })
    .catch(function (error) {
      // An embed must never take the host page down with it.
      message('Leaderboard unavailable: ' + error.message)
    })

  function formatValue(value, board) {
    var text = Number(value).toLocaleString()
    return esc(board.unit ? text + ' ' + board.unit : text)
  }

  function footer(board) {
    var parts = ['<span>' + board.contenders + ' contenders</span>']
    if (board.title_eligible) parts.push('<span class="t">title eligible</span>')
    else if (board.title_min_players)
      parts.push('<span>' + board.title_min_players + ' needed for a title</span>')
    return '<div class="f">' + parts.join('') + '</div>'
  }
})()
