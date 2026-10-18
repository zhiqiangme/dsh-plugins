import { apply as applyUpstream } from 'dsh-bili-scroll';
import { liveConfigValues } from './lib/config.js';

export { Config, inject, name } from 'dsh-bili-scroll';

export function apply(ctx, config) {
  return applyUpstream(ctx, liveConfigValues(config));
}
