'use strict';

(function startApplication() {
  const DB = window.PreanalyticsDB;
  const Catalog = window.PreanalyticsCatalog;

  const PAGE_SIZE = 40;

  const state = {
    tests: [],
    query: '',
    division: 'Todas',
    admin: false,
    editingId: null,
    expanded: new Set(),
    installPrompt: null,
    pinAttempts: 0,
    blockedUntil: 0,
    refreshTimer: null,
    updateRequested: false,
    catalogUpdateAvailable: false,
    visibleCount: PAGE_SIZE,
    searchTimer: null,
    selectedCenter: null,
    editingCenterCode: null,
    referenceRules: null,
    rulesById: new Map(),
    ofertaCentros: null,
    classificationStatus: null,
    referralPublished: false,
    executiveUnits: {},
    officialCenterCodes: new Set(),
    centrosList: [],
    centerFilterCategory: 'all',
    centerSearchQuery: ''
  };

  let scrollObserver = null;

  const byId = (id) => document.getElementById(id);

  function showToast(message, type = 'info') {
    const container = byId('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast ${['success', 'error', 'warning'].includes(type) ? type : ''}`.trim();
    toast.textContent = String(message || '');
    container.appendChild(toast);
    window.setTimeout(() => {
      toast.classList.add('fade');
      window.setTimeout(() => toast.remove(), 220);
    }, 3800);
  }

  function openDialog(id, focusId = '') {
    const dialog = byId(id);
    if (!dialog || dialog.open) return;
    dialog.showModal();
    document.body.classList.add('dialog-open');
    window.setTimeout(() => (focusId ? byId(focusId) : dialog.querySelector('input,button,select,textarea'))?.focus(), 0);
  }

  function closeDialog(id) {
    const dialog = byId(id);
    if (dialog?.open) dialog.close();
  }

  function syncDialogBodyState() {
    document.body.classList.toggle('dialog-open', Boolean(document.querySelector('dialog[open]')));
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  function localDateStamp() {
    const date = new Date();
    const offset = date.getTimezoneOffset() * 60000;
    return new Date(date.getTime() - offset).toISOString().slice(0, 10);
  }

  function formatDateTime(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value || '') : date.toLocaleString('es-CR', { dateStyle: 'short', timeStyle: 'short' });
  }

  function updateOnlineStatus() {
    const online = navigator.onLine;
    byId('onlineDot').classList.toggle('offline', !online);
    byId('onlineText').textContent = online ? 'Laboratorio Clínico · Fase preanalítica' : 'Trabajando sin conexión';
  }

  function updateHeaderCompact() {
    const compact = window.scrollY > 56 || (window.innerHeight < 500 && window.innerWidth > window.innerHeight);
    byId('appHeader').classList.toggle('compact', compact);
  }

  function getDivisions() {
    return Array.from(new Set(state.tests.map((test) => Catalog.divisionName(test.division)).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'es'));
  }

  function renderDivisions() {
    const container = byId('divisionChips');
    container.replaceChildren();
    const divisions = ['Todas', ...getDivisions()];
    if (!divisions.includes(state.division)) state.division = 'Todas';

    for (const division of divisions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `chip${division === state.division ? ' active' : ''}`;
      button.dataset.division = division;
      button.setAttribute('aria-pressed', String(division === state.division));
      if (division !== 'Todas') {
        const swatch = document.createElement('span');
        swatch.className = 'chip-swatch';
        swatch.style.setProperty('--chip-color', Catalog.divisionColor(division));
        swatch.setAttribute('aria-hidden', 'true');
        button.appendChild(swatch);
      }
      button.append(document.createTextNode(division));
      button.addEventListener('click', () => {
        state.division = division;
        state.visibleCount = PAGE_SIZE;
        renderDivisions();
        renderList();
      });
      container.appendChild(button);
    }
  }

  async function loadReferenceRulesAndCenters() {
    try {
      const [statusPayload, directoryPayload, unitPayload, localCenters] = await Promise.all([
        Catalog.fetchEstadoClasificacion(),
        Catalog.fetchCenterDirectory(),
        Catalog.fetchExecutiveUnits(),
        DB.getAllCenters()
      ]);
      let rulesPayload = null;
      let ofertaPayload = null;
      if (statusPayload?.publicable === true && statusPayload?.estadoPublicacion === 'publicado') {
        [rulesPayload, ofertaPayload] = await Promise.all([
          Catalog.fetchReferenceRules(),
          Catalog.fetchOfertaCentros()
        ]);
      }
      state.classificationStatus = statusPayload;
      state.referralPublished = Boolean(
        statusPayload?.publicable === true &&
        statusPayload?.estadoPublicacion === 'publicado' &&
        Array.isArray(rulesPayload?.pruebas) &&
        rulesPayload.pruebas.length === Number(statusPayload.totalPruebas) &&
        Number(statusPayload.totalPendientes) === 0 &&
        ofertaPayload?.centros &&
        rulesPayload.version === statusPayload.version &&
        ofertaPayload.version === statusPayload.version
      );
      if (state.referralPublished) {
        state.referenceRules = rulesPayload;
        state.rulesById = new Map(rulesPayload.pruebas.map((rule) => [String(rule.id), rule]));
      } else {
        state.referenceRules = null;
        state.rulesById = new Map();
      }
      state.executiveUnits = unitPayload?.unidadesPorCentro || {};
      const centerPayload = state.referralPublished ? ofertaPayload : directoryPayload;
      if (centerPayload?.centros) {
        state.ofertaCentros = centerPayload;
        const officialCenters = Object.values(centerPayload.centros).map((center) => ({
          ...Catalog.normalizeCenter({
            ...center,
            unidadEjecutora: state.executiveUnits[center.codigo] || '',
            source: 'official'
          }),
          ...(state.referralPublished ? {
            totalAutorizadas: center.totalAutorizadas,
            pruebasAutorizadas: center.pruebasAutorizadas
          } : {})
        }));
        state.officialCenterCodes = new Set(officialCenters.map((center) => center.codigo));
        state.centrosList = [...officialCenters, ...localCenters]
          .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es', { sensitivity: 'base' }));
      }
      renderClassificationStatus();
    } catch (e) {
      state.referralPublished = false;
      state.rulesById = new Map();
      renderClassificationStatus('No se pudo verificar el estado de publicación. Se mantiene desactivada la clasificación por centro.');
      console.warn('No se pudo cargar el directorio o verificar la clasificación de referencia:', e);
    }
  }

  async function refreshCenterDirectory() {
    const localCenters = await DB.getAllCenters();
    const officialCenters = state.ofertaCentros?.centros
      ? Object.values(state.ofertaCentros.centros).map((center) => ({
          ...Catalog.normalizeCenter({
            ...center,
            unidadEjecutora: state.executiveUnits[center.codigo] || '',
            source: 'official'
          }),
          ...(state.referralPublished ? {
            totalAutorizadas: center.totalAutorizadas,
            pruebasAutorizadas: center.pruebasAutorizadas
          } : {})
        }))
      : [];
    state.officialCenterCodes = new Set(officialCenters.map((center) => center.codigo));
    state.centrosList = [...officialCenters, ...localCenters]
      .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es', { sensitivity: 'base' }));
    if (state.selectedCenter) {
      state.selectedCenter = state.centrosList.find((center) => center.codigo === state.selectedCenter.codigo) || null;
    }
    if (byId('centerDialog').open) renderCenterList();
  }

  function renderClassificationStatus(overrideText = '') {
    const banner = byId('classificationStatusBanner');
    banner.classList.toggle('published', state.referralPublished);
    byId('classificationStatusTitle').textContent = state.referralPublished
      ? 'Clasificación de referencias publicada'
      : 'Clasificación de referencias en proceso';
    byId('classificationStatusText').textContent = overrideText || (state.referralPublished
      ? 'Las reglas publicadas fueron verificadas y ya pueden consultarse por centro.'
      : state.classificationStatus?.notaPublicacion || 'El catálogo puede consultarse, pero todavía no indica qué pruebas puede referir cada centro.');
  }

  /* ── Filtrado dinámico por búsqueda, división y centro de salud CCSS ── */
  function getVisibleTests() {
    return state.tests
      .filter((test) => {
        if (!state.selectedCenter || !state.referralPublished) return true;
        const authIds = state.selectedCenter.pruebasAutorizadas;
        if (Array.isArray(authIds)) {
          const authorized = new Set(authIds.map(String));
          return authorized.has(String(test.id));
        }
        return true;
      })
      .filter((test) => Catalog.matchesQuery(test, state.query))
      .filter((test) => state.division === 'Todas' || Catalog.divisionName(test.division) === state.division);
  }

  function createTag(text, className = '') {
    const tag = document.createElement('span');
    tag.className = `tag ${className}`.trim();
    tag.textContent = text;
    return tag;
  }

  function appendFormattedText(container, text) {
    if (!text || typeof text !== 'string') {
      container.textContent = String(text || '');
      return;
    }
    const lines = text.split('\n');
    lines.forEach((line, lineIndex) => {
      if (lineIndex > 0) container.appendChild(document.createElement('br'));
      const parts = line.split(/(\*\*.*?\*\*)/g);
      for (const part of parts) {
        if (part.startsWith('**') && part.endsWith('**') && part.length >= 4) {
          const strong = document.createElement('strong');
          strong.textContent = part.slice(2, -2);
          container.appendChild(strong);
        } else if (part) {
          container.appendChild(document.createTextNode(part));
        }
      }
    });
  }

  function createField(key, label, value) {
    const field = document.createElement('div');
    field.className = `field${Catalog.isCriticalValue(key, value) ? ' critical' : ''}`;
    const labelElement = document.createElement('div');
    labelElement.className = 'field-label';
    labelElement.textContent = label;
    const valueElement = document.createElement('div');
    valueElement.className = 'field-value';
    
    const displayValue = key === 'division' ? Catalog.divisionName(value) : value;
    appendFormattedText(valueElement, displayValue);
    
    field.append(labelElement, valueElement);
    return field;
  }

  function buildCardDetails(details, test) {
    for (const section of Catalog.SECTIONS) {
      const populated = section.fields.filter(([key]) => {
        const val = test[key];
        return String(val || '').trim() && !Catalog.isUninformativeValue(val);
      });
      if (!populated.length) continue;
      const sectionElement = document.createElement('section');
      sectionElement.className = 'detail-section';
      const heading = document.createElement('h3');
      heading.className = 'section-heading';
      heading.textContent = section.title;
      const grid = document.createElement('div');
      grid.className = 'field-grid';
      for (const [key, label] of populated) grid.appendChild(createField(key, label, test[key]));
      sectionElement.append(heading, grid);
      details.appendChild(sectionElement);
    }

    const rule = state.rulesById.get(String(test.id));
    if (state.referralPublished && rule) {
      const refSection = document.createElement('section');
      refSection.className = 'detail-section';
      const refHeading = document.createElement('h3');
      refHeading.className = 'section-heading';
      refHeading.textContent = 'Clasificación de Referencia (HSJD)';
      
      const refGrid = document.createElement('div');
      refGrid.className = 'field-grid';
      
      const authInfo = Catalog.getAuthTagInfo(rule.tipoAutorizacion);
      if (authInfo) {
        refGrid.appendChild(createField('tipo_autorizacion', 'Alcance Autorizado', authInfo.label));
      }
      if (rule.centrosAutorizados && rule.centrosAutorizados.length > 0) {
        refGrid.appendChild(createField('centros_autorizados', 'Centros Autorizados Específicos', rule.centrosAutorizados.join(', ')));
      }
      if (rule.observaciones && !Catalog.isUninformativeValue(rule.observaciones)) {
        refGrid.appendChild(createField('obs_jefatura', 'Observaciones de Jefatura', rule.observaciones));
      }
      refSection.append(refHeading, refGrid);

      if (rule.condicion && !Catalog.isUninformativeValue(rule.condicion)) {
        const condBox = document.createElement('div');
        condBox.className = 'condition-notice';
        const condTitle = document.createElement('div');
        condTitle.className = 'condition-title';
        condTitle.textContent = '⚠️ Condición Preanalítica o Administrativa de Referencia:';
        const condBody = document.createElement('div');
        condBody.className = 'condition-body';
        condBody.textContent = rule.condicion;
        condBox.append(condTitle, condBody);
        refSection.appendChild(condBox);
      }
      details.appendChild(refSection);
    }

    const actions = document.createElement('div');
    actions.className = 'card-actions';
    const copyButton = document.createElement('button');
    copyButton.type = 'button';
    copyButton.className = 'button secondary';
    copyButton.textContent = 'Copiar ficha';
    copyButton.addEventListener('click', () => copyTest(test, copyButton));
    const shareButton = document.createElement('button');
    shareButton.type = 'button';
    shareButton.className = 'button secondary';
    shareButton.textContent = 'Compartir';
    shareButton.addEventListener('click', () => shareTest(test));
    actions.append(copyButton, shareButton);

    if (state.admin) {
      const editButton = document.createElement('button');
      editButton.type = 'button';
      editButton.className = 'button primary';
      editButton.textContent = 'Editar prueba';
      editButton.addEventListener('click', () => openEditor(test));
      actions.appendChild(editButton);
    }
    details.appendChild(actions);
  }

  function createTestCard(test) {
    const card = document.createElement('article');
    card.className = `test-card${state.expanded.has(test.id) ? ' open' : ''}`;

    const strip = document.createElement('span');
    strip.className = 'tube-strip';
    strip.style.setProperty('--tube-color', Catalog.tubeColor(test.tipo_muestra));
    strip.setAttribute('aria-hidden', 'true');

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'card-toggle';
    toggle.setAttribute('aria-expanded', String(state.expanded.has(test.id)));

    const main = document.createElement('div');
    main.className = 'card-main';
    const name = document.createElement('h2');
    name.className = 'test-name';
    name.textContent = test.nombre;
    const meta = document.createElement('div');
    meta.className = 'test-meta';
    const division = Catalog.divisionName(test.division);
    if (division) {
      const tag = createTag(division, 'division-tag');
      const color = Catalog.divisionColor(division);
      tag.style.setProperty('--division-color', color);
      tag.style.setProperty('--division-bg', Catalog.hexToRgba(color, 0.12));
      meta.appendChild(tag);
    }
    if (test.codigo_digitacion && !Catalog.isUninformativeValue(test.codigo_digitacion)) {
      meta.appendChild(createTag(test.codigo_digitacion));
    }

    const rule = state.rulesById.get(String(test.id));
    if (state.referralPublished && rule) {
      const authInfo = Catalog.getAuthTagInfo(rule.tipoAutorizacion);
      if (authInfo) {
        const authTag = createTag(authInfo.label, `auth-tag ${authInfo.className}`);
        authTag.title = authInfo.title;
        meta.appendChild(authTag);
      }
      if (rule.condicion && !Catalog.isUninformativeValue(rule.condicion)) {
        const condTag = createTag('⚠️ Condicionada', 'condition-tag');
        condTag.title = 'Requiere cumplimiento de condición';
        meta.appendChild(condTag);
      }
    }

    if (test.tipo_muestra && !Catalog.isUninformativeValue(test.tipo_muestra)) {
      const sample = document.createElement('span');
      appendFormattedText(sample, test.tipo_muestra);
      meta.appendChild(sample);
    }
    main.append(name, meta);

    const chevron = document.createElement('span');
    chevron.className = 'chevron';
    chevron.setAttribute('aria-hidden', 'true');
    chevron.textContent = '⌄';
    toggle.append(main, chevron);

    const details = document.createElement('div');
    details.className = 'card-details';
    let detailsBuilt = false;

    if (state.expanded.has(test.id)) {
      buildCardDetails(details, test);
      detailsBuilt = true;
    }

    toggle.addEventListener('click', () => {
      if (!detailsBuilt) {
        buildCardDetails(details, test);
        detailsBuilt = true;
      }
      if (state.expanded.has(test.id)) state.expanded.delete(test.id);
      else state.expanded.add(test.id);
      card.classList.toggle('open', state.expanded.has(test.id));
      toggle.setAttribute('aria-expanded', String(state.expanded.has(test.id)));
      updateExpandButton();
    });

    card.append(strip, toggle, details);
    return card;
  }

  function setupScrollObserver(list) {
    if (scrollObserver) scrollObserver.disconnect();

    const sentinel = document.createElement('div');
    sentinel.className = 'scroll-sentinel';
    sentinel.setAttribute('aria-hidden', 'true');
    list.appendChild(sentinel);

    if (!('IntersectionObserver' in window)) return;
    scrollObserver = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) {
        const allVisible = getVisibleTests();
        if (state.visibleCount < allVisible.length) {
          const nextBatch = allVisible.slice(state.visibleCount, state.visibleCount + PAGE_SIZE);
          state.visibleCount += nextBatch.length;

          const fragment = document.createDocumentFragment();
          for (const test of nextBatch) fragment.appendChild(createTestCard(test));
          list.insertBefore(fragment, sentinel);

          updateExpandButton();
          updateResultCount(allVisible.length);
        }
        if (state.visibleCount >= allVisible.length && scrollObserver) {
          scrollObserver.disconnect();
        }
      }
    }, { rootMargin: '400px' });

    scrollObserver.observe(sentinel);
  }

  function updateResultCount(totalVisible) {
    if (state.selectedCenter && state.referralPublished) {
      byId('resultCount').textContent = `${totalVisible} ${totalVisible === 1 ? 'prueba autorizada' : 'pruebas autorizadas'} para ${state.selectedCenter.nombre} · ${state.tests.length} en catálogo general`;
    } else if (state.selectedCenter) {
      byId('resultCount').textContent = `${totalVisible} ${totalVisible === 1 ? 'prueba encontrada' : 'pruebas encontradas'} en el catálogo general · centro seleccionado solo como referencia de directorio`;
    } else {
      byId('resultCount').textContent = `${totalVisible} ${totalVisible === 1 ? 'prueba encontrada' : 'pruebas encontradas'} · ${state.tests.length} en la base local`;
    }
  }

  function openCenterDialog(options = {}) {
    state.centerSearchQuery = '';
    state.centerFilterCategory = 'all';
    byId('centerSearchInput').value = '';
    byId('addCenterFromDirectoryButton').hidden = !(state.admin && options.manage);
    byId('centerDialogTitle').textContent = options.manage ? 'Administrar áreas y unidades' : 'Seleccionar área, unidad o centro';
    setCenterCategory('all', false);

    renderCenterList();
    openDialog('centerDialog', 'centerSearchInput');
  }

  function setCenterCategory(category, rerender = true) {
    state.centerFilterCategory = category;
    const categories = {
      filterCenterAll: 'all',
      filterCenterHsjd: 'hsjd',
      filterCenterHospitales: 'hospitales',
      filterCenterAreas: 'areas',
      filterCenterUnits: 'units'
    };
    for (const [id, value] of Object.entries(categories)) {
      const active = category === value;
      byId(id).classList.toggle('active', active);
      byId(id).setAttribute('aria-pressed', String(active));
    }
    if (rerender) renderCenterList();
  }

  function handleCenterSearch(event) {
    state.centerSearchQuery = Catalog.normalizeSearch(event.target.value);
    renderCenterList();
  }

  function renderCenterList() {
    const container = byId('centerListGrid');
    container.replaceChildren();

    const query = state.centerSearchQuery;
    const category = state.centerFilterCategory;

    const filtered = state.centrosList.filter((centro) => {
      if (category === 'hsjd' && !centro.esAreaAtraccionHsjd) return false;
      if (category === 'hospitales' && !centro.tipo.toLowerCase().includes('hospital')) return false;
      if (category === 'areas' && !centro.tipo.toLowerCase().includes('área de salud') && !centro.tipo.toLowerCase().includes('area de salud')) return false;
      if (category === 'units' && !centro.unidadEjecutora) return false;

      if (query) {
        const parent = state.centrosList.find((item) => item.codigo === centro.parentAreaCode)?.nombre || '';
        const text = Catalog.normalizeSearch(`${centro.codigo} ${centro.nombre} ${centro.tipo} ${centro.unidadEjecutora} ${centro.region} ${centro.areaAtraccion} ${parent}`);
        return text.includes(query);
      }
      return true;
    });

    if (filtered.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'empty-inline';
      empty.textContent = 'No se encontraron centros de salud que coincidan con la búsqueda.';
      container.appendChild(empty);
      return;
    }

    for (const centro of filtered) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = `center-card${state.selectedCenter?.codigo === centro.codigo ? ' selected' : ''}`;
      
      const header = document.createElement('div');
      header.className = 'center-card-header';
      const badge = document.createElement('span');
      badge.className = 'center-code-badge';
      badge.textContent = centro.codigo;
      const typeSpan = document.createElement('span');
      typeSpan.className = 'center-card-sub';
      typeSpan.textContent = centro.tipo;
      header.append(badge, typeSpan);

      const name = document.createElement('h3');
      name.className = 'center-card-name';
      name.textContent = centro.nombre;

      const sub = document.createElement('p');
      sub.className = 'center-card-sub';
      const parent = state.centrosList.find((item) => item.codigo === centro.parentAreaCode);
      sub.textContent = [centro.region, centro.areaAtraccion, parent ? `Área: ${parent.nombre}` : ''].filter(Boolean).join(' · ') || 'Sin ubicación registrada';

      const meta = document.createElement('div');
      meta.className = 'center-card-meta';
      const unitBadge = document.createElement('span');
      unitBadge.className = 'center-auth-count';
      unitBadge.textContent = centro.unidadEjecutora ? `UE ${centro.unidadEjecutora}` : 'UE por confirmar';
      meta.appendChild(unitBadge);

      if (centro.source === 'local') meta.appendChild(createTag('Registro local', 'local-tag'));

      if (centro.esAreaAtraccionHsjd) {
        const hsjdTag = createTag('Atracción HSJD', 'tag auth-hsjd');
        meta.appendChild(hsjdTag);
      }

      card.append(header, name, sub, meta);
      card.title = state.admin && centro.source === 'local' ? 'Editar este registro local' : 'Seleccionar este establecimiento';
      card.addEventListener('click', () => {
        if (state.admin && centro.source === 'local' && !byId('addCenterFromDirectoryButton').hidden) openCenterEditor(centro);
        else selectCenter(centro);
      });
      container.appendChild(card);
    }
  }

  function selectCenter(centro) {
    state.selectedCenter = centro;
    state.visibleCount = PAGE_SIZE;

    byId('selectedCenterLabel').textContent = `${centro.nombre} (${centro.codigo})`;
    byId('clearCenterFilterButton').hidden = false;

    byId('centerActiveBanner').hidden = false;
    byId('centerActiveTitle').textContent = state.referralPublished
      ? `Oferta autorizada para: ${centro.nombre} (${centro.codigo})`
      : `Centro seleccionado: ${centro.nombre} (${centro.codigo})`;
    byId('centerActiveSubtitle').textContent = state.referralPublished
      ? `${centro.tipo} · ${centro.region} · ${centro.totalAutorizadas} pruebas autorizadas para referencia al HSJD`
      : [centro.tipo, centro.region, centro.unidadEjecutora ? `Unidad ejecutora ${centro.unidadEjecutora}` : 'Unidad ejecutora por confirmar', 'La clasificación de pruebas continúa en proceso'].filter(Boolean).join(' · ');

    closeDialog('centerDialog');
    renderDivisions();
    renderList();
    showToast(state.referralPublished
      ? `Mostrando la oferta autorizada para ${centro.nombre}.`
      : `${centro.nombre} seleccionado. Se mantiene visible el catálogo general porque la clasificación está en proceso.`,
    state.referralPublished ? 'success' : 'warning');
  }

  function clearCenterFilter() {
    state.selectedCenter = null;
    state.visibleCount = PAGE_SIZE;

    byId('selectedCenterLabel').textContent = 'Seleccionar área, unidad o centro…';
    byId('clearCenterFilterButton').hidden = true;
    byId('centerActiveBanner').hidden = true;

    closeDialog('centerDialog');
    renderDivisions();
    renderList();
    showToast('Selección de centro eliminada.');
  }

  function populateParentAreaOptions(currentCode = '') {
    const select = byId('centerParentInput');
    select.replaceChildren(new Option('No corresponde / sin definir', ''));
    const areas = state.centrosList.filter((center) => {
      const type = Catalog.normalizeSearch(center.tipo);
      return center.codigo !== currentCode && type.includes('area de salud');
    });
    for (const area of areas) select.appendChild(new Option(`${area.nombre} (${area.codigo})`, area.codigo));
  }

  function openCenterEditor(center = null) {
    if (!state.admin) return openAdmin();
    const record = center || {};
    state.editingCenterCode = center?.codigo || null;
    byId('centerEditorTitle').textContent = center ? 'Editar área o unidad local' : 'Agregar área o unidad';
    byId('centerCodeInput').value = record.codigo || '';
    byId('centerCodeInput').disabled = Boolean(center);
    byId('centerNameInput').value = record.nombre || '';
    byId('centerTypeInput').value = record.tipo || 'Área de Salud';
    byId('centerExecutiveUnitInput').value = record.unidadEjecutora || '';
    byId('centerRegionInput').value = record.region || '';
    byId('centerNetworkInput').value = record.red || '';
    byId('centerHospitalInput').value = record.hospitalReferencia || '';
    populateParentAreaOptions(record.codigo || '');
    byId('centerParentInput').value = record.parentAreaCode || '';
    byId('deleteCenterButton').hidden = !center;
    byId('centerEditorError').hidden = true;
    closeDialog('centerDialog');
    closeDialog('adminDialog');
    openDialog('centerEditorDialog', center ? 'centerNameInput' : 'centerCodeInput');
  }

  async function saveCenter(event) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.checkValidity()) return form.reportValidity();
    const type = byId('centerTypeInput').value;
    const parentAreaCode = byId('centerParentInput').value;
    const unitCode = byId('centerExecutiveUnitInput').value.trim();
    const error = byId('centerEditorError');
    error.hidden = true;

    if (Catalog.normalizeSearch(type) === 'unidad ejecutora' && !parentAreaCode) {
      error.textContent = 'Seleccione el área de salud a la que corresponde esta unidad.';
      error.hidden = false;
      return;
    }
    if (unitCode && !/^\d{2,12}$/.test(unitCode)) {
      error.textContent = 'El código de unidad ejecutora debe contener únicamente números.';
      error.hidden = false;
      return;
    }

    const code = state.editingCenterCode || byId('centerCodeInput').value;
    const normalizedCode = code.trim().toUpperCase().replace(/\s+/g, '-');
    if (!state.editingCenterCode && (state.officialCenterCodes.has(normalizedCode) || state.centrosList.some((center) => center.codigo === normalizedCode))) {
      error.textContent = 'Ese código interno ya existe en el directorio.';
      error.hidden = false;
      return;
    }

    const existing = state.centrosList.find((center) => center.codigo === state.editingCenterCode);
    const button = byId('saveCenterButton');
    button.disabled = true;
    try {
      const record = Catalog.normalizeCenter({
        codigo: code,
        nombre: byId('centerNameInput').value,
        tipo: type,
        unidadEjecutora: unitCode,
        parentAreaCode,
        region: byId('centerRegionInput').value,
        red: byId('centerNetworkInput').value,
        hospitalReferencia: byId('centerHospitalInput').value,
        areaAtraccion: existing?.areaAtraccion || '',
        source: 'local',
        createdAt: existing?.createdAt
      }, { now: new Date().toISOString(), source: 'local' });
      await DB.upsertCenter(record, existing ? 'actualización de directorio' : 'creación de directorio');
      closeDialog('centerEditorDialog');
      await refreshCenterDirectory();
      showToast(existing ? 'Registro local actualizado.' : 'Área o unidad agregada al directorio local.', 'success');
      openCenterDialog({ manage: true });
    } catch (saveError) {
      error.textContent = saveError.message || 'No se pudo guardar el registro.';
      error.hidden = false;
    } finally {
      button.disabled = false;
    }
  }

  async function deleteCurrentCenter() {
    const center = state.centrosList.find((item) => item.codigo === state.editingCenterCode && item.source === 'local');
    if (!center) return;
    const hasChildren = state.centrosList.some((item) => item.parentAreaCode === center.codigo);
    if (hasChildren) {
      showToast('No se puede eliminar el área mientras tenga unidades asociadas.', 'warning');
      return;
    }
    if (!window.confirm(`¿Eliminar "${center.nombre}" del directorio local?`)) return;
    try {
      await DB.deleteCenter(center.codigo, center.nombre);
      if (state.selectedCenter?.codigo === center.codigo) clearCenterFilter();
      closeDialog('centerEditorDialog');
      await refreshCenterDirectory();
      showToast('Registro local eliminado.', 'success');
      openCenterDialog({ manage: true });
    } catch (error) {
      showToast(error.message || 'No se pudo eliminar el registro.', 'error');
    }
  }

  function renderList() {
    const list = byId('testList');
    const allVisible = getVisibleTests();
    const page = 'IntersectionObserver' in window ? allVisible.slice(0, state.visibleCount) : allVisible;

    list.replaceChildren(...page.map(createTestCard));
    byId('emptyState').hidden = allVisible.length !== 0 || state.tests.length === 0;
    updateResultCount(allVisible.length);
    updateExpandButton();

    if ('IntersectionObserver' in window && allVisible.length > state.visibleCount) {
      setupScrollObserver(list);
    }
  }

  function updateExpandButton() {
    const visible = getVisibleTests();
    const rendered = Math.min(visible.length, state.visibleCount);
    const allOpen = rendered > 0 && visible.slice(0, rendered).every((test) => state.expanded.has(test.id));
    byId('expandAllButton').textContent = allOpen ? 'Contraer visibles' : 'Expandir visibles';
    byId('expandAllButton').disabled = rendered === 0;
  }

  async function copyText(text) {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.className = 'sr-only';
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    textarea.remove();
    if (!copied) throw new Error('No se pudo copiar.');
  }

  async function copyTest(test, button) {
    try {
      await copyText(Catalog.formatTestText(test, {
        center: state.selectedCenter,
        referralPublished: state.referralPublished
      }));
      const original = button.textContent;
      button.textContent = 'Copiado';
      window.setTimeout(() => { button.textContent = original; }, 1600);
    } catch (error) {
      showToast(error.message || 'No se pudo copiar la ficha.', 'error');
    }
  }

  async function shareTest(test) {
    const text = Catalog.formatTestText(test, {
      center: state.selectedCenter,
      referralPublished: state.referralPublished
    });
    try {
      if (navigator.share) {
        await navigator.share({ title: `Preanalítica · ${test.nombre}`, text });
      } else {
        await copyText(text);
        showToast('El navegador no permite compartir; la ficha se copió al portapapeles.', 'success');
      }
    } catch (error) {
      if (error?.name !== 'AbortError') showToast('No se pudo compartir la ficha.', 'error');
    }
  }

  function setCatalogNotice(title = '', message = '') {
    const notice = byId('catalogNotice');
    notice.hidden = !title;
    byId('catalogNoticeTitle').textContent = title;
    byId('catalogNoticeText').textContent = message;
  }

  async function refreshData() {
    state.tests = await DB.getAllTests();

    state.tests.sort((a, b) => String(a.nombre || '').localeCompare(String(b.nombre || ''), 'es', { sensitivity: 'base' }));

    for (const test of state.tests) {
      test._searchIndex = Catalog.buildSearchIndex(test);
    }

    renderDivisions();
    renderList();
    await updateAdminSummary();
    if (state.tests.length && !state.catalogUpdateAvailable) setCatalogNotice();
  }

  function scheduleRefresh() {
    window.clearTimeout(state.refreshTimer);
    state.refreshTimer = window.setTimeout(() => refreshData().catch(console.error), 100);
  }

  async function ensureCatalog() {
    try {
      const result = await Catalog.seedIfEmpty(DB);
      if (result.seeded) showToast(`Catálogo inicial cargado: ${result.count} pruebas.`, 'success');
      if (result.updateAvailable) {
        state.catalogUpdateAvailable = true;
        setCatalogNotice('Nueva versión oficial disponible', 'Sus datos locales no se modificaron. Desde Administración puede exportar un respaldo y restaurar explícitamente el catálogo oficial cuando corresponda.');
      }
      await refreshData();
    } catch (error) {
      await refreshData();
      if (!state.tests.length) {
        setCatalogNotice('Catálogo inicial no disponible', 'Conecte el dispositivo a Internet y pulse "Reintentar". Los archivos de la aplicación sí pueden seguir funcionando offline después de la primera carga.');
      }
      console.error(error);
    }
  }

  function openAdmin() {
    if (state.admin) {
      updateAdminSummary();
      openDialog('adminDialog');
      return;
    }
    byId('pinForm').reset();
    byId('pinError').hidden = true;
    openDialog('pinDialog', 'pinInput');
  }

  async function handlePinSubmit(event) {
    event.preventDefault();
    const now = Date.now();
    if (state.blockedUntil > now) {
      const seconds = Math.ceil((state.blockedUntil - now) / 1000);
      byId('pinError').textContent = `Demasiados intentos. Espere ${seconds} segundos.`;
      byId('pinError').hidden = false;
      return;
    }

    const button = byId('pinSubmitButton');
    button.disabled = true;
    try {
      const valid = await DB.verifyPin(byId('pinInput').value);
      if (!valid) {
        state.pinAttempts += 1;
        if (state.pinAttempts >= 5) {
          state.pinAttempts = 0;
          state.blockedUntil = Date.now() + 30000;
          byId('pinError').textContent = 'Demasiados intentos. Espere 30 segundos.';
        } else {
          byId('pinError').textContent = 'PIN incorrecto.';
        }
        byId('pinError').hidden = false;
        return;
      }
      state.pinAttempts = 0;
      state.admin = true;
      closeDialog('pinDialog');
      renderList();
      await updateAdminSummary();
      openDialog('adminDialog');
    } catch (error) {
      showToast(error.message || 'No se pudo verificar el PIN.', 'error');
    } finally {
      button.disabled = false;
    }
  }

  function createEditorControl(key, label, value, divisions) {
    const wrapper = document.createElement('div');
    wrapper.className = `editor-field${Catalog.WIDE_FIELDS.has(key) ? ' wide' : ''}`;
    const labelElement = document.createElement('label');
    const controlId = `field-${key}`;
    labelElement.htmlFor = controlId;
    labelElement.textContent = `${label}${key === 'nombre' ? ' *' : ''}`;

    let control;
    if (key === 'division') {
      control = document.createElement('input');
      control.setAttribute('list', 'divisionOptions');
    } else if (Catalog.WIDE_FIELDS.has(key) && key !== 'nombre') {
      control = document.createElement('textarea');
      control.rows = key === 'uso_clinico' ? 5 : 3;
    } else {
      control = document.createElement('input');
      control.type = 'text';
    }
    control.id = controlId;
    control.dataset.key = key;
    control.value = value || '';
    control.maxLength = key === 'nombre' ? 300 : 12000;
    if (key === 'nombre') control.required = true;
    wrapper.append(labelElement, control);

    if (key === 'division' && !byId('divisionOptions')) {
      const datalist = document.createElement('datalist');
      datalist.id = 'divisionOptions';
      for (const division of divisions) {
        const option = document.createElement('option');
        option.value = division;
        datalist.appendChild(option);
      }
      wrapper.appendChild(datalist);
    }
    return wrapper;
  }

  function openEditor(test = null) {
    if (!state.admin) return openAdmin();
    const record = test || { id: Catalog.createId(), nombre: '' };
    state.editingId = record.id;
    byId('editorTitle').textContent = test ? 'Editar prueba' : 'Nueva prueba';
    byId('deleteTestButton').hidden = !test;
    const container = byId('editorFields');
    container.replaceChildren();
    const divisions = getDivisions();

    const identity = document.createElement('section');
    identity.className = 'editor-section';
    const identityTitle = document.createElement('h3');
    identityTitle.textContent = 'Identificación';
    const identityGrid = document.createElement('div');
    identityGrid.className = 'editor-grid';
    identityGrid.appendChild(createEditorControl('nombre', 'Nombre de la prueba', record.nombre, divisions));
    identity.append(identityTitle, identityGrid);
    container.appendChild(identity);

    for (const section of Catalog.SECTIONS) {
      const sectionElement = document.createElement('section');
      sectionElement.className = 'editor-section';
      const heading = document.createElement('h3');
      heading.textContent = section.title;
      const grid = document.createElement('div');
      grid.className = 'editor-grid';
      for (const [key, label] of section.fields) grid.appendChild(createEditorControl(key, label, record[key], divisions));
      sectionElement.append(heading, grid);
      container.appendChild(sectionElement);
    }
    closeDialog('adminDialog');
    openDialog('editorDialog', 'field-nombre');
  }

  async function saveEditor(event) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.checkValidity()) return form.reportValidity();
    const existing = state.tests.find((item) => item.id === state.editingId);
    const payload = { id: state.editingId, createdAt: existing?.createdAt };
    form.querySelectorAll('[data-key]').forEach((control) => { payload[control.dataset.key] = control.value; });

    const button = byId('saveTestButton');
    button.disabled = true;
    try {
      const record = Catalog.normalizeTest(payload, { now: new Date().toISOString() });
      await DB.upsertTest(record, existing ? 'actualización' : 'creación');
      closeDialog('editorDialog');
      await refreshData();
      showToast(existing ? 'Prueba actualizada.' : 'Prueba creada.', 'success');
    } catch (error) {
      showToast(error.message || 'No se pudo guardar la prueba.', 'error');
    } finally {
      button.disabled = false;
    }
  }

  async function deleteCurrentTest() {
    const test = state.tests.find((item) => item.id === state.editingId);
    if (!test) return;
    if (!window.confirm(`¿Eliminar "${test.nombre}"? Esta acción quedará registrada en el historial local.`)) return;
    try {
      await DB.deleteTest(test.id, test.nombre);
      state.expanded.delete(test.id);
      closeDialog('editorDialog');
      await refreshData();
      showToast('Prueba eliminada.', 'success');
    } catch (error) {
      showToast(error.message || 'No se pudo eliminar la prueba.', 'error');
    }
  }

  async function exportBackup() {
    try {
      const payload = await DB.exportBackup();
      downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), `preanalitica-respaldo-${localDateStamp()}.json`);
      await DB.recordBackup();
      await updateAdminSummary();
      showToast('Respaldo JSON generado.', 'success');
    } catch (error) {
      showToast(error.message || 'No se pudo exportar el respaldo.', 'error');
    }
  }

  async function importBackupFile(file) {
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) throw new Error('El archivo supera el máximo permitido de 20 MB.');
    const payload = JSON.parse(await file.text());
    const parsed = Catalog.parseBackupPayload(payload);
    if (!window.confirm(`Respaldo validado: ${parsed.tests.length} pruebas y ${parsed.centers.length} registros locales de áreas o unidades. Se reemplazará la base local. ¿Continuar?`)) return;
    await DB.importBackup(parsed, parsed.tests);
    state.expanded.clear();
    await refreshData();
    await refreshCenterDirectory();
    showToast('Respaldo importado correctamente.', 'success');
  }

  async function restoreOfficialCatalog() {
    if (!window.confirm('Se reemplazarán todas las ediciones locales por el catálogo original publicado. Exporte un respaldo antes de continuar. ¿Restaurar?')) return;
    const button = byId('restoreOfficialButton');
    button.disabled = true;
    try {
      const catalog = await Catalog.fetchOfficialCatalog();
      await DB.replaceTests(catalog.tests, {
        action: 'restauración oficial',
        summary: `Catálogo original restaurado con ${catalog.tests.length} pruebas.`,
        source: catalog.sourceLabel,
        meta: {
          catalog_source_version: catalog.sourceVersion,
          catalog_source_label: catalog.sourceLabel,
          restored_at: new Date().toISOString()
        }
      });
      state.catalogUpdateAvailable = false;
      state.expanded.clear();
      await refreshData();
      showToast('Catálogo original restaurado.', 'success');
    } catch (error) {
      showToast(error.message || 'No se pudo restaurar el catálogo original.', 'error');
    } finally {
      button.disabled = false;
    }
  }

  async function exportCsv() {
    try {
      const csv = Catalog.catalogToCsv(state.tests);
      downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `preanalitica-catalogo-${localDateStamp()}.csv`);
      showToast('Catálogo CSV generado.', 'success');
    } catch (error) {
      showToast(error.message || 'No se pudo generar el CSV.', 'error');
    }
  }

  async function requestPersistentStorage() {
    if (!navigator.storage?.persist) return showToast('Este navegador no permite solicitar almacenamiento persistente.', 'warning');
    try {
      const granted = await navigator.storage.persist();
      showToast(granted ? 'Almacenamiento persistente concedido.' : 'El navegador no concedió almacenamiento persistente.', granted ? 'success' : 'warning');
    } catch (error) {
      showToast('No se pudo solicitar persistencia.', 'error');
    }
  }

  async function updateAdminSummary() {
    const [source, backup, centers] = await Promise.all([DB.getMeta('catalog_source_label'), DB.getMeta('last_backup'), DB.getAllCenters()]);
    byId('adminRecordCount').textContent = `${state.tests.length} pruebas · ${centers.length} áreas/unidades locales`;
    byId('adminSource').textContent = source || (state.tests.length ? 'Base existente' : 'Sin catálogo');
    byId('adminBackupStatus').textContent = backup ? formatDateTime(backup) : 'Pendiente';
  }

  async function renderAudit() {
    const rows = await DB.getAudit(300);
    const body = byId('auditTableBody');
    body.replaceChildren();
    for (const entry of rows) {
      const row = document.createElement('tr');
      const date = document.createElement('td');
      date.textContent = formatDateTime(entry.createdAt);
      const action = document.createElement('td');
      action.textContent = entry.action || 'cambio';
      const summary = document.createElement('td');
      summary.textContent = entry.summary || '';
      row.append(date, action, summary);
      body.appendChild(row);
    }
    byId('auditEmpty').hidden = rows.length !== 0;
  }

  async function changePin(event) {
    event.preventDefault();
    try {
      await DB.setPin(byId('newPinInput').value);
      event.currentTarget.reset();
      showToast('PIN actualizado.', 'success');
    } catch (error) {
      showToast(error.message || 'No se pudo actualizar el PIN.', 'error');
    }
  }

  function setupInstallPrompt() {
    window.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault();
      state.installPrompt = event;
      byId('installBtn').hidden = false;
    });
    byId('installBtn').addEventListener('click', async () => {
      if (!state.installPrompt) return;
      state.installPrompt.prompt();
      await state.installPrompt.userChoice.catch(() => null);
      state.installPrompt = null;
      byId('installBtn').hidden = true;
    });
    window.addEventListener('appinstalled', () => {
      state.installPrompt = null;
      byId('installBtn').hidden = true;
      showToast('Aplicación instalada.', 'success');
    });
  }

  function showUpdateBanner(registration) {
    if (!registration?.waiting) return;
    byId('updateBanner').hidden = false;
    byId('applyUpdateButton').onclick = () => {
      state.updateRequested = true;
      registration.waiting?.postMessage({ type: 'SKIP_WAITING' });
    };
  }

  async function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    try {
      const registration = await navigator.serviceWorker.register('./sw.js');
      if (registration.waiting) showUpdateBanner(registration);
      registration.addEventListener('updatefound', () => {
        const worker = registration.installing;
        worker?.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) showUpdateBanner(registration);
        });
      });
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (state.updateRequested) window.location.reload();
      });
    } catch (error) {
      console.warn('No se pudo registrar el service worker:', error);
    }
  }

  function bindEvents() {
    byId('searchInput').addEventListener('input', (event) => {
      state.query = event.target.value;
      byId('clearSearchButton').hidden = !state.query;
      window.clearTimeout(state.searchTimer);
      state.searchTimer = window.setTimeout(() => {
        state.visibleCount = PAGE_SIZE;
        renderList();
      }, 160);
    });
    byId('clearSearchButton').addEventListener('click', () => {
      state.query = '';
      byId('searchInput').value = '';
      byId('clearSearchButton').hidden = true;
      byId('searchInput').focus();
      state.visibleCount = PAGE_SIZE;
      renderList();
    });
    byId('expandAllButton').addEventListener('click', () => {
      const visible = getVisibleTests();
      const rendered = visible.slice(0, state.visibleCount);
      const allOpen = rendered.length && rendered.every((test) => state.expanded.has(test.id));
      for (const test of rendered) allOpen ? state.expanded.delete(test.id) : state.expanded.add(test.id);
      renderList();
    });
    byId('retryCatalogButton').addEventListener('click', ensureCatalog);
    byId('adminButton').addEventListener('click', openAdmin);
    byId('pinForm').addEventListener('submit', handlePinSubmit);
    byId('newTestButton').addEventListener('click', () => openEditor());
    byId('manageCentersButton').addEventListener('click', () => {
      closeDialog('adminDialog');
      openCenterDialog({ manage: true });
    });
    byId('editorForm').addEventListener('submit', saveEditor);
    byId('deleteTestButton').addEventListener('click', deleteCurrentTest);
    byId('exportBackupButton').addEventListener('click', exportBackup);
    byId('importBackupButton').addEventListener('click', () => byId('importBackupInput').click());
    byId('importBackupInput').addEventListener('change', async (event) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) return;
      try { await importBackupFile(file); }
      catch (error) { showToast(error.message || 'No se pudo importar el archivo.', 'error'); }
    });
    byId('exportCsvButton').addEventListener('click', exportCsv);
    byId('restoreOfficialButton').addEventListener('click', restoreOfficialCatalog);
    byId('storageButton').addEventListener('click', requestPersistentStorage);
    byId('auditButton').addEventListener('click', async () => {
      await renderAudit();
      closeDialog('adminDialog');
      openDialog('auditDialog');
    });
    byId('centerSelectorButton').addEventListener('click', () => openCenterDialog());
    byId('clearCenterFilterButton').addEventListener('click', clearCenterFilter);
    byId('resetCenterBannerButton').addEventListener('click', clearCenterFilter);
    byId('resetCenterFilterDialogBtn').addEventListener('click', clearCenterFilter);
    byId('centerSearchInput').addEventListener('input', handleCenterSearch);
    byId('filterCenterAll').addEventListener('click', () => setCenterCategory('all'));
    byId('filterCenterHsjd').addEventListener('click', () => setCenterCategory('hsjd'));
    byId('filterCenterHospitales').addEventListener('click', () => setCenterCategory('hospitales'));
    byId('filterCenterAreas').addEventListener('click', () => setCenterCategory('areas'));
    byId('filterCenterUnits').addEventListener('click', () => setCenterCategory('units'));
    byId('addCenterFromDirectoryButton').addEventListener('click', () => openCenterEditor());
    byId('centerEditorForm').addEventListener('submit', saveCenter);
    byId('deleteCenterButton').addEventListener('click', deleteCurrentCenter);

    byId('changePinForm').addEventListener('submit', changePin);
    byId('lockAdminButton').addEventListener('click', () => {
      state.admin = false;
      closeDialog('adminDialog');
      renderList();
      showToast('Modo administrador cerrado.');
    });
    document.querySelectorAll('[data-close-dialog]').forEach((button) => {
      button.addEventListener('click', () => closeDialog(button.dataset.closeDialog));
    });
    document.querySelectorAll('dialog').forEach((dialog) => {
      dialog.addEventListener('close', syncDialogBodyState);
      dialog.addEventListener('click', (event) => {
        const rect = dialog.getBoundingClientRect();
        const outside = event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom;
        if (outside) dialog.close();
      });
    });
    window.addEventListener('online', updateOnlineStatus);
    window.addEventListener('offline', updateOnlineStatus);
    window.addEventListener('scroll', updateHeaderCompact, { passive: true });
    window.addEventListener('resize', updateHeaderCompact);
    DB.onChange((reason) => {
      if (reason === 'centers') refreshCenterDirectory().catch(console.error);
      else scheduleRefresh();
    });
  }

  async function init() {
    bindEvents();
    setupInstallPrompt();
    updateOnlineStatus();
    updateHeaderCompact();
    try {
      await DB.openDB();
      await ensureCatalog();
      await loadReferenceRulesAndCenters();
      renderList();
      if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(() => registerServiceWorker());
      } else {
        window.setTimeout(() => registerServiceWorker(), 0);
      }
    } catch (error) {
      console.error(error);
      setCatalogNotice('No se pudo iniciar la base local', error.message || 'Revise los permisos del navegador.');
      showToast('No se pudo iniciar la aplicación.', 'error');
    }
  }

  init();
})();
