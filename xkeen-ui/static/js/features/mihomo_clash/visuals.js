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
  paths = [],
  guide = {},
  hitArea = {},
  xLabels = [],
} = {}) {
  const grid = yTicks.map((tick) => (
    `<line x1="${tick.x1}" y1="${tick.y1}" x2="${tick.x2}" y2="${tick.y2}" class="grid"/><text x="${tick.labelX}" y="${tick.labelY}" text-anchor="end">${escapeSvgText(tick.label)}</text>`
  )).join('');
  const series = paths.map((item) => (
    `<path d="${escapeSvgText(item.d)}" class="${escapeSvgText(item.tone)}" data-series-path="${escapeSvgText(item.key)}"/>`
  )).join('');
  const labels = xLabels.map((item) => (
    `<text x="${item.x}" y="${item.y}" text-anchor="${escapeSvgText(item.anchor)}">${escapeSvgText(item.label)}</text>`
  )).join('');
  return `<svg class="xk-mihomo-traffic-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Интерактивный график трафика">
    ${grid}
    ${series}
    <line class="chart-guide" data-chart-guide x1="${guide.x}" y1="${guide.y1}" x2="${guide.x}" y2="${guide.y2}" hidden/>
    <rect class="chart-hit-area" data-chart-hit x="${hitArea.x}" y="${hitArea.y}" width="${hitArea.width}" height="${hitArea.height}"/>
    ${labels}
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
