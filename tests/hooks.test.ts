import assert from 'node:assert/strict';
import { execSync, execFileSync } from 'node:child_process';
import path from 'node:path';
import test, { describe } from 'node:test';
import { normalizeIngestEvent } from '../src/contracts/event-contract.js';

const HOOKS_DIR = path.resolve(import.meta.dirname, '..', 'hooks', 'claude-code');
const PYTHON_DIR = path.join(HOOKS_DIR, 'python');

// Set a bogus URL so curl/urllib don't actually connect
const ENV = {
  ...process.env,
  AGENTSTATS_URL: 'http://127.0.0.1:0',
  AGENTSTATS_SAFETY: '1',
};

function makeSessionStartInput(): string {
  return JSON.stringify({
    session_id: 'test-session-001',
    transcript_path: '/tmp/transcript.jsonl',
    cwd: '/home/user/my-project',
    permission_mode: 'default',
    hook_event_name: 'SessionStart',
    source: 'startup',
    model: 'claude-sonnet-4-5-20250929',
  });
}

function makeStopInput(): string {
  return JSON.stringify({
    session_id: 'test-session-001',
    transcript_path: '/tmp/transcript.jsonl',
    cwd: '/home/user/my-project',
    permission_mode: 'default',
    hook_event_name: 'Stop',
    stop_hook_active: false,
    last_assistant_message: 'Done.',
  });
}

function makePostToolUseInput(toolName: string, toolInput: Record<string, unknown>): string {
  return JSON.stringify({
    session_id: 'test-session-001',
    transcript_path: '/tmp/transcript.jsonl',
    cwd: '/home/user/my-project',
    permission_mode: 'default',
    hook_event_name: 'PostToolUse',
    tool_name: toolName,
    tool_use_id: 'toolu_01ABC123',
    tool_input: toolInput,
    tool_response: { success: true },
  });
}

function makePreToolUseInput(toolName: string, toolInput: Record<string, unknown>): string {
  return JSON.stringify({
    session_id: 'test-session-001',
    transcript_path: '/tmp/transcript.jsonl',
    cwd: '/home/user/my-project',
    permission_mode: 'default',
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_use_id: 'toolu_01DEF456',
    tool_input: toolInput,
  });
}

function makeNotificationInput(): string {
  return JSON.stringify({
    session_id: 'test-session-001',
    transcript_path: '/tmp/transcript.jsonl',
    cwd: '/home/user/my-project',
    permission_mode: 'default',
    hook_event_name: 'Notification',
    message: 'Task completed successfully',
    title: 'Done',
    notification_type: 'idle_prompt',
  });
}

