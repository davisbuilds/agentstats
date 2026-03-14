import type { ContentBlock, Message } from './api/client';

export type SessionTextKind = 'plain' | 'caveat' | 'command' | 'output';

export type SessionTextParseResult =
  | { kind: 'plain'; text: string }
  | { kind: 'caveat'; text: string }
  | { kind: 'command'; name: string; message: string; args: string }
  | { kind: 'output'; stream: 'stdout' | 'stderr'; text: string };

const ANSI_ESCAPE_RE = /\u001b\[[0-9;]*m/g;

function cleanText(text: string): string {
  return text.replace(ANSI_ESCAPE_RE, '').trim();
}

function firstTextBlock(content: string): string | null {
  try {
    const blocks = JSON.parse(content) as ContentBlock[];
    const textBlock = blocks.find((block) => block?.type === 'text' && typeof block.text === 'string');
    return textBlock?.text ?? null;
  } catch {
    return content;
  }
}

export function parseSessionText(text: string | null | undefined): SessionTextParseResult | null {
  if (!text) return null;

  const caveatMatch = text.match(/<local-command-caveat>([\s\S]*?)<\/local-command-caveat>/);
  if (caveatMatch) {
    return { kind: 'caveat', text: cleanText(caveatMatch[1] ?? '') };
  }

  const commandMatch = text.match(
    /<command-name>([\s\S]*?)<\/command-name>\s*<command-message>([\s\S]*?)<\/command-message>\s*<command-args>([\s\S]*?)<\/command-args>/,
  );
  if (commandMatch) {
    return {
      kind: 'command',
      name: cleanText(commandMatch[1] ?? ''),
      message: cleanText(commandMatch[2] ?? ''),
      args: cleanText(commandMatch[3] ?? ''),
    };
  }

  const outputMatch = text.match(/<local-command-(stdout|stderr)>([\s\S]*?)<\/local-command-(stdout|stderr)>/);
  if (outputMatch && outputMatch[1] === outputMatch[3]) {
    return {
      kind: 'output',
      stream: outputMatch[1] as 'stdout' | 'stderr',
      text: cleanText(outputMatch[2] ?? ''),
    };
  }

  return { kind: 'plain', text: cleanText(text) };
}

export function getSessionPreviewText(text: string | null | undefined): string | null {
  const parsed = parseSessionText(text);
  if (!parsed) return null;

  switch (parsed.kind) {
    case 'caveat':
      return null;
    case 'command':
      return null;
    case 'output':
      return null;
    case 'plain':
      return parsed.text.replace(/\s+/g, ' ').trim() || null;
  }
}

export function getMessagePreviewText(message: Pick<Message, 'content'>): string | null {
  const text = firstTextBlock(message.content);
  return getSessionPreviewText(text);
}
