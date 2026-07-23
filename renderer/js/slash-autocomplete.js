/* slash-autocomplete.js — keyboard-first Kimi CLI command completion.
 *
 * Opens only when the composer contains a single slash-command token. The
 * main process owns the authoritative command/skill catalog; this renderer
 * module owns filtering, focus-safe selection, and accessible listbox UI.
 */
(function () {
  'use strict';

  const T = (key, fallback) => (window.I18N?.t ? window.I18N.t(key, fallback) : fallback);
  const MAX_RESULTS = 10;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function score(name, rawInput) {
    const haystack = String(name || '').toLowerCase().replace(/^\//, '');
    const needle = String(rawInput || '').toLowerCase().trim().replace(/^\//, '');
    if (!needle) return 1;
    if (haystack === needle) return 1000;
    if (haystack.startsWith(needle)) return 700 - (haystack.length - needle.length);
    const contains = haystack.indexOf(needle);
    if (contains >= 0) return 500 - contains * 4 - (haystack.length - needle.length);
    let cursor = 0;
    let gaps = 0;
    let previous = -1;
    for (const char of needle) {
      const found = haystack.indexOf(char, cursor);
      if (found < 0) return 0;
      if (previous >= 0) gaps += found - previous - 1;
      previous = found;
      cursor = found + 1;
    }
    return 250 - gaps * 3 - (haystack.length - needle.length);
  }

  function filter(commands, input) {
    return commands
      .map((command, index) => ({ command, index, score: score(command.name, input) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .slice(0, MAX_RESULTS)
      .map((item) => item.command);
  }

  function create({ composer, onValueChange, getContext } = {}) {
    if (!composer) return null;
    const wrap = composer.closest('#composer-wrap') || composer.parentElement;
    if (!wrap) return null;

    const menu = el('div', 'slash-menu');
    menu.hidden = true;
    menu.setAttribute('role', 'listbox');
    menu.setAttribute('aria-label', T('slash.menu_aria', 'Kimi CLI commands'));
    const header = el('div', 'slash-menu-header');
    header.append(
      el('span', 'slash-menu-title', T('slash.menu_title', 'Kimi CLI commands')),
      el('span', 'slash-menu-hint', T('slash.menu_hint', '↑↓ Navigate · Enter Complete'))
    );
    const list = el('div', 'slash-menu-list');
    menu.append(header, list);
    wrap.insertBefore(menu, wrap.firstChild);

    let commands = [];
    let results = [];
    let activeIndex = 0;
    let contextKey = null;
    let loadRequest = 0;
    let loading = false;

    function context() {
      const value = typeof getContext === 'function' ? getContext() : {};
      return value && typeof value === 'object' ? value : {};
    }

    function canOpen() {
      const value = composer.value;
      const ctx = context();
      return ctx.engine === 'cli' && value.startsWith('/') && !/\s/.test(value);
    }

    function close() {
      menu.hidden = true;
      composer.removeAttribute('aria-activedescendant');
      results = [];
      activeIndex = 0;
    }

    function render() {
      list.textContent = '';
      if (loading && !commands.length) {
        list.appendChild(el('div', 'slash-menu-state', T('slash.loading', 'Loading commands…')));
        menu.hidden = false;
        return;
      }
      if (!results.length) {
        list.appendChild(el('div', 'slash-menu-state', T('slash.empty', 'No matching commands')));
        menu.hidden = false;
        composer.removeAttribute('aria-activedescendant');
        return;
      }
      results.forEach((command, index) => {
        const option = el('div', 'slash-option');
        option.id = `slash-option-${index}`;
        option.setAttribute('role', 'option');
        option.setAttribute('aria-selected', index === activeIndex ? 'true' : 'false');
        option.classList.toggle('active', index === activeIndex);
        const name = el('span', 'slash-option-name', command.name);
        const description = el(
          'span',
          'slash-option-description',
          command.descriptionKey
            ? T(command.descriptionKey, command.description)
            : command.description
        );
        option.append(name, description);
        if (command.isSkill) {
          option.appendChild(el('span', 'slash-option-badge', T('slash.skill_badge', 'Skill')));
        }
        option.addEventListener('mouseenter', () => {
          activeIndex = index;
          render();
        });
        option.addEventListener('mousedown', (event) => {
          event.preventDefault();
          select(index);
        });
        list.appendChild(option);
      });
      menu.hidden = false;
      composer.setAttribute('aria-activedescendant', `slash-option-${activeIndex}`);
      list.querySelector('.slash-option.active')?.scrollIntoView?.({ block: 'nearest' });
    }

    function update() {
      if (!canOpen()) {
        close();
        return;
      }
      results = filter(commands, composer.value);
      activeIndex = Math.min(activeIndex, Math.max(0, results.length - 1));
      render();
      void ensureCatalog();
    }

    async function ensureCatalog({ force = false } = {}) {
      const ctx = context();
      if (ctx.engine !== 'cli' || typeof window.kimi?.listSlashCommands !== 'function') return;
      const nextKey = `${ctx.sessionId || ''}\0${ctx.cwd || ''}\0${ctx.engine}`;
      if (!force && (nextKey === contextKey || loading)) return;
      contextKey = nextKey;
      const request = ++loadRequest;
      loading = true;
      if (canOpen()) render();
      try {
        const response = await window.kimi.listSlashCommands({
          sessionId: ctx.sessionId || null,
          cwd: ctx.cwd || null,
        });
        if (request !== loadRequest) return;
        commands = Array.isArray(response?.commands) ? response.commands : [];
      } catch (error) {
        console.warn('listSlashCommands failed', error);
        if (request === loadRequest) commands = [];
      } finally {
        if (request === loadRequest) {
          loading = false;
          if (canOpen()) update();
        }
      }
    }

    function select(index = activeIndex) {
      const command = results[index];
      if (!command) return false;
      composer.value = command.name + (command.acceptsInput ? ' ' : '');
      close();
      onValueChange?.();
      composer.focus();
      const end = composer.value.length;
      composer.setSelectionRange(end, end);
      return true;
    }

    function move(delta) {
      if (!results.length) return;
      activeIndex = (activeIndex + delta + results.length) % results.length;
      render();
    }

    function handleKeydown(event) {
      if (menu.hidden) return false;
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        move(1);
        return true;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        move(-1);
        return true;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        if (!results.length) return false;
        event.preventDefault();
        select();
        return true;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
        return true;
      }
      return false;
    }

    function refresh() {
      contextKey = null;
      void ensureCatalog({ force: true });
      if (canOpen()) update();
      else close();
    }

    composer.setAttribute('aria-autocomplete', 'list');
    composer.setAttribute('aria-controls', 'slash-command-menu');
    menu.id = 'slash-command-menu';
    window.I18N?.onChange?.(() => {
      menu.setAttribute('aria-label', T('slash.menu_aria', 'Kimi CLI commands'));
      header.querySelector('.slash-menu-title').textContent = T('slash.menu_title', 'Kimi CLI commands');
      header.querySelector('.slash-menu-hint').textContent = T('slash.menu_hint', '↑↓ Navigate · Enter Complete');
      if (!menu.hidden) render();
    });

    return {
      close,
      handleInput: update,
      handleKeydown,
      refresh,
    };
  }

  window.SlashAutocomplete = { create };
})();