function runShellHook(script: string, stdin: string): { exitCode: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('bash', [path.join(HOOKS_DIR, script)], {
      input: stdin,
      env: ENV,
      timeout: 10000,
      encoding: 'utf-8',
    });
    return { exitCode: 0, stdout, stderr: '' };
  } catch (err: unknown) {
    const e = err as { status: number; stdout: string; stderr: string };
    return { exitCode: e.status, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

function runPythonHook(script: string, stdin: string): { exitCode: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('python3', [path.join(PYTHON_DIR, script)], {
      input: stdin,
      env: ENV,
      timeout: 10000,
      encoding: 'utf-8',
    });
    return { exitCode: 0, stdout, stderr: '' };
  } catch (err: unknown) {
    const e = err as { status: number; stdout: string; stderr: string };
    return { exitCode: e.status, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

// Validate that the payload a hook would send matches our contract
function validatePayloadShape(eventType: string, fields: Record<string, unknown>) {
  const result = normalizeIngestEvent({
    session_id: 'test-session-001',
    agent_type: 'claude_code',
    event_type: eventType,
    source: 'hook',
    ...fields,
  });
  assert.equal(result.ok, true, `Contract validation failed for ${eventType}: ${JSON.stringify(result)}`);
}

describe('Shell hook scripts', () => {
  test('session_start.sh exits 0', () => {
    const result = runShellHook('session_start.sh', makeSessionStartInput());
    assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
  });

  test('session_end.sh exits 0', () => {
    const result = runShellHook('session_end.sh', makeStopInput());
    assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
  });

  test('post_tool_use.sh exits 0 for Bash tool', () => {
    const result = runShellHook(
      'post_tool_use.sh',
      makePostToolUseInput('Bash', { command: 'npm test' })
    );
    assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
  });

  test('post_tool_use.sh exits 0 for Read tool', () => {
    const result = runShellHook(
      'post_tool_use.sh',
      makePostToolUseInput('Read', { file_path: '/src/index.ts' })
    );
    assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
  });

  test('notification.sh exits 0', () => {
    const result = runShellHook('notification.sh', makeNotificationInput());
    assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
  });

  test('pre_tool_use.sh exits 0 for safe Bash command', () => {
    const result = runShellHook(
      'pre_tool_use.sh',
      makePreToolUseInput('Bash', { command: 'npm test' })
    );
    assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
  });

  test('pre_tool_use.sh exits 2 for rm -rf /', () => {
    const result = runShellHook(
      'pre_tool_use.sh',
      makePreToolUseInput('Bash', { command: 'rm -rf /' })
    );
    assert.equal(result.exitCode, 2, 'Expected exit code 2 for destructive command');
    assert.ok(result.stderr.includes('Blocked'), `stderr should contain block message: ${result.stderr}`);
  });

  test('pre_tool_use.sh exits 2 for rm -rf ~', () => {
    const result = runShellHook(
      'pre_tool_use.sh',
      makePreToolUseInput('Bash', { command: 'rm -rf ~' })
    );
    assert.equal(result.exitCode, 2, 'Expected exit code 2 for destructive command');
  });

  test('pre_tool_use.sh exits 0 for non-Bash tools', () => {
    const result = runShellHook(
      'pre_tool_use.sh',
      makePreToolUseInput('Read', { file_path: '/etc/passwd' })
    );
    assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
  });

  test('pre_tool_use.sh exits 0 when safety is disabled', () => {
    try {
      execFileSync('bash', [path.join(HOOKS_DIR, 'pre_tool_use.sh')], {
        input: makePreToolUseInput('Bash', { command: 'rm -rf /' }),
        env: { ...ENV, AGENTSTATS_SAFETY: '0' },
        timeout: 10000,
        encoding: 'utf-8',
      });
      // If we get here, exit code was 0
    } catch (err: unknown) {
      const e = err as { status: number };
      assert.fail(`Expected exit 0 with safety disabled, got ${e.status}`);
    }
  });
});

describe('Python hook scripts', () => {
  // Check if python3 is available
  let hasPython = false;
  try {
    execSync('python3 --version', { encoding: 'utf-8', timeout: 5000 });
    hasPython = true;
  } catch {
    // python3 not available
  }

  if (!hasPython) {
    test('python3 not available, skipping Python hook tests', { skip: 'python3 not found' }, () => {});
    return;
  }

  test('session_start.py exits 0', () => {
    const result = runPythonHook('session_start.py', makeSessionStartInput());
    assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
  });

  test('session_end.py exits 0', () => {
    const result = runPythonHook('session_end.py', makeStopInput());
    assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
  });

  test('post_tool_use.py exits 0 for Bash tool', () => {
    const result = runPythonHook(
      'post_tool_use.py',
      makePostToolUseInput('Bash', { command: 'npm test' })
    );
    assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
  });

  test('pre_tool_use.py exits 0 for safe command', () => {
    const result = runPythonHook(
      'pre_tool_use.py',
      makePreToolUseInput('Bash', { command: 'npm test' })
    );
    assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
  });

  test('pre_tool_use.py exits 2 for rm -rf /', () => {
    const result = runPythonHook(
      'pre_tool_use.py',
      makePreToolUseInput('Bash', { command: 'rm -rf /' })
    );
    assert.equal(result.exitCode, 2, 'Expected exit code 2 for destructive command');
    assert.ok(result.stderr.includes('Blocked'), `stderr should contain block message: ${result.stderr}`);
  });

  test('pre_tool_use.py exits 2 for rm -rf ~', () => {
    const result = runPythonHook(
      'pre_tool_use.py',
      makePreToolUseInput('Bash', { command: 'rm -rf ~' })
    );
    assert.equal(result.exitCode, 2, 'Expected exit code 2 for destructive command');
  });

  test('pre_tool_use.py exits 0 for non-Bash tools', () => {
    const result = runPythonHook(
      'pre_tool_use.py',
      makePreToolUseInput('Read', { file_path: '/etc/passwd' })
    );
    assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
  });
});

describe('Hook payload contract validation', () => {
  test('session_start payload passes contract', () => {
    validatePayloadShape('session_start', {
      project: 'my-project',
      model: 'claude-sonnet-4-5-20250929',
    });
  });

  test('session_end payload passes contract', () => {
    validatePayloadShape('session_end', { project: 'my-project' });
  });

  test('tool_use payload passes contract', () => {
    validatePayloadShape('tool_use', {
      tool_name: 'Bash',
      project: 'my-project',
      metadata: { command: 'npm test', tool_use_id: 'toolu_01ABC123' },
    });
  });

  test('response payload passes contract', () => {
    validatePayloadShape('response', {
      project: 'my-project',
      metadata: { notification_type: 'idle_prompt', message: 'Done' },
    });
  });

  test('error payload passes contract (blocked command)', () => {
    validatePayloadShape('error', {
      tool_name: 'Bash',
      status: 'error',
      project: 'my-project',
      metadata: { blocked: true, reason: 'destructive_command', command: 'rm -rf /' },
    });
  });
});
