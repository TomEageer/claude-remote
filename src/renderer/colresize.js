// 表格列宽拖动：鼠标移到表头单元格右边缘拖动调整这一列的宽度，双击边缘恢复自动列宽。
// 主界面和预览插件各带一份（插件要自包含），改动时几处保持一致。
(function () {
  'use strict';
  const MIN = 36;

  function headerCells(table) {
    const row = (table.tHead && table.tHead.rows[table.tHead.rows.length - 1]) || table.rows[0];
    if (!row) return null;
    const cells = [...row.cells];
    // 表头有合并单元格时列和格子对不上，不处理
    if (!cells.length || cells.some((c) => c.colSpan > 1)) return null;
    return cells;
  }

  // 第一次拖动时把当前的列宽固定下来，之后按 colgroup 控制
  function freeze(table, cells) {
    if (table.dataset.colsFrozen) return [...table.querySelectorAll(':scope > colgroup.cr-cols > col')];
    const widths = cells.map((c) => c.getBoundingClientRect().width);
    let cg = table.querySelector(':scope > colgroup.cr-cols');
    if (!cg) {
      cg = document.createElement('colgroup');
      cg.className = 'cr-cols';
      table.insertBefore(cg, table.firstChild);
    }
    cg.innerHTML = '';
    const cols = widths.map((w) => {
      const col = document.createElement('col');
      col.style.width = w + 'px';
      cg.appendChild(col);
      return col;
    });
    table.style.tableLayout = 'fixed';
    table.style.width = widths.reduce((a, b) => a + b, 0) + 'px';
    table.style.maxWidth = 'none';
    table.dataset.colsFrozen = '1';
    return cols;
  }

  function unfreeze(table) {
    const cg = table.querySelector(':scope > colgroup.cr-cols');
    if (cg) cg.remove();
    table.style.tableLayout = '';
    table.style.width = '';
    table.style.maxWidth = '';
    delete table.dataset.colsFrozen;
  }

  function makeResizable(table) {
    if (!table || table.dataset.colResize) return;
    const cells = headerCells(table);
    if (!cells) return;
    table.dataset.colResize = '1';
    table.classList.add('cr-resizable');
    cells.forEach((cell, i) => {
      const grip = document.createElement('span');
      grip.className = 'cr-grip';
      grip.title = '拖动调整列宽，双击恢复';
      grip.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        const cols = freeze(table, cells);
        const col = cols[i];
        if (!col) return;
        const startX = e.clientX;
        const startW = parseFloat(col.style.width) || cell.getBoundingClientRect().width;
        const startT = parseFloat(table.style.width) || table.getBoundingClientRect().width;
        try { grip.setPointerCapture(e.pointerId); } catch (_) { /* 模拟事件没有真实指针 */ }
        document.documentElement.classList.add('cr-col-resizing');
        const move = (ev) => {
          const w = Math.max(MIN, startW + ev.clientX - startX);
          col.style.width = w + 'px';
          table.style.width = startT + (w - startW) + 'px';
        };
        const up = () => {
          grip.removeEventListener('pointermove', move);
          grip.removeEventListener('pointerup', up);
          grip.removeEventListener('pointercancel', up);
          document.documentElement.classList.remove('cr-col-resizing');
        };
        grip.addEventListener('pointermove', move);
        grip.addEventListener('pointerup', up);
        grip.addEventListener('pointercancel', up);
      });
      grip.addEventListener('click', (e) => e.stopPropagation());
      grip.addEventListener('dblclick', (e) => {
        e.preventDefault();
        e.stopPropagation();
        unfreeze(table);
      });
      cell.appendChild(grip);
    });
  }

  function makeAllResizable(root) {
    (root || document).querySelectorAll('table').forEach(makeResizable);
  }

  window.makeTableResizable = makeResizable;
  window.makeTablesResizable = makeAllResizable;
})();
