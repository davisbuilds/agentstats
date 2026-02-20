// Cost Dashboard - spend visualization section
const CostDashboard = {
  data: null,

  formatCost(n) {
    if (n === 0 || n == null) return '$0.00';
    if (n < 0.01) return '<$0.01';
    if (n < 1) return '$' + n.toFixed(3);
    return '$' + n.toFixed(2);
  },

  async load(filters) {
    try {
      const qs = new URLSearchParams(filters || {}).toString();
      const res = await fetch(`/api/stats/cost${qs ? '?' + qs : ''}`);
      this.data = await res.json();
      this.render();
    } catch (err) {
      console.error('Failed to load cost data:', err);
    }
  },

  render() {
    const container = document.getElementById('cost-dashboard');
    if (!container || !this.data) return;

    const { by_model, by_project, timeline } = this.data;
    const by_project_list = by_project || [];

    const totalCost = by_model.reduce((sum, m) => sum + m.cost_usd, 0);
    const maxModelCost = Math.max(...by_model.map(m => m.cost_usd), 0.01);
    const maxProjectCost = Math.max(...by_project_list.map(p => p.cost_usd), 0.01);

    container.innerHTML = `
      <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
        <!-- Total Spend -->
        <div class="bg-gray-900 rounded-lg border border-gray-700 p-4">
          <div class="text-xs text-gray-500 uppercase tracking-wider mb-1">Total Spend</div>
          <div class="text-2xl font-bold text-white">${this.formatCost(totalCost)}</div>
          <div class="text-xs text-gray-500 mt-1">${by_model.length} model${by_model.length !== 1 ? 's' : ''} used</div>
        </div>

        <!-- By Model -->
        <div class="bg-gray-900 rounded-lg border border-gray-700 p-4">
          <div class="text-xs text-gray-500 uppercase tracking-wider mb-2">Cost by Model</div>
          ${by_model.length === 0 ? '<div class="text-xs text-gray-500">No cost data yet</div>' :
            by_model.slice(0, 5).map(m => `
              <div class="mb-1.5">
                <div class="flex justify-between text-xs mb-0.5">
                  <span class="text-gray-300 truncate mr-2">${this.shortModel(m.model)}</span>
                  <span class="text-gray-400 shrink-0">${this.formatCost(m.cost_usd)}</span>
                </div>
                <div class="h-1.5 bg-gray-800 rounded-full overflow-hidden">
                  <div class="h-full bg-blue-500 rounded-full" style="width:${Math.max(2, (m.cost_usd / maxModelCost) * 100)}%"></div>
                </div>
              </div>
            `).join('')}
        </div>

        <!-- By Project -->
        <div class="bg-gray-900 rounded-lg border border-gray-700 p-4">
          <div class="text-xs text-gray-500 uppercase tracking-wider mb-2">Top Projects by Cost</div>
          ${by_project_list.length === 0 ? '<div class="text-xs text-gray-500">No cost data yet</div>' :
            by_project_list.slice(0, 5).map(p => `
              <div class="mb-1.5">
                <div class="flex justify-between text-xs mb-0.5">
                  <span class="text-gray-300 truncate mr-2">${p.project}</span>
                  <span class="text-gray-400 shrink-0">${this.formatCost(p.cost_usd)} · ${p.session_count} session${p.session_count !== 1 ? 's' : ''}</span>
                </div>
                <div class="h-1.5 bg-gray-800 rounded-full overflow-hidden">
                  <div class="h-full bg-purple-500 rounded-full" style="width:${Math.max(2, (p.cost_usd / maxProjectCost) * 100)}%"></div>
                </div>
              </div>
            `).join('')}
        </div>
      </div>

      <!-- Cost Timeline -->
      ${timeline.length > 1 ? this.renderTimeline(timeline) : ''}
    `;
  },

  shortModel(model) {
    if (!model) return 'unknown';
    // Shorten common model names
    return model
      .replace(/claude-sonnet-4-5-\d+/, 'sonnet-4.5')
      .replace(/claude-opus-4-6(-\d+)?/, 'opus-4.6')
      .replace(/claude-haiku-4-5-\d+/, 'haiku-4.5')
      .replace(/claude-3-5-sonnet-\d+/, 'sonnet-3.5')
      .replace(/claude-3-5-haiku-\d+/, 'haiku-3.5')
      .replace(/claude-3-opus-\d+/, 'opus-3')
      .replace(/^claude-/, 'c-')
      .replace(/^gpt-/, 'gpt-');
  },

  renderTimeline(timeline) {
    if (!timeline || timeline.length < 2) return '';

    const maxCost = Math.max(...timeline.map(b => b.cost_usd), 0.001);
    const width = 600;
    const height = 80;
    const padding = { left: 0, right: 0, top: 5, bottom: 15 };
    const chartW = width - padding.left - padding.right;
    const chartH = height - padding.top - padding.bottom;

    const points = timeline.map((b, i) => {
      const x = padding.left + (i / (timeline.length - 1)) * chartW;
      const y = padding.top + chartH - (b.cost_usd / maxCost) * chartH;
      return `${x},${y}`;
    }).join(' ');

    // Fill area under the line
    const areaPoints = `${padding.left},${padding.top + chartH} ${points} ${padding.left + chartW},${padding.top + chartH}`;

    // X-axis labels (first, middle, last)
    const labels = [];
    if (timeline.length > 0) {
      labels.push({ x: padding.left, text: this.formatBucketTime(timeline[0].bucket) });
      if (timeline.length > 2) {
        const mid = Math.floor(timeline.length / 2);
        labels.push({ x: padding.left + (mid / (timeline.length - 1)) * chartW, text: this.formatBucketTime(timeline[mid].bucket) });
      }
      labels.push({ x: padding.left + chartW, text: this.formatBucketTime(timeline[timeline.length - 1].bucket) });
    }

    return `
      <div class="bg-gray-900 rounded-lg border border-gray-700 p-4 mt-4">
        <div class="text-xs text-gray-500 uppercase tracking-wider mb-2">Spend Over Time</div>
        <svg viewBox="0 0 ${width} ${height}" class="w-full" preserveAspectRatio="none">
          <polygon points="${areaPoints}" fill="rgba(59,130,246,0.1)" />
          <polyline points="${points}" fill="none" stroke="rgb(59,130,246)" stroke-width="1.5" />
          ${labels.map(l => `<text x="${l.x}" y="${height - 2}" fill="#6b7280" font-size="9" text-anchor="middle">${l.text}</text>`).join('')}
        </svg>
      </div>
    `;
  },

  formatBucketTime(bucket) {
    if (!bucket) return '';
    try {
      const d = new Date(bucket);
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' +
        d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
    } catch { return bucket; }
  },
};
