// Cost Dashboard - spend visualization section
const CostDashboard = {
  data: null,

  formatCost(n) {
    if (n === 0 || n == null) return '$0.00';
    if (n < 0.01) return '<$0.01';
    if (n < 1) return '$' + n.toFixed(3);
    return '$' + n.toFixed(2);
  },

  costWindow: '60d',  // default rolling window

  async load(filters) {
    try {
      const params = new URLSearchParams(filters || {});
      // Apply default 60d window for cost data unless a time filter is already set
      if (!params.has('since') && this.costWindow !== 'all') {
        const days = parseInt(this.costWindow, 10) || 60;
        params.set('since', new Date(Date.now() - days * 86400000).toISOString());
      }
      const qs = params.toString();
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

    // Wire cost window picker
    const picker = document.getElementById('cost-window-picker');
    if (picker) {
      picker.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-cost-window]');
        if (!btn) return;
        this.costWindow = btn.dataset.costWindow;
        this.load(FilterBar.getActiveFilters());
      });
    }
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

    const pts = timeline.map((b, i) => ({
      x: padding.left + (i / (timeline.length - 1)) * chartW,
      y: padding.top + chartH - (b.cost_usd / maxCost) * chartH,
    }));

    // Build smooth cubic bezier path
    const smoothPath = this.smoothLine(pts);

    // Fill area: move to bottom-left, line to first point, smooth curve, line to bottom-right, close
    const fillPath = `M${pts[0].x},${padding.top + chartH} L${pts[0].x},${pts[0].y} ${smoothPath.slice(smoothPath.indexOf('C'))} L${pts[pts.length - 1].x},${padding.top + chartH} Z`;

    // Weekly grid lines aligned to Mondays
    const tStart = new Date(timeline[0].bucket).getTime();
    const tEnd = new Date(timeline[timeline.length - 1].bucket).getTime();
    const tRange = tEnd - tStart;

    const mondays = [];
    // Find the first Monday on or after tStart
    const d0 = new Date(tStart);
    d0.setHours(0, 0, 0, 0);
    const dayOfWeek = d0.getDay(); // 0=Sun, 1=Mon
    const daysUntilMon = dayOfWeek === 0 ? 1 : dayOfWeek === 1 ? 0 : 8 - dayOfWeek;
    const firstMon = new Date(d0);
    firstMon.setDate(firstMon.getDate() + daysUntilMon);

    for (let m = new Date(firstMon); m.getTime() <= tEnd; m.setDate(m.getDate() + 7)) {
      const frac = (m.getTime() - tStart) / tRange;
      if (frac > 0.02 && frac < 0.98) { // skip if too close to edges
        mondays.push({
          x: padding.left + frac * chartW,
          text: m.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        });
      }
    }

    // Edge labels (always show first and last dates)
    const edgeLabels = [
      { x: padding.left, text: this.formatBucketDate(timeline[0].bucket), anchor: 'start' },
      { x: padding.left + chartW, text: this.formatBucketDate(timeline[timeline.length - 1].bucket), anchor: 'end' },
    ];

    const windowOptions = [
      { value: '30d', label: '30d' },
      { value: '60d', label: '60d' },
      { value: '90d', label: '90d' },
      { value: 'all', label: 'All' },
    ];
    const windowPicker = windowOptions.map(o =>
      `<button data-cost-window="${o.value}" class="px-1.5 py-0.5 rounded text-[10px] ${this.costWindow === o.value ? 'bg-gray-700 text-gray-200' : 'text-gray-500 hover:text-gray-300'}">${o.label}</button>`
    ).join('');

    return `
      <div class="bg-gray-900 rounded-lg border border-gray-700 p-4 mt-4">
        <div class="flex items-center justify-between mb-2">
          <div class="text-xs text-gray-500 uppercase tracking-wider">Spend Over Time</div>
          <div class="flex gap-1" id="cost-window-picker">${windowPicker}</div>
        </div>
        <svg viewBox="0 0 ${width} ${height}" class="w-full" preserveAspectRatio="none">
          ${mondays.map(m => `<line x1="${m.x}" y1="${padding.top}" x2="${m.x}" y2="${padding.top + chartH}" stroke="#374151" stroke-width="0.5" />`).join('')}
          <path d="${fillPath}" fill="rgba(59,130,246,0.1)" />
          <path d="${smoothPath}" fill="none" stroke="rgb(59,130,246)" stroke-width="1.5" />
          ${mondays.map(m => `<text x="${m.x}" y="${height - 2}" fill="#6b7280" font-size="9" text-anchor="middle">${m.text}</text>`).join('')}
          ${edgeLabels.map(l => `<text x="${l.x}" y="${height - 2}" fill="#6b7280" font-size="9" text-anchor="${l.anchor}">${l.text}</text>`).join('')}
        </svg>
      </div>
    `;
  },

  // Attempt monotone cubic interpolation for a smooth SVG path
  smoothLine(pts) {
    if (pts.length < 2) return '';
    if (pts.length === 2) return `M${pts[0].x},${pts[0].y} L${pts[1].x},${pts[1].y}`;

    let d = `M${pts[0].x},${pts[0].y}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[Math.max(i - 1, 0)];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[Math.min(i + 2, pts.length - 1)];

      const tension = 0.3;
      const cp1x = p1.x + (p2.x - p0.x) * tension;
      const cp1y = p1.y + (p2.y - p0.y) * tension;
      const cp2x = p2.x - (p3.x - p1.x) * tension;
      const cp2y = p2.y - (p3.y - p1.y) * tension;

      d += ` C${cp1x},${cp1y} ${cp2x},${cp2y} ${p2.x},${p2.y}`;
    }
    return d;
  },

  formatBucketDate(bucket) {
    if (!bucket) return '';
    try {
      const d = new Date(bucket);
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    } catch { return bucket; }
  },
};
