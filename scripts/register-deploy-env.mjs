// Preload for standalone dev/production server entrypoints (node --import).
import { loadDeployEnv, collectModelHosts } from './load-deploy-env.mjs';

const site = loadDeployEnv();
const hosts = [
  ...(process.env.NO_PROXY || process.env.no_proxy || '').split(',').map(value => value.trim()).filter(Boolean),
  '127.0.0.1', 'localhost', '::1', ...collectModelHosts(site.entries),
];
process.env.NO_PROXY = [...new Set(hosts)].join(',');
process.env.no_proxy = process.env.NO_PROXY;
