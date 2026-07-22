/* usage.js — usage view: account quota cards + current-session usage. */
'use strict';

(function () {
  const T = (k, f) => (window.I18N?.t ? window.I18N.t(k, f) : f);

  const CONSOLE_URL = 'https://www.kimi.com/code/console';
  const intFmt = new Intl.NumberFormat('ko-KR');
  const usdFmt = new Intl.NumberFormat('ko-KR', {
    style: 'currency',
    currency: 'USD',
    currencyDisplay: 'narrowSymbol',
  });

  let currentState = null; // last state passed to render(), for event updates

  /* ---- small DOM helpers ---- */

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function fmtNum(n) {
    return typeof n === 'number' && Number.isFinite(n) ? intFmt.format(n) : '—';
  }

  function ratio(used, limit) {
    return typeof used === 'number' && typeof limit === 'number' && limit > 0
      ? used / limit
      : null;
  }

  /** Contract-styled progress bar; fill width set inline (no extra classes). */
  function progressBar(r) {
    const bar = el('div', 'progress-bar');
    const fill = document.createElement('div');
    fill.style.width = `${Math.max(0, Math.min(100, Math.round((r ?? 0) * 100)))}%`;
    bar.appendChild(fill);
    return bar;
  }

  function quotaCard(title, value, r, caption) {
    const card = el('div', 'usage-card');
    card.appendChild(el('div', 'usage-card-title', title));
    card.appendChild(el('div', 'usage-card-value', value));
    if (r != null) {
      card.appendChild(progressBar(r));
      card.appendChild(el('div', 'usage-card-caption', Math.round(r * 100) + T('usage.percent_used', '% 사용')));
    }
    if (caption) card.appendChild(el('div', 'usage-card-caption', caption));
    return card;
  }

  /* ---- account quota cards ---- */

  function renderQuotaCards(container, quota) {
    const grid = el('div', 'usage-card-grid');
    if (!quota) {
      // Quota undiscoverable: point the user at the web console instead.
      const card = el('div', 'usage-card');
      card.appendChild(el('div', 'usage-card-title', T('usage.account_quota', '계정 할당량')));
      card.appendChild(
        el('div', 'usage-card-value', T('usage.quota_console_hint', 'Kimi Code Console에서 확인할 수 있습니다'))
      );
      const openBtn = el('button', 'usage-open-btn', T('usage.open', '열기'));
      openBtn.type = 'button';
      openBtn.addEventListener('click', () => window.kimi.openExternal(CONSOLE_URL));
      card.appendChild(openBtn);
      grid.appendChild(card);
    } else {
      const resets =
        typeof quota.resetsAt === 'string' && quota.resetsAt
          ? T('usage.resets', '재설정: ') +
            new Date(quota.resetsAt).toLocaleString(window.I18N?.lang === 'en' ? 'en-US' : 'ko-KR')
          : null;
      grid.appendChild(
        quotaCard(
          T('usage.weekly', '주간 사용량'),
          `${fmtNum(quota.weeklyUsed)} / ${fmtNum(quota.weeklyLimit)}`,
          ratio(quota.weeklyUsed, quota.weeklyLimit),
          resets
        )
      );
      grid.appendChild(
        quotaCard(
          T('usage.window_5h', '5시간 윈도우'),
          `${fmtNum(quota.window5hUsed)} / ${fmtNum(quota.window5hLimit)}`,
          ratio(quota.window5hUsed, quota.window5hLimit),
          null
        )
      );
      if (quota.extraBalance != null) {
        grid.appendChild(
          quotaCard(
            T('usage.extra_balance', '추가 잔액'),
            fmtNum(quota.extraBalance),
            null,
            null
          )
        );
      }
    }
    container.appendChild(grid);
  }

  /* ---- daily usage (v3): today totals + 7-day mini bar chart ---- */

  const WEEKDAYS_KO = ['일', '월', '화', '수', '목', '금', '토'];
  const WEEKDAYS_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  function dayLabel(dateStr, isToday) {
    if (isToday) return T('usage.daily.today', '오늘');
    const d = new Date(dateStr + 'T00:00:00'); // local noon-safe parse of YYYY-MM-DD
    const names = window.I18N?.lang === 'en' ? WEEKDAYS_EN : WEEKDAYS_KO;
    return Number.isNaN(d.getTime()) ? dateStr.slice(5) : names[d.getDay()];
  }

  /** One chart column: stacked-height pair of bars + weekday label. */
  function dailyCol(d, max, isToday) {
    const inTok = Number(d?.input_tokens ?? 0) || 0;
    const outTok = Number(d?.output_tokens ?? 0) || 0;
    const col = el('div', 'daily-col');
    const inPct = max > 0 ? Math.round((inTok / max) * 100) : 0;
    const outPct = max > 0 ? Math.round((outTok / max) * 100) : 0;
    const bars = el('div', 'daily-bars');
    const inBar = el('div', 'daily-bar daily-bar-in');
    const outBar = el('div', 'daily-bar daily-bar-out');
    // Zero-data days render as a flat baseline tick instead of a gap.
    inBar.style.height = inTok > 0 ? `${Math.max(inPct, 2)}%` : '0';
    outBar.style.height = outTok > 0 ? `${Math.max(outPct, 2)}%` : '0';
    if (inTok === 0 && outTok === 0) bars.classList.add('empty');
    bars.appendChild(inBar);
    bars.appendChild(outBar);
    col.appendChild(bars);
    col.appendChild(el('div', 'daily-day' + (isToday ? ' today' : ''), dayLabel(d?.date ?? '', isToday)));
    return col;
  }

  /**
   * v4 (R2): one '한도' progress row — label + used/limit (%) + bar. The
   * /usages API has no daily window, so the daily section shows the live
   * weekly / 5-hour limits next to today's tokens.
   */
  function limitRow(label, used, limit) {
    const row = el('div', 'daily-limit-row');
    const head = el('div', 'daily-limit-head');
    head.appendChild(el('span', 'daily-limit-label', label));
    const r = ratio(used, limit);
    head.appendChild(
      el(
        'span',
        'daily-limit-value',
        r == null ? '—' : `${fmtNum(used)} / ${fmtNum(limit)} (${Math.round(r * 100)}%)`
      )
    );
    row.appendChild(head);
    row.appendChild(progressBar(r)); // clamps width; null ratio -> empty bar
    return row;
  }

  /** '한도' sub-block for the daily section, fed by render()'s getQuota(). */
  function renderDailyLimits(quota) {
    const box = el('div', 'daily-limits');
    box.appendChild(el('h3', 'daily-limits-title', T('usage.daily.limits', '한도')));
    if (!quota) {
      box.appendChild(
        el('p', 'daily-limits-unavailable', T('usage.daily.limit_unavailable', '한도 정보를 불러올 수 없습니다'))
      );
      return box;
    }
    box.appendChild(
      limitRow(
        T('usage.daily.weekly_limit', '주간 한도'),
        quota.weeklyUsed,
        quota.weeklyLimit
      )
    );
    box.appendChild(
      limitRow(
        T('usage.daily.window_5h_limit', '5시간 한도'),
        quota.window5hUsed,
        quota.window5hLimit
      )
    );
    return box;
  }

  /**
   * '오늘 사용량' section, inserted ABOVE the quota cards (created lazily so
   * index.html stays untouched). Hidden entirely when the preload lacks
   * getDailyUsage (older backend) or the fetch fails.
   * v4: takes render()'s shared getQuota() promise for the '한도' sub-block
   * (one fetch feeds both here and the account cards — no refetch).
   */
  async function renderDaily(quotaPromise) {
    const view = document.getElementById('usage-view');
    if (!view || typeof window.kimi?.getDailyUsage !== 'function') return;
    let box = document.getElementById('daily-usage');
    if (!box) {
      box = el('div', 'daily-usage');
      box.id = 'daily-usage';
      view.insertBefore(box, view.firstChild);
    }
    box.textContent = '';

    let data = null;
    try {
      data = await window.kimi.getDailyUsage();
    } catch (err) {
      console.error('getDailyUsage failed', err);
    }
    const days = Array.isArray(data?.days) ? data.days : [];
    if (!data || days.length === 0) {
      box.hidden = true;
      return;
    }
    box.hidden = false;

    box.appendChild(el('h2', 'usage-section-title', T('usage.daily.title', '오늘 사용량')));

    const todayRow = el('div', 'daily-today');
    const today = data.today ?? {};
    const items = [
      [T('usage.daily.input_tokens', '입력 토큰'), fmtNum(today.input_tokens)],
      [T('usage.daily.output_tokens', '출력 토큰'), fmtNum(today.output_tokens)],
    ];
    if (typeof today.cost_usd === 'number' && Number.isFinite(today.cost_usd)) {
      items.push([T('usage.daily.cost', '비용'), usdFmt.format(today.cost_usd)]);
    }
    for (const [label, value] of items) {
      const item = el('div', 'daily-today-item');
      item.appendChild(el('span', 'daily-today-value', value));
      item.appendChild(el('span', 'daily-today-label', label));
      todayRow.appendChild(item);
    }
    box.appendChild(todayRow);

    // v4 (R2): '한도' sub-block — below today numbers, above the chart.
    const quota = quotaPromise ? await quotaPromise : null;
    box.appendChild(renderDailyLimits(quota));

    const chart = el('div', 'daily-chart');
    const max = days.reduce(
      (m, d) => Math.max(m, Number(d?.input_tokens ?? 0) || 0, Number(d?.output_tokens ?? 0) || 0),
      0
    );
    days.forEach((d, i) => chart.appendChild(dailyCol(d, max, i === days.length - 1)));
    box.appendChild(chart);

    const legend = el('div', 'daily-legend');
    for (const [swatch, label] of [
      ['daily-swatch-in', T('usage.daily.input', '입력')],
      ['daily-swatch-out', T('usage.daily.output', '출력')],
    ]) {
      const item = el('span', 'daily-legend-item');
      item.appendChild(el('span', `daily-swatch ${swatch}`));
      item.appendChild(document.createTextNode(label));
      legend.appendChild(item);
    }
    box.appendChild(legend);
  }

  /* ---- current-session usage ---- */

  function usageRow(label, value) {
    const row = el('div', 'usage-row');
    row.appendChild(el('span', 'usage-row-label', label));
    row.appendChild(el('span', 'usage-row-value', value));
    return row;
  }

  /** Detail block for a session usage object; class .usage-detail for updates. */
  function usageDetail(usage) {
    const box = el('div', 'usage-detail');
    box.appendChild(
      usageRow(
        T('usage.input_tokens', '입력 토큰'),
        fmtNum(usage?.input_tokens)
      )
    );
    box.appendChild(
      usageRow(
        T('usage.output_tokens', '출력 토큰'),
        fmtNum(usage?.output_tokens)
      )
    );
    box.appendChild(
      usageRow(
        T('usage.cache_read_tokens', '캐시 읽기 토큰'),
        fmtNum(usage?.cache_read_tokens)
      )
    );
    box.appendChild(
      usageRow(
        T('usage.cache_creation_tokens', '캐시 생성 토큰'),
        fmtNum(usage?.cache_creation_tokens)
      )
    );
    box.appendChild(
      usageRow(
        T('usage.total_cost', '총 비용'),
        typeof usage?.total_cost_usd === 'number' ? usdFmt.format(usage.total_cost_usd) : '—'
      )
    );
    box.appendChild(
      usageRow(
        T('usage.turns', '턴 수'),
        fmtNum(usage?.turn_count)
      )
    );

    const limit = Number(usage?.context_limit ?? 0);
    const used = Number(usage?.context_tokens ?? 0);
    const ctx = el('div', 'usage-context');
    ctx.appendChild(el('div', 'usage-card-title', T('usage.context_window', '컨텍스트 윈도우')));
    ctx.appendChild(
      el(
        'div',
        'usage-card-value',
        limit > 0
          ? `${intFmt.format(used)} / ${intFmt.format(limit)}` +
            T('common.tokens', ' 토큰') +
            ` (${Math.round((used / limit) * 100)}%)`
          : '—'
      )
    );
    if (limit > 0) ctx.appendChild(progressBar(used / limit));
    box.appendChild(ctx);
    return box;
  }

  function renderSessionUsage(container, state) {
    if (!state?.activeId) {
      container.appendChild(
        el('p', 'usage-empty', T('usage.no_session', '선택된 세션이 없습니다. 대화를 시작하면 이곳에 사용량이 표시됩니다.'))
      );
      return;
    }
    // Rendered asynchronously by render(); placeholder until the profile arrives.
    container.appendChild(el('p', 'usage-empty', T('common.loading', '불러오는 중…')));
  }

  /* ---- public API ---- */

  /** Full render: daily stats + quota cards + active session usage. Called when the view shows. */
  async function render(state) {
    currentState = state;
    const quotaBox = document.getElementById('quota-cards');
    const sessionBox = document.getElementById('session-usage');
    if (!quotaBox || !sessionBox) return;
    quotaBox.textContent = '';
    sessionBox.textContent = '';
    // v4 (R2): one getQuota() call feeds both the daily '한도' sub-block and
    // the account quota cards — share the promise, never refetch.
    const quotaPromise = Promise.resolve()
      .then(() => window.kimi.getQuota())
      .catch((err) => {
        console.error('getQuota failed', err);
        return null;
      });
    void renderDaily(quotaPromise); // '오늘 사용량' section above the quota cards; no need to block on it
    quotaBox.appendChild(el('h2', 'usage-section-title', T('usage.account_quota', '계정 할당량')));
    sessionBox.appendChild(el('h2', 'usage-section-title', T('usage.current_session', '현재 세션')));
    renderSessionUsage(sessionBox, state);

    const quota = await quotaPromise;
    renderQuotaCards(quotaBox, quota);

    const activeId = state?.activeId;
    if (activeId) {
      try {
        const profile = await window.kimi.getProfile(activeId);
        if (activeId !== currentState?.activeId) return; // view state changed mid-fetch
        updateUsage(activeId, profile?.usage);
      } catch (err) {
        console.error('getProfile failed', err);
        const placeholder = sessionBox.querySelector('.usage-empty');
        if (placeholder) placeholder.textContent = T('usage.load_failed', '사용량 정보를 불러올 수 없습니다.');
      }
    }
  }

  /** In-place update from a 'usage' push event (or after a profile fetch). */
  function updateUsage(sessionId, usage) {
    if (!usage || sessionId !== currentState?.activeId) return;
    const sessionBox = document.getElementById('session-usage');
    if (!sessionBox) return;
    const detail = usageDetail(usage);
    const old = sessionBox.querySelector('.usage-detail');
    if (old) old.replaceWith(detail);
    else {
      sessionBox.querySelector('.usage-empty')?.remove();
      sessionBox.appendChild(detail);
    }
  }

  // Language change: re-render only when the usage view is visible.
  window.I18N?.onChange?.(() => {
    if (window.App?.state?.view === 'usage' && currentState) void render(currentState);
  });

  window.Usage = { render, updateUsage };
})();
