<script lang="ts">
  import { onMount } from 'svelte';
  import {
    fetchBrowsingSession,
    fetchMessages,
    fetchSessionChildren,
    type BrowsingSession,
    type Message,
  } from '../../api/client';
  import { timeAgo, agentHexColor } from '../../format';
  import { getMessagePreviewText, getSessionPreviewText } from '../../session-text';
  import MessageBlock from './MessageBlock.svelte';

  interface Props {
    sessionId: string;
    onclose: () => void;
  }
  let { sessionId, onclose }: Props = $props();

  let session = $state<BrowsingSession | null>(null);
  let messages = $state<Message[]>([]);
  let children = $state<BrowsingSession[]>([]);
  let totalMessages = $state(0);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let loadingMore = $state(false);
  let hasMore = $state(false);

  const PAGE_SIZE = 50;
  const displayTitle = $derived.by(() => {
    for (const message of messages) {
      const preview = getMessagePreviewText(message);
      if (preview) return preview;
    }
    if (!session) return sessionId.slice(0, 12);
    return getSessionPreviewText(session.first_message) || (session.message_count > 0 ? 'Local command activity' : session.id.slice(0, 12));
  });

  async function load() {
    loading = true;
    try {
      const [sess, msgs, kids] = await Promise.all([
        fetchBrowsingSession(sessionId),
        fetchMessages(sessionId, { limit: PAGE_SIZE }),
        fetchSessionChildren(sessionId).catch(() => ({ data: [] })),
      ]);
      session = sess;
      messages = msgs.data;
      totalMessages = msgs.total;
      children = kids.data;
      hasMore = msgs.data.length < msgs.total;
    } catch (err) {
      console.error('Failed to load session:', err);
      error = 'Failed to load session.';
    } finally {
      loading = false;
    }
  }

  async function loadMore() {
    if (loadingMore || !hasMore) return;
    loadingMore = true;
    try {
      const res = await fetchMessages(sessionId, {
        offset: messages.length,
        limit: PAGE_SIZE,
      });
      messages = [...messages, ...res.data];
      hasMore = messages.length < res.total;
    } catch (err) {
      console.error('Failed to load more messages:', err);
    } finally {
      loadingMore = false;
    }
  }

  onMount(() => {
    load();
  });
</script>

<main class="flex-1 overflow-hidden flex flex-col">
  <!-- Header -->
  <div class="border-b border-gray-800 px-4 sm:px-6 py-3 flex items-center gap-3 shrink-0">
    <button
      class="text-gray-400 hover:text-gray-200 text-sm"
      onclick={onclose}
    >
      ← Back
    </button>

    {#if session}
      <div class="flex items-center gap-2 min-w-0 flex-1">
        <span
          class="inline-block w-2 h-2 rounded-full shrink-0"
          style="background-color: {agentHexColor(session.agent)}"
        ></span>
        <span class="text-sm text-gray-200 truncate font-medium">
          {displayTitle}
        </span>
      </div>
      <div class="flex items-center gap-3 text-xs text-gray-500 shrink-0">
        {#if session.project}
          <span class="bg-gray-800 px-1.5 py-0.5 rounded">{session.project}</span>
        {/if}
        <span>{session.message_count} messages</span>
        {#if session.started_at}
          <span>{timeAgo(session.started_at)}</span>
        {/if}
      </div>
    {/if}
  </div>

  <!-- Children -->
  {#if children.length > 0}
    <div class="border-b border-gray-800 px-4 sm:px-6 py-2 text-xs text-gray-500">
      <span class="mr-2">Sub-sessions:</span>
      {#each children as child}
        <span class="inline-block bg-gray-800 px-1.5 py-0.5 rounded mr-1">
          {(getSessionPreviewText(child.first_message) || (child.message_count > 0 ? 'Local command activity' : child.id.slice(0, 8))).slice(0, 30)}
        </span>
      {/each}
    </div>
  {/if}

  <!-- Messages -->
  <div class="flex-1 overflow-y-auto px-4 sm:px-6 py-4 space-y-4">
    {#if loading}
      <div class="text-center py-16 text-gray-500 text-sm">Loading messages...</div>
    {:else if error}
      <div class="text-center py-16 text-red-400">
        <p class="text-sm">{error}</p>
        <button class="text-xs mt-2 text-blue-400 hover:text-blue-300" onclick={load}>Retry</button>
      </div>
    {:else if messages.length === 0}
      <div class="text-center py-16 text-gray-500 text-sm">No messages in this session.</div>
    {:else}
      {#each messages as message (message.id)}
        <MessageBlock {message} />
      {/each}

      {#if hasMore}
        <div class="text-center py-3">
          <button
            class="text-sm text-blue-400 hover:text-blue-300"
            onclick={loadMore}
            disabled={loadingMore}
          >
            {loadingMore ? 'Loading...' : `Load more (${messages.length}/${totalMessages})`}
          </button>
        </div>
      {/if}
    {/if}
  </div>
</main>
