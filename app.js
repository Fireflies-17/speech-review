(() => {
  'use strict';
  const data = window.REVIEW_DATA;
  const $ = (selector) => document.querySelector(selector);
  const all = (selector) => [...document.querySelectorAll(selector)];
  const icons = {
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
    compare: '<path d="M4 5h6v14H4zM14 5h6v14h-6zM10 9h4m-4 6h4"/>',
    download: '<path d="M12 3v12m-4-4 4 4 4-4M4 16v4h16v-4"/>',
    cursor: '<path d="m5 3 13 10-7 1-3 7z"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-11v1"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>',
    expand: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m8 0h5v-5"/>',
    chevronLeft: '<path d="m14 5-7 7 7 7"/>',
    chevronRight: '<path d="m10 5 7 7-7 7"/>',
    external: '<path d="M14 3h7v7m0-7L10 14M10 4H4v16h16v-6"/>',
    slides: '<path d="M3 4h18v13H3zM12 17v5m-5 0h10M7 9h4m-4 4h10"/>',
    minus: '<path d="M5 12h14"/>',
    plus: '<path d="M5 12h14M12 5v14"/>',
    check: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
    edit: '<path d="m15 4 5 5M4 20l5-1L21 7a2 2 0 0 0-5-5L4 14z"/>',
    trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7m4-7v7"/>',
  };
  const icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name] || ''}</svg>`;
  function fillIcons(root = document) {
    root.querySelectorAll('[data-icon]').forEach((element) => { element.innerHTML = icon(element.dataset.icon); });
  }
  const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  const originals = new Map(data.concepts.map((item) => [item.id, { ...item, pages: [...item.pages] }]));
  const knowledgeById = new Map();
  const pageInfoByKey = new Map((data.pages || []).map((item) => [`${item.chapter}-${item.page}`, item]));
  const changeById = new Map(data.changes.map((item) => [item.id, item]));
  const storageKey = 'speech-review-2026-v1';
  let saved = data.publishedSnapshot || {};
  try { saved = JSON.parse(localStorage.getItem(storageKey)) || saved; } catch { /* Browser storage can be unavailable in private mode. */ }
  const state = {
    view: 'study', chapter: 1, filter: 'all', query: '', selectedId: '', changeId: 'change-1',
    mode: saved.mode === 'pages' ? 'pages' : 'concepts', indexOpen: false,
    pagePosition: validPagePosition(saved.pagePosition) ? { ...saved.pagePosition } : { chapter: 1, page: 1 },
    reviewed: new Set(),
    trashed: new Set(),
    edits: {},
    additions: {},
    slide: { chapter: 1, version: 2026, page: 60 },
  };
  let visibleItems = [];
  let searchTimer;
  let conceptClickTimer;
  let toastTimer;
  let mobileReturnFocus = null;
  let zoom = 1;
  let editingId = '';
  let addingChapter;
  let pointerSave = null;
  let wheelTotal = 0;
  let wheelDirection = 0;
  let lastWheelEvent = -Infinity;
  let lastWheelTurn = -Infinity;
  const prefetchedSlides = new Set();
  const oldPageCounts = [65, 74, 167, 99, 99, 64];
  const levels = { basic: '基本概念', mastery: '掌握', priority: '重点掌握' };
  const changeKinds = { up: '升格', down: '降级', inferred: '继承推定', added: '新增掌握页' };

  function save({ edits = state.edits, reviewed = state.reviewed, trashed = state.trashed, additions = state.additions } = {}) {
    try {
      localStorage.setItem(storageKey, JSON.stringify({ reviewed: [...reviewed], trashed: [...trashed], last: state.selectedId, edits, additions, mode: state.mode, pagePosition: state.pagePosition }));
      return true;
    } catch { return false; }
  }
  function validatedEdit(id, entry) {
    const source = originals.get(id);
    if (!source) throw new Error('备份中含有无法识别的知识点。');
    return validatedContent(source.chapter, entry);
  }
  function validatedAddition(id, entry) {
    const chapter = entry?.chapter;
    if (!/^manual-[0-9a-f]{32}$/.test(id) || originals.has(id) || !Number.isInteger(chapter) || !chapterOf(chapter)) {
      throw new Error('新增知识点的编号或章节不正确。');
    }
    return { chapter, ...validatedContent(chapter, entry) };
  }
  function validatedContent(chapter, entry) {
    if (!entry || typeof entry.title !== 'string' || !entry.title.trim() || entry.title.length > 200 ||
        typeof entry.body !== 'string' || !entry.body.trim() || entry.body.length > 20000 || !Object.hasOwn(levels, entry.level)) {
      throw new Error('知识点标题、正文或等级格式不正确。');
    }
    const pages = entry.pages;
    const limit = chapterOf(chapter).totalPages;
    if (!Array.isArray(pages) || !pages.length || pages.length > limit || pages.some((page) => !Number.isInteger(page) || page < 1 || page > limit)) {
      throw new Error(`第${chapter}章页码应在 1–${limit} 之间。`);
    }
    const unique = [...new Set(pages)];
    return { title: entry.title.trim(), body: entry.body.trim(), level: entry.level, pages: unique, primaryPage: unique.includes(entry.primaryPage) ? entry.primaryPage : unique[0] };
  }
  function editedMarkup(text, source) {
    const formatted = text.split(/(\$\$[\s\S]+?\$\$)/g).map((part, index) => index % 2
      ? `<div class="review-equation">${escapeHtml(part)}</div>`
      : escapeHtml(part).replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>')).join('');
    if (!source || !text.includes('](formulas/')) return formatted;

    // Reuse only the original formula images belonging to this knowledge point.
    const template = document.createElement('template');
    template.innerHTML = source.bodyHtml;
    const formulas = new Map();
    template.content.querySelectorAll('img.ppt-equation-image').forEach((image) => {
      if (image.closest('.ppt-mixed-row')) {
        image.classList.add('ppt-inline-equation');
        image.removeAttribute('style');
      }
      formulas.set(image.getAttribute('src'), image.outerHTML);
    });
    return formatted.replace(/!\[[^\]\n]*\]\((formulas\/ch[1-6]\/\d{3}-\d+\.png)\)/g, (token, path) => formulas.get(path) || token);
  }
  function rebuildConcepts() {
    knowledgeById.clear();
    for (const source of originals.values()) {
      const edit = state.edits[source.id];
      const item = edit ? {
        ...source,
        title: edit.title,
        titleHtml: edit.title === source.title ? source.titleHtml : escapeHtml(edit.title),
        level: edit.level,
        pages: edit.pages,
        primaryPage: edit.primaryPage,
        search: `${source.search} ${edit.title} ${edit.body}`,
        edit,
      } : { ...source, pages: [...source.pages] };
      knowledgeById.set(item.id, item);
    }
    for (const [id, item] of Object.entries(state.additions)) {
      knowledgeById.set(id, {
        ...item,
        id,
        bodyMarkdown: item.body,
        bodyHtml: editedMarkup(item.body),
        titleHtml: escapeHtml(item.title),
        search: `${item.title} ${item.body}`,
      });
    }
    data.concepts = [...knowledgeById.values()].filter((item) => !state.trashed.has(item.id))
      .sort((a, b) => a.chapter - b.chapter || a.primaryPage - b.primaryPage);
    data.chapters.forEach((chapter) => {
      chapter.counts = { basic: 0, mastery: 0, priority: 0 };
      data.concepts.filter((item) => item.chapter === chapter.id).forEach((item) => chapter.counts[item.level]++);
    });
  }
  function toast(message) {
    $('#toast').textContent = message;
    $('#toast').classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 2300);
  }
  function math(root) {
    if (window.renderMathInElement) {
      renderMathInElement(root, {
        delimiters: [{ left: '$$', right: '$$', display: true }, { left: '$', right: '$', display: false }],
        throwOnError: false, strict: false, trust: false,
      });
    }
  }
  function chapterOf(number) { return data.chapters[number - 1]; }
  function validPagePosition(position) {
    return position && Number.isInteger(position.chapter) && position.chapter >= 1 && position.chapter <= 6 &&
      Number.isInteger(position.page) && position.page >= 1 && position.page <= chapterOf(position.chapter).totalPages;
  }
  function pageInfo() {
    return pageInfoByKey.get(`${state.slide.chapter}-${state.slide.page}`) || { title: `课件第 ${state.slide.page} 页`, grade: '' };
  }
  function persistLocation() {
    if (state.mode === 'pages' && state.view === 'study') state.pagePosition = { chapter: state.slide.chapter, page: state.slide.page };
    save();
    const hash = state.mode === 'pages' ? `page-c${state.slide.chapter}-${state.slide.page}` : state.selectedId;
    if (hash) try { history.replaceState(null, '', `#${hash}`); } catch { /* Local files also support reading without history access. */ }
  }
  function pagePath(chapter, page, version = 2026) {
    return `slides/${version === 2025 ? '2025/' : ''}ch${chapter}/${String(page).padStart(3, '0')}.webp`;
  }
  function footerPage(chapter, page, version) {
    if (chapter === 3 && page >= 133) return page + 1;
    if (chapter === 4 && page >= (version === 2026 ? 85 : 82)) return page + 1;
    return page;
  }
  function pageButton(page, chapter, version = 2026, extraClass = '') {
    const active = state.slide.chapter === chapter && state.slide.page === page && state.slide.version === version;
    return `<button type="button" class="page-chip ${active ? 'active' : ''} ${extraClass}" data-page="${page}" data-chapter="${chapter}" data-version="${version}" aria-label="查看${version}年第${chapter}章PDF第${page}页" ${active ? 'aria-current="page"' : ''}>${page}</button>`;
  }
  function matchingItems() {
    const query = state.query.trim().toLocaleLowerCase();
    const pageQuery = query.match(/^(?:p\.?\s*|第\s*)(\d+)\s*页?$/i);
    let result = data.concepts.filter((item) => query ? true : state.mode === 'pages' ?
      item.chapter === state.slide.chapter && item.pages.includes(state.slide.page) : item.chapter === state.chapter);
    if (query) {
      result = result.filter((item) => pageQuery ? item.pages.includes(Number(pageQuery[1])) :
        `${item.search} ${chapterOf(item.chapter).title}`.toLocaleLowerCase().includes(query));
    }
    return result;
  }
  function renderNavigation() {
    $('.workspace').dataset.mode = state.view === 'study' ? state.mode : 'concepts';
    all('[data-study-mode]').forEach((button) => button.setAttribute('aria-pressed', String(state.view === 'study' && state.mode === button.dataset.studyMode)));
    $('#chapter-nav').innerHTML = data.chapters.map((chapter) => {
      const active = state.view === 'study' && state.chapter === chapter.id;
      const reviewed = data.concepts.filter((item) => item.chapter === chapter.id && state.reviewed.has(item.id)).length;
      const count = chapter.counts.basic + chapter.counts.mastery + chapter.counts.priority;
      return `<button type="button" class="chapter-link ${active ? 'active' : ''}" data-chapter-nav="${chapter.id}" ${active ? 'aria-current="true"' : ''}><span class="chapter-index">${String(chapter.id).padStart(2, '0')}</span><span><span class="chapter-name">${chapter.short}</span><span class="chapter-meta">${count} 个知识点${reviewed ? ` · 已复习 ${reviewed}` : ''}</span></span></button>`;
    }).join('');
    $('#chapter-select').innerHTML = data.chapters.map((chapter) => `<option value="${chapter.id}">第${chapter.id}章 · ${chapter.short}</option>`).join('') + '<option value="changes">2025 → 2026 版本差异</option>';
    $('#chapter-select').value = state.view === 'changes' ? 'changes' : String(state.chapter);
    const total = data.concepts.length;
    const reviewed = data.concepts.filter((item) => state.reviewed.has(item.id)).length;
    $('#progress-count').textContent = `${reviewed} / ${total}`;
    $('#progress-bar').style.width = `${total ? reviewed / total * 100 : 0}%`;
    $('#changes-button').setAttribute('aria-pressed', String(state.view === 'changes'));
    $('#add-concept').hidden = state.view !== 'study';
  }
  function conceptArticle(item) {
    const selected = item.id === state.selectedId;
    const reviewed = state.reviewed.has(item.id);
    return `<article class="concept ${selected ? 'selected' : ''} ${reviewed ? 'reviewed' : ''}" data-concept="${item.id}" aria-labelledby="title-${item.id}">
      <div class="concept-topline">
        <div class="concept-labels"><span class="badge ${item.level}">${levels[item.level]}</span>${item.provisional ? '<span class="update-label">继承推定</span>' : item.updated ? '<span class="update-label">2026 调整</span>' : ''}${state.query ? `<span class="chapter-result-label">第${item.chapter}章</span>` : ''}</div>
        <div class="concept-actions">
          <button class="edit-concept" type="button" data-edit="${item.id}" aria-label="编辑知识点：${escapeHtml(item.title)}">${icon('edit')}<span>编辑</span></button>
          <button class="icon-button trash-concept" type="button" data-trash="${item.id}" aria-label="移入回收站：${escapeHtml(item.title)}" title="移入回收站">${icon('trash')}</button>
          <button class="progress-toggle" type="button" data-reviewed="${item.id}" aria-label="${reviewed ? '取消已复习' : '标记已复习'}：${escapeHtml(item.title)}" aria-pressed="${reviewed}">${reviewed ? icon('check') : ''}</button>
        </div>
      </div>
      <h2 id="title-${item.id}"><button class="concept-title" type="button" data-select="${item.id}" aria-pressed="${selected}">${item.titleHtml}</button></h2>
      <div class="concept-body">${conceptSource(item)}</div>
      ${item.evidence ? `<details class="evidence-note"><summary>录音范围提示 · 待核实</summary><p>${escapeHtml(item.evidence)}</p></details>` : ''}
      <div class="concept-pages"><span class="pages-label">课件</span>${item.pages.map((page) => pageButton(page, item.chapter)).join('')}</div>
    </article>`;
  }
  function conceptSource(item) {
    const original = originals.get(item.id);
    if (!original) return item.bodyHtml;
    const activePage = state.mode === 'pages' && !state.query ? state.slide.page : null;
    if (item.edit && item.edit.body !== item.bodyMarkdown.trim() && item.edit.body !== item.reviewMarkdown?.trim()) {
      return editedMarkup(item.edit.body, original);
    }
    if (item.reviewSections && item.edit?.body !== item.bodyMarkdown.trim()) {
      const pages = activePage === null ? item.reviewReadingOrder : [activePage];
      const sections = pages.map((page) => data.reviewPages[item.reviewSections[page]]?.html).filter(Boolean);
      if (sections.length) return sections.join('');
    }
    if (state.mode !== 'pages' || state.query || !original.pages.includes(state.slide.page)) return item.bodyHtml;
    const source = data.sourcePages?.[`${item.chapter}-${state.slide.page}`];
    if (!source) return item.bodyHtml;
    return `<section class="ppt-source" data-source-page="${source.page}"><div class="ppt-source-label">PPT 原文 · PDF p.${source.page}</div><h3 class="ppt-source-title">${escapeHtml(source.title)}</h3>${source.bodyHtml}</section>`;
  }
  function renderStudy({ preserveSlide = false } = {}) {
    const base = matchingItems();
    visibleItems = base.filter((item) => state.filter === 'all' || (state.filter === 'mastery' ? item.level !== 'basic' : item.level === 'basic'));
    if (!visibleItems.some((item) => item.id === state.selectedId)) state.selectedId = visibleItems[0]?.id || '';
    const chapter = chapterOf(state.chapter);
    const pageMode = state.mode === 'pages';
    $('#chapter-eyebrow').textContent = state.query ? 'SEARCH RESULTS' : `CHAPTER ${String(state.chapter).padStart(2, '0')}${pageMode ? ` · PDF p.${state.slide.page}` : ''}`;
    $('#reading-title').textContent = state.query ? '搜索结果' : chapter.title;
    renderStudySummary(base);
    renderPageBrowser();
    $('.filters').hidden = false;
    all('[data-filter]').forEach((button) => {
      const key = button.dataset.filter;
      const count = base.filter((item) => key === 'all' || (key === 'mastery' ? item.level !== 'basic' : item.level === 'basic')).length;
      button.setAttribute('aria-pressed', String(state.filter === key));
      button.querySelector('span').textContent = count;
    });
    $('.reading-hint').innerHTML = `${icon('slides')}<span>${pageMode && !state.query ? '当前页知识点' : '知识点与对应页码'} · 双击正文编辑</span>`;
    $('#knowledge-list').innerHTML = visibleItems.map(conceptArticle).join('');
    renderEmptyState(base);
    $('#boundary').hidden = Boolean(state.query) || pageMode;
    $('#boundary-content').innerHTML = chapter.boundaryHtml;
    math($('#knowledge-list'));
    math($('#boundary-content'));
    if (!pageMode && state.selectedId) {
      const item = knowledgeById.get(state.selectedId);
      const page = preserveSlide && item.chapter === state.slide.chapter ? state.slide.page : null;
      selectConcept(state.selectedId, { persist: false, page });
    } else {
      if (!pageMode && !state.query && (state.slide.chapter !== state.chapter || state.slide.version !== 2026)) {
        state.slide = { chapter: state.chapter, page: 1, version: 2026 };
      }
      renderPageSource(); updateSelection(); renderSlide();
    }
  }
  function renderStudySummary(base) {
    const chapter = chapterOf(state.chapter);
    $('#chapter-summary').innerHTML = state.query ? `<span>找到 <strong>${base.length}</strong> 个知识点</span><span>搜索全部六章</span>` : state.mode === 'pages' ?
      `<span>PDF 第 <strong>${state.slide.page}</strong> / ${chapter.totalPages} 页</span><span>关联 <strong>${base.length}</strong> 个知识点</span>` :
      `<span><strong>${chapter.counts.basic}</strong> 项基本概念</span><span><strong>${chapter.counts.mastery + chapter.counts.priority}</strong> 项掌握</span><span>${chapter.totalPages} 页课件</span>`;
  }
  function renderEmptyState(base) {
    const pageMode = state.mode === 'pages' && !state.query;
    const noMapping = pageMode && base.length === 0;
    const emptyChapter = !pageMode && !state.query && base.length === 0;
    $('#empty-state').hidden = visibleItems.length !== 0;
    $('#empty-state h2').textContent = noMapping ? '本页尚未关联独立复习条目' : '没有找到匹配的内容';
    $('#empty-state p').textContent = noMapping ? '可以直接阅读课件原页，或翻到下一页继续复习。此提示不改变课件的考察等级。' : pageMode ? '本页没有符合当前等级的知识点，可以清除筛选。' : '试试“MFCC”“基频”，或换一个筛选条件。';
    $('#clear-search').hidden = noMapping || emptyChapter;
    if (emptyChapter) {
      $('#empty-state h2').textContent = '本章没有可复习的知识点';
      $('#empty-state p').textContent = '可从顶部的回收站恢复条目。';
    }
  }
  function renderPageBrowser() {
    const pageMode = state.view === 'study' && state.mode === 'pages';
    $('#page-browser').hidden = !pageMode;
    $('#page-context').hidden = !pageMode || Boolean(state.query);
    $('#page-index').hidden = !pageMode || !state.indexOpen;
    $('#toggle-page-index').setAttribute('aria-expanded', String(pageMode && state.indexOpen));
    if (!pageMode) return;
    const chapter = chapterOf(state.slide.chapter);
    const info = pageInfo();
    $('#study-page-input').value = state.slide.page;
    $('#study-page-input').max = chapter.totalPages;
    $('#study-total-pages').textContent = `/ ${chapter.totalPages}`;
    $('#study-previous-page').disabled = state.slide.page === 1;
    $('#study-next-page').disabled = state.slide.page === chapter.totalPages;
    if (!editingId) {
      $('#page-context').innerHTML = `<div class="page-context-title">${escapeHtml(info.title)}</div>${info.grade ? `<div class="page-grade">课件等级：${escapeHtml(info.grade)}</div>` : ''}`;
    }
    $('#page-index').innerHTML = `<div class="page-index-heading">第${chapter.id}章 · 全部 ${chapter.totalPages} 页</div><div class="page-index-grid">${Array.from({ length: chapter.totalPages }, (_, i) => {
      const number = i + 1;
      const meta = pageInfoByKey.get(`${chapter.id}-${number}`);
      return `<button type="button" data-browse-page="${number}" ${number === state.slide.page ? 'aria-current="page"' : ''} title="${escapeHtml(meta ? `${meta.title} · ${meta.grade}` : `第${number}页`)}">${number}</button>`;
    }).join('')}</div>`;
  }
  function renderPageSource() {
    const edited = knowledgeById.get(editingId);
    const item = edited?.chapter === state.slide.chapter ? edited : knowledgeById.get(state.selectedId);
    const selected = item && item.chapter === state.slide.chapter &&
      (item === edited || state.mode === 'concepts' || item.pages.includes(state.slide.page)) ? item : null;
    $('#source-chapter').textContent = `第${state.slide.chapter}章 · ${chapterOf(state.slide.chapter).short}`;
    $('.reference-heading').textContent = selected ? '本知识点对应页' : '当前课件页';
    $('#reference-pages').innerHTML = (selected?.pages || [state.slide.page]).map((page) => pageButton(page, state.slide.chapter)).join('');
    $('#reference-pages').setAttribute('aria-label', '2026版课件引用页码');
  }
  function changeArticle(item) {
    return `<article class="change-card ${state.changeId === item.id ? 'selected' : ''}" data-change="${item.id}">
      <span class="change-kind ${item.kind}">${changeKinds[item.kind]}</span>
      <h2><button type="button" class="concept-title" data-select-change="${item.id}">${escapeHtml(item.title.replace(/^.*? · /, ''))}</button></h2>
      <div class="change-comparison"><div><div class="change-version-label">2025 版</div><div class="change-version-text">${item.beforeHtml}</div></div><div><div class="change-version-label">2026 版</div><div class="change-version-text">${item.afterHtml}</div></div></div>
      <div class="change-action">${item.actionHtml}</div>
      <div class="change-pages"><span>对照原页</span><button class="page-chip" type="button" data-change-page="${item.id}" data-version="2025">2025 · p.${item.oldPages[0]}</button><button class="page-chip" type="button" data-change-page="${item.id}" data-version="2026">2026 · p.${item.newPages.find((page) => ![11,117,28,31].includes(page)) || item.newPages[0]}</button></div>
    </article>`;
  }
  function renderChanges() {
    $('#page-browser').hidden = true;
    $('#page-context').hidden = true;
    $('#page-index').hidden = true;
    const query = state.query.trim().toLocaleLowerCase();
    const items = data.changes.filter((item) => !query || `${item.title} ${item.beforeHtml} ${item.afterHtml} ${item.actionHtml}`.toLocaleLowerCase().includes(query));
    $('#chapter-eyebrow').textContent = 'VERSION NOTES';
    $('#reading-title').textContent = '2025 → 2026';
    $('#chapter-summary').innerHTML = '<span>逐知识点对照</span><span><strong>9</strong> 项范围调整</span>';
    $('.filters').hidden = true;
    $('.reading-hint').innerHTML = `${icon('compare')}<span>点击年份，对照新旧课件的原页标注</span>`;
    $('#knowledge-list').innerHTML = items.map(changeArticle).join('') + (!query ? `<h2 class="changes-section-title">等级澄清与移页</h2>${data.changeNotes.map((note) => `<div class="changes-note">${note}</div>`).join('')}` : '');
    $('#empty-state').hidden = items.length !== 0;
    $('#empty-state h2').textContent = '没有找到匹配的内容';
    $('#empty-state p').textContent = '试试其他关键词，或清除搜索。';
    $('#clear-search').hidden = false;
    $('#boundary').hidden = true;
    math($('#knowledge-list'));
    if (!items.some((item) => item.id === state.changeId) && items[0]) state.changeId = items[0].id;
    if (items.length) selectChange(state.changeId);
  }
  function render({ resetScroll = true, preserveSlide = false } = {}) {
    clearTimeout(conceptClickTimer);
    renderNavigation();
    if (state.view === 'changes') renderChanges(); else renderStudy({ preserveSlide });
    if (resetScroll) $('#read-scroll').scrollTop = 0;
  }
  function updateSelection() {
    all('[data-concept]').forEach((article) => {
      const active = article.dataset.concept === state.selectedId;
      article.classList.toggle('selected', active);
      article.querySelector('[data-select]').setAttribute('aria-pressed', String(active));
    });
    all('[data-change]').forEach((article) => article.classList.toggle('selected', article.dataset.change === state.changeId));
    all('#knowledge-list [data-page]').forEach((button) => {
      const active = Number(button.dataset.page) === state.slide.page && Number(button.dataset.chapter) === state.slide.chapter && state.slide.version === Number(button.dataset.version);
      button.classList.toggle('active', active);
      if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
    });
  }
  function selectConcept(id, { persist = true, page = null } = {}) {
    const item = knowledgeById.get(id);
    if (!item || state.trashed.has(id)) return;
    if (state.mode === 'pages' && state.view === 'study') {
      const target = page || (item.chapter === state.slide.chapter && item.pages.includes(state.slide.page) ? state.slide.page : item.primaryPage);
      const move = state.slide.chapter !== item.chapter || state.slide.page !== target || state.slide.version !== 2026;
      state.selectedId = id;
      if (move) {
        state.chapter = item.chapter;
        state.slide = { chapter: item.chapter, page: target, version: 2026 };
        state.query = ''; $('#search').value = '';
        render();
      } else { renderPageSource(); updateSelection(); renderSlide(); }
      if (persist) persistLocation();
      return;
    }
    state.selectedId = id;
    state.slide = { chapter: item.chapter, version: 2026, page: page || item.primaryPage };
    renderPageSource();
    updateSelection();
    renderSlide();
    if (persist) {
      persistLocation();
    }
  }
  function selectChange(id, version = 2026, requestedPage = null) {
    const item = changeById.get(id);
    if (!item) return;
    state.changeId = id;
    const newPrimary = item.newPages.find((page) => gradesAreContent(item.chapter, page)) || item.newPages[0];
    state.slide = { chapter: item.chapter, version, page: requestedPage || (version === 2025 ? item.oldPages[0] : newPrimary) };
    $('#source-chapter').textContent = `第${item.chapter}章 · ${chapterOf(item.chapter).short}`;
    $('#source-topic-title').textContent = item.title.replace(/^.*? · /, '');
    $('.reference-heading').textContent = '新旧版本对照页';
    $('#reference-pages').innerHTML = `<span class="reference-old-label">2026 版</span>${item.newPages.map((page) => pageButton(page, item.chapter)).join('')}<span class="reference-old-label">2025 版</span>${item.oldPages.map((page) => pageButton(page, item.chapter, 2025)).join('')}`;
    updateSelection();
    renderSlide();
  }
  function gradesAreContent(chapter, page) {
    return [...originals.values()].some((item) => item.chapter === chapter && item.primaryPage === page);
  }
  function oldAvailablePages() {
    return data.changes.filter((item) => item.chapter === state.slide.chapter).flatMap((item) => item.oldPages).filter((value, index, items) => items.indexOf(value) === index).sort((a, b) => a - b);
  }
  function renderSlide() {
    const { chapter, version, page } = state.slide;
    if (state.view === 'study') $('#source-topic-title').textContent = pageInfo().title;
    const img = $('#slide-image');
    const imageUrl = pagePath(chapter, page, version);
    const alt = `${version}版第${chapter}章《${chapterOf(chapter).title}》PDF第${page}页`;
    if (img.getAttribute('src') !== imageUrl) {
      $('#enlarge-slide').classList.add('loading');
      $('#image-message').hidden = true;
      img.alt = alt;
      img.src = imageUrl;
    }
    $('#slide-version').textContent = `${version} 版`;
    const wheelPaging = state.view === 'study' && state.mode === 'pages';
    $('#wheel-hint').hidden = !wheelPaging;
    $('#slide-instruction').textContent = wheelPaging ? '滚轮翻页 · 点击放大' : '点击图片可放大';
    const footer = footerPage(chapter, page, version);
    $('#page-caption').textContent = `PDF 第 ${page} 页${footer !== page ? ` · 页脚 ${footer}` : ''}`;
    $('#page-input').value = page;
    const total = version === 2026 ? chapterOf(chapter).totalPages : oldPageCounts[chapter - 1];
    $('#page-input').max = total;
    $('#total-pages').textContent = `/ ${total}`;
    $('#open-pdf').hidden = version === 2025;
    $('#open-pdf').href = `decks/ch${chapter}.pdf#page=${page}`;
    const oldPages = oldAvailablePages();
    $('#previous-page').disabled = version === 2026 ? page === 1 : oldPages.indexOf(page) <= 0;
    $('#next-page').disabled = version === 2026 ? page === total : oldPages.indexOf(page) === oldPages.length - 1;
    $('#mobile-page-label').textContent = `p.${page}`;
    all('#reference-pages [data-page]').forEach((button) => {
      const active = Number(button.dataset.page) === page && Number(button.dataset.version) === version;
      button.classList.toggle('active', active);
      if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
    });
    if ($('#image-dialog').open) updateDialogImage();
    if (wheelPaging) {
      for (const adjacent of [page - 1, page + 1]) {
        if (adjacent < 1 || adjacent > total) continue;
        const path = pagePath(chapter, adjacent);
        if (prefetchedSlides.has(path)) continue;
        prefetchedSlides.add(path);
        const preload = new Image();
        preload.src = path;
      }
    }
  }
  function goToPage(page, version = state.slide.version) {
    clearTimeout(conceptClickTimer);
    const limit = version === 2026 ? chapterOf(state.slide.chapter).totalPages : oldPageCounts[state.slide.chapter - 1];
    if (!Number.isInteger(page) || page < 1 || page > limit) {
      toast(`请输入 1–${limit} 之间的页码`);
      $('#page-input').value = state.slide.page;
      $('#study-page-input').value = state.slide.page;
      return;
    }
    if (version === 2025 && !oldAvailablePages().includes(page)) {
      toast('2025 版请从下方对照页码中选择');
      $('#page-input').value = state.slide.page;
      return;
    }
    state.slide.page = page;
    state.slide.version = version;
    const pageMode = state.view === 'study' && state.mode === 'pages';
    if (pageMode && !editingId) {
      state.chapter = state.slide.chapter;
      state.query = ''; $('#search').value = '';
      render();
    } else {
      // Keep the mounted editor and its draft while browsing the slides.
      if (pageMode) renderPageBrowser();
      renderSlide();
      updateSelection();
    }
    if (pageMode) persistLocation();
  }
  function turnPage(direction) {
    const current = state.slide.page;
    const pages = oldAvailablePages();
    const next = state.slide.version === 2026 ? current + direction : pages[pages.indexOf(current) + direction];
    if (Number.isInteger(next)) goToPage(next);
  }
  function resetWheelPaging() {
    wheelTotal = 0; wheelDirection = 0; lastWheelEvent = -Infinity; lastWheelTurn = -Infinity;
  }
  function handleSlideWheel(event) {
    if (state.view !== 'study' || state.mode !== 'pages' || state.slide.version !== 2026 || event.ctrlKey || event.metaKey ||
        Math.abs(event.deltaX) > Math.abs(event.deltaY) || !event.deltaY) return;
    if (event.target.closest('input,textarea,select,[contenteditable="true"]')) return;
    if ($('#image-dialog').open && zoom > 1) return;
    event.preventDefault();
    const now = performance.now();
    const direction = Math.sign(event.deltaY);
    if (now - lastWheelEvent > 180 || direction !== wheelDirection) wheelTotal = 0;
    lastWheelEvent = now;
    wheelDirection = direction;
    if (now - lastWheelTurn < 420) { wheelTotal = 0; return; }
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? innerHeight : 1);
    wheelTotal += delta;
    if (Math.abs(wheelTotal) < 40) return;
    wheelTotal = 0;
    const next = state.slide.page + direction;
    if (next < 1 || next > chapterOf(state.slide.chapter).totalPages) return;
    lastWheelTurn = now;
    goToPage(next);
    if (!$('#image-dialog').open) $('#slide-panel').scrollTop = 0;
  }
  function setChapter(number) {
    resetWheelPaging();
    state.view = 'study';
    state.chapter = number;
    state.query = '';
    $('#search').value = '';
    state.selectedId = '';
    if (state.mode === 'pages') state.slide = { chapter: number, version: 2026, page: 1 };
    render();
    if (state.mode === 'pages') persistLocation();
    else if (state.selectedId) selectConcept(state.selectedId);
  }
  function setMode(mode) {
    if (state.mode === mode && state.view === 'study') return;
    resetWheelPaging();
    const fromChanges = state.view === 'changes';
    const previous = { ...state.slide };
    state.mode = mode; state.view = 'study'; state.query = ''; state.filter = 'all';
    $('#search').value = '';
    if (mode === 'pages') {
      const position = fromChanges || previous.version !== 2026 ? state.pagePosition : previous;
      state.chapter = position.chapter;
      state.slide = { chapter: position.chapter, page: position.page, version: 2026 };
    } else if (!fromChanges) {
      const related = data.concepts.filter((item) => item.chapter === previous.chapter && item.pages.includes(previous.page));
      const selected = related.find((item) => item.id === state.selectedId) || related[0];
      state.chapter = previous.chapter;
      state.selectedId = selected?.id || '';
    }
    render();
    if (mode === 'concepts' && !fromChanges) {
      const item = knowledgeById.get(state.selectedId);
      if (item?.chapter === previous.chapter && item.pages.includes(previous.page)) selectConcept(item.id, { page: previous.page, persist: false });
    }
    persistLocation();
  }
  function setView(view) {
    state.view = view;
    state.query = '';
    $('#search').value = '';
    if (view === 'study' && state.mode === 'pages') {
      state.chapter = state.pagePosition.chapter;
      state.slide = { ...state.pagePosition, version: 2026 };
    }
    render();
  }
  function toggleReviewed(id) {
    if (state.reviewed.has(id)) state.reviewed.delete(id); else state.reviewed.add(id);
    save();
    const article = document.querySelector(`[data-concept="${id}"]`);
    const button = article?.querySelector('[data-reviewed]');
    const done = state.reviewed.has(id);
    article?.classList.toggle('reviewed', done);
    if (button) {
      button.setAttribute('aria-pressed', String(done));
      button.setAttribute('aria-label', `${done ? '取消已复习' : '标记已复习'}：${knowledgeById.get(id).title}`);
      button.innerHTML = done ? icon('check') : '';
    }
    renderNavigation();
  }
  function openMobileViewer() {
    mobileReturnFocus = document.activeElement;
    $('#slide-panel').classList.add('mobile-open');
    $('#slide-panel').setAttribute('role', 'dialog');
    $('#slide-panel').setAttribute('aria-modal', 'true');
    $('#reading-panel').inert = true;
    $('.app-header').inert = true;
    $('#mobile-viewer-button').inert = true;
    $('#close-mobile').focus();
  }
  function closeMobileViewer() {
    $('#slide-panel').classList.remove('mobile-open');
    $('#slide-panel').removeAttribute('role');
    $('#slide-panel').removeAttribute('aria-modal');
    $('#reading-panel').inert = false;
    $('.app-header').inert = false;
    $('#mobile-viewer-button').inert = false;
    mobileReturnFocus?.focus();
  }
  function updateDialogImage() {
    const img = $('#dialog-image');
    img.src = $('#slide-image').src;
    img.alt = $('#slide-image').alt;
    const wheelPaging = state.view === 'study' && state.mode === 'pages';
    $('#dialog-title').textContent = `${state.slide.version} 版 · 第${state.slide.chapter}章 · PDF p.${state.slide.page}${wheelPaging ? zoom > 1 ? ' · 滚动查看' : ' · 滚轮翻页' : ''}`;
    const padding = innerWidth <= 760 ? 24 : 36;
    const fittedWidth = wheelPaging ? Math.min($('#image-dialog').clientWidth - padding, ($('.dialog-image-scroll').clientHeight - padding) * 4 / 3) : $('#image-dialog').clientWidth - padding;
    img.style.width = `${Math.round(fittedWidth * zoom)}px`;
    $('#zoom-reset').textContent = `${Math.round(zoom * 100)}%`;
    $('#zoom-out').disabled = zoom <= .5;
    $('#zoom-in').disabled = zoom >= 3;
  }
  function openImageDialog() {
    if (!$('#slide-image').complete || !$('#slide-image').naturalWidth) return;
    zoom = 1;
    $('#image-dialog').showModal();
    updateDialogImage();
    $('#close-dialog').focus();
  }
  function fillEditor(item, { restoreSource = false } = {}) {
    $('#edit-title').value = item.title;
    $('#edit-body').value = restoreSource ? item.bodyMarkdown : item.edit?.body ?? item.reviewMarkdown ?? item.bodyMarkdown;
    $('#edit-level').value = item.level;
    const pages = [item.primaryPage, ...item.pages.filter((page) => page !== item.primaryPage)];
    $('#edit-pages').value = pages.join('、');
    $('#editor-error').hidden = true;
  }
  function configureEditor({ adding = false, canRestore = false } = {}) {
    $('#editor-title').textContent = adding ? '添加知识点' : '编辑知识点';
    $('#editor-submit').textContent = adding ? '保存知识点' : '完成编辑';
    $('#close-editor').setAttribute('aria-label', adding ? '关闭添加知识点' : '完成编辑');
    $('#reset-concept').hidden = !canRestore;
    $('#add-source-link').hidden = !adding;
    $('#edit-save-note').hidden = adding;
    $('#add-save-note').hidden = !adding;
  }
  function openNewConcept() {
    const { chapter, page } = state.slide;
    addingChapter = chapter;
    configureEditor({ adding: true });
    fillEditor({ title: '', bodyMarkdown: '', level: 'basic', primaryPage: page, pages: [page] });
    $('#editor-context').textContent = `第${chapter}章 · 请按对应课件页填写标题和正文。`;
    $('#add-source-link').href = `decks/ch${chapter}.pdf#page=${page}`;
    $('#editor-dialog').showModal();
    $('#edit-title').focus();
  }
  function openEditor(id) {
    const item = knowledgeById.get(id);
    if (!item) return;
    if (editingId === id) return;
    if (editingId && !saveEditor(null, { reveal: false })) return;
    editingId = id;
    renderPageSource();
    fillEditor(item);
    const source = originals.get(id);
    configureEditor({ canRestore: Boolean(source) });
    $('#editor-context').textContent = source ?
      `第${item.chapter}章 · 课件原标：${levels[source.level]} · PDF p.${source.primaryPage}` :
      `第${item.chapter}章 · 手动添加 · PDF p.${item.primaryPage}`;
    const article = document.querySelector(`[data-concept="${id}"]`);
    article.classList.add('editing');
    const host = document.createElement('div');
    host.className = 'inline-editor';
    host.appendChild($('#editor-form'));
    article.appendChild(host);
    $('#edit-body').focus({ preventScroll: true });
    article.scrollIntoView({ block: 'nearest' });
  }
  function detachEditor(id = editingId) {
    $('#editor-dialog').appendChild($('#editor-form'));
    const article = document.querySelector(`[data-concept="${id}"]`);
    article?.classList.remove('editing');
    article?.querySelector('.inline-editor')?.remove();
    editingId = '';
  }
  function cancelEditor() {
    const id = editingId;
    detachEditor();
    if (state.mode === 'pages') render({ resetScroll: false });
    else renderPageSource();
    document.querySelector(`[data-edit="${id}"]`)?.focus({ preventScroll: true });
  }
  function parsePageInput(value, chapter) {
    const limit = chapterOf(chapter).totalPages;
    const parts = value.trim().replace(/\s*([–—-])\s*/g, '$1').split(/[,，、\s]+/);
    const pages = [];
    for (const part of parts) {
      const match = part.match(/^(\d+)(?:[–—-](\d+))?$/);
      if (!match) throw new Error('页码请填写数字或范围，例如 65–70、73。');
      const first = Number(match[1]), last = Number(match[2] || match[1]);
      if (first < 1 || last > limit || first > last) throw new Error(`第${chapter}章页码应在 1–${limit} 之间，范围应从小到大。`);
      for (let page = first; page <= last; page++) pages.push(page);
    }
    return [...new Set(pages)];
  }
  function readEditor(chapter) {
    const pages = parsePageInput($('#edit-pages').value, chapter);
    return validatedContent(chapter, {
      title: $('#edit-title').value,
      body: $('#edit-body').value,
      level: $('#edit-level').value,
      pages,
      primaryPage: pages[0],
    });
  }
  function saveNewConcept(event) {
    event.preventDefault();
    try {
      const chapter = addingChapter;
      const entry = { chapter, ...readEditor(chapter) };
      const token = [...crypto.getRandomValues(new Uint32Array(4))].map((word) => word.toString(16).padStart(8, '0')).join('');
      const id = `manual-${token}`;
      const additions = { ...state.additions, [id]: entry };
      if (!save({ additions })) throw new Error('浏览器未能保存知识点。请检查是否允许此网页使用本地存储。');
      state.additions = additions;
      rebuildConcepts();
      $('#editor-dialog').close();
      showSavedEdit(id, knowledgeById.get(id), true, true, '已添加知识点');
    } catch (error) {
      $('#editor-error').textContent = error.message;
      $('#editor-error').hidden = false;
    }
  }
  function finishPointerSave() {
    const pending = pointerSave;
    pointerSave = null;
    pending?.finish();
  }

  function saveEditor(event, { reveal = true, pointerId = null } = {}) {
    event?.preventDefault();
    try {
      const id = editingId;
      const source = originals.get(id);
      const previous = knowledgeById.get(id);
      const edit = readEditor(previous.chapter);
      const edits = { ...state.edits };
      let additions = state.additions;
      if (source) {
        const defaultBody = source.reviewMarkdown ?? source.bodyMarkdown;
        const original = edit.title === source.title && edit.body === defaultBody.trim() && edit.level === source.level &&
          edit.primaryPage === source.primaryPage && edit.pages.length === source.pages.length && edit.pages.every((page) => source.pages.includes(page));
        if (original) delete edits[id]; else edits[id] = edit;
      } else additions = { ...additions, [id]: { chapter: previous.chapter, ...edit } };
      if (!save({ edits, additions })) throw new Error('浏览器未能保存修改。请检查是否允许此网页使用本地存储。');
      state.edits = edits;
      state.additions = additions;
      rebuildConcepts();
      const item = knowledgeById.get(id);
      const pagesChanged = item.primaryPage !== previous.primaryPage || item.pages.length !== previous.pages.length ||
        item.pages.some((page) => !previous.pages.includes(page));
      const message = edit.body === source?.bodyMarkdown.trim() ? '已恢复课件原文' : '修改已保存到当前浏览器';
      const finish = () => showSavedEdit(id, item, reveal, pagesChanged, message);
      if (pointerId === null) finish();
      else {
        // Save on press, keeping the pressed control in place until its click.
        const host = $('#editor-form').closest('.inline-editor');
        host.style.visibility = 'hidden';
        host.inert = true;
        editingId = '';
        pointerSave = { pointerId, finish };
      }
      return true;
    } catch (error) {
      $('#editor-error').textContent = error.message;
      $('#editor-error').hidden = false;
      return false;
    }
  }

  function showSavedEdit(id, item, reveal, pagesChanged, message) {
    detachEditor(id);
    state.selectedId = id;
    if (reveal) {
      state.chapter = item.chapter; state.view = 'study'; state.query = ''; state.filter = 'all';
      $('#search').value = '';
    }
    const pageMode = state.mode === 'pages';
    if (pageMode && (pagesChanged || (reveal && item.chapter !== state.slide.chapter))) {
      state.chapter = item.chapter;
      state.slide = { chapter: item.chapter, version: 2026, page: item.primaryPage };
    }
    if (reveal || pagesChanged || pageMode) {
      render({ resetScroll: reveal, preserveSlide: !pagesChanged });
      document.querySelector(`[data-concept="${id}"]`)?.scrollIntoView({ block: reveal ? 'start' : 'nearest' });
    }
    if (reveal) {
      document.querySelector(`[data-edit="${id}"]`)?.focus({ preventScroll: true });
    } else if (!pagesChanged && !pageMode) {
      const article = document.querySelector(`[data-concept="${id}"]`);
      if (article) {
        const matches = matchingItems().some((entry) => entry.id === id) && (state.filter === 'all' || (state.filter === 'mastery' ? item.level !== 'basic' : item.level === 'basic'));
        if (matches) {
          article.outerHTML = conceptArticle(item);
          math(document.querySelector(`[data-concept="${id}"]`));
        } else article.remove();
      }
      $('#empty-state').hidden = Boolean(document.querySelector('[data-concept]'));
      renderNavigation();
      refreshCounts();
      const page = item.chapter === state.slide.chapter ? state.slide.page : null;
      selectConcept(id, { persist: false, page });
    }
    persistLocation();
    toast(message);
  }
  function refreshCounts() {
    const base = matchingItems();
    renderStudySummary(base);
    visibleItems = base.filter((item) => state.filter === 'all' || (state.filter === 'mastery' ? item.level !== 'basic' : item.level === 'basic'));
    renderEmptyState(base);
    all('[data-filter]').forEach((button) => {
      const key = button.dataset.filter;
      button.querySelector('span').textContent = base.filter((item) => key === 'all' || (key === 'mastery' ? item.level !== 'basic' : item.level === 'basic')).length;
    });
  }
  function openBackup() {
    $('#backup-summary').textContent = `${Object.keys(state.additions).length} 个新增 · ${Object.keys(state.edits).length} 项编辑 · ${state.reviewed.size} 个已复习`;
    $('#backup-error').hidden = true;
    $('#import-backup').value = '';
    $('#backup-dialog').showModal();
    $('#export-backup').focus();
  }
  function renderTrash() {
    const items = [...state.trashed].map((id) => knowledgeById.get(id));
    $('#trash-empty').hidden = items.length > 0;
    $('#trash-list').innerHTML = items.map((item) => `<li class="trash-row">
      <div><strong>${escapeHtml(item.title)}</strong><span>第${item.chapter}章 · PDF p.${item.primaryPage}</span></div>
      <button class="secondary-button" type="button" data-restore="${item.id}" aria-label="恢复知识点：${escapeHtml(item.title)}">恢复</button>
    </li>`).join('');
  }
  function setTrashed(id, move) {
    if (!knowledgeById.has(id) || state.trashed.has(id) === move) return;
    const trashed = new Set(state.trashed);
    if (move) trashed.add(id); else trashed.delete(id);
    if (!save({ trashed })) {
      if (move) toast('浏览器未能保存回收站。');
      else {
        $('#trash-error').textContent = '浏览器未能保存恢复操作。';
        $('#trash-error').hidden = false;
      }
      return;
    }
    const index = visibleItems.findIndex((item) => item.id === id);
    const neighbor = visibleItems[index + 1] || visibleItems[index - 1];
    if (move && state.selectedId === id) state.selectedId = neighbor?.id || '';
    state.trashed = trashed;
    rebuildConcepts();
    render({ resetScroll: false });
    if (state.view === 'study') persistLocation();
    if (move) {
      const focus = neighbor && document.querySelector(`[data-select="${neighbor.id}"]`);
      (focus || $('#trash-button')).focus();
      toast('已移入回收站');
    } else {
      $('#trash-error').hidden = true;
      renderTrash();
      ($('#trash-list [data-restore]') || $('#close-trash')).focus();
    }
  }
  function exportBackup() {
    const backup = { schema: 'speech-review-2026', version: 1, exportedAt: new Date().toISOString(), edits: state.edits, additions: state.additions, reviewed: [...state.reviewed], trashed: [...state.trashed] };
    const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url; link.download = `语音信息处理-编辑备份-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
  async function importBackup(event) {
    const file = event.target.files[0];
    if (!file) return;
    try {
      if (file.size > 16 * 1024 * 1024) throw new Error('备份文件过大，请选择本网页导出的 JSON 备份。');
      const backup = JSON.parse(await file.text());
      if (!backup || backup.schema !== 'speech-review-2026' || backup.version !== 1 || !backup.edits || typeof backup.edits !== 'object' || Array.isArray(backup.edits) || Object.keys(backup.edits).length > originals.size) {
        throw new Error('这不是语音信息处理 2026 版的有效编辑备份。');
      }
      const incoming = Object.hasOwn(backup, 'additions') ? backup.additions : {};
      if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) throw new Error('备份中的新增知识点格式不正确。');
      const edits = { ...state.edits };
      const additions = { ...state.additions };
      for (const [id, entry] of Object.entries(backup.edits)) edits[id] = validatedEdit(id, entry);
      for (const [id, entry] of Object.entries(incoming)) additions[id] = validatedAddition(id, entry);
      const reviewed = new Set([...state.reviewed, ...knownIds(backup.reviewed, additions)]);
      const trashed = new Set([...state.trashed, ...knownIds(backup.trashed, additions)]);
      if (!save({ edits, reviewed, trashed, additions })) throw new Error('浏览器未能保存备份。请检查本地存储权限。');
      Object.assign(state, { edits, additions, reviewed, trashed });
      rebuildConcepts();
      render({ resetScroll: false });
      $('#backup-dialog').close();
      toast(`已导入 ${Object.keys(incoming).length} 个新增、${Object.keys(backup.edits).length} 项编辑`);
    } catch (error) {
      $('#backup-error').textContent = error instanceof SyntaxError ? '文件内容不是有效的 JSON 备份。' : error.message;
      $('#backup-error').hidden = false;
    } finally { event.target.value = ''; }
  }

  $('#chapter-nav').addEventListener('click', (event) => {
    const button = event.target.closest('[data-chapter-nav]');
    if (button) setChapter(Number(button.dataset.chapterNav));
  });
  $('#chapter-select').addEventListener('change', (event) => event.target.value === 'changes' ? setView('changes') : setChapter(Number(event.target.value)));
  $('.study-mode').addEventListener('click', (event) => {
    const button = event.target.closest('[data-study-mode]');
    if (button) setMode(button.dataset.studyMode);
  });
  $('#study-previous-page').addEventListener('click', () => turnPage(-1));
  $('#study-next-page').addEventListener('click', () => turnPage(1));
  $('#study-page-input').addEventListener('change', (event) => goToPage(Number(event.target.value)));
  $('#study-page-input').addEventListener('keydown', (event) => { if (event.key === 'Enter') { goToPage(Number(event.target.value)); event.target.blur(); } });
  $('#toggle-page-index').addEventListener('click', () => { state.indexOpen = !state.indexOpen; renderPageBrowser(); });
  $('#page-index').addEventListener('click', (event) => {
    const button = event.target.closest('[data-browse-page]');
    if (button) goToPage(Number(button.dataset.browsePage));
  });
  $('.brand').addEventListener('click', (event) => { event.preventDefault(); state.filter = 'all'; setChapter(1); });
  $('#changes-button').addEventListener('click', () => setView(state.view === 'changes' ? 'study' : 'changes'));
  $('#add-concept').addEventListener('click', openNewConcept);
  $('.filters').addEventListener('click', (event) => {
    const button = event.target.closest('[data-filter]');
    if (!button) return;
    state.filter = button.dataset.filter;
    render();
  });
  $('#search').addEventListener('input', (event) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.query = event.target.value; render(); }, 120);
  });
  $('#clear-search').addEventListener('click', () => {
    state.query = ''; state.filter = 'all'; $('#search').value = ''; render(); $('#search').focus();
  });
  function canDoubleClickToEdit(target) {
    return !target.closest('button,a,input,textarea,select,summary,#editor-form');
  }
  $('#knowledge-list').addEventListener('click', (event) => {
    if (event.target.closest('#editor-form')) return;
    const edit = event.target.closest('[data-edit]');
    if (edit) { openEditor(edit.dataset.edit); return; }
    const trash = event.target.closest('[data-trash]');
    if (trash) { setTrashed(trash.dataset.trash, true); return; }
    const reviewed = event.target.closest('[data-reviewed]');
    if (reviewed) { toggleReviewed(reviewed.dataset.reviewed); return; }
    const changePage = event.target.closest('[data-change-page]');
    if (changePage) { selectChange(changePage.dataset.changePage, Number(changePage.dataset.version)); return; }
    const page = event.target.closest('[data-page]');
    const article = event.target.closest('[data-concept]');
    if (article) {
      const id = article.dataset.concept;
      if (!page && event.detail > 0 && canDoubleClickToEdit(event.target)) {
        // Let a second click enter the editor before changing the slide.
        if (event.detail === 1) conceptClickTimer = setTimeout(() => selectConcept(id), 500);
      } else selectConcept(id, { page: page ? Number(page.dataset.page) : null });
      return;
    }
    const change = event.target.closest('[data-change]');
    if (change) selectChange(change.dataset.change);
  });
  $('#knowledge-list').addEventListener('dblclick', (event) => {
    if (!canDoubleClickToEdit(event.target)) return;
    const article = event.target.closest('[data-concept]');
    if (article) { window.getSelection()?.removeAllRanges(); openEditor(article.dataset.concept); }
  });
  function keepsEditorOpen(target) {
    return target.closest('#editor-form, #slide-panel :is(button, input, a), #image-dialog, #mobile-viewer-button, #page-browser, #page-index');
  }
  document.addEventListener('pointerdown', (event) => {
    if (!event.isPrimary || event.button !== 0) return;
    finishPointerSave();
    if (!editingId || keepsEditorOpen(event.target)) return;
    if (!saveEditor(null, { reveal: false, pointerId: event.pointerId })) event.preventDefault();
  }, true);
  document.addEventListener('pointerup', (event) => {
    const pending = pointerSave;
    if (pending?.pointerId === event.pointerId) {
      // Dragging away can end the press without a click.
      setTimeout(() => { if (pointerSave === pending) finishPointerSave(); }, 0);
    }
  }, true);
  document.addEventListener('pointercancel', (event) => {
    if (pointerSave?.pointerId === event.pointerId) finishPointerSave();
  }, true);
  window.addEventListener('blur', finishPointerSave);
  document.addEventListener('click', (event) => {
    clearTimeout(conceptClickTimer);
    finishPointerSave();
    if (!editingId || keepsEditorOpen(event.target)) return;
    if (event.detail === 0 && saveEditor(null, { reveal: false })) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  $('#reference-pages').addEventListener('click', (event) => {
    const button = event.target.closest('[data-page]');
    if (button) goToPage(Number(button.dataset.page), Number(button.dataset.version));
  });
  $('#slide-image').addEventListener('load', () => { $('#enlarge-slide').classList.remove('loading'); $('#image-message').hidden = true; });
  $('#slide-image').addEventListener('error', () => { $('#enlarge-slide').classList.remove('loading'); $('#image-message').hidden = false; });
  $('#retry-image').addEventListener('click', () => {
    $('#image-message').hidden = true;
    $('#enlarge-slide').classList.add('loading');
    $('#slide-image').src = pagePath(state.slide.chapter, state.slide.page, state.slide.version) + `?retry=${Date.now()}`;
  });
  $('#previous-page').addEventListener('click', () => turnPage(-1));
  $('#slide-panel').addEventListener('wheel', handleSlideWheel, { passive: false });
  $('.dialog-image-scroll').addEventListener('wheel', handleSlideWheel, { passive: false });
  $('#next-page').addEventListener('click', () => turnPage(1));
  $('#page-input').addEventListener('change', (event) => goToPage(Number(event.target.value)));
  $('#page-input').addEventListener('keydown', (event) => { if (event.key === 'Enter') { goToPage(Number(event.target.value)); event.target.blur(); } });
  $('#enlarge-slide').addEventListener('click', openImageDialog);
  $('#mobile-viewer-button').addEventListener('click', openMobileViewer);
  $('#close-mobile').addEventListener('click', closeMobileViewer);
  $('#close-dialog').addEventListener('click', () => $('#image-dialog').close());
  $('#zoom-in').addEventListener('click', () => { zoom = Math.min(3, zoom + .25); updateDialogImage(); });
  $('#zoom-out').addEventListener('click', () => { zoom = Math.max(.5, zoom - .25); updateDialogImage(); });
  $('#zoom-reset').addEventListener('click', () => { zoom = 1; updateDialogImage(); });
  $('#editor-form').addEventListener('submit', (event) => {
    if ($('#editor-dialog').open) saveNewConcept(event); else saveEditor(event);
  });
  $('#close-editor').addEventListener('click', (event) => {
    if ($('#editor-dialog').open) $('#editor-dialog').close(); else saveEditor(event);
  });
  $('#cancel-editor').addEventListener('click', () => {
    if ($('#editor-dialog').open) $('#editor-dialog').close(); else cancelEditor();
  });
  $('#reset-concept').addEventListener('click', () => { fillEditor(originals.get(editingId), { restoreSource: true }); $('#edit-body').focus(); });
  $('#backup-button').addEventListener('click', openBackup);
  $('#close-backup').addEventListener('click', () => $('#backup-dialog').close());
  $('#export-backup').addEventListener('click', exportBackup);
  $('#import-backup').addEventListener('change', importBackup);
  $('#trash-button').addEventListener('click', () => {
    $('#trash-error').hidden = true;
    renderTrash();
    $('#trash-dialog').showModal();
  });
  $('#close-trash').addEventListener('click', () => $('#trash-dialog').close());
  $('#trash-list').addEventListener('click', (event) => {
    const button = event.target.closest('[data-restore]');
    if (button) setTrashed(button.dataset.restore, false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if ($('#image-dialog').open) return;
      if ($('#slide-panel').classList.contains('mobile-open')) { event.preventDefault(); closeMobileViewer(); return; }
      if (editingId) { event.preventDefault(); cancelEditor(); return; }
    }
    if (editingId && event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { saveEditor(event); return; }
    if ($('#editor-dialog').open && event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault(); $('#editor-form').requestSubmit(); return;
    }
    const editing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
    if (event.key === '/' && !editing && !document.querySelector('dialog[open]')) { event.preventDefault(); $('#search').focus(); }
    if (['ArrowLeft', 'ArrowRight'].includes(event.key) && !editing && ($('#image-dialog').open || $('#slide-panel').contains(document.activeElement))) {
      event.preventDefault(); turnPage(event.key === 'ArrowLeft' ? -1 : 1);
    }
    if (event.key === 'Tab' && $('#slide-panel').classList.contains('mobile-open') && !$('#image-dialog').open) {
      const controls = [...$('#slide-panel').querySelectorAll('button:not(:disabled),a[href],input')].filter((element) => element.getClientRects().length);
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  });
  window.addEventListener('resize', () => {
    if (innerWidth > 760 && $('#slide-panel').classList.contains('mobile-open')) closeMobileViewer();
    if ($('#image-dialog').open) updateDialogImage();
  });
  window.addEventListener('hashchange', () => {
    const page = parsePageHash(location.hash);
    if (page) {
      state.mode = 'pages'; state.view = 'study'; state.chapter = page.chapter; state.slide = { ...page, version: 2026 };
      state.query = ''; state.filter = 'all'; $('#search').value = '';
      render(); persistLocation(); return;
    }
    const item = knowledgeById.get(location.hash.slice(1));
    if (item) { state.mode = 'concepts'; state.chapter = item.chapter; state.selectedId = item.id; state.query = ''; state.filter = 'all'; state.view = 'study'; $('#search').value = ''; render(); persistLocation(); document.querySelector(`[data-concept="${item.id}"]`)?.scrollIntoView({ block: 'start' }); }
  });

  function parsePageHash(hash) {
    const match = hash.match(/^#page-c([1-6])-(\d+)$/);
    const position = match ? { chapter: Number(match[1]), page: Number(match[2]) } : null;
    return validPagePosition(position) ? position : null;
  }
  function knownIds(ids, additions) {
    return Array.isArray(ids) ? ids.filter((id) => typeof id === 'string' && (originals.has(id) || Object.hasOwn(additions, id))) : [];
  }

  if (saved.edits && typeof saved.edits === 'object' && !Array.isArray(saved.edits)) {
    for (const [id, edit] of Object.entries(saved.edits)) {
      try { state.edits[id] = validatedEdit(id, edit); } catch { /* Invalid entries do not prevent reading the source material. */ }
    }
  }
  if (saved.additions && typeof saved.additions === 'object' && !Array.isArray(saved.additions)) {
    for (const [id, entry] of Object.entries(saved.additions)) {
      try { state.additions[id] = validatedAddition(id, entry); } catch { /* Skip invalid local entries. */ }
    }
  }
  state.reviewed = new Set(knownIds(saved.reviewed, state.additions));
  state.trashed = new Set(knownIds(saved.trashed, state.additions));
  rebuildConcepts();
  const hashItem = knowledgeById.get(location.hash.slice(1));
  const hashPage = parsePageHash(location.hash);
  const initial = hashItem || knowledgeById.get(saved.last) || data.concepts[0];
  state.chapter = initial?.chapter ?? 1;
  state.selectedId = initial?.id ?? '';
  if (hashItem) state.mode = 'concepts';
  else if (hashPage) state.mode = 'pages';
  if (state.mode === 'pages') {
    const position = hashPage || state.pagePosition;
    state.chapter = position.chapter;
    state.pagePosition = { chapter: position.chapter, page: position.page };
    state.slide = { ...position, version: 2026 };
  }
  fillIcons();
  render();
  if (state.mode === 'concepts' && initial && initial.id !== visibleItems[0]?.id) {
    requestAnimationFrame(() => { document.querySelector(`[data-concept="${initial.id}"]`)?.scrollIntoView({ block: 'start' }); });
  }
})();
