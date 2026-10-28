import { countryFlag, nodeCountryCode, nodeDisplayName } from '../../ui/country_flags.js';

function escapeSvgText(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function mihomoTrafficChartSvg({
  width,
  height,
  yTicks = [],
  xTicks = [],
  areas = [],
  paths = [],
  guide = {},
  hitArea = {},
  axisLabel = '',
} = {}) {
  const horizontalGrid = yTicks.map((tick) => (
    `<line x1="${tick.x1}" y1="${tick.y1}" x2="${tick.x2}" y2="${tick.y2}" class="grid"/><text x="${tick.labelX}" y="${tick.labelY}" text-anchor="end">${escapeSvgText(tick.label)}</text>`
  )).join('');
  const verticalGrid = xTicks.map((tick) => (
    `<line x1="${tick.x}" y1="${guide.y1}" x2="${tick.x}" y2="${guide.y2}" class="grid grid-vertical"/><text x="${tick.x}" y="${tick.labelY}" text-anchor="${escapeSvgText(tick.anchor)}">${escapeSvgText(tick.label)}</text>`
  )).join('');
  const fills = areas.map((item) => (
    `<path d="${escapeSvgText(item.d)}" class="chart-area ${escapeSvgText(item.tone)}" data-chart-area="${escapeSvgText(item.key)}"/>`
  )).join('');
  const series = paths.map((item) => (
    `<path d="${escapeSvgText(item.d)}" class="${escapeSvgText(item.tone)}" data-series-path="${escapeSvgText(item.key)}"/>`
  )).join('');
  const markers = paths.map((item) => (
    `<circle class="chart-marker ${escapeSvgText(item.tone)}" data-chart-marker="${escapeSvgText(item.key)}" r="4" cx="${guide.x}" cy="${guide.y2}" hidden/>`
  )).join('');
  return `<svg class="xk-mihomo-traffic-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Интерактивный график трафика">
    <defs>
      <linearGradient id="xk-mihomo-traffic-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="var(--op-accent)" stop-opacity=".42"/><stop offset="1" stop-color="var(--op-accent)" stop-opacity=".07"/></linearGradient>
      <linearGradient id="xk-mihomo-outside-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="var(--op-warning)" stop-opacity=".38"/><stop offset="1" stop-color="var(--op-warning)" stop-opacity=".1"/></linearGradient>
      <clipPath id="xk-mihomo-traffic-clip"><rect x="${hitArea.x}" y="${hitArea.y}" width="${hitArea.width}" height="${hitArea.height}"/></clipPath>
    </defs>
    ${horizontalGrid}${verticalGrid}
    <g clip-path="url(#xk-mihomo-traffic-clip)">${fills}${series}</g>
    <line class="chart-guide" data-chart-guide x1="${guide.x}" y1="${guide.y1}" x2="${guide.x}" y2="${guide.y2}" hidden/>
    ${markers}
    <rect class="chart-hit-area" data-chart-hit x="${hitArea.x}" y="${hitArea.y}" width="${hitArea.width}" height="${hitArea.height}"/>
    <text class="chart-axis-label" x="${hitArea.x + hitArea.width}" y="${Math.max(12, hitArea.y - 6)}" text-anchor="end">${escapeSvgText(axisLabel)}</text>
  </svg>`;
}

export function mihomoNodeCountryCode(name) {
  return nodeCountryCode(name);
}

export function mihomoNodeDisplayName(name, countryCode = nodeCountryCode(name)) {
  return nodeDisplayName(name, countryCode);
}

export function mihomoCountryFlag(countryCode) {
  return countryFlag(countryCode);
}
