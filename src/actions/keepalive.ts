const workflowPath = '.github/workflows/monitor.yml';
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Renew only an already active monitor. Never enable an intentionally disabled workflow. */
export async function keepalive(repo: string, token: string, enabled: string, fetcher: typeof fetch = fetch) {
  if (enabled !== 'true') return {status: 'skipped', reason: 'monitor_paused'};
  if (!/^[\w-]+\/[\w.-]+$/.test(repo) || /\/\.{1,2}$/.test(repo) || !token) throw new Error('GitHub repository/token missing');

  const base = `https://api.github.com/repos/${repo}`;
  async function api(path: string, method = 'GET') {
    const response = await fetcher(base + path, {
      method,
      headers: {Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28'},
      signal: AbortSignal.timeout(15000),
      redirect: 'error'
    });
    const expected = method === 'PUT' ? 204 : 200;
    if (response.status !== expected) throw new Error(`Keepalive API request failed (${response.status})`);
    return method === 'PUT' ? null : response.json();
  }

  const repository = await api('');
  if (!isRecord(repository) || repository.private !== false) throw new Error('Keepalive supports public repositories only');
  const path = '/actions/workflows/monitor.yml';
  const workflow = await api(path);
  if (!isRecord(workflow) || workflow.path !== workflowPath) throw new Error('Unexpected workflow; refusing to enable it');
  if (workflow.state !== 'active') return {status: 'skipped', reason: 'workflow_not_active'};

  // The enable endpoint also accepts active workflows; no commit or state.json write is needed.
  await api(path + '/enable', 'PUT');
  return {status: 'renewed', workflow: 'monitor.yml'};
}
