export async function runServerStartupBeforeListen({
  initializeDatabaseFn,
  ensureAdminUserFn,
  configureWebPushFn
}) {
  if (typeof initializeDatabaseFn !== 'function') {
    throw new TypeError('initializeDatabaseFn is required');
  }
  if (typeof ensureAdminUserFn !== 'function') {
    throw new TypeError('ensureAdminUserFn is required');
  }
  if (typeof configureWebPushFn !== 'function') {
    throw new TypeError('configureWebPushFn is required');
  }

  await initializeDatabaseFn();
  await ensureAdminUserFn();
  configureWebPushFn();
}

export async function startServerAfterStartup({
  startupFn,
  listenFn
}) {
  if (typeof startupFn !== 'function') {
    throw new TypeError('startupFn is required');
  }
  if (typeof listenFn !== 'function') {
    throw new TypeError('listenFn is required');
  }

  await startupFn();
  return await listenFn();
}
