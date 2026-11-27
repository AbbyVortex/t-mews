import {dispatchRadarWake} from '../src/actions/radar-wake.ts';

try {
  await dispatchRadarWake(process.env);
} catch {
  // Network exceptions can include a private destination. Keep runner output generic.
  console.error('Radar wake check could not complete. A claimed signal is not resent.');
  process.exitCode=1;
}
