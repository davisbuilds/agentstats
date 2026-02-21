// Usage Monitor - Per-agent rolling window usage with progress bars (tokens or cost)
const UsageMonitor = {
  container: null,
  data: null, // AgentUsageData[]
  countdownTimer: null,

  AGENT_LABELS: {
    claude_code: 'Claude Code',
    codex: 'Codex',
  },

  init() {
    this.container = document.getElementById('usage-monitor');
    if (!this.container) return;
    this.fetch();
    this.countdownTimer = setInterval(() => this.renderCountdowns(), 60_000);
  },

  async fetch() {
    try {
      const res = await fetch('/api/stats/usage-monitor');
      this.data = await res.json();
      this.render();
    } catch (err) {
      console.error('Usage monitor fetch error:', err);
    }
  },

  update(usageMonitor) {
    if (!usageMonitor) return;
    this.data = usageMonitor;
    this.render();
  },

  render() {
    if (!this.container || !this.data) return;

    // Filter to agents that have limits
    const agents = this.data.filter(a => a.session.limit > 0 || (a.extended && a.extended.limit > 0));

    if (agents.length === 0) {
      this.container.classList.add('hidden');
      return;
    }
    this.container.classList.remove('hidden');

    let html = '<div class="flex items-center gap-6 flex-wrap">';

    for (const agent of agents) {
      const label = this.AGENT_LABELS[agent.agent_type] || agent.agent_type;
      const fmt = agent.limitType === 'cost' ? this.formatCost : this.formatTokens;

      if (agent.session.limit > 0) {
        html += this.renderBar(
          `${label}`,
          agent.session.used,
          agent.session.limit,
          agent.session.windowHours,
          `session-${agent.agent_type}`,
          `${agent.session.windowHours}h window`,
          fmt
        );
      }

      if (agent.extended && agent.extended.limit > 0) {
        html += this.renderBar(
          `${label}`,
          agent.extended.used,
          agent.extended.limit,
          agent.extended.windowHours,
          `extended-${agent.agent_type}`,
          this.formatWindowLabel(agent.extended.windowHours),
          fmt
        );
      }
    }

    html += '</div>';
    this.container.innerHTML = html;
  },

  renderBar(label, used, limit, windowHours, id, windowLabel, fmt) {
    const pct = limit > 0 ? Math.min((used / limit) * 100, 100) : 0;
    const color = pct < 60 ? 'bg-emerald-500' : pct < 85 ? 'bg-yellow-500' : 'bg-red-500';
    const usedFmt = fmt(used);
    const limitFmt = fmt(limit);

    return `
      <div class="flex items-center gap-3 min-w-0 flex-1" style="min-width:220px;max-width:440px">
        <span class="text-xs text-gray-400 shrink-0">${label}</span>
        <div class="flex-1 min-w-0">
          <div class="h-2 bg-gray-800 rounded-full overflow-hidden">
            <div class="${color} h-full rounded-full transition-all duration-500" style="width:${pct.toFixed(1)}%"></div>
          </div>
        </div>
        <span class="text-xs text-gray-300 tabular-nums shrink-0">${usedFmt}/${limitFmt}</span>
        <span class="text-xs text-gray-500 shrink-0" data-reset-id="${id}">${windowLabel}</span>
      </div>`;
  },

  renderCountdowns() {
    // Window labels are static ("5h window", "24h window"), no countdown needed
  },

  formatWindowLabel(hours) {
    if (hours >= 168 && hours % 168 === 0) return `${hours / 168}w window`;
    if (hours >= 24 && hours % 24 === 0) return `${hours / 24}d window`;
    return `${hours}h window`;
  },

  formatTokens(n) {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
    return String(n);
  },

  formatCost(n) {
    return '$' + n.toFixed(2);
  },
};
