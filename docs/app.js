// Renders the tudigong agent profile page from window.PROFILE_DATA.
// Handles the wish-form button logic (pre-filled Google Form link or placeholder modal).

(function () {
  'use strict';

  // ===================================================================
  // Google Form wish-link helper
  // ===================================================================

  // Builds and opens a pre-filled Google Form URL for the given section.
  // Falls back to the placeholder modal when the form has not been configured.
  function openWishForm(section) {
    var cfg = window.PROFILE_DATA.config;
    if (!cfg.googleFormBase || cfg.googleFormBase.indexOf('REPLACE_WITH') !== -1) {
      showModal();
      return;
    }
    var url = cfg.googleFormBase
      + '?usp=pp_url&'
      + encodeURIComponent(cfg.googleFormEntrySection)
      + '='
      + encodeURIComponent(section);
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  // ===================================================================
  // Placeholder modal (shown when Google Form is not yet configured)
  // ===================================================================

  var modalOverlay = null;

  function showModal() {
    if (modalOverlay) {
      modalOverlay.classList.add('open');
      document.body.style.overflow = 'hidden';
    }
  }

  function hideModal() {
    if (modalOverlay) {
      modalOverlay.classList.remove('open');
      document.body.style.overflow = '';
    }
  }

  function buildModal() {
    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'wishModal';

    var box = document.createElement('div');
    box.className = 'modal-box';

    var closeBtn = document.createElement('button');
    closeBtn.className = 'modal-close';
    closeBtn.setAttribute('aria-label', '关闭');
    closeBtn.innerHTML = '✕';
    closeBtn.addEventListener('click', hideModal);

    var icon = document.createElement('div');
    icon.style.cssText = 'font-size:2.5rem;margin-bottom:12px;text-align:center;';
    icon.textContent = '🏮';

    var title = document.createElement('h3');
    title.style.cssText = 'font-size:1.125rem;font-weight:700;margin-bottom:8px;text-align:center;color:#F5F7FA;';
    title.textContent = '许愿表单尚未配置';

    var body = document.createElement('p');
    body.style.cssText = 'font-size:0.875rem;color:#9CA3AF;text-align:center;line-height:1.6;';
    body.textContent = '社区许愿表单尚未配置，请在 data.js 中填入 Google 表单地址（googleFormBase 字段）后，此按钮即可直接跳转至表单。';

    var hint = document.createElement('p');
    hint.style.cssText = 'font-size:0.75rem;color:#6B7280;text-align:center;margin-top:12px;';
    hint.textContent = '维护指引详见 README.md';

    box.appendChild(closeBtn);
    box.appendChild(icon);
    box.appendChild(title);
    box.appendChild(body);
    box.appendChild(hint);
    overlay.appendChild(box);

    // Close on backdrop click.
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) hideModal();
    });

    document.body.appendChild(overlay);
    modalOverlay = overlay;
  }

  // ===================================================================
  // Utility helpers
  // ===================================================================

  // Creates a section heading element with the left accent bar.
  function makeSectionHeading(text, sectionKey) {
    var wrapper = document.createElement('div');
    wrapper.className = 'flex items-center justify-between mb-8';

    var left = document.createElement('h2');
    left.className = 'section-heading text-2xl font-bold text-white';
    left.textContent = text;

    var btn = document.createElement('button');
    btn.className = 'plus-btn';
    btn.setAttribute('aria-label', '立刻许愿 — ' + text);
    btn.title = '对「' + text + '」提建议或许愿';
    btn.textContent = '+';
    btn.addEventListener('click', function () { openWishForm(sectionKey); });

    wrapper.appendChild(left);
    wrapper.appendChild(btn);
    return wrapper;
  }

  // Returns the Tailwind colour classes for a status value.
  function statusChipClass(status) {
    if (status === '草案') return 'chip chip-draft';
    if (status === '停用') return 'chip chip-inactive';
    return 'chip chip-green';
  }

  // ===================================================================
  // Section A — Hero
  // ===================================================================

  function renderHero() {
    var hero = window.PROFILE_DATA.hero;
    var el = document.getElementById('hero-section');
    if (!el) return;

    // Avatar.
    var avatarWrap = el.querySelector('#hero-avatar');
    if (avatarWrap) avatarWrap.textContent = hero.emoji;

    // Name.
    var nameEl = el.querySelector('#hero-name');
    if (nameEl) nameEl.textContent = hero.name;

    // Name link — points at the project repository.
    var nameEnEl = el.querySelector('#hero-name-en');
    if (nameEnEl) {
      nameEnEl.textContent = hero.nameEn;
      nameEnEl.href = window.PROFILE_DATA.config.repoUrl;
    }

    // Tagline.
    var taglineEl = el.querySelector('#hero-tagline');
    if (taglineEl) taglineEl.textContent = hero.tagline;

    // Subtitle.
    var subtitleEl = el.querySelector('#hero-subtitle');
    if (subtitleEl) subtitleEl.textContent = hero.subtitle;

    // Status chips.
    var chipsEl = el.querySelector('#hero-chips');
    if (chipsEl) {
      chipsEl.innerHTML = '';
      hero.chips.forEach(function (chip, i) {
        var span = document.createElement('span');
        span.className = 'chip' + (i % 2 === 0 ? '' : ' chip-blue');
        span.textContent = chip;
        chipsEl.appendChild(span);
      });
    }

    // CTA button.
    var ctaEl = el.querySelector('#hero-cta');
    if (ctaEl) {
      ctaEl.addEventListener('click', function () { openWishForm('综合建议'); });
    }
  }

  // ===================================================================
  // Section — Skills
  // ===================================================================

  function renderSkills() {
    var skills = window.PROFILE_DATA.skills;
    var container = document.getElementById('skills-content');
    if (!container) return;

    // --- Exclusive skill ---
    var exclusiveBlock = buildBlock('专属技能');
    var exclusiveGrid = document.createElement('div');
    exclusiveGrid.className = 'grid grid-cols-1 sm:grid-cols-2 gap-4 mb-8';
    skills.exclusive.forEach(function (sk) {
      var card = document.createElement('div');
      card.className = 'glass-card p-5';
      var nameRow = document.createElement('div');
      nameRow.className = 'flex items-center gap-2 mb-2';
      var nameLbl = document.createElement('span');
      nameLbl.className = 'font-mono font-semibold text-sm gradient-text';
      nameLbl.textContent = sk.name;
      var badge = document.createElement('span');
      badge.className = 'chip chip-green';
      badge.style.fontSize = '0.65rem';
      badge.textContent = '专属';
      nameRow.appendChild(nameLbl);
      nameRow.appendChild(badge);
      var desc = document.createElement('p');
      desc.className = 'text-sm text-gray-400 leading-relaxed';
      desc.textContent = sk.desc;
      card.appendChild(nameRow);
      card.appendChild(desc);
      exclusiveGrid.appendChild(card);
    });
    exclusiveBlock.appendChild(exclusiveGrid);
    container.appendChild(exclusiveBlock);

    // --- Shared skills ---
    var sharedBlock = buildBlock('共用技能（7 个）');
    var sharedGrid = document.createElement('div');
    sharedGrid.className = 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-8';
    skills.shared.forEach(function (sk) {
      var card = document.createElement('div');
      card.className = 'glass-card p-5';
      var nameLbl = document.createElement('div');
      nameLbl.className = 'font-mono font-semibold text-sm gradient-text mb-2';
      nameLbl.textContent = sk.name;
      var desc = document.createElement('p');
      desc.className = 'text-sm text-gray-400 leading-relaxed';
      desc.textContent = sk.desc;
      card.appendChild(nameLbl);
      card.appendChild(desc);
      sharedGrid.appendChild(card);
    });
    sharedBlock.appendChild(sharedGrid);
    container.appendChild(sharedBlock);

    // --- Abilities / gameplay ---
    var abilitiesBlock = buildBlock('代理功能（' + skills.abilities.length + ' 项）');
    var abilitiesGrid = document.createElement('div');
    abilitiesGrid.className = 'grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4 mb-8';
    skills.abilities.forEach(function (ab) {
      var card = document.createElement('div');
      card.className = 'glass-card p-4';
      var topRow = document.createElement('div');
      topRow.className = 'flex items-start justify-between gap-2 mb-2';
      var nameLbl = document.createElement('span');
      nameLbl.className = 'font-semibold text-sm text-white leading-tight';
      nameLbl.textContent = ab.name;
      var statusChip = document.createElement('span');
      statusChip.className = statusChipClass(ab.status);
      statusChip.style.fontSize = '0.65rem';
      statusChip.style.flexShrink = '0';
      statusChip.textContent = ab.status;
      topRow.appendChild(nameLbl);
      topRow.appendChild(statusChip);
      var desc = document.createElement('p');
      desc.className = 'text-xs text-gray-500 leading-relaxed';
      desc.textContent = ab.desc;
      card.appendChild(topRow);
      card.appendChild(desc);
      abilitiesGrid.appendChild(card);
    });
    abilitiesBlock.appendChild(abilitiesGrid);
    container.appendChild(abilitiesBlock);
  }

  // ===================================================================
  // Section — Community activity (data snapshot)
  // ===================================================================

  function renderDatabase() {
    var db = window.PROFILE_DATA.database;
    var container = document.getElementById('database-content');
    if (!container) return;

    // Intro text.
    var introCard = document.createElement('div');
    introCard.className = 'glass-card p-5 mb-8';
    introCard.innerHTML = '<p class="text-sm text-gray-300 leading-relaxed">' + escHtml(db.intro) + '</p>';
    container.appendChild(introCard);

    // Activity cards — one per kind of community record it keeps.
    var grid = document.createElement('div');
    grid.className = 'grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5 mb-4';
    db.tables.forEach(function (item) {
      var card = document.createElement('div');
      card.className = 'glass-card p-5 flex flex-col';
      var title = document.createElement('div');
      title.className = 'font-semibold text-base text-white mb-2';
      title.textContent = item.label;
      var desc = document.createElement('p');
      desc.className = 'text-sm text-gray-400 leading-relaxed';
      desc.textContent = item.desc;
      card.appendChild(title);
      card.appendChild(desc);
      grid.appendChild(card);
    });
    container.appendChild(grid);

    // Closing note.
    if (db.note) {
      var note = document.createElement('p');
      note.className = 'text-xs text-gray-500 text-center mt-2 mb-2';
      note.textContent = db.note;
      container.appendChild(note);
    }
  }

  // ===================================================================
  // Internal helper — creates a labelled sub-block wrapper
  // ===================================================================

  function buildBlock(label) {
    var wrap = document.createElement('div');
    if (label) {
      var h3 = document.createElement('h3');
      h3.className = 'text-base font-semibold text-gray-300 mb-4 uppercase tracking-widest text-xs';
      h3.textContent = label;
      wrap.appendChild(h3);
    }
    return wrap;
  }

  // Escapes HTML special chars for safe injection into innerHTML.
  function escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ===================================================================
  // Section headings injection
  // ===================================================================

  function injectSectionHeadings() {
    var sections = [
      { placeholderId: 'heading-skills',   label: '技能',     key: '技能' },
      { placeholderId: 'heading-database', label: '社区动态', key: '社区动态' }
    ];
    sections.forEach(function (s) {
      var el = document.getElementById(s.placeholderId);
      if (!el) return;
      var heading = makeSectionHeading(s.label, s.key);
      el.parentNode.replaceChild(heading, el);
    });
  }

  // ===================================================================
  // Entry point
  // ===================================================================

  function init() {
    if (!window.PROFILE_DATA) {
      console.error('PROFILE_DATA is not defined. Make sure data.js is loaded before app.js.');
      return;
    }

    buildModal();
    renderHero();
    injectSectionHeadings();
    renderSkills();
    renderDatabase();

    // Trigger fade-in on each major section container.
    var sectionIds = ['hero-section', 'section-skills', 'section-database', 'site-footer'];
    sectionIds.forEach(function (id, i) {
      var el = document.getElementById(id);
      if (!el) return;
      el.style.opacity = '0';
      setTimeout(function () {
        el.classList.add('fade-in');
        el.style.opacity = '';
      }, i * 120);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
