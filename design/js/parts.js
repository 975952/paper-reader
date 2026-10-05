/* ═══════════════════════════════════════════════════════════════════════════
   parts.js —— 界面片段与共享小工具
   ───────────────────────────────────────────────────────────────────────────
   只做「把数据变成 DOM 字符串」和几个纯函数，不持有应用状态。
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var I = window.PRT_ICONS;

  /* ── 纯函数 ──────────────────────────────────────────────────────── */

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /** 把回答正文转义后，把 **粗体** 与点名的术语渲染成强调。 */
  function answerHTML(s) {
    return esc(s)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  }

  /** 引用摘录 ± 高亮：把命中片段包一层 <em>（当前使用低饱和蓝高亮底色）。 */
  function quoteHTML(quote, hit) {
    var out = esc(quote);
    if (hit) {
      var parts = out.split(esc(hit));
      if (parts.length === 2) out = parts[0] + '<em>' + esc(hit) + '</em>' + parts[1];
    }
    return out;
  }

  function icon(name, size) { return I.svg(name, size || 17); }

  /** 纯图标按钮：aria-label 承担语义，data-tip 承担 tooltip，图标本身是 aria-hidden。 */
  function iconBtn(opts) {
    var o = opts || {};
    var cls = 'ic-btn' + (o.cls ? ' ' + o.cls : '');
    var attrs = [
      'class="' + cls + '"',
      'aria-label="' + esc(o.label) + '"',
      'data-tip="' + esc(o.tip || o.label) + '"'
    ];
    if (o.id) attrs.push('id="' + esc(o.id) + '"');
    if (o.action) attrs.push('data-action="' + esc(o.action) + '"');
    if (o.expanded != null) attrs.push('aria-expanded="' + (o.expanded ? 'true' : 'false') + '"');
    if (o.pressed != null) attrs.push('aria-pressed="' + (o.pressed ? 'true' : 'false') + '"');
    if (o.haspopup) attrs.push('aria-haspopup="menu"');
    if (o.disabled) attrs.push('disabled');
    if (o.tipPos) attrs.push('data-tip-pos="' + esc(o.tipPos) + '"');
    // 图标统一包一层 .ic：与 HTML 里的静态图标同构（复制反馈等就地换图标时好定位）
    var inner = '<span class="ic">' + icon(o.icon, o.size || 16) + '</span>' +
      (o.badge ? '<span class="badge">' + esc(o.badge) + '</span>' : '');
    return '<button type="button" ' + attrs.join(' ') + '>' + inner + '</button>';
  }

  /* ── 发送范围 ────────────────────────────────────────────────────── */

  var SCOPES = {
    selection:  { icon: 'selection', short: '选中文字', long: '只发送当前选中的文字', tip: '本次发送范围：当前选中的文字', cap: '✓', pre: '✓', post: '✓' },
    page:       { icon: 'page',      short: '当前页面', long: '发送当前这一页的正文', tip: '本次发送范围：当前页面（第 3 页）', cap: '✓', pre: '✓', post: '✓' },
    paper:      { icon: 'book',      short: '论文',     long: '发送整篇论文作为上下文', tip: '本次发送范围：整篇论文', cap: '✓', pre: '✓', post: '✓' },
    'paper-web':{ icon: 'web',       short: '论文 + 网络', long: '发送整篇论文，并先联网搜索一次', tip: '本次发送范围：整篇论文 + 联网搜索', cap: '✓', pre: '✓', post: '✓' }
  };

  var SCOPE_ORDER = ['selection', 'page', 'paper', 'paper-web'];

  function scopeMeta(scope) { return SCOPES[scope] || SCOPES.paper; }

  /** 发送框里的范围控件（图标 + 极短文字，避免用户猜当前范围）。 */
  function cpScopeHTML(scope) {
    var m = scopeMeta(scope);
    return '<button type="button" class="cp-scope" id="cpScope" data-scope="' + scope + '" ' +
      'aria-label="当前发送范围：' + esc(m.long) + '" data-tip="' + esc(m.tip) + '">' +
      '<span class="cp-scope-ic">' + icon(m.icon, 16) + '</span>' +
      '<span class="cp-scope-txt" id="cpScopeText">' + esc(m.short) + '</span>' +
      '</button>';
  }

  function rangeOptionsHTML(current, selectionAvailable) {
    return SCOPE_ORDER.map(function (key) {
      var m = scopeMeta(key);
      var checked = key === current ? 'true' : 'false';
      var disabled = (key === 'selection' && !selectionAvailable) ? ' disabled' : '';
      var tip = (key === 'selection' && !selectionAvailable)
        ? '请先在正文中选择文字'
        : '发送范围：' + m.long;
      var extra = key === 'paper-web' ? '<span class="rp-opt-ic">' + icon('web', 16) + '</span>' : '';
      return '<button type="button" class="rp-opt" role="radio" aria-checked="' + checked + '"' + disabled +
        ' data-scope="' + key + '" aria-label="' + esc(tip) + '" data-tip="' + esc(tip) + '">' +
        '<span class="rp-dot" aria-hidden="true"></span>' +
        '<span class="rp-txt">' + esc(longLabel(key)) + '</span>' +
        extra + '</button>';
    }).join('');
  }

  function longLabel(key) {
    return { selection: '当前选中文字', page: '当前页面', paper: '整篇论文', 'paper-web': '整篇论文 + 联网搜索' }[key];
  }

  /* ── 回答卡片 ────────────────────────────────────────────────────── */

  /**
   * 卡片底部依据图标：引用图标 + 数量；展开后是激活态（蓝色）并保留数字。
   */

  function noteBtnHTML(card) {
    var saved = !!card.note;
    return iconBtn({
      icon: saved ? 'note-check' : 'note-plus',
      label: saved ? '已在笔记中' : '添加到笔记',
      tip: saved ? '已在笔记中' : '添加到笔记',
      action: 'save-note',
      cls: saved ? 'is-saved' : ''
    });
  }

  /** 卡片底部：默认只放「依据 / 笔记 / 更多」三个图标。 */
  function cardBarHTML(card) {
    var left = '', right = '';
    var active = !!card.evidenceOpen;

    // 本地使用的发送范围：只显示图标，tooltip 说明完整范围
    left += '<span class="scope-row">' + card.scope.map(function (key) {
      var m = scopeMeta(key);
      return '<span class="scope-ic" data-scope="' + key + '" data-tip="' + esc(m.tip) + '" ' +
        'aria-label="' + esc(m.tip) + '" role="img">' + icon(m.icon, 16) + '</span>';
    }).join('') + '</span>';

    if (card.ui === 'streaming') {
      right += '<span class="card-note">正在生成<span class="dots"><i></i><i></i><i></i></span></span>';
      right += iconBtn({ icon: 'stop', label: '停止生成', tip: '停止', action: 'stop' });
      return '<div class="card-bar">' + left + '<span class="bar-spacer"></span>' + right + '</div>';
    }

    if (card.ui === 'stopped') {
      right += '<span class="card-note">已停止，已生成的内容保留</span>';
      right += iconBtn({ icon: 'play', label: '继续生成', tip: '继续生成', action: 'resume' });
      right += iconBtn({ icon: 'regen', label: '重新回答', tip: '重新回答', action: 'regen' });
      right += iconBtn({ icon: 'more', label: '更多操作', tip: '更多操作', action: 'more', haspopup: true, id: 'moreStopped' });
      return '<div class="card-bar">' + left + '<span class="bar-spacer"></span>' + right + '</div>';
    }

    if (card.ui === 'failed') {
      right += '<span class="card-note is-failed">回答未完成</span>';
      right += iconBtn({ icon: 'regen', label: '重试', tip: '重试', action: 'retry' });
      right += iconBtn({ icon: 'more', label: '更多操作', tip: '更多操作', action: 'more', haspopup: true, id: 'moreFailed' });
      return '<div class="card-bar">' + left + '<span class="bar-spacer"></span>' + right + '</div>';
    }

    // 依据图标在左、紧跟范围标记；笔记与更多在右
    left += iconBtn({
      icon: 'quote',
      label: active ? ('收起 ' + card.citations.length + ' 条依据') : ('查看 ' + card.citations.length + ' 条依据'),
      tip: active ? '收起依据' : '依据 · ' + card.citations.length + ' 条原文证据',
      action: 'evidence',
      cls: active ? 'is-active' : '',
      badge: String(card.citations.length),
      expanded: active
    });

    right += noteBtnHTML(card);
    right += iconBtn({ icon: 'more', label: '更多操作', tip: '更多操作', action: 'more', haspopup: true, id: 'moreDefault' });
    return '<div class="card-bar">' + left + '<span class="bar-spacer"></span>' + right + '</div>';
  }

  /** 依据展开区：论文短标题 · 页码 + 1–2 行原文摘录 + 跳转箭头 + 依据状态图标。 */
  function evidenceHTML(card) {
    if (!card.evidenceOpen) return '';
    var items = card.citations.map(function (c) {
      var mark = { direct: 'sup-direct', infer: 'sup-infer', none: 'sup-none' }[c.support];
      var markTip = {
        direct: '原文直接支持',
        infer: '基于相关段落归纳',
        none: '未找到直接依据'
      }[c.support];
      return '<li class="ev-item" data-support="' + c.support + '" data-action="jump" data-cite="' + c.page + '" ' +
          'data-anchor="' + c.anchor + '" role="button" tabindex="0" ' +
          'aria-label="跳转到第 ' + c.page + ' 页：' + esc(c.quote.slice(0, 24)) + '">' +
          '<span class="ev-mark" role="img" aria-label="' + esc(markTip) + '" data-tip="' + esc(markTip) + '">' +
            icon(mark, 16) + '</span>' +
          '<span class="ev-main">' +
            '<span class="ev-src">' + esc(c.title) + ' <span class="ev-pg">· p.' + c.page + '</span></span>' +
            '<span class="ev-quote">&ldquo;' + quoteHTML(c.quote, c.hit) + '&rdquo;</span>' +
          '</span>' +
          '<span class="ev-jump">' + iconBtn({
            icon: 'jump', label: '跳转到原文第 ' + c.page + ' 页', tip: '跳转原文 · p.' + c.page,
            action: 'jump', cls: ''
          }) + '</span>' +
        '</li>';
    }).join('');
    return '<section class="evidence" aria-label="依据">' +
      '<div class="ev-head"><span>依据</span>' +
        iconBtn({ icon: 'chev-up', label: '收起依据', tip: '收起依据', action: 'evidence', cls: 'is-active', expanded: true }) +
      '</div><ul class="ev-list">' + items + '</ul></section>';
  }

  function noteRowHTML(card) {
    if (!card.note || !card.note.editing) return '';
    return '<div class="note-row">' +
      '<input class="inp-note" id="noteTitleInput" type="text" value="' + esc(card.note.title) + '" ' +
        'placeholder="笔记标题" aria-label="笔记标题">' +
      '<span class="note-actions">' +
        iconBtn({ icon: 'check', label: '确认保存笔记', tip: '确认', action: 'note-confirm' }) +
        iconBtn({ icon: 'close', label: '取消保存', tip: '取消', action: 'note-cancel' }) +
      '</span></div>';
  }

  /**
   * 回答卡片。AI 回答正文是唯一的视觉主体：
   * 没有卡片标题、没有「AI回答 / 回答完成」这类内部状态标签。
   */
  function cardHTML(card) {
    var cls = 'card';
    if (card.ui === 'streaming') cls += ' is-busy is-typing';
    if (card.ui === 'failed') cls += ' is-failed';
    if (card.backFrom) cls += ' has-back';

    var out = '<article class="' + cls + '" data-card="' + card.id + '" aria-label="回答">';

    // 论文操作 / 译文 这类结果带一个中性标签；普通问答没有标签，正文直接开始
    if (card.label) {
      out += '<div class="card-label"><span class="ic">' + icon('sparkle', 14) + '</span>' + esc(card.label) + '</div>';
    }

    // 跳转原文后：卡片左上角返回箭头，恢复跳转前的阅读位置
    if (card.backFrom) {
      out += '<div class="card-back">' + iconBtn({
        icon: 'back', label: '返回跳转前的阅读位置', tip: '返回原位置', action: 'back-pos'
      }) + '</div>';
    }

    // 生成中 / 失败时必须保留用户的问题；正常回答不重复显示（正文才是主体）
    if (card.showQuestion) {
      out += '<p class="card-q"><span class="ic">' + icon('quote', 14) + '</span>' +
        '<span class="card-q-txt">' + esc(card.question) + '</span></p>';
    }

    out += '<p class="card-body" id="body-' + card.id + '">' + answerHTML(card.answer);
    if (card.ui === 'streaming') out += '<span class="caret" aria-hidden="true"></span>';
    out += '</p>';

    out += evidenceHTML(card);
    out += noteRowHTML(card);
    out += cardBarHTML(card);
    out += '</article>';
    return out;
  }

  /* ── 左栏笔记 ────────────────────────────────────────────────────── */

  function noteItemHTML(note) {
    return '<li class="note-item" data-note="' + esc(note.id) + '" tabindex="0" ' +
      'aria-label="笔记：' + esc(note.title) + '">' +
      '<span class="note-item-title">' + esc(note.title) + '</span>' +
      '<span class="note-item-meta">' + esc(note.paper) + ' · p.' + note.page + '</span></li>';
  }

  function notesListHTML(notes) {
    return notes.map(noteItemHTML).join('');
  }

  /* ── 设置页片段（主题 / 字号即时生效，范围单选） ─────────────────── */

  function themeOptionsHTML(theme) {
    var items = [
      ['system', 'monitor', '跟随系统'],
      ['light', 'sun', '浅色'],
      ['dark', 'moon', '深色']
    ];
    return items.map(function (it) {
      var on = it[0] === theme;
      return '<button type="button" class="seg-opt" role="radio" aria-checked="' + (on ? 'true' : 'false') +
        '" data-theme-set="' + it[0] + '" aria-label="主题：' + it[2] + '">' +
        icon(it[1], 16) + '<span>' + it[2] + '</span></button>';
    }).join('');
  }

  window.PRT_PARTS = {
    esc: esc,
    answerHTML: answerHTML,
    quoteHTML: quoteHTML,
    icon: icon,
    iconBtn: iconBtn,
    SCOPES: SCOPES,
    SCOPE_ORDER: SCOPE_ORDER,
    scopeMeta: scopeMeta,
    longLabel: longLabel,
    cpScopeHTML: cpScopeHTML,
    rangeOptionsHTML: rangeOptionsHTML,
    cardHTML: cardHTML,
    evidenceHTML: evidenceHTML,
    noteRowHTML: noteRowHTML,
    notesListHTML: notesListHTML,
    noteItemHTML: noteItemHTML,
    themeOptionsHTML: themeOptionsHTML
  };
})();
