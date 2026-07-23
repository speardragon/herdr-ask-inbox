export function captureExecFile(responses = []) {
  const calls = [];
  const execFile = async (bin, args, options) => {
    calls.push({
      bin,
      args: structuredClone(args),
      options: { ...options, env: options?.env ? { ...options.env } : undefined },
    });
    const response = responses[calls.length - 1];
    if (response instanceof Error) throw response;
    return response ?? { stdout: '', stderr: '' };
  };
  return { calls, execFile };
}

export function fakeHerdr(overrides = {}) {
  const calls = [];
  const method = (name, result) => async (...args) => {
    calls.push({ name, args: structuredClone(args) });
    return typeof result === 'function' ? result(...args) : result;
  };
  return {
    calls,
    api: {
      snapshot: method('snapshot', overrides.snapshot ?? {
        focused_workspace_id: 'w-focused',
        panes: [],
        agents: [],
      }),
      readPane: method('readPane', overrides.readPane ?? ''),
      sendAgentKeys: method('sendAgentKeys'),
      focusAgent: method('focusAgent'),
      openPopup: method('openPopup', overrides.openPopup ?? 'w-focused:p-popup'),
      focusPopup: method('focusPopup'),
      notify: method('notify'),
      reportBlocked: method('reportBlocked'),
      releaseBlocked: method('releaseBlocked'),
    },
  };
}
