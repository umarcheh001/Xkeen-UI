// Windowed list of fixed-height rows, for the "all devices" view of a big network.
//
// Only the rows around the visible part exist in the DOM: the scroll box keeps the
// full height through a spacer, the rows layer is moved to the first drawn row. Same
// idea as the virtual table of the Xray logs (static/js/features/xray_log_view.js),
// without that table's variable-height detail row.
//
//   const list = createVirtualRows(host, { rowHeight: 52, height: 420, renderRow })
//   list.setItems(items)   renderRow(item, index) -> HTML of the row content
//   list.scrollToEnd()     list.destroy()
//
// The rows are drawn by renderRow's caller-escaped HTML; the wrapper only adds
// the absolute geometry (class xkv-row, data-index, role="row").

const DEFAULT_OVERSCAN = 4;

export function createVirtualRows(host, { rowHeight, height = 420, overscan = DEFAULT_OVERSCAN, renderRow, label = "" }) {
  host.innerHTML = `<div class="xkv" role="rowgroup" tabindex="0" aria-label="${String(label).replace(/"/g, "&quot;")}" style="height:${height}px"><div class="xkv-space"><div class="xkv-rows"></div></div></div>`;
  const box = host.querySelector(".xkv");
  const space = host.querySelector(".xkv-space");
  const rows = host.querySelector(".xkv-rows");
  let items = [];
  let first = -1;
  let last = -1;
  let frame = 0;

  const visibleCount = () => Math.ceil((box.clientHeight || height) / rowHeight);

  function paint(force = false) {
    frame = 0;
    const total = items.length;
    const start = Math.max(0, Math.floor(box.scrollTop / rowHeight) - overscan);
    const end = Math.min(total, start + visibleCount() + overscan * 2 + 1);
    if (!force && start === first && end === last) return;
    first = start;
    last = end;
    let html = "";
    for (let index = start; index < end; index += 1) {
      html += `<div class="xkv-row" role="row" data-index="${index}" style="height:${rowHeight}px">${renderRow(items[index], index)}</div>`;
    }
    rows.style.transform = `translateY(${start * rowHeight}px)`;
    rows.innerHTML = html;
  }

  const schedule = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => paint());
  };
  box.addEventListener("scroll", schedule, { passive: true });

  return {
    setItems(next) {
      items = Array.isArray(next) ? next : [];
      space.style.height = `${items.length * rowHeight}px`;
      first = -1;
      last = -1;
      paint(true);
    },
    scrollToEnd() {
      box.scrollTop = box.scrollHeight;
      paint();
    },
    rowCount: () => rows.childElementCount,
    destroy() {
      cancelAnimationFrame(frame);
      box.removeEventListener("scroll", schedule);
      host.innerHTML = "";
    },
  };
}
