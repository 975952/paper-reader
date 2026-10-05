/* ═══════════════════════════════════════════════════════════════════════════
   reader.js —— 阅读助手界面的行为层（设计稿可交互实现）
   ───────────────────────────────────────────────────────────────────────────
   需求里每一条交互规则都在这里落地：
     · 发送范围上拉栏：点击箭头展开 / 点箭头收起 / 点外部收起 / 选完自动收起 /
       发送后自动收起 / 范围沿用到下一次 / 没有选中文字时置灰并提示
     · 依据展开：卡片内部展开，不新开窗口；展开后依据图标变激活态、保留数字
     · 跳转原文：正文滚到对应页与段落、短暂低饱和蓝高亮、卡片左上角出现返回箭头
     · 保存为笔记：图标原地变已保存、底部出现可编辑标题行（默认是用户的问题）、
       右侧只有确认 / 取消两个图标；保存后左栏笔记同步增加
     · 生成中 / 停止 / 失败：保留问题与已生成内容，底部只留对应图标
     · 复制：复制正文 + 论文名 + 页码 + 引用，图标短暂变对勾后恢复
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var I = window.PRT_ICONS;
  var P = window.PRT_PARTS;

  /* ── 常量数据 ────────────────────────────────────────────────────── */

  var PAPER = { name: 'Attention Is All You Need.pdf', short: 'Attention Is All You Need' };
  var DEFAULT_BASE = 'https://api.apiyi.com/v1';

  var FULL_ANSWER =
    'Transformer 使用自注意力机制，能够同时关注输入序列中的不同位置，' +
    '因此更好地处理长距离依赖关系。\n\n' +
    '每个位置的表示都由它与序列中所有位置的加权组合得到：权重来自 query 与 key 的兼容度，' +
    'value 按权重求和。前馈子层、残差连接与层归一化把这种可并行的关系建模固定成可堆叠的模块。\n\n' +
    '代价是计算量随序列长度平方增长，因此后来出现了多种稀疏化与近似方案。';

  /* 生成中状态展示的「已经生成的部分」 */
  var PARTIAL_ANSWER =
    'Transformer 使用自注意力机制，能够同时关注输入序列中的不同位置，' +
    '因此更好地处理长距离依赖关系。\n\n' +
    '每个位置的表示都由它与序列中所有位置的加权组合得到：权重来自 query 与 key 的兼容度，' +
    'value 按权重求和。';

  /* 失败状态保留的部分内容 */
  var FAILED_ANSWER =
    'Transformer 使用自注意力机制，能够同时关注输入序列中的不同位置，' +
    '因此更好地处理长距离依赖关系。\n\n' +
    '每个位置的表示都由它与序列中所有位置的加权组合得到：';

  var CITATIONS = [
    {
      title: 'Attention Is All You Need', page: 4, support: 'direct', anchor: 'p-dep',
      quote: 'the model to jointly attend to information from different representation subspaces at different positions',
      hit: 'jointly attend'
    },
    {
      title: 'Attention Is All You Need', page: 3, support: 'infer', anchor: 'p-attn',
      quote: 'the weight assigned to each value is computed by a compatibility function of the query with the corresponding key',
      hit: 'compatibility function'
    },
    {
      title: 'Neural Machine Translation by Jointly Learning to Align and Translate', page: 2, support: 'none',
      quote: '没有在本篇论文正文中找到与之直接对应的段落，该结论来自引言部分的综述性表述。',
      hit: ''
    }
  ];

  /* ── 应用状态 ────────────────────────────────────────────────────── */

  var state = {
    view: 'reading',          // reading | settings
    theme: 'light',
    themePref: 'light',
    answerFont: 17,
    defaultScope: 'paper',    // 设置页里的默认发送范围
    scope: 'paper',           // 发送框里的当前范围（发送后沿用）
    selection: '',
    rangeOpen: false,
    rangeClosing: false,
    menu: null,               // card | input | null
    savedNotes: 1,
    notes: [
      { id: 'n0', title: '为什么自注意力能替代循环结构？', paper: PAPER.short, page: 4, ts: Date.now() - 86400000 }
    ],
    card: null,
    cardOrder: 1,
    backFrom: null,           // 跳转前的阅读位置
    hitTimer: null,
    typing: null,
    copyFlash: false
  };

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  /* ── 界面状态定义（每条对应需求里的一个状态，也是截图入口） ──────── */

  function baseCard(over) {
    var card = {
      id: 'c' + state.cardOrder++,
      question: '为什么自注意力能替代循环结构？',
      answer: FULL_ANSWER,
      ui: 'done',            // done | streaming | stopped | failed
      scope: state.scope === 'paper-web' ? ['paper', 'web'] : [state.scope],
      citations: CITATIONS.slice(0, 2),
      evidenceOpen: false,
      note: null,
      showQuestion: false,
      streamFrom: 0
    };
    for (var k in over) if (Object.prototype.hasOwnProperty.call(over, k)) card[k] = over[k];
    return card;
  }

  var STATES = [
    { id: 'settings-light', name: '设置页 · 浅色', group: '设置', view: 'settings', theme: 'light' },
    { id: 'settings-dark',  name: '设置页 · 深色', group: '设置', view: 'settings', theme: 'dark' },
    { id: 'answer-basic',   name: '回答卡片（默认）', group: '回答', theme: 'light',
      card: function () { return baseCard(); } },
    { id: 'answer-evidence', name: '依据展开', group: '回答', theme: 'light',
      card: function () { return baseCard({ evidenceOpen: true }); } },
    { id: 'answer-jump',    name: '跳转原文', group: '回答', theme: 'light', scrollPage: 'page4', highlight: 'p-dep',
      card: function () { return baseCard({ evidenceOpen: true, backFrom: true, scope: ['paper'] }); } },
    { id: 'answer-note',    name: '已保存笔记', group: '回答', theme: 'light',
      card: function () {
        return baseCard({
          note: { title: '为什么自注意力能替代循环结构？', editing: false },
          scope: ['paper']
        });
      } },
    { id: 'answer-menu',    name: '更多菜单展开', group: '回答', theme: 'light', menu: 'card',
      card: function () { return baseCard(); } },
    { id: 'icon-hover',     name: '图标悬停', group: '回答', theme: 'light', hover: 'cite',
      card: function () { return baseCard(); } },

    /* 与现有应用一一对应的三个入口：论文操作、划选动作、页边标记 */
    { id: 'ops-menu',       name: '论文操作菜单', group: '回答', theme: 'light', menu: 'ops',
      card: function () { return baseCard(); } },
    { id: 'selection-bubble', name: '划选气泡', group: '回答', theme: 'light', bubble: true, type: true,
      card: function () {
        return baseCard({
          label: '译文',
          answer: '注意力函数可以描述为：把一个 query 与一组 key-value 对映射成一个输出，其中 query、key、value 与输出都是向量。',
          citations: [{ title: PAPER.short, page: 3, support: 'direct', anchor: 'p-attn', quote: 'An attention function can be described as mapping a query and a set of key-value pairs to an output', hit: 'attention function' }]
        });
      } },
    { id: 'page-bookmark',  name: '页边标记', group: '回答', theme: 'light', bookmark: true,
      card: function () { return baseCard({ scope: ['page'] }); } },

    { id: 'range-collapsed', name: '发送范围收起', group: '发送范围', theme: 'light', type: true,
      card: function () { return baseCard({ scope: ['paper'] }); } },
    { id: 'range-expanded',  name: '发送范围展开', group: '发送范围', theme: 'light', type: true, rangeOpen: true,
      card: function () { return baseCard({ scope: ['paper'] }); } },
    { id: 'range-web',       name: '论文 + 联网搜索', group: '发送范围', theme: 'light', scope: 'paper-web', type: true,
      card: function () { return baseCard({ scope: ['paper', 'web'] }); } },

    { id: 'gen-streaming',  name: '正在生成', group: '状态', theme: 'light', busy: true,
      card: function () { return baseCard({ ui: 'streaming', answer: PARTIAL_ANSWER, showQuestion: true, streamFrom: PARTIAL_ANSWER.length }); } },
    { id: 'gen-stopped',    name: '停止生成', group: '状态', theme: 'light',
      card: function () { return baseCard({ ui: 'stopped', answer: PARTIAL_ANSWER, showQuestion: true }); } },
    { id: 'gen-failed',     name: '失败重试', group: '状态', theme: 'light',
      card: function () { return baseCard({ ui: 'failed', answer: FAILED_ANSWER, showQuestion: true }); } },

    { id: 'dark-answer',    name: '深色 · 回答卡片', group: '深色', theme: 'dark',
      card: function () { return baseCard(); } },
    { id: 'dark-range',     name: '深色 · 发送范围', group: '深色', theme: 'dark', rangeOpen: true, type: true,
      card: function () { return baseCard(); } },
    { id: 'dark-failed',    name: '深色 · 失败重试', group: '深色', theme: 'dark',
      card: function () { return baseCard({ ui: 'failed', answer: FAILED_ANSWER, showQuestion: true }); } }
  ];

  var jumping = false;   // 「跳转原文」是交互动作，不作为可点选状态

  /* ── 渲染 ────────────────────────────────────────────────────────── */

  function renderTabs() {
    var host = $('#dsTabs');
    var f = document.createDocumentFragment();
    STATES.forEach(function (s) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'ds-tab';
      b.setAttribute('data-state-tab', s.id);
      b.setAttribute('aria-current', 'false');
      b.textContent = s.name;
      f.appendChild(b);
    });
    host.appendChild(f);
  }

  function renderNotes() {
    $('#notesCount').textContent = String(state.notes.length);
    $('#railNotesCount').textContent = String(state.notes.length);
    $('#railNotesCount').hidden = state.notes.length === 0;
    $('#notesList').innerHTML = state.notes.length ? P.notesListHTML(state.notes.slice().reverse()) : '';
    $('#notesEmpty').hidden = state.notes.length > 0;
  }

  function renderCard() {
    $('#asList').innerHTML = state.card ? P.cardHTML(state.card) : '';
    if (state.card && state.card.note && state.card.note.editing) {
      var input = $('#noteTitleInput');
      if (input) {
        input.value = state.card.note.title;
        if (!state.card.note.focusOnce) {
          state.card.note.focusOnce = true;
          input.focus();
          input.setSelectionRange(input.value.length, input.value.length);
        }
      }
    }
    syncCardExtras();
  }

  /** 由状态定义施加的一次性界面事实（跳转、菜单、悬停演示、生成）。 */
  function syncCardExtras() {
    var def = currentDef();

    if (def.id === 'answer-jump') {
      var target = document.getElementById(def.scrollPage || 'page4');
      if (target) $('#pdfScroll').scrollTop = target.offsetTop - 16;
      if (def.highlight) applyHit(def.highlight, false);
      $('#jumpBack').hidden = false;
    }
    if (def.menu === 'card') openCardMenu('moreDefault');
    if (def.menu === 'ops') { var ops = $('#btnOps'); if (ops) openMenu('ops', ops); }
    if (def.bubble) {
      var target = $('#p-attn');
      if (target) {
        var range = document.createRange();
        range.selectNodeContents(target);
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        window.setTimeout(function () { showSelBubble(window.getSelection()); }, 30);
      }
    }
    if (def.bookmark && !$('#viewer .page-bookmark')) {
      state.selection = 'An attention function can be described as mapping a query and a set of key-value pairs to an output';
      addBookmark();
      renderAttach();
    }
    if (def.hover === 'cite') {
      var btn = $('[data-action="evidence"]');
      if (btn) setHoverSim(btn);
    }
  }

  /** 悬停演示：只给该按钮加类（截图用），不改真实 :hover。 */
  function setHoverSim(btn) {
    $$('.is-hover-sim').forEach(function (el) { el.classList.remove('is-hover-sim'); });
    btn.classList.add('is-hover-sim');
    showHoverTip('依据 · 2 条原文证据', btn);
  }

  function applyHit(anchor, immediate) {
    var el = document.getElementById(anchor);
    if (!el) return;
    el.classList.remove('pg-hit', 'is-fading');
    void el.offsetWidth;
    el.classList.add('pg-hit');
    // 短暂：高亮后淡到很轻的状态留着，作为「刚刚从这里来的」定位标记，可被返回箭头清掉
    clearTimeout(state.hitTimer);
    state.hitTimer = window.setTimeout(function () { el.classList.add('is-fading'); }, immediate ? 400 : 900);
  }

  function currentDef() {
    var id = document.documentElement.getAttribute('data-state');
    return STATES.filter(function (s) { return s.id === id; })[0] || STATES[2];
  }

  /* ── 主题 ────────────────────────────────────────────────────────── */

  function resolvedTheme(pref) {
    if (pref === 'system') {
      return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    return pref;
  }

  function applyTheme(pref) {
    state.themePref = pref;
    state.theme = resolvedTheme(pref);
    document.documentElement.setAttribute('data-theme', state.theme);
    $$('[data-theme-set]').forEach(function (el) {
      var on = el.getAttribute('data-theme-set') === pref;
      if (el.classList.contains('seg-btn')) el.classList.toggle('is-active', on);
      if (el.getAttribute('role') === 'radio') el.setAttribute('aria-checked', on ? 'true' : 'false');
    });
  }

  /* ── 发送框 ──────────────────────────────────────────────────────── */

  function renderComposerBar() {
    var bar = $('#cpBar');
    if (!bar) return;
    var busy = state.card && state.card.ui === 'streaming';
    bar.innerHTML =
      P.iconBtn({
        icon: 'chev-up', label: state.rangeOpen ? '收起发送范围' : '展开发送范围',
        tip: state.rangeOpen ? '收起发送范围' : '发送范围', action: 'range-toggle',
        expanded: state.rangeOpen, cls: state.rangeOpen ? 'is-active' : ''
      }) +
      P.cpScopeHTML(state.scope) +
      P.iconBtn({ icon: 'capture', label: '截图 / 长截图，加进对话', tip: '截图加进对话', action: 'clip' }) +
      '<span class="cp-spacer"></span>' +
      P.iconBtn({ icon: 'more', label: '更多输入操作', tip: '更多输入操作', action: 'input-more', haspopup: true }) +
      P.iconBtn({
        icon: busy ? 'stop' : 'send',
        label: busy ? '停止生成' : '发送问题',
        tip: busy ? '停止' : '发送',
        action: busy ? 'stop' : 'send',
        cls: busy ? 'cp-stop' : 'cp-send',
        id: 'btnSend'
      });
  }

  function renderRangePanel() {
    var panel = $('#rangePanel');
    panel.innerHTML =
      '<div class="rp-head"><span class="rp-title">发送范围</span>' +
        P.iconBtn({ icon: 'chev-down', label: '收起发送范围', tip: '收起', action: 'range-collapse' }) +
      '</div>' +
      '<div class="rp-opts" id="rpOpts" role="radiogroup" aria-label="本次发送范围">' +
        P.rangeOptionsHTML(state.scope, !!state.selection) +
      '</div>' +
      '<p class="rp-note">范围只对下一次发送生效，之后沿用当前选择。</p>';
  }

  function setEmptyText() {
    var ta = $('#chatInput');
    if (!ta) return;
    if (ta.value === '') {
      ta.value = '\u00A0';
      ta.classList.add('is-empty');
    } else if (ta.value !== '\u00A0') {
      ta.classList.remove('is-empty');
    }
  }

  function inputText() {
    var v = $('#chatInput').value;
    return v === '\u00A0' ? '' : v.trim();
  }

  function renderAttach() {
    var row = $('#attachRow');
    if (!row) return;
    if (!state.selection) { row.hidden = true; return; }
    row.hidden = false;
    $('#attachText').textContent = state.selection;
  }

  function openRange() {
    state.rangeOpen = true;
    var panel = $('#rangePanel');
    panel.hidden = false;
    panel.classList.remove('is-closing');
    renderRangePanel();
  }

  function closeRange(animate) {
    if (!state.rangeOpen) return;
    state.rangeOpen = false;
    var panel = $('#rangePanel');
    if (animate && !panel.hidden) {
      panel.classList.add('is-closing');
      window.setTimeout(function () {
        panel.hidden = true;
        panel.classList.remove('is-closing');
      }, 130);
    } else {
      panel.hidden = true;
    }
  }

  /* ── 菜单 ────────────────────────────────────────────────────────── */

  function menuHTML(kind, card) {
    var items = [];
    if (kind === 'ops') {
      /* 论文操作：高频四个直接平铺，其余收进「更多操作」（与现有应用 ops.js 同一套动作） */
      items = [
        { icon: 'sparkle', label: '一句话速览', action: 'op-quick' },
        { icon: 'outline', label: '阅读路线', action: 'op-route' },
        { icon: 'explain', label: '方法拆解', action: 'op-method' },
        { icon: 'book', label: '术语表', action: 'op-terms' },
        { sep: true },
        { icon: 'more', label: '更多操作', action: 'op-more' }
      ];
    } else if (kind === 'input') {
      items = [
        { icon: 'selection', label: '把选中的文字加进来', action: 'attach-selection' },
        { icon: 'page', label: '把当前页面文字加进来', action: 'attach-page' },
        { icon: 'pencil', label: '插入公式', action: 'insert-formula' },
        { sep: true },
        { icon: 'trash', label: '清空输入框', action: 'clear-input' }
      ];
    } else if (card && card.ui === 'streaming') {
      items = [{ icon: 'copy', label: '复制已生成的内容', action: 'copy' }, { sep: true },
        { icon: 'trash', label: '删除', action: 'delete' }];
    } else if (card && card.ui === 'stopped') {
      items = [{ icon: 'play', label: '继续生成', action: 'resume' },
        { icon: 'regen', label: '重新回答', action: 'regen' },
        { icon: 'copy', label: '复制', action: 'copy' }, { sep: true },
        { icon: 'trash', label: '删除', action: 'delete' }];
    } else if (card && card.ui === 'failed') {
      items = [{ icon: 'regen', label: '重试', action: 'retry' },
        { icon: 'copy', label: '复制已生成的内容', action: 'copy' }, { sep: true },
        { icon: 'trash', label: '删除', action: 'delete' }];
    } else {
      items = [{ icon: 'copy', label: '复制', action: 'copy' },
        { icon: 'regen', label: '重新回答', action: 'regen' }, { sep: true },
        { icon: 'trash', label: '删除', action: 'delete' }];
    }
    return items.map(function (it) {
      if (it.sep) return '<div class="menu-sep" role="separator"></div>';
      var cls = it.action === 'delete' ? 'menu-item is-danger' : 'menu-item';
      return '<button type="button" class="' + cls + '" role="menuitem" data-action="' + it.action + '">' +
        '<span class="ic">' + I.svg(it.icon, 16) + '</span><span>' + P.esc(it.label) + '</span></button>';
    }).join('');
  }

  var MENU_SEL = { card: '#cardMenu', input: '#inputMenu', ops: '#opsMenu' };

  function openMenu(kind, anchor, card) {
    state.menu = kind;
    var menu = $(MENU_SEL[kind] || '#cardMenu');
    $$('#cardMenu, #inputMenu, #opsMenu').forEach(function (m) { if (m !== menu) m.hidden = true; });
    menu.innerHTML = menuHTML(kind, card);
    menu.hidden = false;
    var r = anchor.getBoundingClientRect();
    var mw = menu.offsetWidth, mh = menu.offsetHeight;
    var left = Math.min(r.left, window.innerWidth - mw - 8);
    left = Math.max(8, left);
    var top = r.top - mh - 6;
    if (top < 8) top = Math.min(r.bottom + 6, window.innerHeight - mh - 8);
    menu.style.left = Math.round(left) + 'px';
    menu.style.top = Math.round(top) + 'px';
    if (anchor.setAttribute) anchor.setAttribute('aria-expanded', 'true');
    anchor.setAttribute('data-menu-anchor', kind);
    var first = menu.querySelector('.menu-item');
    if (first) first.focus();
  }
  function closeMenu() {
    if (!state.menu) return;
    $$('#cardMenu, #inputMenu, #opsMenu').forEach(function (m) { m.hidden = true; });
    $$('[data-menu-anchor]').forEach(function (a) {
      a.setAttribute('aria-expanded', 'false');
      a.removeAttribute('data-menu-anchor');
    });
    state.menu = null;
  }

  function openCardMenu(anchorId) {
    var btn = document.getElementById(anchorId) || $('[data-action="more"]');
    if (btn) openMenu('card', btn, state.card);
  }

  /** 悬停演示：把 tooltip 显示出来（截图用，不依赖真实指针）。 */
  function showHoverTip(text, el) {
    var r = el.getBoundingClientRect();
    showTip(text, r.left + r.width / 2, r.top, 'top');
  }

  /* ── tooltip ─────────────────────────────────────────────────────── */

  var tipEl = null, tipTimer = null;

  function showTip(text, cx, top, place) {
    if (!text) return;
    tipEl.textContent = text;
    tipEl.hidden = false;
    var w = tipEl.offsetWidth, h = tipEl.offsetHeight;
    var left = Math.round(cx - w / 2);
    left = Math.max(6, Math.min(left, window.innerWidth - w - 6));
    var y = Math.round(top - h - 6);
    if (place === 'bottom') y = Math.round(top + 6);
    if (y < 6) y = Math.round(top + 22);
    tipEl.style.left = left + 'px';
    tipEl.style.top = y + 'px';
    tipEl.classList.toggle('tip-bottom', place === 'bottom');
  }

  function hideTip() {
    clearTimeout(tipTimer);
    tipTimer = null;
    if (tipEl) tipEl.hidden = true;
  }

  function bindTips() {
    document.addEventListener('pointerover', function (e) {
      var t = e.target.closest('[data-tip]');
      if (!t) return;
      if (t.disabled) {
        // 置灰选项也要能说明原因（悬停提示「请先在正文中选择文字」）
        var r0 = t.getBoundingClientRect();
        showTip(t.getAttribute('data-tip'), r0.left + r0.width / 2, r0.top, 'top');
        return;
      }
      clearTimeout(tipTimer);
      tipTimer = window.setTimeout(function () {
        var r = t.getBoundingClientRect();
        showTip(t.getAttribute('data-tip'), r.left + r.width / 2, r.top, 'top');
      }, 260);
    });
    document.addEventListener('pointerout', function (e) {
      if (e.target.closest && e.target.closest('[data-tip]')) hideTip();
    });
    document.addEventListener('pointerdown', hideTip);
    $$('.as-scroll, .pdf-scroll, .st-body').forEach(function (el) {
      el.addEventListener('scroll', hideTip, { passive: true });
    });
    window.addEventListener('blur', hideTip);
  }

  /* ── 生成 / 停止 / 重试 ──────────────────────────────────────────── */

  function streamRemaining() {
    var card = state.card;
    if (!card) return;
    card.ui = 'streaming';
    var full = FULL_ANSWER;
    var i = Number.isFinite(card.streamFrom) && card.streamFrom > 0
      ? Math.min(card.streamFrom, full.length)
      : (card.answer ? card.answer.length : 0);
    card.answer = full.slice(0, i);
    card.streamFrom = i;
    renderCard();
    renderComposerBar();

    var last = 0;
    function step(ts) {
      if (!state.card || state.card !== card || card.ui !== 'streaming') return;
      // 模拟大模型流式输出：按固定节奏出字（约 35 字/秒），滚得太快反而看不清
      if (!last) last = ts;
      var elapsed = ts - last;
      if (elapsed < 26) { state.typing = requestAnimationFrame(step); return; }
      last = ts;
      i = Math.min(full.length, i + 1);
      card.answer = full.slice(0, i);
      var body = document.getElementById('body-' + card.id);
      if (body) {
        var nearBottom = isNearBottom();
        body.innerHTML = P.answerHTML(card.answer) + '<span class="caret" aria-hidden="true"></span>';
        if (nearBottom) scrollPanel(false);
      }
      if (i >= full.length) {
        card.ui = 'done';
        card.showQuestion = false;
        state.typing = null;
        renderCard();
        renderComposerBar();
        return;
      }
      state.typing = requestAnimationFrame(step);
    }
    state.typing = requestAnimationFrame(step);
  }

  function stopStream() {
    cancelAnimationFrame(state.typing);
    state.typing = null;
    var card = state.card;
    if (!card) return;
    card.ui = 'stopped';
    renderCard();
    renderComposerBar();
  }

  function isNearBottom() {
    var el = $('#asScroll');
    return el.scrollHeight - el.scrollTop - el.clientHeight < 90;
  }

  function scrollPanel(smooth) {
    var el = $('#asScroll');
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }

  /* ── 论文操作 / 划选动作：结果都进右侧助手面板 ───────────────────── */

  var OP_TEXT = {
    '一句话速览': '本文提出 Transformer，完全用自注意力替代循环与卷积，在机器翻译上取得更好效果且训练更并行。',
    '阅读路线': '建议顺序：§2 背景 → §3.1 编码器解码器堆叠 → §3.2 注意力 → §3.3 前馈与残差 → §6 实验与消融。',
    '方法拆解': '输入 → 位置编码 → N 层「多头注意力 + 前馈」→ 残差与层归一化 → 线性 + Softmax 输出。',
    '术语表': '自注意力：序列内部互相加权；多头：并行多组子空间；位置编码：补回顺序信息。'
  };

  function pushResultCard(opts) {
    var card = baseCard({
      question: opts.question || '',
      answer: opts.answer || '',
      ui: 'done',
      scope: opts.scope || (state.scope === 'paper-web' ? ['paper', 'web'] : [state.scope]),
      citations: opts.citations || [],
      evidenceOpen: false,
      note: null,
      showQuestion: false,
      backFrom: false,
      label: opts.label || ''
    });
    state.card = card;
    renderCard();
    scrollPanel(true);
    return card;
  }

  /** 论文操作：不在别处再开一个结果区，结果进当前面板（与现有应用口径一致） */
  function runPaperOp(label) {
    var text = OP_TEXT[label];
    if (!text) text = '论文操作的结果会作为一条回答进入右侧面板，可展开依据、跳转原文、存成笔记。';
    pushResultCard({ label: label, answer: text, citations: CITATIONS.slice(0, 1) });
  }

  /** 划选动作：翻译 / 解释 —— 结果同样进面板，不在选区旁就地浮动 */
  function runSelectionAction(act) {
    var sel = state.selection || 'self-attention';
    if (act === 'translate') {
      pushResultCard({
        label: '译文',
        answer: '注意力函数可以描述为：把一个 query 与一组 key-value 对映射成一个输出，其中 query、key、value 与输出都是向量。',
        citations: [{ title: PAPER.short, page: 3, support: 'direct', anchor: 'p-attn', quote: 'An attention function can be described as mapping a query and a set of key-value pairs to an output', hit: 'attention function' }]
      });
      return;
    }
    pushResultCard({
      label: '解释',
      answer: '这句话在说：' + sel.slice(0, 40) + ' … 它的作用是把序列中任意两个位置直接连起来，' +
        '不必像循环网络那样逐级传递；代价是计算量随序列长度平方增长。',
      citations: CITATIONS.slice(0, 2)
    });
  }

  /** 页边标记：不加黄色高亮，只在页边留一个小书签（与现有应用一致） */
  function addBookmark() {
    var page = parseInt($('#curPage').textContent, 10) || 3;
    state.notes.push({
      id: 'n' + (++state.savedNotes),
      title: state.selection ? ('页边标记 · ' + state.selection.slice(0, 20)) : '页边标记',
      paper: PAPER.short,
      page: page,
      ts: Date.now()
    });
    renderNotes();
    var mark = document.createElement('span');
    mark.className = 'page-bookmark';
    mark.setAttribute('aria-hidden', 'true');
    mark.innerHTML = I.svg('bookmark', 14);
    var target = document.getElementById('page' + page) || $('#page3');
    target.appendChild(mark);
  }

  /* ── 复制 ────────────────────────────────────────────────────────── */

  function copyPayload(card) {
    var cites = card.citations.map(function (c) {
      return '- ' + c.title + ' · p.' + c.page + '：「' + c.quote + '」';
    }).join('\n');
    return card.answer + '\n\n—— ' + PAPER.short + ' · p.3\n\n引用：\n' + cites;
  }

  function flashCopy(btn) {
    if (!btn) return;
    var host = btn.querySelector('.ic');
    if (!host) return;
    state.copyFlash = true;
    host.innerHTML = I.svg('check', 16);
    // 卡片可能在这 1.1 秒内重渲染（展开依据等），所以恢复时按选择器重新取元素
    window.setTimeout(function () {
      state.copyFlash = false;
      var live = document.querySelector('.card-bar [data-action="more"] .ic') ||
                 document.querySelector('[data-action="more"] .ic');
      if (live) live.innerHTML = I.svg('more', 16);
    }, 1100);
  }

  function doCopy(anchorEl) {
    var text = state.card ? copyPayload(state.card) : '';
    var done = function () { flashCopy(anchorEl); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done(); });
      return;
    }
    fallbackCopy(text);
    done();
  }

  function fallbackCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    } catch (e) { /* 剪贴板不可用时静默：不弹任何大型提示 */ }
  }

  /* ── 笔记 ────────────────────────────────────────────────────────── */

  function startNote() {
    var card = state.card;
    if (!card || card.ui === 'streaming' || card.ui === 'failed') return;
    if (!card.note) card.note = { title: card.question, editing: true, focusOnce: false };
    else card.note.editing = true;
    renderCard();
    var input = $('#noteTitleInput');
    if (input) { input.focus(); input.select(); }
  }

  function confirmNote() {
    var card = state.card;
    if (!card || !card.note) return;
    var input = $('#noteTitleInput');
    card.note.title = (input && input.value.trim()) || card.question;
    card.note.editing = false;
    card.note.createdAt = Date.now();
    card.note.paper = PAPER.short;
    card.note.page = 3;
    card.note.answer = card.answer;
    state.notes.push({
      id: 'n' + (++state.savedNotes), title: card.note.title, paper: PAPER.short,
      page: card.note.page, ts: card.note.createdAt
    });
    renderCard();
    renderNotes();
  }

  function cancelNote() {
    var card = state.card;
    if (!card || !card.note) return;
    card.note.editing = false;
    renderCard();
  }

  /* ── 跳转原文 / 返回 ─────────────────────────────────────────────── */

  function jumpTo(cite) {
    jumping = true;
    var scroll = $('#pdfScroll');
    state.backFrom = { page: $('#curPage').textContent, scrollTop: scroll.scrollTop };
    var target = document.getElementById('page' + cite.page);
    if (target) scroll.scrollTo({ top: target.offsetTop - 16, behavior: 'smooth' });
    $('#curPage').textContent = String(cite.page);
    window.setTimeout(function () {
      applyHit(cite.anchor, false);
      // 卡片继续保持可见，并在左上角给出返回箭头
      var card = state.card;
      if (card) {
        card.backFrom = true;
        card.evidenceOpen = true;
        renderCard();
        scrollPanel(false);
      }
      $('#jumpBack').hidden = false;
      jumping = false;
    }, 260);
  }

  function jumpToAnchor(anchor, page) {
    jumpTo({ anchor: anchor, page: page });
  }

  function backToPosition() {
    var card = state.card;
    if (card) card.backFrom = false;
    renderCard();
    var from = state.backFrom;
    if (from) {
      $('#curPage').textContent = from.page;
      $('#pdfScroll').scrollTo({ top: from.scrollTop, behavior: 'smooth' });
    }
    $('#jumpBack').hidden = true;
    $$('.pg-hit').forEach(function (el) { el.classList.remove('pg-hit', 'is-fading'); });
  }

  /* ── 设置页 ──────────────────────────────────────────────────────── */

  function renderSettings() {
    var seg = $('#themeSeg');
    if (seg) {
      seg.innerHTML = P.themeOptionsHTML(state.themePref);
      $$('#themeSeg [data-theme-set]').forEach(function (el) {
        var on = el.getAttribute('data-theme-set') === state.themePref;
        el.setAttribute('aria-checked', on ? 'true' : 'false');
      });
    }
    $$('#defaultScope .rp-opt').forEach(function (el) {
      el.setAttribute('aria-checked', el.getAttribute('data-scope') === state.defaultScope ? 'true' : 'false');
    });
    var val = $('#sizeValue');
    if (val) val.textContent = state.answerFont + ' px';
    var prev = $('#sizePreview');
    if (prev) prev.style.setProperty('--preview-fs', state.answerFont + 'px');
  }

  function setAnswerFont(v) {
    state.answerFont = Math.max(13, Math.min(21, v));
    renderSettings();
  }

  function restoreDefaults() {
    applyTheme('light');
    setAnswerFont(17);
    state.defaultScope = 'paper';
    state.scope = 'paper';
    renderSettings();
    renderComposerBar();
    $('#restoreNote').hidden = false;
    // 只重置主题 / 阅读字号 / 默认发送范围：API Key、论文、笔记、历史问答都不动
  }

  /* ── 视图切换 ────────────────────────────────────────────────────── */

  function renderView() {
    var settingsOpen = state.view === 'settings';
    $('#settings').hidden = !settingsOpen;
    $('#app').style.display = settingsOpen ? 'none' : '';
    if (settingsOpen) renderSettings();
  }

  function applyState(id) {
    var def = STATES.filter(function (s) { return s.id === id; })[0] || STATES[2];
    if (state.typing) cancelAnimationFrame(state.typing);
    state.typing = null;
    closeMenu();
    hideTip();
    closeSelBubble();
    $('#jumpBack').hidden = true;
    $$('.pg-hit').forEach(function (el) { el.classList.remove('pg-hit', 'is-fading'); });
    $$('.page-bookmark').forEach(function (el) { el.remove(); });
    $$('.is-hover-sim').forEach(function (el) { el.classList.remove('is-hover-sim'); });

    document.documentElement.setAttribute('data-state', def.id);
    $$('[data-state-tab]').forEach(function (t) {
      t.setAttribute('aria-current', t.getAttribute('data-state-tab') === def.id ? 'true' : 'false');
    });

    state.view = def.view || 'reading';
    applyTheme(def.theme || 'light');
    state.scope = def.scope || 'paper';
    // 「发送范围」这一组状态演示的是输入状态：正文里还没有划选
    state.selection = def.type ? '' : 'self-attention、jointly attend to information from different representation subspaces';
    $('#chatInput').value = def.type ? '\u00A0' : '';
    setEmptyText();

    state.notes = def.id === 'answer-note'
      ? [
        { id: 'n0', title: '为什么自注意力能替代循环结构？', paper: PAPER.short, page: 4, ts: Date.now() - 86400000 },
        { id: 'n1', title: '为什么自注意力能替代循环结构？', paper: PAPER.short, page: 3, ts: Date.now() - 60000 }
      ]
      : [{ id: 'n0', title: '为什么自注意力能替代循环结构？', paper: PAPER.short, page: 4, ts: Date.now() - 86400000 }];

    state.card = def.card ? def.card() : null;
    state.backFrom = null;
    state.rangeOpen = false;
    $('#rangePanel').hidden = true;

    var sc0 = $('#pdfScroll');
    if (sc0) sc0.scrollTop = 0;
    var cur = $('#curPage');
    if (cur) cur.textContent = '3';
    renderAttach();
    renderNotes();
    renderCard();
    renderComposerBar();
    renderRangePanel();
    renderView();

    // 依据展开时，把正文的对应段落也带进视野（证据与原文互为参照）
    if (def.id === 'answer-evidence') {
      var sc = $('#pdfScroll');
      var p3 = document.getElementById('page3');
      if (sc && p3) sc.scrollTop = p3.offsetTop - 16 + 132;
    }
    if (def.rangeOpen) openRange();
    if (def.busy) streamRemaining();          // 状态定义给的是已生成部分，进入后继续流式输出
    // 菜单/悬停/跳转这类需要布局稳定的动作，放到下一帧再施加
    window.requestAnimationFrame(function () { syncCardExtras(); });
  }

  /* ── 事件 ────────────────────────────────────────────────────────── */

  function bind() {
    // 设计稿状态切换
    $('#dsTabs').addEventListener('click', function (e) {
      var b = e.target.closest('[data-state-tab]');
      if (!b) return;
      applyState(b.getAttribute('data-state-tab'));
      try { history.replaceState(null, '', '?state=' + b.getAttribute('data-state-tab')); } catch (err) { /* file:// 下无所谓 */ }
    });

    // 顶栏主题
    $$('.tb-right [data-theme-set]').forEach(function (b) {
      b.addEventListener('click', function () { applyTheme(b.getAttribute('data-theme-set')); renderSettings(); });
    });

    // 设置页
    $('#btnSettings').addEventListener('click', function () { state.view = 'settings'; renderView(); });
    $('#btnCloseSettings').addEventListener('click', function () { state.view = 'reading'; renderView(); });
    $('#settings').addEventListener('click', function (e) {
      var t = e.target.closest('[data-theme-set]');
      if (t) { applyTheme(t.getAttribute('data-theme-set')); renderSettings(); }
      var opt = e.target.closest('#defaultScope .rp-opt');
      if (opt) {
        state.defaultScope = opt.getAttribute('data-scope');
        state.scope = state.defaultScope;   // 默认范围决定发送框的初始值
        renderSettings();
        renderComposerBar();
      }
    });
    $('#btnSizeDown').addEventListener('click', function () { setAnswerFont(state.answerFont - 1); });
    $('#btnSizeUp').addEventListener('click', function () { setAnswerFont(state.answerFont + 1); });
    $('#btnRestoreDefaults').addEventListener('click', restoreDefaults);
    $('#btnEye').addEventListener('click', function () {
      var inp = $('#cfgApiKey');
      var show = inp.type === 'password';
      inp.type = show ? 'text' : 'password';
      this.setAttribute('aria-pressed', show ? 'true' : 'false');
      this.setAttribute('aria-label', show ? '隐藏 API Key' : '显示 API Key');
      this.setAttribute('data-tip', show ? '隐藏' : '显示');
      this.querySelector('.ic').innerHTML = I.svg(show ? 'eye-off' : 'eye', 16);
    });
    $('#btnBaseReset').addEventListener('click', function () {
      $('#cfgBaseURL').value = DEFAULT_BASE;
      $('#cfgBaseURL').focus();
    });

    // 范围面板是 #composer 的兄弟节点，事件委托挂在两者共同的父级上
    $('.assistant').addEventListener('click', function (e) {
      var t = e.target.closest('[data-action]');
      var opt = e.target.closest('#rpOpts .rp-opt');
      if (opt) {
        if (opt.disabled) return;
        state.scope = opt.getAttribute('data-scope');
        closeRange(true);            // 选完自动收起
        renderComposerBar();
        renderRangePanel();
        return;
      }
      if (!t) return;
      var act = t.getAttribute('data-action');
      if (act === 'range-toggle') { state.rangeOpen ? closeRange(true) : openRange(); renderComposerBar(); return; }
      if (act === 'range-collapse') { closeRange(true); renderComposerBar(); return; }
      if (act === 'input-more') { openMenu('input', t); return; }
      if (act === 'clip') { openMenu('input', t); return; }
      if (act === 'send') { send(); return; }
      if (act === 'stop') { stopStream(); return; }
    });

    // 范围面板里点空白不关；点外部关闭
    document.addEventListener('pointerdown', function (e) {
      if (state.rangeOpen && !e.target.closest('#rangePanel') && !e.target.closest('#cpBar')) closeRange(true), renderComposerBar();
      if (state.menu && !e.target.closest('.menu') && !e.target.closest('[data-menu-anchor]')) closeMenu();
      if (!e.target.closest('#selBubble')) closeSelBubble();
    });

    // tooltip 里的按钮点击（置灰项没有按钮，无需处理）

    // 回答卡片 + 输入菜单
    $('#asList').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-action]');
      var evItem = e.target.closest('.ev-item');
      if (btn) {
        handleCardAction(btn.getAttribute('data-action'), btn);
        return;
      }
      if (evItem) jumpToAnchor(evItem.getAttribute('data-anchor'), parseInt(evItem.getAttribute('data-cite'), 10));
    });
    $('#asList').addEventListener('keydown', function (e) {
      var item = e.target.closest('.ev-item');
      if (item && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        jumpToAnchor(item.getAttribute('data-anchor'), parseInt(item.getAttribute('data-cite'), 10));
      }
    });

    $('#inputMenu').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-action]');
      if (!btn) return;
      var act = btn.getAttribute('data-action');
      closeMenu();
      if (act === 'clear-input') { $('#chatInput').value = ''; setEmptyText(); }
      if (act === 'clip') return;
      if (act === 'attach-selection' || act === 'attach-page') {
        state.selection = state.selection || 'An attention function can be described as mapping a query and a set of key-value pairs to an output.';
        renderAttach();
      }
      if (act === 'insert-formula') {
        var ta = $('#chatInput');
        if (ta.classList.contains('is-empty')) { ta.value = ''; ta.classList.remove('is-empty'); }
        ta.value = (ta.value === '\u00A0' ? '' : ta.value) + ' $\\mathrm{softmax}(QK^\\top/\\sqrt{d_k})V$';
        ta.focus();
      }
    });

    // 论文操作菜单：结果进助手面板（与现有应用一致：不在别处再开一个结果区）
    $('#btnOps').addEventListener('click', function () {
      state.menu === 'ops' ? (closeMenu(), $('#btnOps').setAttribute('aria-expanded', 'false')) : openMenu('ops', $('#btnOps'));
    });
    $('#opsMenu').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-action]');
      if (!btn) return;
      var label = btn.textContent.trim();
      closeMenu();
      runPaperOp(label);
    });

    // 划选气泡：只负责选动作，结果一律进右侧面板
    $('#selBubble').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-sel-act]');
      if (!btn) return;
      var act = btn.getAttribute('data-sel-act');
      if (act === 'bookmark') { addBookmark(); return; }
      if (act === 'copy') { fallbackCopy(state.selection); return; }
      if (act === 'ask') {
        var ta2 = $('#chatInput');
        ta2.value = (ta2.value === '\u00A0' ? '' : ta2.value);
        ta2.classList.remove('is-empty');
        ta2.focus();
        return;
      }
      runSelectionAction(act);
    });
    $('#selBubble').addEventListener('pointerdown', function (e) { e.preventDefault(); });
    $('#cardMenu').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-action]');
      if (!btn) return;
      var act = btn.getAttribute('data-action');
      closeMenu();
      // 菜单点完会收起，反馈要落在仍然可见的卡片「更多」图标上
      var anchor = $('.card-bar [data-action="more"]') || $('[data-action="more"]') || btn;
      handleCardAction(act, anchor);
    });

    // 输入框
    var ta = $('#chatInput');
    ta.addEventListener('input', function () {
      if (ta.value === '') setEmptyText();
      else ta.classList.remove('is-empty');
      renderComposerBar();
    });
    ta.addEventListener('focus', function () { ta.classList.add('is-focused'); });
    ta.addEventListener('blur', function () { ta.classList.remove('is-focused'); });
    ta.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); send(); }
      if (e.key === 'Escape') { closeRange(true); closeMenu(); hideTip(); ta.blur(); }
    });

    // 正文划选 → 自动切换为「当前选中文字」，并浮出划选气泡
    document.addEventListener('selectionchange', function () {
      var sel = window.getSelection();
      if (!sel || sel.isCollapsed) return;
      var text = String(sel).trim();
      if (!text) return;
      var node = sel.anchorNode;
      if (!node || !$('#viewer').contains(node.nodeType === 1 ? node : node.parentNode)) return;
      state.selection = text.replace(/\s+/g, ' ').slice(0, 220);
      if (state.scope !== 'selection') { state.scope = 'selection'; renderComposerBar(); }
      renderAttach();
      renderRangePanelState();
      showSelBubble(sel);
    });

    // 返回跳转前的阅读位置
    $('#btnBackPos').addEventListener('click', backToPosition);
    $('#btnAttachClose').addEventListener('click', function () {
      state.selection = '';
      renderAttach();
      if (state.scope === 'selection') { state.scope = 'paper'; renderComposerBar(); }
      renderRangePanelState();
    });
    $('#btnHintClose').addEventListener('click', function () { $('#hintbar').hidden = true; });

    // 全局键盘
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        if (state.menu) { closeMenu(); return; }
        if (state.rangeOpen) { closeRange(true); renderComposerBar(); return; }
        if (!$('#selBubble').hidden) { closeSelBubble(); return; }
        if (state.view === 'settings') { state.view = 'reading'; renderView(); }
      }
    });
  }

  function renderRangePanelState() {
    // 选中文字状态变化后，重新生成选项（置灰 / 可用）
    if (state.rangeOpen) renderRangePanel();
  }

  /** 划选气泡：判断文字下方浮出，只负责选动作（结果进面板） */
  function showSelBubble(sel) {    var bubble = $('#selBubble');
    if (!bubble) return;
    var rect = sel.rangeCount ? sel.getRangeAt(0).getBoundingClientRect() : null;
    if (!rect || !rect.width) { bubble.hidden = true; return; }
    bubble.hidden = false;
    var viewer = $('#viewer').getBoundingClientRect();
    var w = bubble.offsetWidth, h = bubble.offsetHeight;
    var left = rect.left + rect.width / 2 - viewer.left - w / 2;
    left = Math.max(6, Math.min(left, viewer.width - w - 6));
    var top = rect.bottom - viewer.top + 8;
    if (rect.bottom + h + 20 > window.innerHeight) top = rect.top - viewer.top - h - 8;
    bubble.style.left = Math.round(left) + 'px';
    bubble.style.top = Math.round(top) + 'px';
  }

  function closeSelBubble() {
    var bubble = $('#selBubble');
    if (bubble) bubble.hidden = true;
  }

  function handleCardAction(act, btn) {
    var card = state.card;
    if (!card) return;
    if (act === 'evidence') {
      card.evidenceOpen = !card.evidenceOpen;
      renderCard();
      return;
    }
    if (act === 'save-note') { startNote(); return; }
    if (act === 'note-confirm') { confirmNote(); return; }
    if (act === 'note-cancel') { cancelNote(); return; }
    if (act === 'copy') { doCopy(btn); return; }
    if (act === 'more') { openMenu('card', btn, card); return; }
    if (act === 'stop') { stopStream(); return; }    if (act === 'resume') { streamRemaining(); return; }
    if (act === 'regen' || act === 'retry') {
      cancelAnimationFrame(state.typing);
      state.typing = null;
      card.answer = '';
      card.ui = 'streaming';
      card.showQuestion = true;
      card.evidenceOpen = false;
      card.note = null;
      card.backFrom = false;
      renderCard();
      renderComposerBar();
      if (act === 'retry') {
        // 重试：同一张卡片原地恢复，不清空用户的问题
        window.setTimeout(function () {
          var body = document.getElementById('body-' + card.id);
          if (body && isNearBottom()) scrollPanel(false);
        }, 30);
      }
      streamRemaining();
      return;
    }
    if (act === 'delete') {
      card.answer = '';
      card.ui = 'done';
      $('#asList').innerHTML = '<p class="as-empty" style="margin:14px 4px;color:var(--fg-ghost);font-size:var(--fs-ui-sm)">这条回答已删除。可以重新输入问题，或从左侧笔记里找回已保存的内容。</p>';
      renderComposerBar();
      return;
    }
    if (act === 'back-pos') { backToPosition(); return; }
    if (act === 'jump') {
      var item = btn.closest('.ev-item');
      if (item) jumpToAnchor(item.getAttribute('data-anchor'), parseInt(item.getAttribute('data-cite'), 10));
      return;
    }
  }

  function send() {
    var text = inputText();
    if (!text) { $('#chatInput').focus(); return; }
    cancelAnimationFrame(state.typing);
    closeRange(false);
    state.card = baseCard({
      question: text,
      answer: '',
      ui: 'streaming',
      showQuestion: true,
      evidenceOpen: false,
      scope: state.scope === 'paper-web' ? ['paper', 'web'] : [state.scope],
      note: null,
      backFrom: false
    });
    $('#chatInput').value = '';
    setEmptyText();
    renderCard();
    renderComposerBar();
    scrollPanel(false);
    streamRemaining();
  }

  /* ── 启动 ────────────────────────────────────────────────────────── */

  function boot() {
    tipEl = $('#tip');
    I.mount(document);
    renderTabs();
    bindTips();
    bind();

    var m = /[?&]state=([a-z0-9-]+)/i.exec(location.search);
    var wanted = m && STATES.some(function (s) { return s.id === m[1]; }) ? m[1] : 'answer-basic';
    applyState(wanted);

    // 设计稿标注：右下角引导条默认隐藏，只在首次进入没有状态参数时露一下
    if (!m) {
      $('#hintText').textContent = '顶部状态条可以切换 14 个界面状态；点右侧「⋯」可展开更多操作。';
      $('#hintbar').hidden = false;
    }

    if (window.matchMedia) {
      var mq = window.matchMedia('(prefers-color-scheme: dark)');
      var onChange = function () { if (state.themePref === 'system') applyTheme('system'); };
      if (mq.addEventListener) mq.addEventListener('change', onChange);
      else if (mq.addListener) mq.addListener(onChange);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
