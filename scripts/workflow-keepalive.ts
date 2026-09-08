import {keepalive} from '../src/actions/keepalive.ts';

try {
  const result = await keepalive(process.env.GITHUB_REPOSITORY ?? '', process.env.GITHUB_TOKEN ?? '', process.env.T_MEWS_ENABLED ?? '');
  console.log(JSON.stringify(result));
} catch {
  // Do not log credentials, arbitrary response bodies or network exception details.
  console.error('T-MEWS keepalive failed. Check the workflow Actions write permission and GitHub availability. RSS monitoring is independent.');
  process.exitCode = 1;
}
