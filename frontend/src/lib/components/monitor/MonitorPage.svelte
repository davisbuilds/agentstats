<script lang="ts">
  import { onMount } from 'svelte';
  import AgentCards from './AgentCards.svelte';
  import EventFeed from './EventFeed.svelte';
  import CostDashboard from './CostDashboard.svelte';
  import ToolAnalytics from './ToolAnalytics.svelte';
  import SessionDetail from './SessionDetail.svelte';
  import { setEvents, setSessions, setStats, setCostData, setToolStats, getFilters } from '../../stores/monitor.svelte';
  import { fetchStats, fetchEvents, fetchSessions, fetchCostData, fetchToolStats } from '../../api/client';

  interface Props {
    onfilterchange: (filters: Record<string, string>) => void;
  }
  let { onfilterchange }: Props = $props();

  export async function reload(filters: Record<string, string> = {}) {
    const sessionsParams: Record<string, string> = { limit: '0', exclude_status: 'ended' };
    if (filters.agent_type) sessionsParams.agent_type = filters.agent_type;

    try {
      const [statsData, eventsData, sessionsData] = await Promise.all([
        fetchStats(filters),
        fetchEvents(filters),
        fetchSessions(sessionsParams),
      ]);
      setStats(statsData);
      setEvents(eventsData.events || []);
      setSessions(sessionsData.sessions || []);
    } catch (err) {
      console.error('Failed to load monitor data:', err);
    }

    // Load analytics independently
    const analyticsResults = await Promise.allSettled([
      fetchCostData(filters).then(setCostData),
      fetchToolStats(filters).then(setToolStats),
    ]);
    for (const result of analyticsResults) {
      if (result.status === 'rejected') {
        console.error('Failed to load monitor analytics:', result.reason);
      }
    }
  }

  onMount(() => {
    reload(getFilters());
  });
</script>

<main class="flex-1 min-h-0 overflow-y-auto flex flex-col p-4 sm:p-6 gap-6">
  <section>
    <AgentCards />
  </section>

  <section>
    <CostDashboard />
  </section>

  <section>
    <ToolAnalytics />
  </section>

  <EventFeed />
</main>

<SessionDetail />
